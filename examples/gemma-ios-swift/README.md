# Gemma 4 iOS Agent with Grantex Offline Auth

A minimal iOS/macOS Swift project demonstrating Grantex offline authorization for a Gemma 4 on-device AI agent. The app verifies JWT grant tokens locally using Apple CryptoKit, stores consent bundles in the Keychain, and maintains a tamper-evident audit log with Ed25519 signatures — all without network connectivity at runtime.

## Why Offline Auth for iOS

Apple devices running Gemma 4 on-device (via Core ML or the Google AI Edge SDK) need authorization that works without a server round-trip. Consider the scenarios:

- **Apple Watch** running a health monitoring agent — frequently offline
- **iPad in a classroom** — managed device with restricted network access
- **iPhone in airplane mode** — user wants the agent to keep working
- **Mac with local LLM** — privacy-sensitive workloads that should not phone home

Grantex consent bundles package everything needed for offline authorization into a single artifact:

| Component | Purpose |
|-----------|---------|
| JWT grant token | Signed proof of what the agent is allowed to do |
| JWKS snapshot | Server's public keys for verifying the JWT locally |
| Ed25519 key pair | For signing audit entries without server involvement |
| Sync endpoint | Where to upload audit entries when connectivity returns |

The bundle is stored in the iOS Keychain (or macOS Keychain), which provides hardware-backed encryption on devices with a Secure Enclave.

## Architecture

```
┌──────────────────────────────────────────────────┐
│              iOS / macOS App                       │
│                                                    │
│  ┌───────────┐    ┌──────────────────────────┐    │
│  │  main.swift│───►│ Gemma Agent Logic         │    │
│  │           │    │                            │    │
│  │ setup()   │    │  ┌──────────────────────┐ │    │
│  │ run()     │    │  │  OfflineVerifier     │ │    │
│  │ sync()    │    │  │  (CryptoKit RSA)     │ │    │
│  └───────────┘    │  └──────────┬───────────┘ │    │
│                   │             │              │    │
│                   │  ┌──────────▼───────────┐ │    │
│                   │  │  Scope Enforcer      │ │    │
│                   │  └──────────┬───────────┘ │    │
│                   │             │              │    │
│                   │  ┌──────────▼───────────┐ │    │
│                   │  │  AuditLogger         │ │    │
│                   │  │  (Ed25519 + SHA-256) │ │    │
│                   │  └──────────────────────┘ │    │
│                   └──────────────────────────────┘  │
│                                                    │
│  ┌────────────────────────────────────────────┐   │
│  │  ConsentBundleManager                       │   │
│  │  Keychain (Secure Enclave on supported HW) │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
          │                          ▲
          │ Phase 1: Fetch bundle    │ Phase 3: Sync audit
          ▼                          │
    ┌──────────────┐
    │  Grantex API  │
    │  Cloud Server │
    └──────────────┘
```

## Project Structure

```
gemma-ios-swift/
  Package.swift                                    — SPM manifest
  Sources/GrantexGemmaExample/
    main.swift                                     — Entry point, drives the demo
    OfflineVerifier.swift                           — JWT verification with CryptoKit
    ConsentBundleManager.swift                     — Bundle storage in Keychain
    AuditLogger.swift                              — Hash-chained, Ed25519-signed audit log
  README.md                                        — This file
```

## Prerequisites

- **Xcode 15+**
- **macOS 14+ or iOS 17+** (for CryptoKit RSA support)
- **Swift 5.9+**
- A running Grantex instance (local via Docker or the hosted API)

## Setup

### 1. Open the project

```bash
cd examples/gemma-ios-swift
open Package.swift
```

Or from the command line:

```bash
swift build
swift run
```

### 2. Configure the Grantex endpoint

Edit the constants at the top of `main.swift`:

```swift
let grantexBaseURL = "http://localhost:3001"
let grantexAPIKey = "sandbox-api-key-local"
let agentId = "agent_gemma_ios_01"
let userId = "user_alice"
```

### 3. Start the local Grantex stack

From the repo root:

```bash
docker compose up -d
```

## How to Run

### As a macOS command-line tool

```bash
swift run GrantexGemmaExample
```

### In Xcode

Open `Package.swift` in Xcode, select the `GrantexGemmaExample` scheme, and click Run.

### Expected Output

