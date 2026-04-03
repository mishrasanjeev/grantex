# Gemma 4 Smart Home Agent on Raspberry Pi

A complete Python example showing a Gemma 4 on-device AI agent running on a Raspberry Pi with Grantex offline authorization. The agent controls a simulated smart home system, verifying every tool invocation against a pre-fetched consent bundle — no internet connection required at runtime.

## Why Offline Authorization Matters

On-device AI agents like Gemma 4 run locally on edge hardware — a Raspberry Pi managing your smart home, a sensor hub in a warehouse, or an industrial controller on a factory floor. These devices often operate in environments with intermittent or no internet connectivity. Traditional authorization (call an API on every action) breaks down in these scenarios.

Grantex solves this with **consent bundles**: self-contained authorization packages that include everything a device needs to verify permissions offline:

- A signed JWT grant token with embedded scopes
- A JWKS snapshot for signature verification without network calls
- An Ed25519 key pair for signing tamper-evident audit entries
- A hash-chained audit log that can be verified for integrity even without connectivity

The three-phase lifecycle:

1. **Online (setup)**: Fetch a consent bundle from the Grantex API while the device has connectivity
2. **Offline (runtime)**: Verify tokens, enforce scopes, and log actions — all locally
3. **Online (sync)**: When connectivity returns, sync the accumulated audit log back to the cloud

## Architecture

```
                          ONLINE                    OFFLINE
                     ┌─────────────┐          ┌──────────────────┐
                     │  Grantex    │          │  Raspberry Pi 5  │
                     │  Cloud API  │          │                  │
                     │             │          │  ┌────────────┐  │
  setup_bundle.py ──►│ POST /v1/   │          │  │ Gemma 4    │  │
                     │ consent-    │──bundle──►│  │ Agent      │  │
                     │ bundles     │          │  └─────┬──────┘  │
                     │             │          │        │         │
                     │             │          │  ┌─────▼──────┐  │
                     │             │          │  │ Offline     │  │
                     │             │          │  │ Verifier    │  │
                     │             │          │  │ (JWT+JWKS)  │  │
                     │             │          │  └─────┬──────┘  │
                     │             │          │        │         │
                     │             │          │  ┌─────▼──────┐  │
  sync_audit.py  ◄───│  POST /v1/  │◄─entries─│  │ Audit Log  │  │
                     │  consent-   │          │  │ (JSONL +   │  │
                     │  bundles/   │          │  │  Ed25519)  │  │
                     │  :id/sync   │          │  └────────────┘  │
                     └─────────────┘          └──────────────────┘
```

## What This Example Does

The example simulates a smart home agent running on a Raspberry Pi. It:

1. **`setup_bundle.py`** — Connects to the Grantex API (online), creates a consent bundle with smart home scopes (`sensors:read`, `actuators:write`, `alerts:send`), and stores it encrypted on disk.

2. **`agent.py`** — Loads the stored consent bundle (no network needed), creates an offline verifier and audit log, then simulates the agent performing actions:
   - Reads temperature and humidity sensors (requires `sensors:read`)
   - Controls actuators like thermostats and lights (requires `actuators:write`)
   - Sends alerts when sensor values are out of range (requires `alerts:send`)
   - Demonstrates what happens when a scope is violated (caught and logged)
   - Prints a summary of all audit entries with hash chain status

3. **`sync_audit.py`** — When the Pi regains connectivity, syncs all accumulated audit entries to the Grantex cloud in batches.

4. **`verify_audit.py`** — Verifies the integrity of the local audit log by checking the hash chain. Detects any tampering with historical entries.

## Prerequisites

- **Raspberry Pi 5** (or any Linux ARM64/x86 machine)
- **Python 3.9+**
- **pip** (Python package manager)
- A running Grantex instance (local via `docker compose up` or the hosted API)

## Setup

### 1. Install dependencies

```bash
cd examples/gemma-raspberry-pi
pip install -r requirements.txt
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

For local development with the Docker stack:

```bash
# .env
GRANTEX_API_KEY=sandbox-api-key-local
GRANTEX_AGENT_ID=agent_gemma_raspi_01
GRANTEX_USER_ID=user_alice
GRANTEX_URL=http://localhost:3001
BUNDLE_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The `BUNDLE_ENCRYPTION_KEY` is a 64-character hex string (256-bit AES key) used to encrypt the consent bundle on disk. Generate one with:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 3. Start the local Grantex stack (if using Docker)

From the repo root:

```bash
docker compose up -d
```

## How to Run

### Phase 1: Create the consent bundle (online)

```bash
python setup_bundle.py
```

This connects to the Grantex API, creates a consent bundle with smart home scopes, and stores it encrypted at `./data/bundle.enc`. You only need to run this once (or when the bundle expires).

Expected output:

```
[setup] Connecting to Grantex API at http://localhost:3001...
[setup] Creating consent bundle for agent_gemma_raspi_01...
[setup]   Scopes: sensors:read, actuators:write, alerts:send
[setup]   Offline TTL: 72h
[setup] Bundle created successfully!
[setup]   Bundle ID: bndl_01JXXXXXXXXXXXXXXXXXXXXXX
[setup]   Expires: 2026-04-06T12:00:00.000Z
[setup]   Sync endpoint: http://localhost:3001/v1/consent-bundles/bndl_.../sync
[setup] Bundle encrypted and stored at ./data/bundle.enc
[setup] Done! The agent can now operate offline.
```

