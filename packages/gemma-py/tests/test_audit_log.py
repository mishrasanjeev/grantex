"""Tests for the offline audit log."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)
from cryptography.hazmat.primitives.serialization import (
    load_pem_private_key,
)

from grantex_gemma import (
    OfflineAuditLog,
    create_offline_audit_log,
    verify_chain,
)
from grantex_gemma._types import (
    OfflineAuditKey,
    SignedAuditEntry,
    VerifiedGrant,
)


@pytest.mark.asyncio
async def test_append_creates_signed_entry(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Appended entries should have valid Ed25519 signatures."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)
    entry = await log.append(
        action="read:contacts",
        grant=sample_grant,
        result="success",
        metadata={"count": 42},
    )

    assert entry.seq == 1
    assert entry.action == "read:contacts"
    assert entry.agent_did == "did:web:agent.example.com"
    assert entry.result == "success"
    assert entry.signature  # non-empty
    assert entry.hash  # non-empty
    assert entry.prev_hash == "0" * 64

    # Verify the Ed25519 signature
    private_key = load_pem_private_key(
        offline_audit_key.private_key.encode("utf-8"),
        password=None,
    )
    assert isinstance(private_key, Ed25519PrivateKey)
    public_key = private_key.public_key()

    import base64

    sig_bytes = base64.urlsafe_b64decode(entry.signature)
    # This should not raise
    public_key.verify(sig_bytes, entry.hash.encode("utf-8"))


@pytest.mark.asyncio
async def test_chain_hashes_correctly(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Each entry's prev_hash should match the previous entry's hash."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)

    entry1 = await log.append("action1", sample_grant, "success")
    entry2 = await log.append("action2", sample_grant, "success")
    entry3 = await log.append("action3", sample_grant, "success")

    assert entry1.prev_hash == "0" * 64
    assert entry2.prev_hash == entry1.hash
    assert entry3.prev_hash == entry2.hash

    # Verify full chain
    valid, broken_at = verify_chain([entry1, entry2, entry3])
    assert valid is True
    assert broken_at is None


@pytest.mark.asyncio
async def test_detect_tampered_entry(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Tampered entries should be detected by verify_chain."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)

    entry1 = await log.append("action1", sample_grant, "success")
    entry2 = await log.append("action2", sample_grant, "success")

    # Tamper with entry2's action
    tampered = SignedAuditEntry(
        seq=entry2.seq,
        timestamp=entry2.timestamp,
        action="TAMPERED_ACTION",
        agent_did=entry2.agent_did,
        grant_id=entry2.grant_id,
        scopes=entry2.scopes,
        result=entry2.result,
        metadata=entry2.metadata,
        prev_hash=entry2.prev_hash,
        hash=entry2.hash,  # Hash won't match
        signature=entry2.signature,
    )

    valid, broken_at = verify_chain([entry1, tampered])
    assert valid is False
    assert broken_at == 1


@pytest.mark.asyncio
async def test_entries_written_to_jsonl(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Entries should be persisted in JSONL format."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)
    await log.append("action1", sample_grant, "success")
    await log.append("action2", sample_grant, "denied")

    with open(tmp_log_path, "r", encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.strip()]

    assert len(lines) == 2

    entry1 = json.loads(lines[0])
    assert entry1["seq"] == 1
    assert entry1["action"] == "action1"

    entry2 = json.loads(lines[1])
    assert entry2["seq"] == 2
    assert entry2["action"] == "action2"


@pytest.mark.asyncio
async def test_resumes_from_existing_log(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """A new OfflineAuditLog instance should resume seq from existing file."""
    log1 = create_offline_audit_log(offline_audit_key, tmp_log_path)
    entry1 = await log1.append("action1", sample_grant, "success")

    # Create a new instance pointing to the same file
    log2 = create_offline_audit_log(offline_audit_key, tmp_log_path)
    entry2 = await log2.append("action2", sample_grant, "success")

    assert entry2.seq == 2
    assert entry2.prev_hash == entry1.hash


@pytest.mark.asyncio
async def test_sync_entries_in_batches(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Sync should POST entries in batches and return SyncResult."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)

    # Append 5 entries
    for i in range(5):
        await log.append(f"action{i}", sample_grant, "success")

    # Mock httpx
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "accepted": 3,
        "rejected": 0,
        "revocationStatus": "active",
    }

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("grantex_gemma._audit_log.httpx.AsyncClient", return_value=mock_client):
        result = await log.sync(
            endpoint="https://api.grantex.dev/v1/audit/sync",
            api_key="test-key",
            bundle_id="bundle-123",
            batch_size=3,
        )

    # 5 entries / batch 3 = 2 batches
    assert mock_client.post.call_count == 2
    # Each batch returns 3 accepted
    assert result.accepted == 6  # 3 + 3
    assert result.rejected == 0
    assert result.revocation_status == "active"


@pytest.mark.asyncio
async def test_append_with_no_metadata(
    offline_audit_key: OfflineAuditKey,
    tmp_log_path: str,
    sample_grant: VerifiedGrant,
) -> None:
    """Appending without metadata should use empty dict."""
    log = create_offline_audit_log(offline_audit_key, tmp_log_path)
    entry = await log.append("action1", sample_grant, "success")
    assert entry.metadata == {}
