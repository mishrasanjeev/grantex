"""End-to-end tests for grantex-gemma against the live production service.

Live tests (marked ``@pytest.mark.live``) hit the real Grantex production
auth service. Run them with::

    pytest tests/e2e/ -m live

Offline simulation tests run without any network access.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from jwt.algorithms import RSAAlgorithm

from grantex_gemma import (
    BundleTamperedError,
    OfflineVerificationError,
    OfflineVerifier,
    create_offline_audit_log,
    create_offline_verifier,
    compute_entry_hash,
    load_bundle,
    store_bundle,
    verify_chain,
)
from grantex_gemma._types import (
    ConsentBundle,
    JWKSSnapshot,
    OfflineAuditKey,
    SignedAuditEntry,
    VerifiedGrant,
)

# ---------------------------------------------------------------------------
#  Constants
# ---------------------------------------------------------------------------

PRODUCTION_URL = "https://grantex-auth-dd4mtrt2gq-uc.a.run.app"
JWKS_URL = f"{PRODUCTION_URL}/.well-known/jwks.json"


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


def _generate_rsa_key_pair() -> tuple[RSAPrivateKey, dict[str, Any]]:
    """Generate an RSA key pair and return (private_key, jwk_dict)."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    public_key = private_key.public_key()
    jwk: dict[str, Any] = json.loads(
        RSAAlgorithm.to_jwk(public_key)  # type: ignore[arg-type]
    )
    return private_key, jwk


def _make_snapshot(
    keys: list[dict[str, Any]],
    valid_days: int = 7,
) -> JWKSSnapshot:
    """Create a JWKSSnapshot from a list of JWK dicts."""
    now = datetime.now(tz=timezone.utc)
    return JWKSSnapshot(
        keys=keys,
        fetched_at=now.isoformat(),
        valid_until=datetime(
            now.year, now.month, now.day + valid_days, tzinfo=timezone.utc
        ).isoformat()
        if now.day + valid_days <= 28
        else (
            datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc).isoformat()
        ),
    )


def _sign_grant_token(
    private_key: RSAPrivateKey,
    kid: str,
    claims: dict[str, Any] | None = None,
) -> str:
    """Sign a JWT with standard Grantex claims."""
    now = int(time.time())
    default_claims: dict[str, Any] = {
        "jti": f"tok_e2e_{now}",
        "sub": "user:e2e-test",
        "agt": "did:key:z6MkE2EAgent",
        "dev": "dev_e2e",
        "scp": ["data:read"],
        "iat": now,
        "exp": now + 3600,
        "grnt": "grant_e2e_001",
    }
    if claims:
        default_claims.update(claims)
    return pyjwt.encode(
        default_claims,
        private_key,
        algorithm="RS256",
        headers={"kid": kid},
    )


def _generate_ed25519_key_pair() -> OfflineAuditKey:
    """Generate an Ed25519 key pair for audit log signing."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return OfflineAuditKey(
        public_key=public_pem,
        private_key=private_pem,
        algorithm="Ed25519",
    )


# ===========================================================================
#  LIVE PRODUCTION TESTS
# ===========================================================================


@pytest.mark.live
@pytest.mark.asyncio
async def test_fetch_jwks_from_production() -> None:
    """Fetch JWKS from the production endpoint and verify structure."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(JWKS_URL, timeout=30.0)

    assert resp.status_code == 200
    body = resp.json()
    assert "keys" in body
    assert isinstance(body["keys"], list)
    assert len(body["keys"]) >= 1

    # Every key must have kty and kid
    for key in body["keys"]:
        assert "kty" in key
        assert "kid" in key

    # Expect at least one RSA key with the primary kid
    rsa_keys = [k for k in body["keys"] if k["kty"] == "RSA"]
    assert len(rsa_keys) >= 1

    primary = next(
        (k for k in body["keys"] if k.get("kid") == "grantex-2026-04"),
        None,
    )
    assert primary is not None
    assert primary["kty"] == "RSA"