```
══════════════════════════════════════════════════════
  Grantex Gemma Agent — iOS/macOS Example
══════════════════════════════════════════════════════

Phase 1: Creating consent bundle (online)...
──────────────────────────────────────────────────────
Bundle created successfully!
  Bundle ID: bndl_01JXXXXXXXXXXXXXXXXXXXXXX
  Expires:   2026-04-06T12:00:00.000Z
Bundle stored in Keychain

Phase 2: Running agent offline...
──────────────────────────────────────────────────────
Bundle loaded from Keychain
Grant verified offline:
  Agent:     agent_gemma_ios_01
  Principal: user_alice
  Scopes:    sensors:read, actuators:write, alerts:send
  Expires:   2026-04-06 12:00:00 +0000

Simulating smart home agent actions...
──────────────────────────────────────────────────────
[read_sensor] temp_living_room → temperature=22.5°C (OK)
[read_sensor] humidity_bedroom → humidity=45.2% (OK)
[control_actuator] thermostat set_temp:23 → thermostat set to 23°C (OK)
[send_alert] Humidity below threshold → alert sent (OK)
[control_actuator] door_lock unlock → front door unlocked (OK)

Testing scope violation...
──────────────────────────────────────────────────────
[delete_device] thermostat_main → DENIED: missing scope admin:delete

Audit Log Summary
──────────────────────────────────────────────────────
  #  | Action             | Result  | Hash (first 12)
  ---|--------------------|---------|-----------------
  1  | read_sensor        | success | a3f2b1c9d8e7
  2  | read_sensor        | success | 7b4e2a1f9c8d
  3  | control_actuator   | success | e5d4c3b2a1f0
  4  | send_alert         | success | 1a2b3c4d5e6f
  5  | control_actuator   | success | 9f8e7d6c5b4a
  6  | delete_device      | denied  | 3d2c1b0a9f8e

Hash chain: VALID (6 entries)
```

## How It Works

### Phase 1: Online Bundle Setup

The app calls the Grantex API to create a consent bundle, then stores it in the Keychain:

```swift
let bundle = try await ConsentBundleManager.fetchBundle(
    baseURL: grantexBaseURL,
    apiKey: grantexAPIKey,
    agentId: agentId,
    userId: userId,
    scopes: ["sensors:read", "actuators:write", "alerts:send"]
)
try ConsentBundleManager.store(bundle)
```

### Phase 2: Offline Agent Execution

The agent loads the bundle from the Keychain, verifies the JWT, and runs tools:

```swift
let bundle = try ConsentBundleManager.load()
let verifier = OfflineVerifier(jwksSnapshot: bundle.jwksSnapshot)
let grant = try verifier.verify(token: bundle.grantToken)

// Each tool checks scopes before executing
let result = readSensor("temp_01", grant: grant, auditLogger: logger)
```

### Phase 3: Online Sync

When connectivity returns, the accumulated audit entries are uploaded:

```swift
let entries = auditLogger.readEntries()
// POST entries to bundle.syncEndpoint
```

## Key Technical Details

### JWT Verification with CryptoKit

The `OfflineVerifier` uses Apple's CryptoKit and Security framework to verify RS256 JWTs:

1. Decode the JWT header to find the key ID (`kid`)
2. Look up the RSA public key in the JWKS snapshot
3. Verify the RS256 signature using `SecKeyVerifySignature`
4. Check expiry with clock skew tolerance
5. Extract Grantex claims (`scp`, `agt`, `sub`, `grnt`, `jti`)

### Keychain Storage

The `ConsentBundleManager` stores the bundle in the iOS/macOS Keychain with:
- `kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — encrypted at rest, tied to device
- `kSecAttrService: "dev.grantex.gemma"` — namespaced to avoid collisions
- The bundle JSON is stored as `kSecValueData`

### Ed25519 Audit Signatures

Each audit entry is signed using CryptoKit's `Curve25519.Signing`:

```swift
let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: keyBytes)
let signature = try privateKey.signature(for: hashData)
```

The signatures use the same Ed25519 algorithm as the Python and TypeScript implementations, ensuring cross-platform audit log verification.

## Dependencies

This project uses only Apple frameworks — no third-party dependencies:

| Framework | Purpose |
|-----------|---------|
| `Foundation` | JSON parsing, networking, file I/O |
| `CryptoKit` | SHA-256 hashing, Ed25519 signing |
| `Security` | RSA signature verification, Keychain storage |

## Notes

- This is a **command-line tool** for demonstration. In a real iOS app, you would integrate the same classes into a UIKit or SwiftUI view controller.
- The Keychain API is available on both iOS and macOS, so this code works on both platforms.
- For actual Gemma 4 inference on Apple hardware, you would use Core ML with the converted Gemma model.
- The audit log file is stored at `~/.grantex/audit.jsonl` (macOS) or in the app's documents directory (iOS).

## License

Apache-2.0
