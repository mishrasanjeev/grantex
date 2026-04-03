"""
Audit Integrity Verifier — Check the hash chain of the local audit log.

This script reads the JSONL audit log and verifies that:
  1. Every entry's SHA-256 hash matches its contents
  2. Every entry's prev_hash matches the previous entry's hash
  3. The chain is unbroken from the genesis entry to the latest

If any entry has been modified, inserted, or deleted after the fact,
the hash chain will be broken and this script will report the exact
entry where the break occurred.

This can run offline — no network call is needed.

Usage:
    python verify_audit.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from grantex_gemma import SignedAuditEntry, compute_entry_hash, verify_chain


AUDIT_LOG_PATH = str(Path(__file__).parent / "data" / "audit.jsonl")


def main() -> None:
    """Verify the integrity of the local audit log hash chain."""

    print("=" * 54)
    print("  Grantex Audit Log Integrity Verifier")
    print("=" * 54)
    print()

    # ── Load entries ─────────────────────────────────────────────
    log_path = Path(AUDIT_LOG_PATH)
    if not log_path.exists():
        print(f"[verify] No audit log found at {AUDIT_LOG_PATH}")
        print("         Run agent.py first to generate audit entries.")
        sys.exit(1)

    entries: list[SignedAuditEntry] = []
    raw_entries: list[dict] = []

    with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                data = json.loads(stripped)
                raw_entries.append(data)
                entries.append(SignedAuditEntry(**data))
            except (json.JSONDecodeError, TypeError) as exc:
                print(f"[verify] ERROR: Malformed entry on line {line_num}: {exc}")
                sys.exit(1)

    if not entries:
        print("[verify] Audit log is empty. Nothing to verify.")
        return

    print(f"[verify] Loaded {len(entries)} entries from {AUDIT_LOG_PATH}")
    print()

    # ── Verify individual entry hashes ───────────────────────────
    print("[verify] Checking individual entry hashes...")
    hash_errors = 0
    for i, (entry, raw) in enumerate(zip(entries, raw_entries)):
        # Recompute the hash from the entry's content fields
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
            print(f"  Entry #{entry.seq}: HASH MISMATCH")
            print(f"    Stored:   {entry.hash}")
            print(f"    Expected: {expected_hash}")
            hash_errors += 1
        else:
            print(f"  Entry #{entry.seq}: OK")

    print()

    # ── Verify hash chain linkage ────────────────────────────────
    print("[verify] Checking hash chain linkage...")

    valid, broken_at = verify_chain(entries)

    if valid:
        print("  Chain is VALID — all entries are linked correctly.")
    else:
        print(f"  Chain is BROKEN at entry index {broken_at}")
        if broken_at is not None and broken_at < len(entries):
            broken_entry = entries[broken_at]
            if broken_at > 0:
                prev_entry = entries[broken_at - 1]
                print(f"    Entry #{broken_entry.seq} prev_hash: {broken_entry.prev_hash[:24]}...")
                print(f"    Entry #{prev_entry.seq} hash:       {prev_entry.hash[:24]}...")
            else:
                print(f"    Entry #{broken_entry.seq} has an unexpected hash")

    print()

    # ── Summary ──────────────────────────────────────────────────
    print("-" * 54)
    print("  Verification Summary")
    print("-" * 54)
    print(f"  Total entries:    {len(entries)}")
    print(f"  Hash mismatches:  {hash_errors}")
    print(f"  Chain integrity:  {'VALID' if valid else 'BROKEN'}")
    print()

    if entries:
        first = entries[0]
        last = entries[-1]
        print(f"  First entry:  seq={first.seq}, time={first.timestamp[:19]}")
        print(f"  Last entry:   seq={last.seq}, time={last.timestamp[:19]}")
        print(f"  Agent DID:    {last.agent_did}")
        print(f"  Grant ID:     {last.grant_id}")

    print()

    # ── Action counts ────────────────────────────────────────────
    action_counts: dict[str, int] = {}
    result_counts: dict[str, int] = {}
    for entry in entries:
        action_counts[entry.action] = action_counts.get(entry.action, 0) + 1
        result_counts[entry.result] = result_counts.get(entry.result, 0) + 1

    print("  Actions:")
    for action, count in sorted(action_counts.items()):
        print(f"    {action}: {count}")

    print()
    print("  Results:")
    for result, count in sorted(result_counts.items()):
        print(f"    {result}: {count}")

    print()

    if hash_errors > 0 or not valid:
        print("  INTEGRITY CHECK FAILED")
        print("  The audit log may have been tampered with.")
        sys.exit(1)
    else:
        print("  INTEGRITY CHECK PASSED")
        print("  All entries are authentic and unmodified.")


if __name__ == "__main__":
    main()
