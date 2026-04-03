"""Hash chain utilities for audit log integrity."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ._errors import HashChainError
from ._types import SignedAuditEntry


def compute_entry_hash(entry: dict[str, Any]) -> str:
    """Compute SHA-256 hash of an audit entry's content fields.

    The hash covers seq, timestamp, action, agent_did, grant_id,
    scopes, result, metadata, and prev_hash — but NOT the hash
    or signature fields themselves.
    """
    canonical = {
        "seq": entry["seq"],
        "timestamp": entry["timestamp"],
        "action": entry["action"],
        "agent_did": entry["agent_did"],
        "grant_id": entry["grant_id"],
        "scopes": entry["scopes"],
        "result": entry["result"],
        "metadata": entry["metadata"],
        "prev_hash": entry["prev_hash"],
    }
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def verify_chain(
    entries: list[SignedAuditEntry],
) -> tuple[bool, int | None]:
    """Verify the integrity of a hash chain.

    Returns (True, None) if the chain is valid, or
    (False, index) where index is the first broken entry.

    Raises HashChainError if entries are empty.
    """
    if not entries:
        raise HashChainError("Cannot verify an empty chain")

    for i, entry in enumerate(entries):
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
        expected_hash = compute_entry_hash(entry_dict)
        if entry.hash != expected_hash:
            return (False, i)

        # Check prev_hash linkage (first entry should have
        # prev_hash == "0" * 64 or empty)
        if i > 0:
            if entry.prev_hash != entries[i - 1].hash:
                return (False, i)

    return (True, None)
