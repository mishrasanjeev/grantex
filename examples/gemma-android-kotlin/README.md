# Gemma 4 Android Agent with Grantex Offline Auth

A minimal Android project demonstrating how to integrate Grantex offline authorization with a Gemma 4 on-device agent running on Android. The app verifies grant tokens locally using a pre-fetched JWKS snapshot, enforces scopes on every tool invocation, and maintains a tamper-evident audit log — all without network connectivity.

## Why This Matters for Android

Gemma 4 runs on-device via the Google AI Edge SDK, meaning the model and agent logic execute entirely on the phone. But on-device execution creates a challenge: how do you authorize what the agent can do without calling a cloud API on every action?

Traditional approaches break down:
- **API-based auth**: Fails when the phone is in airplane mode, underground, or in a low-connectivity area
- **Hardcoded permissions**: No audit trail, no revocation, no user control
- **Token-only auth**: No way to verify the token signature without the server's public keys

Grantex consent bundles solve this by packaging everything the device needs for offline authorization:

1. **JWT grant token** — Signed by the Grantex server, contains the authorized scopes
2. **JWKS snapshot** — The server's public keys for verifying the JWT signature locally
3. **Ed25519 key pair** — For signing audit entries that can be verified later
4. **Sync metadata** — Where to upload audit entries when connectivity returns

The bundle is stored in `EncryptedSharedPreferences` (backed by Android Keystore), so it's protected at rest even on a rooted device.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Android App                       │
│                                                  │
│  ┌────────────┐    ┌─────────────────────────┐  │
│  │ MainActivity│───►│     GemmaAgent          │  │
│  │            │    │  ┌───────────────────┐  │  │
│  │ [Setup]    │    │  │ Offline Verifier  │  │  │
│  │ [Run]      │    │  │ (JWT + JWKS)      │  │  │
│  │ [Sync]     │    │  └────────┬──────────┘  │  │
│  └────────────┘    │           │              │  │
│                    │  ┌────────▼──────────┐  │  │
│                    │  │ Scope Enforcer    │  │  │
│                    │  │ (per-tool check)  │  │  │
│                    │  └────────┬──────────┘  │  │
│                    │           │              │  │
│                    │  ┌────────▼──────────┐  │  │
│                    │  │ Audit Logger      │  │  │
│                    │  │ (hash-chained)    │  │  │
│                    │  └──────────────────┘  │  │
│                    └─────────────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │       OfflineAuthManager                  │   │
│  │  EncryptedSharedPreferences (Keystore)    │   │
│  │  ┌──────────────────────────────────┐    │   │
│  │  │ consent_bundle.json (encrypted)  │    │   │
│  │  └──────────────────────────────────┘    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
         │                          ▲
         │  Phase 1: Fetch bundle   │  Phase 3: Sync audit
         ▼                          │
   ┌──────────────┐
   │  Grantex API  │
   │  Cloud Server │
   └──────────────┘
```

## Project Structure

```
gemma-android-kotlin/
  app/
    build.gradle.kts              — Dependencies and Android config
    src/main/java/dev/grantex/gemma/example/
      MainActivity.kt             — Entry point, drives the 3-phase flow
      GemmaAgent.kt               — Agent with scoped tools and audit logging
      OfflineAuthManager.kt       — Consent bundle lifecycle (encrypted storage)
      AuditLogger.kt              — Hash-chained, signed audit log for Android
  settings.gradle.kts             — Project settings
  README.md                       — This file
