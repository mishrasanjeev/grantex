"""
Phase 2 — Offline Agent: Smart home agent with Grantex offline authorization.

This is the main agent script that runs on the Raspberry Pi without internet.
It loads a previously-stored consent bundle, verifies the grant token offline,
and simulates a Gemma 4 smart home agent performing actions with scope
enforcement and tamper-evident audit logging.

Every tool invocation:
  1. Checks the required scope against the verified grant
  2. Executes the tool (simulated sensor/actuator interaction)
  3. Logs the action to a hash-chained, Ed25519-signed audit file

No network calls are made during this entire script.

Usage:
    python agent.py
"""

from __future__ import annotations

import asyncio
import json
import os
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from grantex_gemma import (
    ScopeViolationError,
    SignedAuditEntry,
    VerifiedGrant,
    create_offline_audit_log,
    create_offline_verifier,
    has_scope,
    load_bundle,
    verify_chain,
)

# ── Configuration ────────────────────────────────────────────────────

load_dotenv()

ENCRYPTION_KEY = os.environ.get(
    "BUNDLE_ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

DATA_DIR = Path(__file__).parent / "data"
BUNDLE_PATH = str(DATA_DIR / "bundle.enc")
AUDIT_LOG_PATH = str(DATA_DIR / "audit.jsonl")

# ── Simulated Sensor Data ────────────────────────────────────────────
# In a real deployment, these would read from GPIO, I2C, or MQTT.

SENSOR_DATA: dict[str, dict[str, Any]] = {
    "temp_living_room": {"type": "temperature", "value": 22.5, "unit": "°C"},
    "temp_kitchen": {"type": "temperature", "value": 24.1, "unit": "°C"},
    "humidity_bedroom": {"type": "humidity", "value": 45.2, "unit": "%"},
    "motion_hallway": {"type": "motion", "value": True, "unit": "bool"},
    "light_level_patio": {"type": "light", "value": 340, "unit": "lux"},
}

ACTUATOR_STATE: dict[str, str] = {
    "thermostat_main": "22°C",
    "light_living_room": "on",
    "light_bedroom": "off",
    "door_lock_front": "locked",
    "fan_kitchen": "off",
}


# ── Tool Definitions ─────────────────────────────────────────────────
# Each tool verifies its required scope before executing and logs an
# audit entry regardless of success or failure.


async def read_sensor(
    sensor_id: str,
    grant: VerifiedGrant,
    audit_log: Any,
) -> str:
    """Read a sensor value. Requires the 'sensors:read' scope.

    Args:
        sensor_id: Identifier of the sensor to read.
        grant: The verified grant from offline verification.
        audit_log: The offline audit log for recording actions.

    Returns:
        A human-readable string with the sensor reading.
    """
    required_scope = "sensors:read"
    print(f"\n[tool] read_sensor(sensor_id={sensor_id})")

    # ── Scope enforcement ────────────────────────────────────────
    if not has_scope(grant.scopes, required_scope):
        print(f"       Scope check: {required_scope} ... DENIED")
        print(f"       Missing scope: {required_scope}")
        await audit_log.append(
            action="read_sensor",
            grant=grant,
            result="denied",
            metadata={"sensor_id": sensor_id, "reason": f"missing scope: {required_scope}"},
        )
        return f"DENIED: missing scope {required_scope}"

    print(f"       Scope check: {required_scope} ... OK")

    # ── Execute the tool ─────────────────────────────────────────
    sensor = SENSOR_DATA.get(sensor_id)
    if sensor is None:
        result_str = f"sensor {sensor_id} not found"
        await audit_log.append(
            action="read_sensor",
            grant=grant,
            result="error",
            metadata={"sensor_id": sensor_id, "error": "not_found"},
        )
        print(f"       Result: {result_str}")
        return result_str

    result_str = f"{sensor['type']}={sensor['value']}{sensor['unit']}"
    print(f"       Result: {result_str}")

    # ── Log the action ───────────────────────────────────────────
    entry = await audit_log.append(
        action="read_sensor",
        grant=grant,
        result="success",
        metadata={"sensor_id": sensor_id, "reading": sensor["value"]},
    )
    print(f"       Audit entry #{entry.seq} logged (action=read_sensor, result=success)")

    return result_str


async def control_actuator(
    actuator_id: str,
    action: str,
    grant: VerifiedGrant,
    audit_log: Any,
) -> str:
    """Control an actuator. Requires the 'actuators:write' scope.

    Args:
        actuator_id: Identifier of the actuator to control.
        action: The action to perform (e.g., 'set_temp:23', 'unlock').
        grant: The verified grant from offline verification.
        audit_log: The offline audit log for recording actions.

    Returns:
        A human-readable string with the action result.
    """
    required_scope = "actuators:write"
    print(f"\n[tool] control_actuator(actuator_id={actuator_id}, action={action})")

    # ── Scope enforcement ────────────────────────────────────────
    if not has_scope(grant.scopes, required_scope):
        print(f"       Scope check: {required_scope} ... DENIED")
        print(f"       Missing scope: {required_scope}")
        await audit_log.append(
            action="control_actuator",
            grant=grant,
            result="denied",
            metadata={
                "actuator_id": actuator_id,
                "requested_action": action,
                "reason": f"missing scope: {required_scope}",
            },
        )
        return f"DENIED: missing scope {required_scope}"

    print(f"       Scope check: {required_scope} ... OK")

    # ── Execute the tool ─────────────────────────────────────────
    if actuator_id not in ACTUATOR_STATE:
        result_str = f"actuator {actuator_id} not found"
        await audit_log.append(
            action="control_actuator",
            grant=grant,
            result="error",
            metadata={"actuator_id": actuator_id, "error": "not_found"},
        )
        print(f"       Result: {result_str}")
        return result_str

    # Parse action like "set_temp:23" or "unlock"
    if ":" in action:
        cmd, value = action.split(":", 1)
    else:
        cmd, value = action, ""

    # Simulate actuator responses
    result_map: dict[str, str] = {
        "set_temp": f"thermostat set to {value}°C",
        "on": f"{actuator_id} turned on",
        "off": f"{actuator_id} turned off",
        "lock": f"{actuator_id.replace('_', ' ')} locked",
        "unlock": f"{actuator_id.replace('_', ' ')} unlocked",
    }
    result_str = result_map.get(cmd, f"{actuator_id}: {action} executed")
    ACTUATOR_STATE[actuator_id] = action

    print(f"       Result: {result_str}")

    # ── Log the action ───────────────────────────────────────────
    entry = await audit_log.append(
        action="control_actuator",
        grant=grant,
        result="success",
        metadata={"actuator_id": actuator_id, "command": action},
    )
    print(f"       Audit entry #{entry.seq} logged (action=control_actuator, result=success)")

    return result_str


async def send_alert(
    message: str,
    grant: VerifiedGrant,
    audit_log: Any,
) -> str:
    """Send an alert notification. Requires the 'alerts:send' scope.

    Args:
        message: The alert message to send.
        grant: The verified grant from offline verification.
        audit_log: The offline audit log for recording actions.

    Returns:
        A confirmation string.
    """
    required_scope = "alerts:send"
    print(f"\n[tool] send_alert(message={message})")

    # ── Scope enforcement ────────────────────────────────────────
    if not has_scope(grant.scopes, required_scope):
        print(f"       Scope check: {required_scope} ... DENIED")
        print(f"       Missing scope: {required_scope}")
        await audit_log.append(
            action="send_alert",
            grant=grant,
            result="denied",
            metadata={"message": message, "reason": f"missing scope: {required_scope}"},
        )
        return f"DENIED: missing scope {required_scope}"

    print(f"       Scope check: {required_scope} ... OK")

    # ── Execute the tool ─────────────────────────────────────────
    # In production, this would push to MQTT, NTFY, Pushover, etc.
    result_str = "alert sent"
    print(f"       Result: {result_str}")

    # ── Log the action ───────────────────────────────────────────
    entry = await audit_log.append(
        action="send_alert",
        grant=grant,
        result="success",
        metadata={"message": message},
    )
    print(f"       Audit entry #{entry.seq} logged (action=send_alert, result=success)")

    return result_str


async def attempt_unauthorized_action(
    device_id: str,
    grant: VerifiedGrant,
    audit_log: Any,
) -> str:
    """Attempt an action that requires a scope the agent does not have.

    This demonstrates scope enforcement: the agent has sensors:read,
    actuators:write, and alerts:send — but NOT admin:delete.

    Args:
        device_id: Device to attempt deletion on.
        grant: The verified grant from offline verification.
        audit_log: The offline audit log for recording actions.

    Returns:
        A denial message.
    """
    required_scope = "admin:delete"
    print(f"\n[tool] delete_device(device_id={device_id})")

    # ── Scope enforcement — this will fail ───────────────────────
    if not has_scope(grant.scopes, required_scope):
        print(f"       Scope check: {required_scope} ... DENIED")
        print(f"       Missing scope: {required_scope}")

        entry = await audit_log.append(
            action="delete_device",
            grant=grant,
            result="denied",
            metadata={
                "device_id": device_id,
                "reason": f"missing scope: {required_scope}",
            },
        )
        print(f"       Audit entry #{entry.seq} logged (action=delete_device, result=denied)")

        return f"DENIED: missing scope {required_scope}"

    # This line should never be reached
    return "deleted"


def print_audit_summary(entries: list[SignedAuditEntry]) -> None:
    """Print a formatted summary table of all audit entries."""
    print()
    print("  #  | Timestamp            | Action             | Result  | Hash (first 12)")
    print("  ---|----------------------|--------------------|---------|----------------")
    for entry in entries:
        ts = entry.timestamp[:19]  # Trim to seconds
        action = entry.action.ljust(18)
        result = entry.result.ljust(7)
        hash_short = entry.hash[:12]
        print(f"  {entry.seq:<2} | {ts} | {action} | {result} | {hash_short}")


async def main() -> None:
    """Run the smart home agent with offline authorization."""

    print("=" * 54)
    print("  Grantex Gemma Smart Home Agent — Raspberry Pi")
    print("=" * 54)
    print()

    # ── Load the consent bundle ──────────────────────────────────
    # This reads the encrypted file from disk and decrypts it.
    # No network call is made.
    print(f"[agent] Loading consent bundle from {BUNDLE_PATH}...")

    if not Path(BUNDLE_PATH).exists():
        print(f"[agent] ERROR: Bundle file not found at {BUNDLE_PATH}")
        print("        Run setup_bundle.py first to create the bundle.")
        return

    bundle = load_bundle(
        path=BUNDLE_PATH,
        encryption_key=ENCRYPTION_KEY,
    )
    print(f"[agent] Bundle loaded (ID: {bundle.bundle_id})")

    # ── Create the offline verifier ──────────────────────────────
    # The verifier uses the JWKS snapshot from the bundle to verify
    # the JWT signature without any network call.
    print("[agent] Creating offline verifier...")

    verifier = create_offline_verifier(
        jwks_snapshot=bundle.jwks_snapshot,
        clock_skew_seconds=60,  # Allow 1 minute of clock drift
    )

    # ── Verify the grant token offline ───────────────────────────
    # This validates the JWT signature, checks expiry, and extracts
    # the scopes — all using the pre-fetched JWKS keys.
    grant = await verifier.verify(bundle.grant_token)

    print("[agent] Grant verified offline:")
    print(f"         Agent:     {grant.agent_did}")
    print(f"         Principal: {grant.principal_did}")
    print(f"         Scopes:    {', '.join(grant.scopes)}")
    print(f"         Expires:   {grant.expires_at}")

    # ── Create the offline audit log ─────────────────────────────
    # Every action is logged to a JSONL file on disk. Each entry is
    # Ed25519-signed and hash-chained to prevent tampering.
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    audit_log = create_offline_audit_log(
        signing_key=bundle.offline_audit_key,
        log_path=AUDIT_LOG_PATH,
        max_size_mb=10,
    )

    # ── Simulate the agent performing actions ────────────────────
    print()
    print("-" * 54)
    print("  Simulating smart home agent actions...")
    print("-" * 54)

    # Action 1: Read the living room temperature
    await read_sensor("temp_living_room", grant, audit_log)

    # Action 2: Read bedroom humidity
    await read_sensor("humidity_bedroom", grant, audit_log)

    # Action 3: Adjust the thermostat
    await control_actuator("thermostat_main", "set_temp:23", grant, audit_log)

    # Action 4: Send an alert about low humidity
    await send_alert("Humidity below threshold in bedroom", grant, audit_log)

    # Action 5: Unlock the front door (legitimate action)
    await control_actuator("door_lock_front", "unlock", grant, audit_log)

    # ── Test scope violation ─────────────────────────────────────
    print()
    print("-" * 54)
    print("  Testing scope violation...")
    print("-" * 54)

    # Action 6: Try to delete a device — this should be DENIED
    # The agent has sensors:read, actuators:write, alerts:send
    # but NOT admin:delete
    await attempt_unauthorized_action("thermostat_main", grant, audit_log)

    # ── Print audit summary ──────────────────────────────────────
    print()
    print("-" * 54)
    print("  Audit Log Summary")
    print("-" * 54)

    # Read all entries from the JSONL log file and display them
    entries: list[SignedAuditEntry] = []
    if Path(AUDIT_LOG_PATH).exists():
        with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    data = json.loads(stripped)
                    entries.append(SignedAuditEntry(**data))

    print_audit_summary(entries)

    # ── Verify hash chain integrity ──────────────────────────────
    if entries:
        valid, broken_at = verify_chain(entries)
        if valid:
            print(f"\nHash chain integrity: VALID")
        else:
            print(f"\nHash chain integrity: BROKEN at entry #{broken_at}")

        success_count = sum(1 for e in entries if e.result == "success")
        denied_count = sum(1 for e in entries if e.result == "denied")
        error_count = sum(1 for e in entries if e.result == "error")

        parts = []
        if success_count:
            parts.append(f"{success_count} success")
        if denied_count:
            parts.append(f"{denied_count} denied")
        if error_count:
            parts.append(f"{error_count} error")
        print(f"Total entries: {len(entries)} ({', '.join(parts)})")

    print()


if __name__ == "__main__":
    asyncio.run(main())
