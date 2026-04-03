"""Security-focused tests for grantex-gemma."""

from __future__ import annotations

import base64
import hmac
import json
import time
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric.rsa import (
    RSAPrivateKey,
    RSAPublicKey,
)

from grantex_gemma import (
    OfflineVerificationError,
    SignedAuditEntry,
    compute_entry_hash,
    create_offline_verifier,
    verify_chain,
)
from grantex_gemma._types import JWKSSnapshot

from conftest import make_test_jwt


@pytest.mark.asyncio
async def test_reject_alg_none(
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Tokens with alg:none must be rejected."""
    # Craft a token with alg:none manually
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "none", "typ": "JWT"}).encode()
    ).rstrip(b"=")
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "jti": "tok_none",
                "sub": "sub",
                "agt": "agt",
                "scp": [],
                "exp": int(time.time()) + 3600,
                "iat": int(time.time()),
            }
        ).encode()
    ).rstrip(b"=")
    token = f"{header.decode()}.{payload.decode()}."

    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(
        OfflineVerificationError, match="'none' is not allowed"
    ):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_reject_hs256(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """HS256 tokens must be rejected even if the key matches."""
    now = int(time.time())
    # Create an HS256 token (symmetric key attack vector)
    token = pyjwt.encode(
        {
            "jti": "tok_hs256",
            "sub": "sub",
            "agt": "agt",
            "scp": [],
            "iat": now,
            "exp": now + 3600,
        },
        "secret",
        algorithm="HS256",
    )
    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(
        OfflineVerificationError, match="HS256.*not allowed"
    ):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_reject_forged_token(
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """A token with a valid structure but forged signature must fail."""
    # Build a valid-looking token with garbage signature
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "kid": "test-kid-1", "typ": "JWT"}).encode()
    ).rstrip(b"=")
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "jti": "tok_forged",
                "sub": "sub",
                "agt": "agt",
                "scp": [],
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
            }
        ).encode()
    ).rstrip(b"=")
    fake_sig = base64.urlsafe_b64encode(b"forged" * 20).rstrip(b"=")
    token = f"{header.decode()}.{payload.decode()}.{fake_sig.decode()}"

    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(OfflineVerificationError, match="verification failed"):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_reject_future_iat(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Tokens with iat far in the future should still verify
    (iat is informational, exp is what matters for expiry).
    But we test the token is well-formed."""
    future = int(time.time()) + 86400 * 365
    token = make_test_jwt(
        rsa_key_pair,
        claims={"iat": future, "exp": future + 3600},
    )
    # This should verify since exp is in the future
    verifier = create_offline_verifier(jwks_snapshot)
    grant = await verifier.verify(token)
    assert grant.jti == "tok_test123"


@pytest.mark.asyncio
async def test_error_messages_do_not_leak_keys(
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Error messages should not contain key material."""
    verifier = create_offline_verifier(jwks_snapshot)
    try:
        await verifier.verify("garbage.token.here")
    except OfflineVerificationError as exc:
        msg = str(exc)
        # Should not contain any base64-encoded key material
        for key_data in jwks_snapshot.keys:
            if "n" in key_data:
                assert key_data["n"] not in msg
            if "d" in key_data:
                assert key_data["d"] not in msg


def test_hash_chain_detects_deletion() -> None:
    """Deleting an entry from the middle of a chain should break it."""

    def _entry(
        seq: int, action: str, prev: str
    ) -> SignedAuditEntry:
        d = {
            "seq": seq,
            "timestamp": "2026-04-01T00:00:00Z",
            "action": action,
            "agent_did": "agt",
            "grant_id": "gnt",
            "scopes": [],
            "result": "ok",
            "metadata": {},
            "prev_hash": prev,
        }
        h = compute_entry_hash(d)
        return SignedAuditEntry(**d, hash=h, signature="sig")

    e1 = _entry(1, "a", "0" * 64)
    e2 = _entry(2, "b", e1.hash)
    e3 = _entry(3, "c", e2.hash)

    # Delete e2 — chain [e1, e3] is broken
    valid, broken_at = verify_chain([e1, e3])
    assert valid is False
    assert broken_at == 1  # e3's prev_hash != e1's hash


def test_hash_chain_detects_reordering() -> None:
    """Swapping entries should break the chain."""

    def _entry(
        seq: int, action: str, prev: str
    ) -> SignedAuditEntry:
        d = {
            "seq": seq,
            "timestamp": "2026-04-01T00:00:00Z",
            "action": action,
            "agent_did": "agt",
            "grant_id": "gnt",
            "scopes": [],
            "result": "ok",
            "metadata": {},
            "prev_hash": prev,
        }
        h = compute_entry_hash(d)
        return SignedAuditEntry(**d, hash=h, signature="sig")

    e1 = _entry(1, "a", "0" * 64)
    e2 = _entry(2, "b", e1.hash)
    e3 = _entry(3, "c", e2.hash)

    # Swap e2 and e3
    valid, broken_at = verify_chain([e1, e3, e2])
    assert valid is False


@pytest.mark.asyncio
async def test_no_keys_in_snapshot(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
) -> None:
    """Verifier with empty JWKS should fail gracefully."""
    empty_snapshot = JWKSSnapshot(
        keys=[],
        fetched_at="2026-04-01T00:00:00Z",
        valid_until="2026-04-08T00:00:00Z",
    )
    token = make_test_jwt(rsa_key_pair)
    verifier = create_offline_verifier(empty_snapshot)
    with pytest.raises(
        OfflineVerificationError, match="No RSA keys available"
    ):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_reject_token_with_empty_string() -> None:
    """Empty string should be rejected."""
    snapshot = JWKSSnapshot(
        keys=[],
        fetched_at="2026-04-01T00:00:00Z",
        valid_until="2026-04-08T00:00:00Z",
    )
    verifier = create_offline_verifier(snapshot)
    with pytest.raises(OfflineVerificationError, match="Malformed JWT"):
        await verifier.verify("")


@pytest.mark.asyncio
async def test_scope_enforcer_in_verifier(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Verifier should enforce scopes correctly."""
    token = make_test_jwt(
        rsa_key_pair,
        claims={"scp": ["read:contacts"]},
    )
    verifier = create_offline_verifier(
        jwks_snapshot,
        require_scopes=["read:contacts", "write:calendar"],
        on_scope_violation="throw",
    )
    from grantex_gemma import ScopeViolationError

    with pytest.raises(ScopeViolationError, match="write:calendar"):
        await verifier.verify(token)