```

## Prerequisites

- **Android Studio Hedgehog (2023.1)** or later
- **Android SDK API 26+** (Android 8.0 Oreo minimum)
- **Kotlin 1.9+**
- A running Grantex instance (local via Docker or the hosted API)

## Setup

### 1. Open in Android Studio

Open the `gemma-android-kotlin/` directory as an Android project.

### 2. Configure the Grantex endpoint

Edit `MainActivity.kt` and update the constants at the top:

```kotlin
private const val GRANTEX_BASE_URL = "http://10.0.2.2:3001" // Android emulator → host
private const val GRANTEX_API_KEY = "sandbox-api-key-local"
private const val AGENT_ID = "agent_gemma_android_01"
private const val USER_ID = "user_alice"
```

Note: `10.0.2.2` is the special IP that routes from the Android emulator to your host machine's `localhost`.

### 3. Start the local Grantex stack

From the repo root:

```bash
docker compose up -d
```

### 4. Build and run

Click **Run** in Android Studio, or:

```bash
./gradlew installDebug
```

## How It Works

### Phase 1: Online Bundle Setup

When the user taps **Setup**, the app calls the Grantex API to create a consent bundle. The bundle is stored encrypted in `EncryptedSharedPreferences`, which uses the Android Keystore for key management.

```kotlin
val bundle = OfflineAuthManager.fetchAndStoreBundle(
    context = this,
    baseUrl = GRANTEX_BASE_URL,
    apiKey = GRANTEX_API_KEY,
    agentId = AGENT_ID,
    userId = USER_ID,
    scopes = listOf("sensors:read", "actuators:write", "alerts:send"),
)
```

### Phase 2: Offline Agent Execution

When the user taps **Run Agent**, the app loads the stored bundle and creates a `GemmaAgent`. The agent verifies the grant token using the embedded JWKS snapshot (no network), then executes tools with scope enforcement:

```kotlin
val agent = GemmaAgent(
    bundle = OfflineAuthManager.loadBundle(this),
    auditLogger = AuditLogger(this),
)

// Each tool checks its required scope before executing
agent.readSensor("temp_living_room")     // requires sensors:read
agent.controlActuator("thermostat", "set:23") // requires actuators:write
agent.sendAlert("High temperature")      // requires alerts:send
agent.deleteDevice("thermostat")         // requires admin:delete → DENIED
```

### Phase 3: Online Sync

When the user taps **Sync**, the app uploads all accumulated audit entries to the Grantex cloud. The server validates the hash chain and signatures.

## Key Integration Points

### JWT Verification Without Network

The `GemmaAgent` uses the Nimbus JOSE+JWT library to verify the grant token JWT against the JWKS snapshot stored in the bundle. This is the same RSA signature verification the server would do, but performed entirely on-device:

```kotlin
val jwkSet = JWKSet.parse(bundle.jwksSnapshot)
val key = jwkSet.getKeyByKeyId(jwt.header.keyID)
val verifier = RSASSAVerifier(key.toRSAKey())
jwt.verify(verifier)
```

### Scope Enforcement

Every tool invocation checks the JWT's `scp` claim against the tool's required scope. If the scope is missing, the tool returns an error and the attempt is logged as "denied":

```kotlin
if (!grant.scopes.contains(requiredScope)) {
    auditLogger.append(action = "read_sensor", result = "denied", ...)
    throw ScopeViolationException("Missing scope: $requiredScope")
}
```

### Tamper-Evident Audit Log

Each audit entry is:
1. SHA-256 hashed with the previous entry's hash (forming a chain)
2. Signed with the Ed25519 key from the consent bundle
3. Stored in a JSONL file in the app's internal storage

```
Entry #1 ──hash──► Entry #2 ──hash──► Entry #3
  sig: Ed25519       sig: Ed25519       sig: Ed25519
```

## Dependencies

| Library | Purpose |
|---------|---------|
| `com.nimbusds:nimbus-jose-jwt` | JWT parsing and RSA signature verification |
| `androidx.security:security-crypto` | EncryptedSharedPreferences for bundle storage |
| `org.bouncycastle:bcprov-jdk18on` | Ed25519 signing for audit entries |
| `com.squareup.okhttp3:okhttp` | HTTP client for bundle fetch and audit sync |
| `org.json:json` | JSON parsing (Android built-in) |

## Notes

- This is a **structural example** showing the integration pattern. In production, you would integrate with the Google AI Edge SDK for actual Gemma 4 inference.
- The `EncryptedSharedPreferences` approach is suitable for bundles up to a few hundred KB. For larger bundles, consider `EncryptedFile`.
- The audit log is stored at `context.filesDir/grantex/audit.jsonl`. It persists across app restarts.
- Clock skew tolerance is set to 60 seconds by default. Adjust for devices with unreliable clocks.

## License

Apache-2.0
