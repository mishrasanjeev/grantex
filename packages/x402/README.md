# @grantex/x402

**Agent Spend Authorization for x402 Payment Flows**

Grantex Delegation Tokens (GDTs) for authorizing AI agent spending via the [x402 HTTP Payment Required](https://www.x402.org/) protocol on Base L2.

The x402 protocol enables AI agents to pay for API resources using USDC on Base L2 with no login, no API key, and no subscription. **@grantex/x402** adds the missing authorization layer — proving that the paying agent was authorized to make that payment on behalf of a human or organization.

## Installation

```bash
npm install @grantex/x402
```

## Quick Start

### 1. Generate Keys & Issue a GDT

```typescript
import { generateKeyPair, issueGDT } from '@grantex/x402';

// Generate key pairs for principal (human) and agent
const principal = generateKeyPair();
const agent = generateKeyPair();

// Issue a Grantex Delegation Token
const gdt = await issueGDT({
  agentDID: agent.did,
  scope: ['weather:read', 'news:read'],
  spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
  expiry: '24h',
  signingKey: principal.privateKey,
});

console.log('GDT issued:', gdt);
```

### 2. Agent Fetches with x402 + GDT

```typescript
import { createX402Agent } from '@grantex/x402';

const agent = createX402Agent({
  gdt: gdtToken,
  paymentHandler: async (details) => {
    // Sign and submit Base L2 USDC transfer
    const txHash = await payOnBaseL2(details);
    return txHash;
  },
});

// Automatic: 402 → pay → retry, with GDT attached
const response = await agent.fetch('https://api.weather.xyz/forecast');
const data = await response.json();
```

### 3. Protect Your API (Express Middleware)

```typescript
import express from 'express';
import { x402Middleware } from '@grantex/x402';

const app = express();

// Require a valid GDT for weather endpoints
app.use('/api/weather', x402Middleware({
  requiredScopes: ['weather:read'],
  currency: 'USDC',
}));

app.get('/api/weather/forecast', (req, res) => {
  const { gdt } = req as any;
  res.json({
    forecast: 'sunny',
    authorizedBy: gdt.principalDID,
    agentDID: gdt.agentDID,
  });
});
```

### 4. Verify a GDT Standalone

```typescript
import { verifyGDT } from '@grantex/x402';

const result = await verifyGDT(gdtToken, {
  resource: 'weather:read',
  amount: 0.001,
  currency: 'USDC',
});

if (result.valid) {
  console.log(`Authorized by ${result.principalDID}`);
  console.log(`Remaining limit: $${result.remainingLimit} ${result.scopes}`);
} else {
  console.error(`Rejected: ${result.error}`);
}
```

## GDT Token Structure (W3C VC 2.0)

A GDT is a W3C Verifiable Credential 2.0 encoded as a JWT, signed with Ed25519:

```json
{
  "iss": "did:key:z6Mk...principal...",
  "sub": "did:key:z6Mk...agent...",
  "vc": {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://grantex.dev/v1/x402"],
    "type": ["VerifiableCredential", "GrantexDelegationToken"],
    "credentialSubject": {
      "id": "did:key:z6Mk...agent...",
      "scope": ["weather:read", "news:read"],
      "spendLimit": { "amount": 10, "currency": "USDC", "period": "24h" },
      "paymentChain": "base",
      "delegationChain": ["did:key:...principal..."]
    }
  },
  "iat": 1711036800,
  "exp": 1711123200,
  "jti": "550e8400-e29b-41d4-a716-446655440000"
}
```

## API Reference

### `issueGDT(params): Promise<string>`

Issue a signed GDT (W3C VC 2.0 JWT).

| Parameter | Type | Description |
|-----------|------|-------------|
| `agentDID` | `string` | DID of the agent being delegated to |
| `scope` | `string[]` | Resource:action scopes (e.g. `['weather:read']`) |
| `spendLimit` | `SpendLimit` | `{ amount, currency, period }` |
| `expiry` | `string` | ISO 8601 duration (`PT24H`) or datetime |
| `signingKey` | `Uint8Array` | 32-byte Ed25519 private key seed |
| `delegationChain` | `string[]?` | Parent DIDs for sub-delegation |
| `paymentChain` | `string?` | Blockchain (default: `'base'`) |

### `verifyGDT(token, context): Promise<VerifyResult>`

Verify a GDT against a request context.

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | GDT JWT to verify |
| `context.resource` | `string` | Resource:action scope to check |
| `context.amount` | `number` | Spend amount for this request |
| `context.currency` | `Currency` | `'USDC'` or `'USDT'` |

Returns `VerifyResult`:
```typescript
{
  valid: boolean;
  agentDID: string;
  principalDID: string;
  remainingLimit: number;
  scopes: string[];
  tokenId: string;
  expiresAt: string;
  error?: string;
}
```

### `createX402Agent(config): { fetch }`

Create an x402 agent with automatic 402 → pay → retry handling.

### `x402Middleware(options): ExpressMiddleware`

Express middleware for GDT verification.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `required` | `boolean` | `true` | Require GDT (403 if missing) |
| `requiredScopes` | `string[]` | - | Required scopes to check |
| `currency` | `Currency` | `'USDC'` | Currency for verification |
| `extractAmount` | `(req) => number` | - | Custom amount extractor |
| `verifyFn` | `Function` | `verifyGDT` | Custom verification |

### `generateKeyPair(): Ed25519KeyPair`

Generate an Ed25519 key pair with DID. Returns `{ privateKey, publicKey, did }`.

### `derivePublicKey(privateKey): { publicKey, did }`

Derive the public key and DID from a 32-byte Ed25519 private key seed.

### `decodeGDT(token): GDTJWTPayload`

Decode a GDT JWT without verification (for inspection only).

### `parseExpiry(expiry): number`

Parse an expiry string into epoch seconds. Supports: `"24h"`, `"7d"`, `"PT24H"`, `"P7D"`, or ISO 8601 datetime.

### DID Utilities

```typescript
import { publicKeyToDID, didToPublicKey, isValidDID } from '@grantex/x402';

const did = publicKeyToDID(publicKey);     // Uint8Array → did:key string
const key = didToPublicKey(did);           // did:key string → Uint8Array
const ok = isValidDID(did);               // true if valid Ed25519 did:key
```

### Revocation

```typescript
import { getRevocationRegistry } from '@grantex/x402';

const registry = getRevocationRegistry();
await registry.revoke(tokenId, 'compromised agent');

// Subsequent verifications will reject this token
const result = await verifyGDT(token, context);
// result.valid === false, result.error === 'Token has been revoked'
```

### Audit Log

```typescript
import { getAuditLog } from '@grantex/x402';

const log = getAuditLog();
const entries = await log.query({
  eventType: 'verification',
  agentDID: 'did:key:z6Mk...',
  limit: 100,
});
```

## CLI

```bash
# Generate a key pair
grantex-x402 keygen

# Issue a GDT
grantex-x402 issue \
  --agent did:key:z6Mk... \
  --scope weather:read,news:read \
  --limit 10 \
  --expiry 24h \
  --key principal.key

# Verify a GDT
grantex-x402 verify <token> --resource weather:read --amount 0.001

# Revoke a GDT
grantex-x402 revoke <tokenId>

# Decode (inspect) a GDT
grantex-x402 decode <token>
grantex-x402 inspect <token>   # alias for decode

# View audit log
grantex-x402 audit
grantex-x402 audit --type issuance --limit 10
```

## x402 Flow

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ Principal │────▶│  GDT Issuer  │────▶│  GDT (JWT)   │
│ (Human)   │     │  issueGDT()  │     │  W3C VC 2.0  │
└──────────┘     └──────────────┘     └──────┬───────┘
                                              │
                                              ▼
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│   Agent   │────▶│ x402 Adapter │────▶│  x402 API    │
│           │     │ fetch + GDT  │     │ + Middleware  │
└──────────┘     └──────────────┘     └──────┬───────┘
                                              │
                  ┌──────────────┐            │
                  │  Revocation  │◀───────────┤
                  │  Registry    │            │
                  └──────────────┘     ┌──────▼───────┐
                                       │  Audit Log   │
                  ┌──────────────┐     │  (append)    │
                  │  Base L2     │     └──────────────┘
                  │  USDC Pay    │
                  └──────────────┘
```

## Scope Matching

Scopes support exact match and wildcard patterns:

| Granted Scope | Requested Resource | Match? |
|---|---|---|
| `weather:read` | `weather:read` | ✅ |
| `weather:read` | `weather:write` | ❌ |
| `weather:*` | `weather:read` | ✅ |
| `weather:*` | `weather:write` | ✅ |
| `*` | `anything:anything` | ✅ |

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
