"""Tests for consent bundle creation and storage."""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from grantex_gemma import (
    BundleTamperedError,
    ConsentBundle,
    GrantexAuthError,
    JWKSSnapshot,
    OfflineAuditKey,
    create_consent_bundle,
    load_bundle,
    store_bundle,
)


def _make_bundle() -> ConsentBundle:
    """Create a sample ConsentBundle for testing."""
    return ConsentBundle(
        bundle_id="bnd_test123",
        grant_token="eyJ...",
        jwks_snapshot=JWKSSnapshot(
            keys=[{"kty": "RSA", "kid": "k1", "n": "abc", "e": "AQAB"}],
            fetched_at="2026-04-01T00:00:00Z",
            valid_until="2026-04-04T00:00:00Z",
        ),
        offline_audit_key=OfflineAuditKey(
            public_key="-----BEGIN PUBLIC KEY-----\nMCo...\n-----END PUBLIC KEY-----",
            private_key="-----BEGIN PRIVATE KEY-----\nMC4...\n-----END PRIVATE KEY-----",
            algorithm="Ed25519",
        ),
        checkpoint_at=100,
        sync_endpoint="https://api.grantex.dev/v1/audit/sync",
        offline_expires_at="2026-04-04T00:00:00Z",
    )


@pytest.mark.asyncio
async def test_create_bundle_success() -> None:
    """create_consent_bundle should POST and return a ConsentBundle."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "bundleId": "bnd_new",
        "grantToken": "eyJ...",
        "jwksSnapshot": {
            "keys": [{"kty": "RSA", "kid": "k1"}],
            "fetchedAt": "2026-04-01T00:00:00Z",
            "validUntil": "2026-04-04T00:00:00Z",
        },
        "offlineAuditKey": {
            "publicKey": "pub",
            "privateKey": "priv",
            "algorithm": "Ed25519",
        },
        "checkpointAt": 0,
        "syncEndpoint": "https://api.grantex.dev/v1/audit/sync",
        "offlineExpiresAt": "2026-04-04T00:00:00Z",
    }

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch(
        "grantex_gemma._consent_bundle.httpx.AsyncClient",
        return_value=mock_client,
    ):
        bundle = await create_consent_bundle(
            api_key="test-key",
            agent_id="did:web:agent.example.com",
            user_id="did:web:user.example.com",
            scopes=["read:contacts"],
            offline_ttl="72h",
        )

    assert bundle.bundle_id == "bnd_new"
    assert bundle.jwks_snapshot.keys[0]["kty"] == "RSA"
    assert bundle.offline_audit_key.algorithm == "Ed25519"
    mock_client.post.assert_called_once()


@pytest.mark.asyncio
async def test_create_bundle_auth_error() -> None:
    """create_consent_bundle should raise GrantexAuthError on 401."""
    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.text = "Unauthorized"

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch(
        "grantex_gemma._consent_bundle.httpx.AsyncClient",
        return_value=mock_client,
    ):
        with pytest.raises(GrantexAuthError, match="Invalid API key"):
            await create_consent_bundle(
                api_key="bad-key",
                agent_id="agent",
                user_id="user",
                scopes=["read:contacts"],
            )


def test_store_and_load_encrypted_bundle(tmp_path: Any) -> None:
    """Bundle should survive encrypt -> store -> load -> decrypt."""
    bundle = _make_bundle()
    path = str(tmp_path / "bundle.enc")
    key = "a" * 64  # 32 bytes in hex

    store_bundle(bundle, path, key)
    assert os.path.exists(path)

    loaded = load_bundle(path, key)
    assert loaded.bundle_id == bundle.bundle_id
    assert loaded.grant_token == bundle.grant_token
    assert loaded.jwks_snapshot.keys == bundle.jwks_snapshot.keys
    assert loaded.offline_audit_key.algorithm == bundle.offline_audit_key.algorithm
    assert loaded.checkpoint_at == bundle.checkpoint_at
    assert loaded.sync_endpoint == bundle.sync_endpoint
    assert loaded.offline_expires_at == bundle.offline_expires_at


def test_detect_tampered_bundle(tmp_path: Any) -> None:
    """Modifying the ciphertext should raise BundleTamperedError."""
    bundle = _make_bundle()
    path = str(tmp_path / "bundle.enc")
    key = "b" * 64

    store_bundle(bundle, path, key)

    # Tamper with the file
    with open(path, "r", encoding="utf-8") as f:
        data = f.read()
    # Flip a character in the middle
    mid = len(data) // 2
    tampered_char = "A" if data[mid] != "A" else "B"
    tampered = data[:mid] + tampered_char + data[mid + 1 :]
    with open(path, "w", encoding="utf-8") as f:
        f.write(tampered)

    with pytest.raises(BundleTamperedError):
        load_bundle(path, key)


def test_load_bundle_wrong_key(tmp_path: Any) -> None:
    """Loading with the wrong key should raise BundleTamperedError."""
    bundle = _make_bundle()
    path = str(tmp_path / "bundle.enc")
    key1 = "c" * 64
    key2 = "d" * 64

    store_bundle(bundle, path, key1)

    with pytest.raises(BundleTamperedError, match="tampered"):
        load_bundle(path, key2)
