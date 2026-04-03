# @grantex/gemma

Offline authorization adapter for Google Gemma on-device AI agents -- issue consent bundles online, verify grant tokens and enforce scopes entirely offline, and sync tamper-evident audit logs back to Grantex cloud when connectivity returns.

[![npm version](https://img.shields.io/npm/v/@grantex/gemma.svg)](https://www.npmjs.com/package/@grantex/gemma)
[![License](https://img.shields.io/npm/l/@grantex/gemma)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@grantex/gemma)](https://www.npmjs.com/package/@grantex/gemma)
[![Tests](https://img.shields.io/github/actions/workflow/status/mishrasanjeev/grantex/ci.yml?label=tests)](https://github.com/mishrasanjeev/grantex/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev/sdks/gemma)** | **[API Reference](https://docs.grantex.dev/api-reference)** | **[GitHub](https://github.com/mishrasanjeev/grantex)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)**

---

## What is @grantex/gemma?

[Google Gemma 4](https://ai.google.dev/gemma) is a family of lightweight, open-weight models designed to run directly on edge devices -- phones, Raspberry Pis, Jetson boards, and embedded hardware. When an AI agent built on Gemma operates in the field, it often loses internet connectivity for hours or days at a time. Traditional cloud-based authorization (OAuth 2.0, API-key checks) simply stops working the moment the network drops.

`@grantex/gemma` solves this by bringing the [Grantex](https://grantex.dev) delegated authorization protocol to offline environments. While the device is still online, it fetches a **consent bundle** -- a self-contained package containing a signed grant token, a JWKS snapshot for signature verification, and an Ed25519 key pair for audit signing. Once offline, the agent verifies tokens, enforces scopes, and logs every action to a tamper-evident, hash-chained audit log -- all without a single network call.

The lifecycle follows **three phases**: (1) **Online bundle issue** -- fetch the consent bundle and persist it with AES-256-GCM encryption, (2) **Offline verify + audit** -- verify JWTs, enforce scopes, and sign audit entries locally, and (3) **Sync** -- when connectivity returns, upload the audit log to the Grantex cloud with batched retry. This package also ships framework adapters for Google ADK and LangChain, so you can wrap any tool with offline authorization in a single function call.

---

## Installation

```bash
npm install @grantex/gemma
```

```bash
yarn add @grantex/gemma
```

```bash
pnpm add @grantex/gemma
```

---

## Quick Start

### Phase 1 -- Online: Issue a Consent Bundle

```typescript
import { createConsentBundle, storeBundle } from '@grantex/gemma';

// While the device is online, request a consent bundle from Grantex
const bundle = await createConsentBundle({
  apiKey: process.env.GRANTEX_API_KEY!,
  agentId: 'agent_gemma_01',
  userId: 'user_alice',
  scopes: ['calendar:read', 'email:send'],
  offlineTTL: '72h', // bundle is valid for 72 hours offline
});

// Persist the bundle to encrypted local storage (AES-256-GCM)
await storeBundle(bundle, '/data/grantex/bundle.enc', process.env.ENCRYPTION_KEY!);
```

### Phase 2 -- Offline: Verify Tokens and Log Actions

```typescript
import {
  loadBundle,
  createOfflineVerifier,
  createOfflineAuditLog,
  enforceScopes,
} from '@grantex/gemma';

// Load the bundle from encrypted storage
const bundle = await loadBundle('/data/grantex/bundle.enc', process.env.ENCRYPTION_KEY!);

// Create the offline verifier using the embedded JWKS snapshot
const verifier = createOfflineVerifier({
  jwksSnapshot: bundle.jwksSnapshot,
  requireScopes: ['calendar:read'],
  maxDelegationDepth: 2,
});

// Verify the grant token entirely on-device -- no network call
const grant = await verifier.verify(bundle.grantToken);
console.log(grant.agentDID, grant.scopes, grant.expiresAt);

// Create a hash-chained, Ed25519-signed offline audit log
const auditLog = createOfflineAuditLog({
  signingKey: bundle.offlineAuditKey,
  logPath: '/data/grantex/audit.jsonl',
});

// Log every action the agent performs
await auditLog.append({
  action: 'tool:read_calendar',
  agentDID: grant.agentDID,
  grantId: grant.grantId,
  scopes: grant.scopes,
  result: 'success',
  metadata: { eventCount: 5 },
});
```

### Phase 3 -- Online: Sync Audit Log

```typescript
import { syncAuditLog } from '@grantex/gemma';

// When connectivity returns, sync all un-uploaded entries
const result = await syncAuditLog(auditLog, {
  endpoint: bundle.syncEndpoint,
  apiKey: process.env.GRANTEX_API_KEY!,
  bundleId: bundle.bundleId,
  batchSize: 100, // entries per HTTP request
});

console.log(`Synced ${result.syncedCount} entries`);
if (result.hasErrors) console.error(result.errors);
```

---

## Architecture

```
  ONLINE (Phase 1)                OFFLINE (Phase 2)              ONLINE (Phase 3)
  ─────────────────               ─────────────────              ─────────────────
  Grantex Cloud                   On-Device (Gemma 4)            Grantex Cloud
  ┌──────────────┐                ┌──────────────────┐           ┌──────────────┐
  │ POST /v1/    │  consent       │ loadBundle()      │  sync    │ POST /v1/    │
  │ consent-     │  bundle        │   ▼ JWKS Snapshot  │  audit   │ audit/       │
  │ bundles      │ ──────────►    │   ▼ verify(token)  │ ──────►  │ offline-sync │
  └──────────────┘                │   ▼ enforceScopes()│          └──────────────┘
       AES-256-GCM ◄──────────   │   ▼ auditLog       │
       encrypted on disk          │   ▼ Hash-Chained   │
                                  │     (.jsonl)       │
                                  └──────────────────┘
```

---

## API Reference

### Verifier

#### `createOfflineVerifier(options): OfflineVerifier`

Create an offline JWT verifier that validates Grantex grant tokens using a pre-fetched JWKS snapshot. No network call is made during verification.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `jwksSnapshot` | `JWKSSnapshot` | **required** | Pre-fetched JWKS keys from the consent bundle |
| `clockSkewSeconds` | `number` | `30` | Clock skew tolerance in seconds |
| `requireScopes` | `string[]` | -- | Scopes that must be present in every verified token |
| `maxDelegationDepth` | `number` | -- | Maximum delegation chain depth (inclusive) |
| `onScopeViolation` | `'throw' \| 'log'` | `'throw'` | Behaviour when a scope check fails |

**Returns** an `OfflineVerifier` with a single method:

- **`verify(token: string): Promise<VerifiedGrant>`** -- verify a JWT and return the decoded grant.

**`VerifiedGrant` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `agentDID` | `string` | Agent's DID (`agt` JWT claim) |
| `principalDID` | `string` | User who authorized the grant (`sub` claim) |
| `scopes` | `string[]` | Granted scopes (`scp` claim) |
| `expiresAt` | `Date` | Token expiry |
| `jti` | `string` | Unique token ID (`jti` claim) |
| `grantId` | `string` | Grant record ID (`grnt` claim, falls back to `jti`) |
| `depth` | `number` | Delegation depth (0 = root grant) |

**Example:**

```typescript
const verifier = createOfflineVerifier({
  jwksSnapshot: bundle.jwksSnapshot,
  requireScopes: ['files:read'],
  clockSkewSeconds: 60,
  maxDelegationDepth: 3,
});

const grant = await verifier.verify(bundle.grantToken);
console.log(grant.agentDID);   // 'did:web:agent.example'
console.log(grant.scopes);     // ['files:read', 'files:write']
console.log(grant.grantId);    // 'grnt_01J...'
```

---

#### `enforceScopes(grantScopes, requiredScopes): void`

Throws `ScopeViolationError` if any required scope is missing from the grant.

#### `hasScope(grantScopes, scope): boolean`

Check whether a single scope is present. Returns `boolean`.

---

### Consent Bundles

#### `createConsentBundle(options): Promise<ConsentBundle>`

Request a consent bundle from the Grantex API. This call requires network connectivity -- the returned bundle is then used for all offline operations.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **required** | Grantex developer API key |
| `baseUrl` | `string` | `https://api.grantex.dev` | API base URL |
| `agentId` | `string` | **required** | Agent requesting the bundle |
| `userId` | `string` | **required** | End-user / principal granting consent |
| `scopes` | `string[]` | **required** | Requested scopes |
| `offlineTTL` | `string` | `'72h'` | Offline validity period (e.g. `'24h'`, `'7d'`) |
| `offlineAuditKeyAlgorithm` | `string` | `'Ed25519'` | Signing algorithm for audit entries |
| `storage` | `string` | -- | Storage backend: `'encrypted-file'`, `'keychain'`, `'secure-enclave'` |
| `storagePath` | `string` | -- | File path when storage is `'encrypted-file'` |

**`ConsentBundle` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `bundleId` | `string` | Unique bundle identifier |
| `grantToken` | `string` | Grantex grant token (RS256 JWT) |
| `jwksSnapshot` | `JWKSSnapshot` | JWKS keys for offline verification |
| `offlineAuditKey` | `{ publicKey, privateKey, algorithm }` | Ed25519 key pair for signing audit entries |
| `checkpointAt` | `number` | Unix-ms timestamp of last successful cloud sync |
| `syncEndpoint` | `string` | URL for syncing audit entries back to cloud |
| `offlineExpiresAt` | `string` | ISO-8601 timestamp after which offline operation is disallowed |

**Example:**

```typescript
const bundle = await createConsentBundle({
  apiKey: 'gx_live_...',
  agentId: 'agent_gemma_field',
  userId: 'usr_01J...',
  scopes: ['sensor:read', 'actuator:write'],
  offlineTTL: '7d',
});
```

---

#### `storeBundle(bundle, path, encryptionKey): Promise<void>`

Encrypt and write a bundle to disk using AES-256-GCM. File format: `[12-byte IV][16-byte auth-tag][ciphertext]`. The encryption key is SHA-256-hashed to derive a 32-byte AES key, so any passphrase length works.

#### `loadBundle(path, encryptionKey): Promise<ConsentBundle>`

Read and decrypt a bundle from disk. Throws `BundleTamperedError` if decryption or integrity check fails.

#### `shouldRefresh(bundle): boolean`

Returns `true` when less than 20% of the bundle's total offline TTL remains. Call this proactively when connectivity is available.

#### `refreshBundle(bundle, apiKey, baseUrl?): Promise<ConsentBundle>`

Refresh an expiring bundle via the Grantex API. Returns a new bundle with extended `offlineExpiresAt`, fresh JWKS snapshot, and rotated audit keys.

```typescript
if (shouldRefresh(bundle)) {
  const refreshed = await refreshBundle(bundle, process.env.GRANTEX_API_KEY!);
  await storeBundle(refreshed, '/data/grantex/bundle.enc', process.env.ENCRYPTION_KEY!);
}
```

---

### Audit Log

#### `createOfflineAuditLog(options): OfflineAuditLog`

Create an append-only, Ed25519-signed, hash-chained audit log backed by a JSONL file. Every entry is cryptographically linked to the previous one, forming a tamper-evident chain.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `signingKey` | `{ publicKey, privateKey, algorithm }` | **required** | Ed25519 key pair (from consent bundle) |
| `logPath` | `string` | **required** | Path to the JSONL log file |
| `maxSizeMB` | `number` | `50` | Max file size in MB before rotation |
| `rotateOnSize` | `boolean` | `true` | Enable automatic size-based rotation |

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `append` | `(entry: AuditEntry) => Promise<SignedAuditEntry>` | Append a new signed, hash-chained entry |
| `entries` | `() => Promise<SignedAuditEntry[]>` | Read all entries from the log file |
| `unsyncedCount` | `() => Promise<number>` | Count entries not yet synced to cloud |
| `markSynced` | `(upToSeq: number) => Promise<void>` | Mark entries as synced up to a sequence number |

**`SignedAuditEntry` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `seq` | `number` | Monotonically increasing sequence number |
| `timestamp` | `string` | ISO-8601 timestamp of the entry |
| `action` | `string` | Action performed (e.g. `'tool:read_calendar'`) |
| `agentDID` | `string` | Agent that performed the action |
| `grantId` | `string` | Grant under which the action was authorized |
| `scopes` | `string[]` | Scopes the grant carried at the time |
| `result` | `string` | Outcome: `'success'`, `'auth_failure'`, `'scope_violation'`, `'execution_error'` |
| `metadata` | `Record<string, unknown>?` | Optional structured metadata |
| `prevHash` | `string` | SHA-256 hash of the previous entry (genesis: `'0000000000000000'`) |
| `hash` | `string` | SHA-256 hash of this entry |
| `signature` | `string` | Ed25519 signature of the hash (hex-encoded) |

---

#### `syncAuditLog(auditLog, options): Promise<SyncResult>`

POST un-synced audit entries to the Grantex cloud in batches with automatic retry (3 attempts, exponential back-off).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | **required** | Sync endpoint URL (from `bundle.syncEndpoint`) |
| `apiKey` | `string` | **required** | Developer API key |
| `bundleId` | `string` | **required** | Consent bundle ID linking entries to an offline session |
| `batchSize` | `number` | `100` | Entries per HTTP request |

Returns `SyncResult` with `syncedCount`, `hasErrors`, and `errors[]`.

---

#### `computeEntryHash(entry): string`

Compute the SHA-256 hash of an audit entry. Input: `seq|timestamp|action|agentDID|grantId|scopes|result|metadata|prevHash`.

#### `verifyChain(entries): { valid: boolean; brokenAt?: number }`

Verify the integrity of an ordered sequence of entries. Checks hash recomputation, `prevHash` linkage, and sequence continuity.

#### `verifyEntrySignature(entry, publicKey): boolean`

Verify the Ed25519 signature of a single audit entry.

```typescript
import { verifyChain, verifyEntrySignature } from '@grantex/gemma';

const { valid, brokenAt } = verifyChain(await auditLog.entries());
const sigValid = verifyEntrySignature(entry, bundle.offlineAuditKey.publicKey);
```

---

### Adapters

#### `withGrantexAuthADK(tool, options)` / `withGrantexAuthLangChain(tool, options)`

Wrap a Google ADK `FunctionTool` or LangChain `StructuredTool` with Grantex offline authorization. Before the tool executes, the grant token is verified and scopes are enforced. After execution, an audit entry is appended automatically.

```typescript
import { withGrantexAuthADK, withGrantexAuthLangChain } from '@grantex/gemma';

// Google ADK -- wraps tools with `func` or `run` methods
const protectedAdkTool = withGrantexAuthADK(myAdkTool, {
  verifier, auditLog,
  requiredScopes: ['calendar:read'],
  grantToken: bundle.grantToken,
});

// LangChain -- wraps tools with `_call` or `invoke` methods
const protectedLcTool = withGrantexAuthLangChain(myLangChainTool, {
  verifier, auditLog,
  requiredScopes: ['email:read'],
  grantToken: bundle.grantToken,
});
```

**Both adapters accept the same options:**

| Option | Type | Description |
|--------|------|-------------|
| `verifier` | `OfflineVerifier` | Offline verifier instance |
| `auditLog` | `OfflineAuditLog` | Offline audit log instance |
| `requiredScopes` | `string[]` | Scopes required to invoke this tool |
| `grantToken` | `string` | Grantex grant token (JWT) |

---

## Type Definitions

```typescript
interface JWKSSnapshot {
  keys: JWK[];        // JWK key objects (must include kid and alg)
  fetchedAt: string;   // ISO-8601 when snapshot was fetched
  validUntil: string;  // ISO-8601 after which snapshot should be refreshed
}

interface ConsentBundle {
  bundleId: string;
  grantToken: string;                   // RS256 JWT
  jwksSnapshot: JWKSSnapshot;
  offlineAuditKey: { publicKey: string; privateKey: string; algorithm: string };
  checkpointAt: number;                 // Unix-ms timestamp
  syncEndpoint: string;
  offlineExpiresAt: string;             // ISO-8601
}

interface VerifiedGrant {
  agentDID: string;      principalDID: string;
  scopes: string[];      expiresAt: Date;
  jti: string;           grantId: string;       depth: number;
}

interface SignedAuditEntry {
  seq: number;           timestamp: string;      action: string;
  agentDID: string;      grantId: string;        scopes: string[];
  result: string;        metadata?: Record<string, unknown>;
  prevHash: string;      hash: string;           signature: string;
}

interface SyncResult {
  syncedCount: number;   hasErrors: boolean;     errors: string[];
}

// Errors -- all extend GrantexAuthError (which extends Error with a `code` property)
class OfflineVerificationError  { code: string }  // VERIFICATION_FAILED, MALFORMED_TOKEN,
                                                   // BLOCKED_ALGORITHM, MISSING_KID, KID_NOT_FOUND,
                                                   // FUTURE_IAT, DELEGATION_DEPTH_EXCEEDED
class ScopeViolationError       { requiredScopes: string[]; grantScopes: string[] }
class TokenExpiredError          { expiredAt: Date }
class BundleTamperedError       { /* code: BUNDLE_TAMPERED */ }
class HashChainError            { brokenAt: number }
```

---

## Security

**What offline verification guarantees:**
- **Signature integrity** -- every token is verified against a pre-fetched JWKS snapshot using RS256.
- **Scope enforcement** -- required scopes are checked on every verification; agents cannot escalate permissions.
- **Tamper-evident audit trail** -- every entry is SHA-256 hash-chained and Ed25519-signed. `verifyChain()` detects any modification.
- **Encrypted storage** -- bundles are stored with AES-256-GCM (12-byte IV, 16-byte auth-tag). The encryption key is SHA-256-hashed to derive the 32-byte AES key.

**What it does NOT guarantee:**
- **Real-time revocation** -- if a grant is revoked in the cloud while the device is offline, the local verifier continues to accept the token until expiry or `offlineExpiresAt`. This is an inherent trade-off of offline operation.
- **Clock accuracy** -- verification depends on the device clock. Use `clockSkewSeconds` to account for drift.

**Additional security details:**
- **Blocked algorithms** -- `none` and `HS256` are explicitly blocked to prevent signature bypass and symmetric-key confusion attacks. Only `RS256` tokens are accepted.
- **Hash chain** -- each entry hash is computed from `seq|timestamp|action|agentDID|grantId|scopes|result|metadata|prevHash`. Genesis hash: `'0000000000000000'`.
- **Ed25519 audit signing** -- every entry's hash is signed with the private key from the consent bundle. Verify with `verifyEntrySignature()`.

---

## Platform Compatibility

`@grantex/gemma` runs anywhere Node.js 18+ is available:

| Platform | Requirement | Notes |
|----------|-------------|-------|
| Raspberry Pi 5 | Node.js 18+ (ARM64) | 3.2ms avg verification |
| Android | React Native / Termux | 1.8ms avg verification |
| iOS | JavaScriptCore / embedded V8 | 1.8ms avg verification |
| NVIDIA Jetson | Node.js 18+ (ARM64) | 1.1ms avg verification |
| Desktop | Node.js 18+ (x64/ARM64) | < 1ms avg verification |
| Edge servers | Cloudflare Workers, Deno Deploy | < 1ms avg verification |

The package is pure ESM (`"type": "module"` in your `package.json`, or use dynamic `import()`).

---

## Error Handling

All errors extend `GrantexAuthError` and include a machine-readable `code` property:

```typescript
import {
  TokenExpiredError, ScopeViolationError,
  OfflineVerificationError, BundleTamperedError, HashChainError,
} from '@grantex/gemma';

try {
  const grant = await verifier.verify(token);
  enforceScopes(grant.scopes, ['files:write']);
} catch (err) {
  if (err instanceof TokenExpiredError) {
    console.error(`Token expired at ${err.expiredAt.toISOString()}`);
  } else if (err instanceof ScopeViolationError) {
    console.error(`Missing: required ${err.requiredScopes}, got ${err.grantScopes}`);
  } else if (err instanceof OfflineVerificationError) {
    console.error(`[${err.code}]: ${err.message}`);
  } else if (err instanceof BundleTamperedError) {
    console.error('Bundle integrity check failed');
  } else if (err instanceof HashChainError) {
    console.error(`Chain broken at entry ${err.brokenAt}`);
  }
}
```

---

## Testing

49 tests across 6 test files (offline verifier, scope enforcer, consent bundles, hash chain, audit log, security):

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run typecheck   # type checking only
```

---

## Framework Integrations

| Framework | Adapter | Import |
|-----------|---------|--------|
| [Google ADK](https://google.github.io/adk-docs/) | `withGrantexAuthADK` | `import { withGrantexAuthADK } from '@grantex/gemma'` |
| [LangChain](https://js.langchain.com/) | `withGrantexAuthLangChain` | `import { withGrantexAuthLangChain } from '@grantex/gemma'` |

Both adapters automatically handle token verification, scope enforcement, and audit logging. See the [Adapters](#adapters) section above for full usage examples.

---

## Examples

| Example | Platform | Description |
|---------|----------|-------------|
| [`gemma-raspberry-pi`](https://github.com/mishrasanjeev/grantex/tree/main/examples/gemma-raspberry-pi) | Raspberry Pi 5 | Python agent with bundle setup, offline operation, and audit sync |
| [`gemma-android-kotlin`](https://github.com/mishrasanjeev/grantex/tree/main/examples/gemma-android-kotlin) | Android | Kotlin app with offline auth manager and audit logging |
| [`gemma-ios-swift`](https://github.com/mishrasanjeev/grantex/tree/main/examples/gemma-ios-swift) | iOS | Swift package with offline verifier and consent bundle manager |

---

## Troubleshooting

### Token verification fails offline

The JWKS snapshot embedded in your consent bundle may have expired. Check the `validUntil` field:

```typescript
import { isSnapshotExpired } from '@grantex/gemma';

if (isSnapshotExpired(bundle.jwksSnapshot)) {
  // Snapshot expired -- refresh the bundle when connectivity is available
}
```

Also verify the `offlineExpiresAt` on the bundle itself has not passed.

### BundleTamperedError when loading

This means decryption failed. Common causes:
- **Wrong encryption key** -- ensure you pass the same key used during `storeBundle()`.
- **Corrupted file** -- the bundle file was partially written or modified on disk.
- **File too short** -- the file must contain at least 28 bytes (12-byte IV + 16-byte auth-tag).

### Hash chain broken

`verifyChain()` returns `{ valid: false, brokenAt: N }` when entries have been modified outside the audit log. This is expected tamper-detection behaviour. Do not manually edit the JSONL audit file.

### Clock skew errors

If verification fails with `FUTURE_IAT` or tokens appear expired prematurely, increase the clock skew tolerance:

```typescript
const verifier = createOfflineVerifier({
  jwksSnapshot: bundle.jwksSnapshot,
  clockSkewSeconds: 120, // allow up to 2 minutes of drift
});
```

---

## Related Packages

| Package | Description |
|---------|-------------|
| [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) | TypeScript SDK for the Grantex protocol |
| [`grantex`](https://pypi.org/project/grantex/) | Python SDK |
| [`grantex-adk`](https://pypi.org/project/grantex-adk/) | Google ADK integration (Python) |
| [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) | LangChain integration |
| [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) | MCP server for Claude Desktop / Cursor / Windsurf |
| [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) | Command-line tool |
| [`@grantex/express`](https://www.npmjs.com/package/@grantex/express) | Express.js middleware |
| [`@grantex/gateway`](https://www.npmjs.com/package/@grantex/gateway) | Reverse-proxy gateway |

---

## Contributing

See [CONTRIBUTING.md](https://github.com/mishrasanjeev/grantex/blob/main/CONTRIBUTING.md) for guidelines on setting up the development environment, running tests, and submitting pull requests.

---

## License

[Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
