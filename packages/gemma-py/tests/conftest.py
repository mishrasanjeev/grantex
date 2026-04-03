"""Shared fixtures for grantex-gemma tests."""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timezone
from typing import Any, Generator

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)
from cryptography.hazmat.primitives.asymmetric.rsa import (
    RSAPrivateKey,
    RSAPublicKey,
)
from jwt.algorithms import RSAAlgorithm

from grantex_gemma._types import (
    JWKSSnapshot,
    OfflineAuditKey,
    VerifiedGrant,
)


@pytest.fixture
def rsa_key_pair() -> tuple[RSAPrivateKey, RSAPublicKey]:
    """Generate an RSA key pair for testing."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    return private_key, private_key.public_key()


@pytest.fixture
def rsa_jwk(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
) -> dict[str, Any]:
    """Export the RSA public key as a JWK dict."""
    _, public_key = rsa_key_pair
    pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    jwk: dict[str, Any] = json.loads(
        RSAAlgorithm.to_jwk(public_key)  # type: ignore[arg-type]
    )
    jwk["kid"] = "test-kid-1"
    jwk["use"] = "sig"
    jwk["alg"] = "RS256"
    return jwk


@pytest.fixture
def jwks_snapshot(rsa_jwk: dict[str, Any]) -> JWKSSnapshot:
    """Create a JWKS snapshot with the test RSA key."""
    return JWKSSnapshot(
        keys=[rsa_jwk],
        fetched_at="2026-04-01T00:00:00Z",
        valid_until="2026-04-08T00:00:00Z",
    )


@pytest.fixture
def ed25519_key_pair() -> tuple[Ed25519PrivateKey, bytes, bytes]:
    """Generate an Ed25519 key pair and return (private, private_pem, public_pem)."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_key, private_pem, public_pem


@pytest.fixture
def offline_audit_key(
    ed25519_key_pair: tuple[Ed25519PrivateKey, bytes, bytes],
) -> OfflineAuditKey:
    """Create an OfflineAuditKey from the test Ed25519 key pair."""
    _, private_pem, public_pem = ed25519_key_pair
    return OfflineAuditKey(
        public_key=public_pem.decode("utf-8"),
        private_key=private_pem.decode("utf-8"),
        algorithm="Ed25519",
    )


@pytest.fixture
def tmp_log_path(tmp_path: Any) -> str:
    """Temporary path for the audit log file."""
    return str(tmp_path / "audit.jsonl")


@pytest.fixture
def sample_grant() -> VerifiedGrant:
    """A sample VerifiedGrant for testing."""
    return VerifiedGrant(
        agent_did="did:web:agent.example.com",
        principal_did="did:web:user.example.com",
        scopes=["read:contacts", "write:calendar"],
        expires_at=datetime(2026, 12, 31, tzinfo=timezone.utc),
        jti="tok_abc123",
        grant_id="gnt_xyz789",
        depth=0,
    )


def make_test_jwt(
    rsa_key_pair: tuple[RSAPrivateKey, RSAPublicKey],
    kid: str = "test-kid-1",
    claims: dict[str, Any] | None = None,
    algorithm: str = "RS256",
    headers: dict[str, Any] | None = None,
) -> str:
    """Create a signed JWT for testing."""
    private_key, _ = rsa_key_pair
    now = int(time.time())
    default_claims: dict[str, Any] = {
        "jti": "tok_test123",
        "sub": "did:web:user.example.com",
        "agt": "did:web:agent.example.com",
        "dev": "dev_test",
        "scp": ["read:contacts", "write:calendar"],
        "iat": now,
        "exp": now + 3600,
        "grnt": "gnt_test456",
    }
    if claims:
        default_claims.update(claims)

    hdr: dict[str, Any] = {"kid": kid}
    if headers:
        hdr.update(headers)

    return pyjwt.encode(
        default_claims,
        private_key,
        algorithm=algorithm,
        headers=hdr,
    )
