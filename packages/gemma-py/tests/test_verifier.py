"""Tests for the offline JWT verifier."""

from __future__ import annotations

import json
import time
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import (
    RSAPrivateKey,
    RSAPublicKey,
)
from jwt.algorithms import RSAAlgorithm

from grantex_gemma import (
    OfflineVerificationError,
    OfflineVerifier,
    ScopeViolationError,
    TokenExpiredError,
    create_offline_verifier,
)
from grantex_gemma._types import JWKSSnapshot

from conftest import make_test_jwt


@pytest.mark.asyncio
async def test_verify_valid_rs256_jwt(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Valid RS256 token should verify and return a VerifiedGrant."""
    token = make_test_jwt(rsa_key_pair)
    verifier = create_offline_verifier(jwks_snapshot)
    grant = await verifier.verify(token)

    assert grant.agent_did == "did:web:agent.example.com"
    assert grant.principal_did == "did:web:user.example.com"
    assert "read:contacts" in grant.scopes
    assert "write:calendar" in grant.scopes
    assert grant.jti == "tok_test123"
    assert grant.grant_id == "gnt_test456"
    assert grant.depth == 0


@pytest.mark.asyncio
async def test_reject_mismatched_kid(
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token signed with a different key should fail verification."""
    # Generate a completely different key pair
    other_private = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    )
    other_public = other_private.public_key()
    now = int(time.time())
    token = pyjwt.encode(
        {
            "jti": "tok_bad",
            "sub": "sub",
            "agt": "agt",
            "dev": "dev",
            "scp": [],
            "iat": now,
            "exp": now + 3600,
        },
        other_private,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )

    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(OfflineVerificationError, match="verification failed"):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_reject_expired_token(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Expired tokens should raise TokenExpiredError."""
    past = int(time.time()) - 7200
    token = make_test_jwt(
        rsa_key_pair,
        claims={"iat": past - 3600, "exp": past},
    )
    verifier = create_offline_verifier(jwks_snapshot, clock_skew_seconds=0)
    with pytest.raises(TokenExpiredError, match="expired"):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_allow_within_clock_skew(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token expired within clock_skew_seconds should still verify."""
    now = int(time.time())
    # Token expired 10 seconds ago, but skew is 30
    token = make_test_jwt(
        rsa_key_pair,
        claims={"iat": now - 3600, "exp": now - 10},
    )
    verifier = create_offline_verifier(
        jwks_snapshot, clock_skew_seconds=30
    )
    grant = await verifier.verify(token)
    assert grant.jti == "tok_test123"


@pytest.mark.asyncio
async def test_enforce_required_scopes_pass(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token with all required scopes should pass."""
    token = make_test_jwt(rsa_key_pair)
    verifier = create_offline_verifier(
        jwks_snapshot, require_scopes=["read:contacts"]
    )
    grant = await verifier.verify(token)
    assert "read:contacts" in grant.scopes


@pytest.mark.asyncio
async def test_enforce_required_scopes_fail(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token missing a required scope should raise ScopeViolationError."""
    token = make_test_jwt(rsa_key_pair)
    verifier = create_offline_verifier(
        jwks_snapshot,
        require_scopes=["admin:delete"],
        on_scope_violation="throw",
    )
    with pytest.raises(ScopeViolationError, match="admin:delete"):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_enforce_max_delegation_depth(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token exceeding max delegation depth should be rejected."""
    token = make_test_jwt(
        rsa_key_pair,
        claims={
            "delegationDepth": 3,
            "parentAgt": "did:web:parent.example.com",
            "parentGrnt": "gnt_parent",
        },
    )
    verifier = create_offline_verifier(
        jwks_snapshot, max_delegation_depth=2
    )
    with pytest.raises(
        OfflineVerificationError, match="Delegation depth 3 exceeds"
    ):
        await verifier.verify(token)


@pytest.mark.asyncio
async def test_delegation_depth_within_limit(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token within max delegation depth should pass."""
    token = make_test_jwt(
        rsa_key_pair,
        claims={"delegationDepth": 1},
    )
    verifier = create_offline_verifier(
        jwks_snapshot, max_delegation_depth=2
    )
    grant = await verifier.verify(token)
    assert grant.depth == 1


@pytest.mark.asyncio
async def test_handle_malformed_jwt(
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Garbage input should raise OfflineVerificationError."""
    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(OfflineVerificationError, match="Malformed JWT"):
        await verifier.verify("not.a.jwt")


@pytest.mark.asyncio
async def test_handle_multiple_keys_in_snapshot(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    rsa_jwk: dict[str, Any],
) -> None:
    """Verifier should find the correct key among multiple keys."""
    # Create a second key
    other_private = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    )
    other_jwk: dict[str, Any] = json.loads(
        RSAAlgorithm.to_jwk(other_private.public_key())  # type: ignore[arg-type]
    )
    other_jwk["kid"] = "other-kid"
    other_jwk["use"] = "sig"
    other_jwk["alg"] = "RS256"

    snapshot = JWKSSnapshot(
        keys=[other_jwk, rsa_jwk],
        fetched_at="2026-04-01T00:00:00Z",
        valid_until="2026-04-08T00:00:00Z",
    )

    token = make_test_jwt(rsa_key_pair, kid="test-kid-1")
    verifier = create_offline_verifier(snapshot)
    grant = await verifier.verify(token)
    assert grant.jti == "tok_test123"


@pytest.mark.asyncio
async def test_scope_violation_log_mode(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """In log mode, scope violation should not raise."""
    token = make_test_jwt(rsa_key_pair)
    verifier = create_offline_verifier(
        jwks_snapshot,
        require_scopes=["admin:nuke"],
        on_scope_violation="log",
    )
    # Should not raise
    grant = await verifier.verify(token)
    assert grant.jti == "tok_test123"


@pytest.mark.asyncio
async def test_missing_required_claims(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    jwks_snapshot: JWKSSnapshot,
) -> None:
    """Token missing required claims should be rejected."""
    now = int(time.time())
    # Missing 'agt' claim
    token = pyjwt.encode(
        {
            "jti": "tok_incomplete",
            "sub": "sub",
            "dev": "dev",
            "scp": [],
            "iat": now,
            "exp": now + 3600,
        },
        rsa_key_pair[0],
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    verifier = create_offline_verifier(jwks_snapshot)
    with pytest.raises(
        OfflineVerificationError, match="missing required claim"
    ):
        await verifier.verify(token)
