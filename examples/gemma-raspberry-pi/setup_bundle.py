"""
Phase 1 — Online Setup: Create and store a consent bundle.

This script runs while the Raspberry Pi has internet connectivity.
It contacts the Grantex API to create a consent bundle containing:
  - A signed JWT grant token with the requested scopes
  - A JWKS snapshot for offline signature verification
  - An Ed25519 key pair for signing audit entries
  - Sync endpoint and expiry metadata

The bundle is encrypted with AES-256-GCM and written to disk.
After this, the agent can operate fully offline.

Usage:
    python setup_bundle.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from grantex_gemma import create_consent_bundle, store_bundle

# ── Configuration ────────────────────────────────────────────────────

load_dotenv()

API_KEY = os.environ.get("GRANTEX_API_KEY", "sandbox-api-key-local")
AGENT_ID = os.environ.get("GRANTEX_AGENT_ID", "agent_gemma_raspi_01")
USER_ID = os.environ.get("GRANTEX_USER_ID", "user_alice")
BASE_URL = os.environ.get("GRANTEX_URL", "http://localhost:3001")
ENCRYPTION_KEY = os.environ.get(
    "BUNDLE_ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

# Scopes for a smart home agent
SCOPES = [
    "sensors:read",       # Read temperature, humidity, motion sensors
    "actuators:write",    # Control thermostats, lights, locks
    "alerts:send",        # Send alerts and notifications
]

# Where to store the encrypted bundle
DATA_DIR = Path(__file__).parent / "data"
BUNDLE_PATH = str(DATA_DIR / "bundle.enc")


async def main() -> None:
    """Create a consent bundle and store it encrypted on disk."""

    print(f"[setup] Connecting to Grantex API at {BASE_URL}...")
    print(f"[setup] Creating consent bundle for {AGENT_ID}...")
    print(f"[setup]   Scopes: {', '.join(SCOPES)}")
    print(f"[setup]   Offline TTL: 72h")
    print()

    # ── Step 1: Create the consent bundle via the Grantex API ────────
    # This is the only network call. Everything after this is offline.
    try:
        bundle = await create_consent_bundle(
            api_key=API_KEY,
            agent_id=AGENT_ID,
            user_id=USER_ID,
            scopes=SCOPES,
            offline_ttl="72h",
            base_url=BASE_URL,
        )
    except Exception as exc:
        print(f"[setup] ERROR: Failed to create consent bundle: {exc}")
        print()
        print("  Make sure the Grantex stack is running:")
        print("    docker compose up -d   (from repo root)")
        print()
        print("  Or set GRANTEX_URL to your hosted API endpoint.")
        sys.exit(1)

    print("[setup] Bundle created successfully!")
    print(f"[setup]   Bundle ID: {bundle.bundle_id}")
    print(f"[setup]   Expires: {bundle.offline_expires_at}")
    print(f"[setup]   Sync endpoint: {bundle.sync_endpoint}")
    print()

    # ── Step 2: Encrypt and store the bundle locally ─────────────────
    # The bundle contains a private key and a signed JWT, so we encrypt
    # it at rest using AES-256-GCM. The encryption key should be stored
    # securely (e.g., in a hardware TPM on the Pi, or as an env var).
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    store_bundle(
        bundle=bundle,
        path=BUNDLE_PATH,
        encryption_key=ENCRYPTION_KEY,
    )

    print(f"[setup] Bundle encrypted and stored at {BUNDLE_PATH}")
    print("[setup] Done! The agent can now operate offline.")


if __name__ == "__main__":
    asyncio.run(main())
