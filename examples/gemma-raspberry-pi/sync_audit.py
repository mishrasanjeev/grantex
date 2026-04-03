"""
Phase 3 — Online Sync: Upload accumulated audit entries to the Grantex cloud.

When the Raspberry Pi regains internet connectivity, this script reads the
local JSONL audit log and syncs all entries to the Grantex cloud API. The
server validates the hash chain and Ed25519 signatures, ensuring the entries
have not been tampered with while the device was offline.

The sync endpoint also returns the current revocation status of the grant.
If the grant has been revoked (e.g., the user revoked access from the
Grantex portal), the agent should stop operating and delete the local bundle.

Usage:
    python sync_audit.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from grantex_gemma import (
    create_offline_audit_log,
    load_bundle,
)

# ── Configuration ────────────────────────────────────────────────────

load_dotenv()

API_KEY = os.environ.get("GRANTEX_API_KEY", "sandbox-api-key-local")
ENCRYPTION_KEY = os.environ.get(
    "BUNDLE_ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

DATA_DIR = Path(__file__).parent / "data"
BUNDLE_PATH = str(DATA_DIR / "bundle.enc")
AUDIT_LOG_PATH = str(DATA_DIR / "audit.jsonl")


async def main() -> None:
    """Sync the offline audit log to the Grantex cloud."""

    print("=" * 54)
    print("  Grantex Audit Sync — Raspberry Pi")
    print("=" * 54)
    print()

    # ── Check prerequisites ──────────────────────────────────────
    if not Path(BUNDLE_PATH).exists():
        print("[sync] ERROR: No bundle found. Run setup_bundle.py first.")
        sys.exit(1)

    if not Path(AUDIT_LOG_PATH).exists():
        print("[sync] No audit log found. Nothing to sync.")
        print("[sync] Run agent.py first to generate audit entries.")
        return

    # ── Load the bundle to get sync endpoint and bundle ID ───────
    print("[sync] Loading consent bundle...")
    bundle = load_bundle(
        path=BUNDLE_PATH,
        encryption_key=ENCRYPTION_KEY,
    )
    print(f"[sync] Bundle ID: {bundle.bundle_id}")
    print(f"[sync] Sync endpoint: {bundle.sync_endpoint}")
    print()

    # ── Create the audit log instance to access the sync method ──
    audit_log = create_offline_audit_log(
        signing_key=bundle.offline_audit_key,
        log_path=AUDIT_LOG_PATH,
    )

    # ── Count entries to sync ────────────────────────────────────
    entry_count = 0
    with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                entry_count += 1

    if entry_count == 0:
        print("[sync] Audit log is empty. Nothing to sync.")
        return

    print(f"[sync] Found {entry_count} audit entries to sync.")
    print("[sync] Uploading to Grantex cloud...")
    print()

    # ── Sync in batches ──────────────────────────────────────────
    # The sync method POSTs entries in configurable batch sizes.
    # The server validates each entry's hash and signature.
    try:
        result = await audit_log.sync(
            endpoint=bundle.sync_endpoint,
            api_key=API_KEY,
            bundle_id=bundle.bundle_id,
            batch_size=100,
        )
    except Exception as exc:
        print(f"[sync] ERROR: Sync failed: {exc}")
        print()
        print("  Make sure the Grantex stack is running and reachable.")
        print("  The audit entries are still safely stored locally.")
        sys.exit(1)

    # ── Report results ───────────────────────────────────────────
    print("[sync] Sync complete!")
    print(f"  Accepted: {result.accepted}")
    print(f"  Rejected: {result.rejected}")
    print(f"  Revocation status: {result.revocation_status}")

    if result.revocation_status == "revoked":
        print()
        print("  WARNING: The grant has been revoked!")
        print("  The agent should stop operating and delete the local bundle.")
        print("  The user may have revoked access from the Grantex portal.")

    if result.new_bundle is not None:
        print()
        print("  A refreshed bundle was returned by the server.")
        print("  Storing the new bundle...")
        from grantex_gemma import store_bundle

        store_bundle(
            bundle=result.new_bundle,
            path=BUNDLE_PATH,
            encryption_key=ENCRYPTION_KEY,
        )
        print(f"  New bundle stored at {BUNDLE_PATH}")
        print(f"  New expiry: {result.new_bundle.offline_expires_at}")

    print()
    print("[sync] Done!")


if __name__ == "__main__":
    asyncio.run(main())