@pytest.mark.live
@pytest.mark.asyncio
async def test_create_offline_verifier_with_production_jwks() -> None:
    """Create an OfflineVerifier from the live production JWKS."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(JWKS_URL, timeout=30.0)

    body = resp.json()
    snapshot = JWKSSnapshot(
        keys=body["keys"],
        fetched_at=datetime.now(tz=timezone.utc).isoformat(),
        valid_until="2026-12-31T00:00:00Z",
    )

    verifier = create_offline_verifier(snapshot)
    assert isinstance(verifier, OfflineVerifier)


@pytest.mark.live
@pytest.mark.asyncio
async def test_sign_and_verify_against_production_jwks() -> None:
    """Sign a test JWT locally and verify against production JWKS key import.

    This tests that the production JWKS contains importable RSA keys.
    We sign with our own key (not the production key), but this exercises
    the JWKS fetching and snapshot creation paths end-to-end.
    """
    # Generate our own key pair
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "e2e-local-key"
    jwk["alg"] = "RS256"

    snapshot = _make_snapshot([jwk])
    verifier = create_offline_verifier(snapshot)

    token = _sign_grant_token(
        private_key,
        kid="e2e-local-key",
        claims={
            "sub": "user:live-e2e",
            "agt": "did:key:z6MkLiveAgent",
            "scp": ["calendar:read", "contacts:read"],
            "grnt": "grant_live_001",
        },
    )

    grant = await verifier.verify(token)
    assert grant.principal_did == "user:live-e2e"
    assert grant.agent_did == "did:key:z6MkLiveAgent"
    assert grant.scopes == ["calendar:read", "contacts:read"]
    assert grant.grant_id == "grant_live_001"
    assert grant.depth == 0


@pytest.mark.live
@pytest.mark.asyncio
async def test_reject_token_signed_with_different_key() -> None:
    """Token signed with a key not in the JWKS snapshot must be rejected."""
    # Fetch production JWKS
    async with httpx.AsyncClient() as client:
        resp = await client.get(JWKS_URL, timeout=30.0)

    body = resp.json()
    snapshot = JWKSSnapshot(
        keys=body["keys"],
        fetched_at=datetime.now(tz=timezone.utc).isoformat(),
        valid_until="2026-12-31T00:00:00Z",
    )
    verifier = create_offline_verifier(snapshot)

    # Sign with a locally generated key (NOT the production key)
    rogue_private, _ = _generate_rsa_key_pair()
    token = _sign_grant_token(
        rogue_private,
        kid="grantex-2026-04",  # Use the production kid but wrong key
        claims={
            "sub": "user:rogue",
            "agt": "did:key:z6MkRogue",
            "scp": ["admin:all"],
        },
    )

    # The signature check should fail
    with pytest.raises(OfflineVerificationError):
        await verifier.verify(token)


# ===========================================================================
#  OFFLINE SIMULATION TESTS
# ===========================================================================


@pytest.mark.asyncio
async def test_full_lifecycle_offline() -> None:
    """Full lifecycle: keygen -> sign -> verify -> audit -> chain -> sync sim."""
    # 1. Generate RSA key pair for token signing
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "lifecycle-key"
    jwk["alg"] = "RS256"
    snapshot = _make_snapshot([jwk])

    # 2. Sign a JWT
    token = _sign_grant_token(
        private_key,
        kid="lifecycle-key",
        claims={
            "sub": "user:lifecycle-principal",
            "agt": "did:key:z6MkLifecycleAgent",
            "scp": ["files:read", "files:write"],
            "grnt": "grant_lifecycle_001",
        },
    )

    # 3. Verify offline
    verifier = create_offline_verifier(snapshot)
    grant = await verifier.verify(token)
    assert grant.principal_did == "user:lifecycle-principal"
    assert grant.agent_did == "did:key:z6MkLifecycleAgent"
    assert grant.scopes == ["files:read", "files:write"]
    assert grant.grant_id == "grant_lifecycle_001"

    # 4. Create audit log with Ed25519 signing
    audit_key = _generate_ed25519_key_pair()
    with tempfile.TemporaryDirectory() as tmp_dir:
        log_path = os.path.join(tmp_dir, "lifecycle-audit.jsonl")

        audit_log = create_offline_audit_log(
            signing_key=audit_key,
            log_path=log_path,
        )

        # 5. Append entries
        actions = [
            "read_contacts",
            "write_calendar",
            "send_email",
            "query_database",
            "update_profile",
        ]

        entries: list[SignedAuditEntry] = []
        for action in actions:
            signed = await audit_log.append(
                action=action,
                grant=grant,
                result="success",
                metadata={"traceId": f"trace_{action}"},
            )
            entries.append(signed)

        assert len(entries) == 5

        # 6. Read back and verify hash chain
        raw_entries = audit_log._read_entries()
        signed_entries = [
            SignedAuditEntry(**entry) for entry in raw_entries
        ]
        assert len(signed_entries) == 5

        chain_result = verify_chain(signed_entries)
        assert chain_result == (True, None)

        # Verify first entry has the genesis prev_hash
        assert signed_entries[0].prev_hash == "0" * 64

        # Verify chain linkage
        for i in range(1, len(signed_entries)):
            assert signed_entries[i].prev_hash == signed_entries[i - 1].hash

        # 7. Verify recomputed hashes match
        for entry in signed_entries:
            entry_dict = {
                "seq": entry.seq,
                "timestamp": entry.timestamp,
                "action": entry.action,
                "agent_did": entry.agent_did,
                "grant_id": entry.grant_id,
                "scopes": entry.scopes,
                "result": entry.result,
                "metadata": entry.metadata,
                "prev_hash": entry.prev_hash,
            }
            recomputed = compute_entry_hash(entry_dict)
            assert entry.hash == recomputed


@pytest.mark.asyncio
async def test_bundle_encryption_roundtrip() -> None:
    """Store and load a consent bundle with AES-256-GCM encryption."""
    # Generate RSA key pair for the bundle's JWT
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "bundle-key"
    jwk["alg"] = "RS256"
    snapshot = _make_snapshot([jwk])

    token = _sign_grant_token(
        private_key,
        kid="bundle-key",
        claims={
            "sub": "user:bundle-test",
            "agt": "did:key:z6MkBundleAgent",
            "scp": ["data:read"],
            "grnt": "grant_bundle_001",
        },
    )

    audit_key = _generate_ed25519_key_pair()

    original_bundle = ConsentBundle(
        bundle_id=f"bundle_e2e_{int(time.time())}",
        grant_token=token,
        jwks_snapshot=snapshot,
        offline_audit_key=audit_key,
        checkpoint_at=int(time.time() * 1000),
        sync_endpoint=f"{PRODUCTION_URL}/v1/audit/offline-sync",
        offline_expires_at=datetime(
            2026, 12, 31, tzinfo=timezone.utc
        ).isoformat(),
    )

    # 64 hex chars = 32 bytes AES key
    encryption_key = "a" * 64

    with tempfile.TemporaryDirectory() as tmp_dir:
        bundle_path = os.path.join(tmp_dir, "test-bundle.enc")

        # Store encrypted
        store_bundle(original_bundle, bundle_path, encryption_key)

        # Load and decrypt
        loaded = load_bundle(bundle_path, encryption_key)

        # Verify all fields match
        assert loaded.bundle_id == original_bundle.bundle_id
        assert loaded.grant_token == original_bundle.grant_token
        assert loaded.jwks_snapshot.keys == original_bundle.jwks_snapshot.keys
        assert (
            loaded.jwks_snapshot.fetched_at
            == original_bundle.jwks_snapshot.fetched_at
        )
        assert (
            loaded.jwks_snapshot.valid_until
            == original_bundle.jwks_snapshot.valid_until
        )
        assert (
            loaded.offline_audit_key.public_key
            == original_bundle.offline_audit_key.public_key
        )
        assert (
            loaded.offline_audit_key.private_key
            == original_bundle.offline_audit_key.private_key
        )
        assert loaded.offline_audit_key.algorithm == "Ed25519"
        assert loaded.checkpoint_at == original_bundle.checkpoint_at
        assert loaded.sync_endpoint == original_bundle.sync_endpoint
        assert (
            loaded.offline_expires_at
            == original_bundle.offline_expires_at
        )

        # Verify the loaded bundle's JWT is still valid
        verifier = create_offline_verifier(loaded.jwks_snapshot)
        grant = await verifier.verify(loaded.grant_token)
        assert grant.principal_did == "user:bundle-test"


@pytest.mark.asyncio
async def test_bundle_storage_rejects_wrong_key() -> None:
    """Loading a bundle with the wrong encryption key must fail."""
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "wrong-key-test"
    jwk["alg"] = "RS256"

    bundle = ConsentBundle(
        bundle_id="bundle_wrong_key",
        grant_token=_sign_grant_token(private_key, kid="wrong-key-test"),
        jwks_snapshot=_make_snapshot([jwk]),
        offline_audit_key=OfflineAuditKey(
            public_key="fake", private_key="fake", algorithm="Ed25519"
        ),
        checkpoint_at=int(time.time() * 1000),
        sync_endpoint="https://example.com/sync",
        offline_expires_at="2026-12-31T00:00:00Z",
    )

    correct_key = "b" * 64
    wrong_key = "c" * 64

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = os.path.join(tmp_dir, "wrong-key-bundle.enc")
        store_bundle(bundle, path, correct_key)

        with pytest.raises(BundleTamperedError):
            load_bundle(path, wrong_key)


@pytest.mark.asyncio
async def test_performance_verify_100_tokens() -> None:
    """Verify 100 tokens and assert average < 10ms."""
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "perf-key"
    jwk["alg"] = "RS256"
    snapshot = _make_snapshot([jwk])
    verifier = create_offline_verifier(snapshot)

    # Pre-generate tokens
    tokens: list[str] = []
    for i in range(100):
        tokens.append(
            _sign_grant_token(
                private_key,
                kid="perf-key",
                claims={
                    "sub": f"user:perf-{i}",
                    "agt": "did:key:z6MkPerfAgent",
                    "scp": ["read:data"],
                    "grnt": f"grant_perf_{i}",
                    "jti": f"tok_perf_{i}",
                },
            )
        )

    # Warm up
    await verifier.verify(tokens[0])

    # Timed run
    start = time.perf_counter()
    for token in tokens:
        await verifier.verify(token)
    elapsed = time.perf_counter() - start

    avg_ms = (elapsed / 100) * 1000
    print(
        f"[perf] 100 token verifications: "
        f"{elapsed * 1000:.1f}ms total, {avg_ms:.3f}ms avg"
    )
    assert avg_ms < 10, f"Average verification time {avg_ms:.3f}ms exceeds 10ms"


@pytest.mark.asyncio
async def test_sync_simulation_200_entries() -> None:
    """Create 200 audit entries, verify chain, simulate batch sync."""
    audit_key = _generate_ed25519_key_pair()

    # Create a sample grant for the audit entries
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "sync-key"
    jwk["alg"] = "RS256"
    snapshot = _make_snapshot([jwk])

    token = _sign_grant_token(
        private_key,
        kid="sync-key",
        claims={
            "sub": "user:sync-test",
            "agt": "did:key:z6MkSyncAgent",
            "scp": ["data:read", "data:write"],
            "grnt": "grant_sync_001",
        },
    )
    verifier = create_offline_verifier(snapshot)
    grant = await verifier.verify(token)

    with tempfile.TemporaryDirectory() as tmp_dir:
        log_path = os.path.join(tmp_dir, "sync-sim-audit.jsonl")

        audit_log = create_offline_audit_log(
            signing_key=audit_key,
            log_path=log_path,
        )

        # Append 200 entries
        entry_count = 200
        for i in range(entry_count):
            await audit_log.append(
                action=f"action_{i % 10}",
                grant=grant,
                result="denied" if i % 20 == 0 else "success",
                metadata={"batchIdx": i // 100, "entryIdx": i},
            )

        # Read and verify the chain
        raw_entries = audit_log._read_entries()
        signed_entries = [
            SignedAuditEntry(**entry) for entry in raw_entries
        ]
        assert len(signed_entries) == entry_count

        chain_result = verify_chain(signed_entries)
        assert chain_result == (True, None)

        # Verify sequence numbers are consecutive
        for i, entry in enumerate(signed_entries):
            assert entry.seq == i + 1

        # Verify chain linkage
        assert signed_entries[0].prev_hash == "0" * 64
        for i in range(1, len(signed_entries)):
            assert signed_entries[i].prev_hash == signed_entries[i - 1].hash


@pytest.mark.asyncio
async def test_tampered_chain_detected() -> None:
    """Tampering with an entry's hash should be detected by verify_chain."""
    audit_key = _generate_ed25519_key_pair()
    private_key, jwk = _generate_rsa_key_pair()
    jwk["kid"] = "tamper-key"
    jwk["alg"] = "RS256"

    token = _sign_grant_token(
        private_key,
        kid="tamper-key",
        claims={
            "sub": "user:tamper-test",
            "agt": "did:key:z6MkTamperAgent",
            "scp": ["files:read"],
            "grnt": "grant_tamper_001",
        },
    )
    verifier = create_offline_verifier(_make_snapshot([jwk]))
    grant = await verifier.verify(token)

    with tempfile.TemporaryDirectory() as tmp_dir:
        log_path = os.path.join(tmp_dir, "tamper-audit.jsonl")

        audit_log = create_offline_audit_log(
            signing_key=audit_key,
            log_path=log_path,
        )

        for i in range(5):
            await audit_log.append(
                action=f"action_{i}",
                grant=grant,
                result="success",
            )

        raw_entries = audit_log._read_entries()
        signed_entries = [
            SignedAuditEntry(**entry) for entry in raw_entries
        ]

        # Tamper with entry 2
        tampered = list(signed_entries)
        tampered[2] = SignedAuditEntry(
            seq=tampered[2].seq,
            timestamp=tampered[2].timestamp,
            action=tampered[2].action,
            agent_did=tampered[2].agent_did,
            grant_id=tampered[2].grant_id,
            scopes=tampered[2].scopes,
            result=tampered[2].result,
            metadata=tampered[2].metadata,
            prev_hash=tampered[2].prev_hash,
            hash="deadbeef" * 8,
            signature=tampered[2].signature,
        )

        result = verify_chain(tampered)
        assert result == (False, 2)
