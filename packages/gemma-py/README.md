# grantex-gemma

Offline authorization for Google Gemma on-device AI agents. Issue consent bundles online, verify grant tokens and enforce scopes entirely offline, and sync tamper-evident audit logs back to the Grantex cloud when connectivity returns.

[![PyPI](https://img.shields.io/pypi/v/grantex-gemma)](https://pypi.org/project/grantex-gemma/)
[![Python](https://img.shields.io/pypi/pyversions/grantex-gemma)](https://pypi.org/project/grantex-gemma/)
[![License](https://img.shields.io/pypi/l/grantex-gemma)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![Downloads](https://img.shields.io/pypi/dm/grantex-gemma)](https://pypi.org/project/grantex-gemma/)

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev/integrations/gemma)** | **[API Reference](https://docs.grantex.dev/api-reference)** | **[GitHub](https://github.com/mishrasanjeev/grantex)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)**

## What is grantex-gemma?

When you run Gemma 4 on a Raspberry Pi, NVIDIA Jetson, or any server-side device, the model often needs to act on behalf of a user — reading contacts, sending messages, accessing calendars. But these devices go offline. WiFi drops, cellular is spotty, and edge deployments may only sync once a day.

**grantex-gemma** solves this with a three-phase offline authorization model:

1. **Online** — While connected, your agent requests a *consent bundle* from the Grantex API. The bundle contains a signed grant token, a JWKS snapshot for offline verification, and an Ed25519 key pair for signing audit entries.

2. **Offline** — The agent verifies the grant token locally (RS256 against the JWKS snapshot), enforces scopes, and logs every action to a tamper-evident, hash-chained audit file. No network required.

3. **Sync** — When connectivity returns, the agent uploads the signed audit log to the Grantex cloud. The server verifies the hash chain, checks for revocations, and optionally issues a refreshed bundle.

Everything is cryptographically verifiable. Grant tokens are standard Grantex JWTs (RS256). Audit entries are Ed25519-signed and SHA-256 hash-chained. Bundles are encrypted at rest with AES-256-GCM.

## Installation

```bash
pip install grantex-gemma
```

With development dependencies:

```bash
pip install grantex-gemma[dev]
```

**Requirements:** Python 3.9+, [httpx](https://www.python-httpx.org/), [PyJWT](https://pyjwt.readthedocs.io/), [cryptography](https://cryptography.io/)

## Quick Start

```python
import asyncio
from grantex_gemma import (
    create_consent_bundle,
    create_offline_verifier,
    create_offline_audit_log,
    store_bundle,
    load_bundle,
)

ENCRYPTION_KEY = "a1b2c3..."  # 64-char hex string (256-bit key)

async def main():
    # ── Phase 1: Online — Issue a consent bundle ────────────────────
    bundle = await create_consent_bundle(
        api_key="gx_dev_...",
        agent_id="did:web:my-agent.example.com",
        user_id="did:web:alice.example.com",
        scopes=["read:contacts", "write:calendar"],
        offline_ttl="72h",  # Bundle valid for 72 hours offline
    )

    # Persist to disk with AES-256-GCM encryption
    store_bundle(bundle, "/data/grantex/bundle.enc", ENCRYPTION_KEY)

    # ── Phase 2: Offline — Verify tokens and log actions ────────────
    bundle = load_bundle("/data/grantex/bundle.enc", ENCRYPTION_KEY)

    verifier = create_offline_verifier(
        bundle.jwks_snapshot,
        require_scopes=["read:contacts"],
        max_delegation_depth=2,
    )

    # Verify the grant token — pure local crypto, no HTTP call
    grant = await verifier.verify(bundle.grant_token)
    print(f"Authorized: {grant.agent_did} for {grant.scopes}")

    # Create an append-only, hash-chained audit log
    audit = create_offline_audit_log(
        bundle.offline_audit_key,
        log_path="/data/grantex/audit.jsonl",
    )

    # Log every action the agent performs
    entry = await audit.append("read:contacts", grant, "success", {"count": 42})
    print(f"Logged entry #{entry.seq}, hash: {entry.hash[:16]}...")

    # ── Phase 3: Online — Sync audit log ────────────────────────────
    result = await audit.sync(
        endpoint=bundle.sync_endpoint,
        api_key="gx_dev_...",
        bundle_id=bundle.bundle_id,
    )
    print(f"Synced: {result.accepted} accepted, {result.rejected} rejected")

    # If the grant was revoked while offline, stop the agent
    if result.revocation_status == "revoked":
        print("Grant revoked — halting agent")

asyncio.run(main())
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  PHASE 1: ONLINE                                             │
│                                                              │
│  Device ──POST /v1/consent-bundles──▶ Grantex API           │
│                                        │                     │
│                              store_bundle(AES-256-GCM)       │
│                                        ▼                     │
│                              [encrypted file on disk]        │
├──────────────────────────────────────────────────────────────┤
│  PHASE 2: OFFLINE                                            │
│                                                              │
│  load_bundle() ──▶ OfflineVerifier.verify(token)            │
│                         │    RS256 + JWKS snapshot           │
│                         ▼                                    │
│                    VerifiedGrant ──▶ AuditLog.append()       │
│                                     Ed25519 + SHA-256 chain  │
│                                        ▼                     │
│                                   [audit.jsonl]              │
├──────────────────────────────────────────────────────────────┤
│  PHASE 3: SYNC                                               │
│                                                              │
│  AuditLog.sync() ──POST batches──▶ Grantex API             │
│                                      ▼                       │
│                                  SyncResult                  │
│                                  ├─ accepted / rejected      │
│                                  ├─ revocation_status        │
│                                  └─ new_bundle (optional)    │
└──────────────────────────────────────────────────────────────┘
```

## API Reference

### `create_offline_verifier(jwks_snapshot, ...) -> OfflineVerifier`

Create an offline JWT verifier for on-device use.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `jwks_snapshot` | `JWKSSnapshot` | required | Pre-fetched JWKS keys for RS256 verification |
| `clock_skew_seconds` | `int` | `30` | Allowable clock drift in seconds |
| `require_scopes` | `list[str] \| None` | `None` | Scopes that must be present on every token |
| `max_delegation_depth` | `int \| None` | `None` | Maximum delegation chain depth allowed |
| `on_scope_violation` | `str` | `"throw"` | `"throw"` raises `ScopeViolationError`, `"log"` warns |

Returns an `OfflineVerifier` with a single method:

- **`async verify(token: str) -> VerifiedGrant`** — Verify a JWT and return the decoded grant. Raises `OfflineVerificationError`, `TokenExpiredError`, or `ScopeViolationError`.

### `create_consent_bundle(api_key, agent_id, user_id, scopes, ...) -> ConsentBundle`

Request a consent bundle from the Grantex API (requires network).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `api_key` | `str` | required | Grantex developer API key |
| `agent_id` | `str` | required | Agent DID or identifier |
| `user_id` | `str` | required | Principal (user) identifier |
| `scopes` | `list[str]` | required | Requested authorization scopes |
| `offline_ttl` | `str` | `"72h"` | How long the bundle is valid offline |
| `base_url` | `str` | `"https://api.grantex.dev"` | Grantex API base URL |

### `store_bundle(bundle, path, encryption_key) -> None`

Encrypt and write a consent bundle to disk using AES-256-GCM.

| Parameter | Type | Description |
|-----------|------|-------------|
| `bundle` | `ConsentBundle` | The bundle to encrypt and store |
| `path` | `str` | File path for the encrypted bundle |
| `encryption_key` | `str` | Hex-encoded 256-bit key (64 hex characters) |

### `load_bundle(path, encryption_key) -> ConsentBundle`

Load and decrypt a consent bundle from disk. Raises `BundleTamperedError` if decryption or integrity check fails. Raises `FileNotFoundError` if the file does not exist.

### `create_offline_audit_log(signing_key, log_path, ...) -> OfflineAuditLog`

Create an append-only, Ed25519-signed, hash-chained audit log backed by a JSONL file.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `signing_key` | `OfflineAuditKey` | required | Ed25519 key pair for signing entries |
| `log_path` | `str` | required | Path to the JSONL log file |
| `max_size_mb` | `int` | `50` | Maximum log file size in MB before rotation |
| `rotate_on_size` | `bool` | `True` | Whether to rotate when size limit is reached |

**`OfflineAuditLog` methods:**

- **`async append(action, grant, result, metadata=None) -> SignedAuditEntry`** — Append a signed, hash-chained entry.
- **`async sync(endpoint, api_key, bundle_id, batch_size=100) -> SyncResult`** — Upload audit entries to the Grantex cloud in batches.

### `enforce_scopes(grant_scopes, required_scopes) -> None`

Ensure all required scopes are present. Raises `ScopeViolationError` if any are missing.

```python
from grantex_gemma import enforce_scopes
enforce_scopes(grant.scopes, ["read:contacts", "write:calendar"])
```

### `has_scope(grant_scopes, scope) -> bool`

Check if a single scope is present in the grant.

```python
from grantex_gemma import has_scope
if has_scope(grant.scopes, "write:calendar"):
    ...
```

### `compute_entry_hash(entry) -> str`

Compute the SHA-256 hash of an audit entry's content fields (`seq`, `timestamp`, `action`, `agent_did`, `grant_id`, `scopes`, `result`, `metadata`, `prev_hash`).

### `verify_chain(entries) -> tuple[bool, int | None]`

Verify the integrity of a hash chain. Returns `(True, None)` if valid, or `(False, index)` where `index` is the first broken entry.

```python
from grantex_gemma import verify_chain
valid, broken_at = verify_chain(entries)
if not valid:
    print(f"Chain broken at entry {broken_at}")
```

## Type Definitions

All types are Python `dataclass` instances importable from `grantex_gemma`:

### `JWKSSnapshot`

```python
@dataclass
class JWKSSnapshot:
    keys: list[dict[str, Any]]  # JWK key objects
    fetched_at: str             # ISO 8601 timestamp
    valid_until: str            # ISO 8601 expiry
```

### `OfflineAuditKey`

```python
@dataclass
class OfflineAuditKey:
    public_key: str   # PEM-encoded Ed25519 public key
    private_key: str  # PEM-encoded Ed25519 private key
    algorithm: str    # "Ed25519"
```

### `ConsentBundle`

```python
@dataclass
class ConsentBundle:
    bundle_id: str                      # Unique bundle identifier
    grant_token: str                    # RS256-signed Grantex JWT
    jwks_snapshot: JWKSSnapshot         # Keys for offline verification
    offline_audit_key: OfflineAuditKey  # Ed25519 key pair for signing
    checkpoint_at: int                  # Unix timestamp for next sync
    sync_endpoint: str                  # URL for audit log upload
    offline_expires_at: str             # ISO 8601 offline expiry
```

### `VerifiedGrant`

```python
@dataclass
class VerifiedGrant:
    agent_did: str          # Agent DID (from "agt" claim)
    principal_did: str      # User DID (from "sub" claim)
    scopes: list[str]       # Authorized scopes (from "scp" claim)
    expires_at: datetime    # Token expiry (from "exp" claim)
    jti: str                # Token ID (from "jti" claim)
    grant_id: str           # Grant ID (from "grnt" or "jti" claim)
    depth: int              # Delegation depth (0 = root grant)
```

### `SignedAuditEntry`

```python
@dataclass
class SignedAuditEntry:
    seq: int                  # Monotonic sequence number
    timestamp: str            # ISO 8601 timestamp
    action: str               # Action performed
    agent_did: str            # Agent that performed the action
    grant_id: str             # Grant that authorized it
    scopes: list[str]         # Scopes on the grant
    result: str               # "success", "denied", etc.
    metadata: dict[str, Any]  # Arbitrary context
    prev_hash: str            # SHA-256 hash of previous entry
    hash: str                 # SHA-256 hash of this entry
    signature: str            # Ed25519 signature (base64url)
```

### `SyncResult`

```python
@dataclass
class SyncResult:
    accepted: int                    # Entries accepted by server
    rejected: int                    # Entries rejected by server
    revocation_status: str           # "active" or "revoked"
    new_bundle: ConsentBundle | None # Refreshed bundle (if issued)
```

## Error Classes

All exceptions inherit from `GrantexGemmaError`:

| Exception | Raised when |
|-----------|-------------|
| `GrantexGemmaError` | Base class for all grantex-gemma errors |
| `OfflineVerificationError` | JWT verification fails (bad signature, missing claims, unsupported algorithm) |
| `ScopeViolationError` | A required scope is missing from the grant |
| `TokenExpiredError` | The grant token has expired (past `exp` + clock skew) |
| `BundleTamperedError` | AES-256-GCM decryption fails — bundle was modified or wrong key |
| `GrantexAuthError` | API returns 401/403 or a network error during bundle creation/sync |
| `HashChainError` | Hash chain integrity verification fails, or sync returns an error |

`GrantexAuthError` includes a `status_code` property for HTTP error codes.

### Catching errors in practice

```python
from grantex_gemma import (
    GrantexGemmaError,
    OfflineVerificationError,
    TokenExpiredError,
    ScopeViolationError,
    BundleTamperedError,
)

try:
    bundle = load_bundle("/data/bundle.enc", encryption_key)
    grant = await verifier.verify(bundle.grant_token)
    enforce_scopes(grant.scopes, ["write:calendar"])
except BundleTamperedError:
    # Bundle corrupted or wrong encryption key — re-fetch when online
    pass
except TokenExpiredError:
    # Grant expired — request a new consent bundle
    pass
except ScopeViolationError:
    # Agent tried to exceed its permissions
    await audit.append("write:calendar", grant, "denied")
except OfflineVerificationError:
    # Bad signature, missing claims, etc.
    pass
except GrantexGemmaError:
    # Catch-all for any grantex-gemma error
    pass
```

## Security

- **RS256 only** — The verifier rejects `alg: "none"` and `alg: "HS256"` tokens. Only RS256 with pre-fetched public keys is accepted.
- **AES-256-GCM** — Consent bundles are encrypted at rest. Tampering is detected by GCM authentication.
- **Ed25519 audit signatures** — Every audit entry is signed with the bundle's Ed25519 private key. Signatures are verified server-side during sync.
- **SHA-256 hash chain** — Each audit entry's hash covers the previous entry's hash, forming a tamper-evident chain. Breaking one entry invalidates all subsequent entries.
- **No secrets in tokens** — Grant tokens are standard JWTs verified against public keys. No shared secrets.
- **Clock skew tolerance** — Configurable tolerance (default 30s) prevents false rejections on devices with imprecise clocks.
- **Delegation depth limits** — Prevent unbounded delegation chains with `max_delegation_depth`.

## Platform Compatibility

`grantex-gemma` runs anywhere Python 3.9+ is available:

| Platform | Python | Avg verify time | Notes |
|----------|--------|-----------------|-------|
| Raspberry Pi 5 | 3.9+ | 3.2 ms | Tested on Raspberry Pi OS (64-bit) |
| NVIDIA Jetson | 3.9+ | 1.1 ms | Orin Nano / AGX Orin |
| Linux server | 3.9+ | < 1 ms | x86_64, tested on Ubuntu 22.04+ |
| macOS | 3.9+ | < 1 ms | Apple Silicon and Intel |
| Windows | 3.9+ | < 1 ms | Windows 10/11, native and WSL |

Verification is pure CPU (RSA signature check) — no GPU required. The bottleneck on constrained devices is the `cryptography` library's RSA implementation, which is written in Rust/C and well-optimized.

## Testing

```bash
pip install -e ".[dev]"
pytest
```

41 tests covering offline verification, consent bundle creation, hash chain integrity, audit log operations, and security edge cases. Uses `pytest-asyncio` for async support and `respx` for HTTP mocking.

```bash
pytest --cov=grantex_gemma --cov-report=term-missing  # coverage
mypy src/grantex_gemma                                  # type checking
```

## Examples

### Raspberry Pi agent

A complete example running a Gemma 4 agent on a Raspberry Pi with offline authorization:

```
examples/gemma-raspberry-pi/
  setup_bundle.py    # Phase 1: Create and store a consent bundle
  agent.py           # Phase 2: Offline agent with verification and audit
  sync_audit.py      # Phase 3: Sync audit log when back online
  verify_audit.py    # Verify hash chain integrity of the audit log
```

See the [Raspberry Pi example README](https://github.com/mishrasanjeev/grantex/tree/main/examples/gemma-raspberry-pi) for setup instructions.

## Troubleshooting

### `BundleTamperedError` when loading a bundle

The encryption key does not match the key used to store the bundle, or the file was modified. Use the same 64-character hex key for both `store_bundle` and `load_bundle`.

### `OfflineVerificationError: No RSA keys available`

The JWKS snapshot contains no RSA keys. This usually means the bundle was created with a test/mock API that returned an empty key set. Create a new bundle against the real Grantex API.

### `TokenExpiredError` after being offline too long

The grant token's `exp` claim has passed. Consent bundles have a limited offline TTL (default 72 hours). Re-create the bundle when connectivity is available, or request a longer `offline_ttl`.

### `ScopeViolationError` on verify

The grant token does not include the scopes specified in `require_scopes`. Either request the correct scopes when creating the bundle, or set `on_scope_violation="log"` to downgrade to a warning.

### `HashChainError` during sync

The server detected a gap or inconsistency in the hash chain. This happens if log entries were manually edited or the file was corrupted. Use `verify_chain()` locally to find the broken entry.

### `cryptography` fails to install on Raspberry Pi

```bash
sudo apt-get install -y build-essential libssl-dev libffi-dev python3-dev
pip install --prefer-binary cryptography
```

## Related Packages

| Package | Description | Install |
|---------|-------------|---------|
| [`grantex`](https://pypi.org/project/grantex/) | Python SDK (full API client) | `pip install grantex` |
| [`grantex-adk`](https://pypi.org/project/grantex-adk/) | Google ADK integration | `pip install grantex-adk` |
| [`@grantex/gemma`](https://www.npmjs.com/package/@grantex/gemma) | TypeScript version of this package | `npm install @grantex/gemma` |

## Contributing

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex/packages/gemma-py
pip install -e ".[dev]"
pytest
```

## License

Apache-2.0