### Phase 2: Run the agent (offline)

```bash
python agent.py
```

This loads the encrypted bundle, verifies the grant token offline, and simulates the agent performing smart home actions. No network calls are made.

Expected output:

```
══════════════════════════════════════════════════════
  Grantex Gemma Smart Home Agent — Raspberry Pi
══════════════════════════════════════════════════════

[agent] Loading consent bundle from ./data/bundle.enc...
[agent] Bundle loaded (ID: bndl_01JXXXXXXXXXXXXXXXXXXXXXX)
[agent] Creating offline verifier...
[agent] Grant verified offline:
         Agent:     agent_gemma_raspi_01
         Principal: user_alice
         Scopes:    sensors:read, actuators:write, alerts:send
         Expires:   2026-04-06 12:00:00+00:00

──────────────────────────────────────────────────────
  Simulating smart home agent actions...
──────────────────────────────────────────────────────

[tool] read_sensor(sensor_id=temp_living_room)
       Scope check: sensors:read ... OK
       Result: temperature=22.5°C
       Audit entry #1 logged (action=read_sensor, result=success)

[tool] read_sensor(sensor_id=humidity_bedroom)
       Scope check: sensors:read ... OK
       Result: humidity=45.2%
       Audit entry #2 logged (action=read_sensor, result=success)

[tool] control_actuator(actuator_id=thermostat_main, action=set_temp:23)
       Scope check: actuators:write ... OK
       Result: thermostat set to 23°C
       Audit entry #3 logged (action=control_actuator, result=success)

[tool] send_alert(message=Humidity below threshold in bedroom)
       Scope check: alerts:send ... OK
       Result: alert sent
       Audit entry #4 logged (action=send_alert, result=success)

[tool] control_actuator(actuator_id=door_lock_front, action=unlock)
       Scope check: actuators:write ... OK
       Result: front door unlocked
       Audit entry #5 logged (action=control_actuator, result=success)

──────────────────────────────────────────────────────
  Testing scope violation...
──────────────────────────────────────────────────────

[tool] delete_device(device_id=thermostat_main)
       Scope check: admin:delete ... DENIED
       Missing scope: admin:delete
       Audit entry #6 logged (action=delete_device, result=denied)

──────────────────────────────────────────────────────
  Audit Log Summary
──────────────────────────────────────────────────────

  #  | Timestamp            | Action             | Result  | Hash (first 12)
  ---|----------------------|--------------------|---------|----------------
  1  | 2026-04-03T10:00:01  | read_sensor        | success | a3f2b1c9d8e7
  2  | 2026-04-03T10:00:02  | read_sensor        | success | 7b4e2a1f9c8d
  3  | 2026-04-03T10:00:03  | control_actuator   | success | e5d4c3b2a1f0
  4  | 2026-04-03T10:00:04  | send_alert         | success | 1a2b3c4d5e6f
  5  | 2026-04-03T10:00:05  | control_actuator   | success | 9f8e7d6c5b4a
  6  | 2026-04-03T10:00:06  | delete_device      | denied  | 3d2c1b0a9f8e

Hash chain integrity: VALID
Total entries: 6 (5 success, 1 denied)
```

### Phase 3: Sync audit log (online)

```bash
python sync_audit.py
```

When the Pi reconnects, this syncs all audit entries to the Grantex cloud.

### Verify audit integrity (anytime)

```bash
python verify_audit.py
```

This reads the local JSONL audit log and verifies the hash chain, checking that no entries have been tampered with.

## File Overview

| File | Purpose |
|------|---------|
| `setup_bundle.py` | Online: creates and stores a consent bundle |
| `agent.py` | Offline: loads bundle, verifies grant, runs tools with scope enforcement, logs audit |
| `sync_audit.py` | Online: syncs accumulated audit entries to Grantex cloud |
| `verify_audit.py` | Offline: verifies hash chain integrity of local audit log |
| `requirements.txt` | Python dependencies |
| `.env.example` | Environment variable template |

## How the Audit Hash Chain Works

Every audit entry includes a `prev_hash` field pointing to the hash of the previous entry, forming an immutable chain:

```
Entry #1                Entry #2                Entry #3
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ seq: 1       │       │ seq: 2       │       │ seq: 3       │
│ action: ...  │       │ action: ...  │       │ action: ...  │
│ prev_hash:   │──┐    │ prev_hash:   │──┐    │ prev_hash:   │
│  000...000   │  │    │  a3f2b1...   │  │    │  7b4e2a...   │
│ hash:        │  │    │ hash:        │  │    │ hash:        │
│  a3f2b1...  ◄┘──┘    │  7b4e2a...  ◄┘──┘    │  e5d4c3...   │
│ signature:   │       │ signature:   │       │ signature:   │
│  Ed25519     │       │  Ed25519     │       │  Ed25519     │
└──────────────┘       └──────────────┘       └──────────────┘
```

If anyone modifies entry #1 after the fact, its hash changes, which breaks the `prev_hash` link in entry #2. The `verify_audit.py` script detects this.

## License

Apache-2.0
