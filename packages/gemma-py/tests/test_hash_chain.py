"""Tests for hash chain utilities."""

from __future__ import annotations

import pytest

from grantex_gemma import (
    HashChainError,
    SignedAuditEntry,
    compute_entry_hash,
    verify_chain,
)


def _make_entry(
    seq: int,
    action: str,
    prev_hash: str,
    compute: bool = True,
) -> SignedAuditEntry:
    """Create a test SignedAuditEntry, optionally computing the hash."""
    entry_dict = {
        "seq": seq,
        "timestamp": "2026-04-01T00:00:00Z",
        "action": action,
        "agent_did": "did:web:agent.example.com",
        "grant_id": "gnt_test",
        "scopes": ["read:contacts"],
        "result": "success",
        "metadata": {},
        "prev_hash": prev_hash,
    }
    entry_hash = compute_entry_hash(entry_dict) if compute else "badhash"
    return SignedAuditEntry(
        seq=seq,
        timestamp="2026-04-01T00:00:00Z",
        action=action,
        agent_did="did:web:agent.example.com",
        grant_id="gnt_test",
        scopes=["read:contacts"],
        result="success",
        metadata={},
        prev_hash=prev_hash,
        hash=entry_hash,
        signature="sig_placeholder",
    )


def test_compute_entry_hash_deterministic() -> None:
    """Same input should produce the same hash."""
    entry = {
        "seq": 1,
        "timestamp": "2026-04-01T00:00:00Z",
        "action": "test",
        "agent_did": "did:web:agent",
        "grant_id": "gnt_1",
        "scopes": ["a", "b"],
        "result": "success",
        "metadata": {"key": "val"},
        "prev_hash": "0" * 64,
    }
    h1 = compute_entry_hash(entry)
    h2 = compute_entry_hash(entry)
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex digest


def test_compute_entry_hash_changes_with_content() -> None:
    """Different content should produce different hashes."""
    entry1 = {
        "seq": 1,
        "timestamp": "2026-04-01T00:00:00Z",
        "action": "action_A",
        "agent_did": "did:web:agent",
        "grant_id": "gnt_1",
        "scopes": [],
        "result": "success",
        "metadata": {},
        "prev_hash": "0" * 64,
    }
    entry2 = {**entry1, "action": "action_B"}
    assert compute_entry_hash(entry1) != compute_entry_hash(entry2)


def test_verify_chain_valid() -> None:
    """A properly linked chain should verify."""
    e1 = _make_entry(1, "action1", "0" * 64)
    e2 = _make_entry(2, "action2", e1.hash)
    e3 = _make_entry(3, "action3", e2.hash)

    valid, broken_at = verify_chain([e1, e2, e3])
    assert valid is True
    assert broken_at is None


def test_verify_chain_detects_tampered_hash() -> None:
    """A chain with a wrong hash should be detected."""
    e1 = _make_entry(1, "action1", "0" * 64)
    e2_bad = _make_entry(2, "action2", e1.hash, compute=False)

    valid, broken_at = verify_chain([e1, e2_bad])
    assert valid is False
    assert broken_at == 1


def test_verify_chain_detects_broken_linkage() -> None:
    """A chain with broken prev_hash linkage should be detected."""
    e1 = _make_entry(1, "action1", "0" * 64)
    # e2 has correct hash but wrong prev_hash
    e2 = _make_entry(2, "action2", "wrong_prev_hash" + "0" * 50)

    valid, broken_at = verify_chain([e1, e2])
    assert valid is False
    assert broken_at == 1


def test_verify_chain_empty_raises() -> None:
    """Empty chain should raise HashChainError."""
    with pytest.raises(HashChainError, match="empty chain"):
        verify_chain([])


def test_verify_chain_single_entry() -> None:
    """Single-entry chain should verify."""
    e1 = _make_entry(1, "action1", "0" * 64)
    valid, broken_at = verify_chain([e1])
    assert valid is True
    assert broken_at is None
