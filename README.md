<div align="center">

# Grantex

### Delegated Authorization Protocol for AI Agents

**What OAuth 2.0 is to humans, Grantex is to agents.**

<br/>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Spec Version](https://img.shields.io/badge/spec-v1.0--final-green)](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
[![IETF Draft](https://img.shields.io/badge/IETF-draft--mishra--oauth--agent--grants-blue)](https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/)
[![SOC 2 Type I](https://img.shields.io/badge/SOC%202-Type%20I%20Certified-brightgreen)](https://docs.grantex.dev/security)
[![CI](https://img.shields.io/github/actions/workflow/status/mishrasanjeev/grantex/ci.yml?branch=main&label=CI)](https://github.com/mishrasanjeev/grantex/actions/workflows/ci.yml)
[![679+ Tests](https://img.shields.io/badge/tests-679%2B%20passing-brightgreen)](https://github.com/mishrasanjeev/grantex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@grantex/sdk)](https://www.npmjs.com/package/@grantex/sdk)
[![PyPI](https://img.shields.io/pypi/v/grantex)](https://pypi.org/project/grantex/)
[![npm downloads](https://img.shields.io/npm/dm/@grantex/sdk?label=npm%20downloads)](https://www.npmjs.com/package/@grantex/sdk)
[![GitHub Stars](https://img.shields.io/github/stars/mishrasanjeev/grantex?style=social)](https://github.com/mishrasanjeev/grantex)
[![Docs](https://img.shields.io/badge/docs-grantex.dev-3fb950)](https://grantex.dev/docs)

<br/>

[Docs](https://docs.grantex.dev) | [Playground](https://grantex.dev/playground) | [Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md) | [Dashboard](https://grantex.dev/dashboard) | [IETF Draft](https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/)

<br/>

<img src="docs/images/flow-diagram.svg" alt="Grantex Protocol Flow" width="100%"/>

<br/>

</div>

## Try in 30 seconds

```bash
npm install @grantex/sdk
```

```typescript
import { Grantex, verifyGrantToken } from '@grantex/sdk';
const gx = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

// 1. Authorize an agent for a user
const auth = await gx.authorize({ agentId: 'agent-123', userId: 'user-456', scopes: ['calendar:read', 'email:send'] });

// 2. Exchange code for a scoped, signed JWT
const { grantToken } = await gx.tokens.exchange({ code: auth.code, agentId: 'agent-123' });

// 3. Verify anywhere — offline, no callback needed
const grant = await verifyGrantToken(grantToken, { jwksUri: 'https://api.grantex.dev/.well-known/jwks.json' });
console.log(grant.scopes); // ['calendar:read', 'email:send']
```

```bash
pip install grantex             # Python
go get github.com/mishrasanjeev/grantex-go  # Go
npm install -g @grantex/cli     # CLI
```

> **30+ packages** across TypeScript, Python, and Go. Integrations for **LangChain, OpenAI Agents SDK, Google ADK, CrewAI, Vercel AI, AutoGen, MCP, Express.js, FastAPI**, and **Terraform**. 679+ tests. Fully self-hostable. Apache 2.0.

---

## The Problem

AI agents are booking travel, sending emails, deploying code, and spending money — on behalf of real humans. But:

- **No scoping** — agents get the same access as the key owner
- **No consent** — users never approve what the agent can do
- **No per-agent identity** — you know the key was used, but not which agent or why
- **No revocation granularity** — one agent misbehaves, rotate the key, kill everything
- **No delegation control** — Agent A calls Agent B? Copy-paste credentials
- **No spending limits** — an agent with a cloud API key can provision unlimited resources

OAuth solved this for web apps. IAM solved it for cloud. **AI agents have nothing. Until now.**

---

## How It Works

<img src="docs/images/flow-diagram.svg" alt="Grantex Protocol Flow" width="100%"/>

---

## Quickstart

### 1. Register your agent

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const agent = await grantex.agents.register({
  name: 'travel-booker',
  description: 'Books flights and hotels on behalf of users',
  scopes: ['calendar:read', 'payments:initiate:max_500', 'email:send'],
});

console.log(agent.did);
// → did:grantex:ag_01HXYZ123abc...
```

### 2. Request authorization from a user

```typescript
const authRequest = await grantex.authorize({
  agentId: agent.id,
  userId: 'user_abc123',       // your app's user identifier
  scopes: ['calendar:read', 'payments:initiate:max_500'],
  expiresIn: '24h',
  redirectUri: 'https://yourapp.com/auth/callback',
});

// Redirect user to authRequest.consentUrl
// Grantex handles the consent UI — plain language, mobile-first
console.log(authRequest.consentUrl);
// → https://consent.grantex.dev/authorize?req=eyJ...
```

### 3. Exchange the authorization code for a grant token

```typescript
// After user approves, your redirectUri receives a `code`.
// Exchange it for a signed grant token (RS256 JWT):
const token = await grantex.tokens.exchange({
  code,                  // from the redirect callback
  agentId: agent.id,
});

console.log(token.grantToken);  // RS256 JWT — pass this to your agent
console.log(token.scopes);      // ['calendar:read', 'payments:initiate:max_500']
console.log(token.grantId);     // 'grnt_01HXYZ...'
```

### 4. Verify the token and use it

```typescript
// Verify offline — no network call needed (uses published JWKS)
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken(token.grantToken, {
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
  requiredScopes: ['calendar:read'],
});
console.log(grant.principalId); // 'user_abc123'
console.log(grant.scopes);     // ['calendar:read', 'payments:initiate:max_500']

// Pass to your agent — it's now authorized
await travelAgent.run({ grantToken: token.grantToken, task: 'Book cheapest flight to Delhi on March 1' });
```

### 5. Log every action

```typescript
// Inside your agent — one line, zero overhead
await grantex.audit.log({
  agentId: agent.id,
  grantId: token.grantId,
  action: 'payment.initiated',
  status: 'success',
  metadata: { amount: 420, currency: 'USD', merchant: 'Air India' },
});
```

### 6. Verify a token (service-side)

```typescript
// In any service that receives agent requests — no Grantex account needed
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken(token, {
  jwksUri: 'https://grantex.dev/.well-known/jwks.json',  // or cache locally
  requiredScopes: ['payments:initiate'],
});
// Throws if token is expired, revoked, tampered, or missing required scopes
```

### 7. Give users control over their permissions

```typescript
// Generate a short-lived link for the end-user to view & revoke agent access
const session = await grantex.principalSessions.create({
  principalId: 'user_abc123',
  expiresIn: '2h',
});
// Send session.dashboardUrl to the user via email, in-app notification, etc.
```

---

## Python SDK

```python
from grantex import Grantex, ExchangeTokenParams

client = Grantex(api_key=os.environ["GRANTEX_API_KEY"])

# Register agent
agent = client.agents.register(
    name="finance-agent",
    scopes=["transactions:read", "payments:initiate:max_100"],
)

# Authorize a user
auth = client.authorize(
    agent_id=agent.id,
    user_id="user_abc123",
    scopes=["transactions:read", "payments:initiate:max_100"],
)
# Redirect user to auth.consent_url — they approve in plain language

# Exchange the authorization code for a grant token
token = client.tokens.exchange(ExchangeTokenParams(code=code, agent_id=agent.id))

# Verify the token offline — no network call needed
from grantex import verify_grant_token, VerifyGrantTokenOptions

grant = verify_grant_token(token.grant_token, VerifyGrantTokenOptions(
    jwks_uri="https://api.grantex.dev/.well-known/jwks.json",
))
print(grant.scopes)  # ('transactions:read', 'payments:initiate:max_100')

# Log an action
client.audit.log(
    agent_id=agent.id,
    grant_id=token.grant_id,
    action="transaction.read",
    status="success",
    metadata={"account_last4": "4242"},
)
```

---

## The Grant Token

Grantex tokens are standard JWTs (RS256) extended with agent-specific claims. Any service can verify them offline using the published JWKS — no dependency on Grantex at runtime:

```json
{
  "iss": "https://grantex.dev",
  "sub": "user_abc123",
  "agt": "did:grantex:ag_01HXYZ123abc",
  "dev": "org_yourcompany",
  "scp": ["calendar:read", "payments:initiate:max_500"],
  "iat": 1709000000,
  "exp": 1709086400,
  "jti": "tok_01HXYZ987xyz",
  "grnt": "grnt_01HXYZ456def"
}
```

| Claim | Meaning |
|-------|---------|
| `sub` | The end-user who authorized this agent |
| `agt` | The agent's DID — cryptographically verifiable identity |
| `dev` | The developer org that built the agent |
| `scp` | Exact scopes granted — services should check these |
| `jti` | Unique token ID — used for real-time revocation |
| `grnt` | Grant record ID — links token to the persisted grant |
| `aud` | Intended audience (optional) — services should reject tokens with a mismatched `aud` |

**Delegation claims** (present on sub-agent tokens):

| Claim | Meaning |
|-------|---------|
| `parentAgt` | DID of the parent agent that spawned this sub-agent |
| `parentGrnt` | Grant ID of the parent grant — full delegation chain is traceable |
| `delegationDepth` | How many hops from the root grant (root = 0) |

---

## Multi-Agent Delegation

Grantex supports multi-agent pipelines where a root agent spawns sub-agents with narrower scopes. Sub-agent tokens carry a full delegation chain that any service can inspect.

```typescript
// Root agent has a grant for ['calendar:read', 'calendar:write', 'email:send']
// It spawns a sub-agent that only needs calendar read access

const delegated = await grantex.grants.delegate({
  parentGrantToken: rootGrantToken,   // root agent's token
  subAgentId: subAgent.id,            // sub-agent to authorize
  scopes: ['calendar:read'],          // must be ⊆ parent scopes
  expiresIn: '1h',                    // capped at parent token's expiry
});

// delegated.grantToken is a fully signed JWT with:
//   parentAgt, parentGrnt, delegationDepth = 1
```

```python
# Python equivalent
delegated = grantex.grants.delegate(
    parent_grant_token=root_grant_token,
    sub_agent_id=sub_agent.id,
    scopes=["calendar:read"],
    expires_in="1h",
)
```

**Constraints enforced by the protocol:**
- Sub-agent scopes must be a strict subset of the parent's scopes — scope escalation is rejected with 400
- Sub-agent token expiry is `min(parent expiry, requested expiry)` — sub-agents can never outlive their parent
- Revoking a root grant cascades to all descendant grants atomically

---

## Advanced Features

<details>
<summary><strong>FIDO2 / WebAuthn</strong> — passkey-based consent verification</summary>

## FIDO2 / WebAuthn

Grantex supports passkey-based human presence verification using the FIDO2/WebAuthn standard. When enabled, end-users prove they are physically present during the consent flow by authenticating with a passkey (biometric, security key, or platform authenticator). This raises the assurance level of every grant from "user clicked approve" to "user was cryptographically verified."

### How It Works

1. **Developer enables FIDO** — Set `fidoRequired: true` on your developer profile via `PATCH /v1/me`
2. **User registers a passkey** — During the first consent flow, the user registers a FIDO2 credential (fingerprint, Face ID, YubiKey, etc.)
3. **User authenticates on consent** — On subsequent authorization requests, the user completes a WebAuthn assertion challenge instead of a simple button click
4. **FIDO evidence embedded in grants** — The assertion result is recorded in the grant and can be embedded in Verifiable Credentials as cryptographic proof of human presence

### SDK Usage

```typescript
// Enable FIDO for your developer account
await grantex.updateSettings({ fidoRequired: true, fidoRpName: 'My App' });

// Register a passkey for an end-user (called from the browser)
const options = await grantex.webauthn.registerOptions({ principalId: 'user_abc123' });
// Pass options to navigator.credentials.create() in the browser
const credential = await navigator.credentials.create({ publicKey: options });
await grantex.webauthn.registerVerify({ challengeId: options.challengeId, response: credential });

// List and manage credentials
const creds = await grantex.webauthn.listCredentials('user_abc123');
await grantex.webauthn.deleteCredential(credentialId);
```

```python
# Enable FIDO for your developer account
client.update_settings(fido_required=True, fido_rp_name="My App")

# Register a passkey (server-side portion)
options = client.webauthn.register_options(principal_id="user_abc123")
# Browser performs navigator.credentials.create() and sends response back
result = client.webauthn.register_verify(challenge_id=options.challenge_id, response=credential_response)

# List and manage credentials
creds = client.webauthn.list_credentials("user_abc123")
client.webauthn.delete_credential(credential_id)
```

### WebAuthn API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/webauthn/register/options` | Generate passkey registration options |
| `POST` | `/v1/webauthn/register/verify` | Verify registration and store credential |
| `GET` | `/v1/webauthn/credentials` | List WebAuthn credentials for a principal |
| `DELETE` | `/v1/webauthn/credentials/:id` | Delete a credential |
| `POST` | `/v1/webauthn/assert/options` | Generate assertion options for consent |
| `POST` | `/v1/webauthn/assert/verify` | Verify assertion during consent |
| `PATCH` | `/v1/me` | Update developer settings (FIDO config) |

</details>

<details>
<summary><strong>Verifiable Credentials</strong> — W3C VC-JWT issuance and verification</summary>

## Verifiable Credentials

Grantex can issue W3C Verifiable Credentials (VCs) alongside standard JWTs. While JWTs are optimized for real-time authorization, VCs provide a portable, tamper-proof, standards-compliant proof of authorization that can be presented to any verifier — including systems outside the Grantex ecosystem.

### Why VCs Matter for Agents

In agentic commerce, an agent acting on your behalf needs to prove its authorization to third-party services that may not integrate with Grantex directly. A Verifiable Credential is a self-contained, cryptographically signed document that any party can verify using the issuer's published DID document — no API calls, no accounts, no trust relationships required.

### How It Works

When exchanging an authorization code for a grant token, pass `credentialFormat: "vc-jwt"` to receive a Verifiable Credential alongside the standard grant token:

```typescript
const result = await grantex.tokens.exchange({
  code,
  agentId: agent.id,
  credentialFormat: 'vc-jwt',   // opt-in to VC issuance
});

console.log(result.grantToken);         // standard RS256 JWT (unchanged)
console.log(result.verifiableCredential); // W3C VC-JWT
```

```python
result = client.tokens.exchange(ExchangeTokenParams(
    code=code,
    agent_id=agent.id,
    credential_format="vc-jwt",
))

print(result.verifiable_credential)  # W3C VC-JWT
```

### Credential Types

| Type | Description |
|------|-------------|
| `AgentGrantCredential` | Issued for direct grants — attests that a principal authorized an agent with specific scopes |
| `DelegatedGrantCredential` | Issued for delegated grants — includes the full delegation chain |

### Verifying a VC

```typescript
const verification = await grantex.credentials.verify(vcJwt);
console.log(verification.valid);
console.log(verification.credentialSubject);
console.log(verification.issuer); // "did:web:grantex.dev"
```

```python
verification = client.credentials.verify(vc_jwt)
print(verification.valid)
print(verification.credential_subject)
```

### Revocation via StatusList2021

Grantex implements the W3C StatusList2021 revocation mechanism. Each credential references a status list entry. When a grant is revoked, the corresponding bit in the status list is flipped, and any verifier checking the credential sees it as revoked.

```typescript
// Check a specific credential's status
const cred = await grantex.credentials.get(credentialId);
console.log(cred.status); // "active" or "revoked"

// List credentials with filters
const { credentials } = await grantex.credentials.list({
  grantId: 'grnt_01HXYZ...',
  status: 'active',
});
```

### FIDO Evidence in VCs

When FIDO is enabled and the user completes a WebAuthn assertion during consent, the VC includes a `fidoEvidence` field that cryptographically proves human presence at the time of authorization. This is compatible with the Mastercard Verifiable Intent specification for agentic commerce.

### DID Infrastructure

Grantex publishes a W3C DID document at `/.well-known/did.json` (`did:web:grantex.dev`). This document contains the public keys used to sign Verifiable Credentials, enabling any party to verify credentials without contacting Grantex:

```bash
curl https://api.grantex.dev/.well-known/did.json
```

### Verifiable Credentials API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/credentials/:id` | Retrieve a Verifiable Credential |
| `GET` | `/v1/credentials` | List Verifiable Credentials |
| `POST` | `/v1/credentials/verify` | Verify a VC-JWT |
| `GET` | `/v1/credentials/status/:id` | StatusList2021 credential |
| `GET` | `/.well-known/did.json` | W3C DID document |

</details>

<details>
<summary><strong>MPP Agent Identity</strong> — verifiable agent identity for machine payments</summary>

## MPP Agent Identity

MPP (Machine Payments Protocol) defines how AI agents pay for services via HTTP 402 flows. Grantex adds the missing identity layer: an `AgentPassportCredential` (W3C VC 2.0) that lets any merchant verify *who* authorized a payment, *what* the agent is allowed to buy, and *how much* it can spend — all in <50ms, offline-capable.

### Why Agent Passports?

When an agent makes an MPP payment today, the `source` field is a wallet address — no human name, no organization, no authorization chain. For $0.10 API calls, nobody cares. For $500 B2B procurement, this is a compliance blocker. Visa and Mastercard are building proprietary agent identity networks (Trusted Agent Protocol, AgentPay), but these are closed and non-interoperable.

Grantex passports are the open, standards-based answer: a W3C VC 2.0 credential signed with Ed25519, carrying the full delegation chain from human to agent, with StatusList2021 revocation and a public trust registry.

### How It Works

```
  Human Principal          AgentPassportCredential           AI Agent              Merchant              Audit
  ━━━━━━━━━━━━━━━          ━━━━━━━━━━━━━━━━━━━━━━━           ━━━━━━━━              ━━━━━━━━              ━━━━━
       │                                                        │                     │                   │
       │  1. Issue passport                                     │                     │                   │
       │──────────────────────▶ W3C VC 2.0                      │                     │                   │
       │                       Ed25519 signed                   │                     │                   │
       │                       Categories: [inference, compute] │                     │                   │
       │                       Max: 50 USDC                     │                     │                   │
       │                       Expiry: 24h                      │                     │                   │
       │                                  │                     │                     │                   │
       │                                  │  2. Store           │                     │                   │
       │                                  └────────────────────▶│                     │                   │
       │                                                        │                     │                   │
       │                                                        │  3. MPP payment +   │                   │
       │                                                        │  X-Grantex-Passport │                   │
       │                                                        │────────────────────▶│                   │
       │                                                        │                     │                   │
       │                                                        │  4. Verify (<50ms)  │                   │
       │                                                        │                     │──▶ Sig + Expiry   │
       │                                                        │                     │──▶ Categories     │
       │                                                        │                     │──▶ Amount limit   │
       │                                                        │                     │                   │
       │                                                        │  5. ✓ Deliver       │  6. Log           │
       │                                                        │◀────────────────────│──────────────────▶│
       │                                                        │                     │                   │
```

> **Key insight**: The passport is a self-contained W3C VC — merchants verify it offline using cached JWKS. No API call to Grantex needed after the initial key fetch.

### Credential Structure

| Field | Description |
|-------|-------------|
| `id` | `urn:grantex:passport:<ulid>` |
| `issuer` | `did:web:grantex.dev` |
| `credentialSubject.id` | Agent DID (`did:grantex:ag_...`) |
| `credentialSubject.humanPrincipal` | DID of the authorizing human |
| `credentialSubject.organizationDID` | Org DID (`did:web:<domain>`) |
| `credentialSubject.grantId` | Links to underlying Grantex grant |
| `credentialSubject.allowedMPPCategories` | `inference`, `compute`, `data`, `storage`, `search`, `media`, `delivery`, `browser`, `general` |
| `credentialSubject.maxTransactionAmount` | `{ amount, currency }` ceiling per transaction |
| `credentialSubject.delegationDepth` | Inherited from grant delegation chain |
| `credentialStatus` | StatusList2021 revocation entry |
| `proof` | Ed25519Signature2020 |

### Issue a Passport

**TypeScript:**

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const passport = await grantex.passports.issue({
  agentId: 'ag_01HXYZ...',
  grantId: 'grnt_01HXYZ...',
  allowedMPPCategories: ['inference', 'compute'],
  maxTransactionAmount: { amount: 50, currency: 'USDC' },
  paymentRails: ['tempo'],
  expiresIn: '24h',
});
// passport.passportId   → "urn:grantex:passport:01HXYZ..."
// passport.encodedCredential → base64url for X-Grantex-Passport header
```

**cURL:**

```bash
curl -X POST https://api.grantex.dev/v1/passport/issue \
  -H "Authorization: Bearer $GRANTEX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "ag_01HXYZ...",
    "grantId": "grnt_01HXYZ...",
    "allowedMPPCategories": ["inference", "compute"],
    "maxTransactionAmount": { "amount": 50, "currency": "USDC" },
    "expiresIn": "24h"
  }'
```

### Attach to MPP Requests

```typescript
import { createMppPassportMiddleware } from '@grantex/mpp';

const middleware = createMppPassportMiddleware({ passport });
const enrichedRequest = await middleware(new Request(url, init));
// enrichedRequest now has X-Grantex-Passport header
const response = await fetch(enrichedRequest);
```

### Verify on the Merchant Side

**Standalone verification:**

```typescript
import { verifyPassport } from '@grantex/mpp';

const verified = await verifyPassport(encodedCredential, {
  requiredCategories: ['inference'],
  maxAmount: 10,
});
// verified.humanDID        → "did:grantex:user_alice"
// verified.organizationDID → "did:web:acme.com"
// verified.allowedCategories → ["inference", "compute"]
// verified.maxTransactionAmount → { amount: 50, currency: "USDC" }
```

**Express middleware (one-liner):**

```typescript
import { requireAgentPassport } from '@grantex/mpp';

app.use('/api/inference', requireAgentPassport({
  requiredCategories: ['inference'],
  maxAmount: 10,
}));
// req.agentPassport is populated on valid requests
// 403 with typed error code on invalid requests
```

### Trust Registry

Query any organization's verified trust level — no authentication required:

```bash
curl https://api.grantex.dev/v1/trust-registry/did:web:grantex.dev
# {"organizationDID":"did:web:grantex.dev","trustLevel":"soc2","domains":["grantex.dev"]}
```

```typescript
import { lookupOrgTrust } from '@grantex/mpp';

const record = await lookupOrgTrust('did:web:acme.com');
// record.trustLevel → "verified" | "soc2" | "basic"
// record.verificationMethod → "dns-txt" | "manual" | "soc2"
```

### Revocation

Revoking a passport flips a StatusList2021 bit — propagates instantly:

```typescript
await grantex.passports.revoke('urn:grantex:passport:01HXYZ...');
// Subsequent verifyPassport() calls return PASSPORT_REVOKED
```

### Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `PASSPORT_EXPIRED` | 403 | Credential `validUntil` has passed |
| `PASSPORT_REVOKED` | 403 | StatusList2021 bit is set |
| `INVALID_SIGNATURE` | 403 | Signature verification failed |
| `UNTRUSTED_ISSUER` | 403 | Issuer DID not in trusted list |
| `CATEGORY_MISMATCH` | 403 | Categories don't cover required service |
| `AMOUNT_EXCEEDED` | 403 | Max amount below required threshold |
| `MISSING_PASSPORT` | 403 | No `X-Grantex-Passport` header |
| `MALFORMED_CREDENTIAL` | 403 | Invalid base64url or missing VC fields |

### MPP Agent Identity API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/v1/passport/issue` | API key | Issue AgentPassportCredential |
| `GET` | `/v1/passport/:id` | API key | Retrieve passport by ID |
| `POST` | `/v1/passport/:id/revoke` | API key | Revoke passport (StatusList2021) |
| `GET` | `/v1/trust-registry/:orgDID` | None | Look up org trust record (public) |
| `GET` | `/v1/trust-registry` | API key | List all trust records (admin) |

See [`packages/mpp/`](packages/mpp/) for full package docs. Demo: [grantex.dev/mpp-demo](https://grantex.dev/mpp-demo).

</details>

<details>
<summary><strong>SD-JWT Selective Disclosure</strong> — privacy-preserving credential presentation</summary>

## SD-JWT Selective Disclosure

Grantex supports SD-JWT (Selective Disclosure JWT) for privacy-preserving credential presentation. While a standard VC-JWT reveals all claims to every verifier, SD-JWT lets the holder choose exactly which fields to disclose — keeping everything else hidden.

### Why SD-JWT?

In agentic commerce, different verifiers need different levels of information. A payment processor needs to know the agent's scopes and budget, but not the principal's identity. A compliance auditor needs the principal and timestamps, but not the scopes. SD-JWT enables minimum-disclosure presentations that satisfy each verifier's requirements without over-sharing.

### How It Works

When exchanging an authorization code, pass `credentialFormat: "sd-jwt"` to receive an SD-JWT credential:

```typescript
const result = await grantex.tokens.exchange({
  code,
  agentId: agent.id,
  credentialFormat: 'sd-jwt',   // opt-in to SD-JWT issuance
});

console.log(result.grantToken);         // standard RS256 JWT (unchanged)
console.log(result.sdJwt);              // SD-JWT with selective disclosure
```

```python
result = client.tokens.exchange(ExchangeTokenParams(
    code=code,
    agent_id=agent.id,
    credential_format="sd-jwt",
))

print(result.sd_jwt)  # SD-JWT with selective disclosure
```

### Creating a Presentation

The holder selects which claims to disclose when presenting to a verifier:

```typescript
const presentation = await grantex.credentials.present({
  sdJwt: result.sdJwt,
  disclosedClaims: ['scopes', 'agentId'],   // only reveal these fields
});

// Send presentation to the verifier — they see scopes and agentId,
// but principalId, developerId, grantId, etc. remain hidden
```

```python
presentation = client.credentials.present(
    sd_jwt=result.sd_jwt,
    disclosed_claims=["scopes", "agent_id"],
)
```

### SD-JWT Format

An SD-JWT consists of: `<issuer-jwt>~<disclosure1>~<disclosure2>~...~`

Each disclosure is a base64url-encoded JSON array `[salt, claim-name, claim-value]`. The verifier can only see claims for which a disclosure is provided.

### Disclosable Claims

| Claim | Description |
|-------|-------------|
| `principalId` | The end-user who authorized the grant |
| `developerId` | The developer who owns the agent |
| `scopes` | The authorized scopes |
| `agentId` | The agent's DID |
| `grantId` | The grant record identifier |
| `issuedAt` | When the credential was issued |
| `expiresAt` | When the credential expires |

### SD-JWT API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/token` | Exchange code for grant token + SD-JWT (with `credentialFormat: "sd-jwt"`) |
| `POST` | `/v1/credentials/verify` | Verify an SD-JWT presentation |

</details>

<details>
<summary><strong>Budget Controls</strong> — per-agent spending limits with atomic debit</summary>

## Budget Controls

Grantex provides per-grant budget controls that let developers cap how much an agent can spend. Budget allocations are enforced atomically — if a debit would exceed the remaining balance, it fails with a 402 `INSUFFICIENT_BUDGET` error. Threshold alerts fire at 50% and 80% consumption, and the remaining budget is embedded in grant tokens via the `bdg` JWT claim.

```typescript
// Allocate a budget to a grant
const budget = await grantex.budgets.allocate({
  grantId: 'grnt_01HXYZ...',
  amount: 1000,
  currency: 'USD',
});

// Debit against the budget
const debit = await grantex.budgets.debit({
  grantId: 'grnt_01HXYZ...',
  amount: 42.50,
  description: 'Flight booking',
});
console.log(debit.remaining); // 957.50

// Check the current balance
const balance = await grantex.budgets.balance('grnt_01HXYZ...');
console.log(balance.remainingBudget);

// List all budget transactions for a grant
const { transactions } = await grantex.budgets.transactions('grnt_01HXYZ...');
```

```python
# Allocate a budget to a grant
budget = client.budgets.allocate(
    grant_id="grnt_01HXYZ...",
    amount=1000,
    currency="USD",
)

# Debit against the budget
debit = client.budgets.debit(
    grant_id="grnt_01HXYZ...",
    amount=42.50,
    description="Flight booking",
)
print(debit.remaining)  # 957.50

# Check the current balance
balance = client.budgets.balance("grnt_01HXYZ...")

# List all budget transactions
transactions = client.budgets.transactions("grnt_01HXYZ...")
```

### Budget API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/budget/allocate` | Create a budget allocation for a grant |
| `POST` | `/v1/budget/debit` | Debit against a grant's budget (402 if insufficient) |
| `GET` | `/v1/budget/balance/:grantId` | Get remaining balance for a grant |
| `GET` | `/v1/budget/allocations` | List all budget allocations |
| `GET` | `/v1/budget/transactions/:grantId` | List transactions and total spend for a grant |

</details>

<details>
<summary><strong>Event Streaming</strong> — real-time SSE and WebSocket</summary>

## Event Streaming

Grantex provides real-time event streaming via Server-Sent Events (SSE) and WebSocket. Subscribe to authorization lifecycle events as they happen — grant creation, revocation, token issuance, and budget threshold alerts. Events are published to both webhooks and streaming endpoints, so you can choose push or pull.

```typescript
// SSE — async generator, automatically reconnects
for await (const event of grantex.events.stream()) {
  console.log(event.type);   // 'grant.created', 'token.issued', etc.
  console.log(event.data);
}

// Convenience wrapper with a callback
grantex.events.subscribe((event) => {
  if (event.type === 'budget.threshold') {
    alert(`Grant ${event.data.grantId} is at ${event.data.percentage}% budget`);
  }
});
```

```python
# SSE — async generator
async for event in client.events.stream():
    print(event.type)   # 'grant.created', 'grant.revoked', etc.
    print(event.data)

# Convenience wrapper
async def handler(event):
    if event.type == "budget.exhausted":
        await revoke_grant(event.data["grant_id"])

await client.events.subscribe(handler)
```

### Event Types

| Event | Description |
|-------|-------------|
| `grant.created` | A new grant was approved by an end-user |
| `grant.revoked` | A grant was revoked (by user, developer, or cascade) |
| `token.issued` | A grant token was exchanged or refreshed |
| `budget.threshold` | A budget allocation crossed 50% or 80% usage |
| `budget.exhausted` | A budget allocation reached 0 remaining |

### Event Streaming API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/events/stream` | SSE event stream (Bearer auth) |
| `GET` | `/v1/events/ws` | WebSocket event stream |

</details>

<details>
<summary><strong>Usage Metering</strong> — track API consumption per developer</summary>

## Usage Metering

Grantex tracks API usage per developer — token exchanges, authorization requests, and verification calls. Use the metering API to monitor consumption, enforce plan limits, and export usage data for billing.

```typescript
// Get current period usage
const usage = await grantex.usage.current();
console.log(usage.tokenExchanges);
console.log(usage.authorizations);
console.log(usage.totalRequests);

// Get usage history over the last 30 days
const { entries } = await grantex.usage.history({ days: 30 });
entries.forEach((e) => console.log(`${e.date}: ${e.totalRequests} requests`));
```

```python
# Get current period usage
usage = client.usage.current()
print(usage.token_exchanges)
print(usage.total_requests)

# Get usage history over the last 30 days
history = client.usage.history(days=30)
for entry in history.entries:
    print(f"{entry.date}: {entry.total_requests} requests")
```

### Usage Metering API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/usage` | Current period usage for the authenticated developer |
| `GET` | `/v1/usage/history?days=N` | Daily usage history for the last N days |

</details>

<details>
<summary><strong>Custom Domains</strong> — white-label consent UI and API endpoints</summary>

## Custom Domains

Grantex supports custom domains for white-labeling the consent UI and API endpoints. Register your domain, verify ownership via DNS TXT record, and all Grantex-hosted consent pages will be served under your brand.

```typescript
// Register a custom domain
const domain = await grantex.domains.create({ domain: 'auth.yourapp.com' });
console.log(domain.verificationToken);
// → Add a DNS TXT record: _grantex-verify.auth.yourapp.com = <token>

// Verify the domain after adding the DNS record
const verified = await grantex.domains.verify(domain.id);
console.log(verified.verified); // true

// List all registered domains
const { domains } = await grantex.domains.list();

// Delete a domain
await grantex.domains.delete(domain.id);
```

```python
# Register a custom domain
domain = client.domains.create(domain="auth.yourapp.com")
print(domain.verification_token)

# Verify after adding DNS TXT record
verified = client.domains.verify(domain.id)
print(verified.verified)  # True

# List all domains
domains = client.domains.list()

# Delete a domain
client.domains.delete(domain.id)
```

### Custom Domains API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/domains` | Register a new custom domain |
| `GET` | `/v1/domains` | List all registered domains |
| `POST` | `/v1/domains/:id/verify` | Verify domain ownership via DNS TXT |
| `DELETE` | `/v1/domains/:id` | Remove a custom domain |

</details>

<details>
<summary><strong>Policy-as-Code</strong> — OPA and Cedar policy backends</summary>

## Policy-as-Code

Grantex supports pluggable policy backends for fine-grained authorization decisions. In addition to the built-in policy engine, you can connect OPA (Open Policy Agent) or Cedar to evaluate authorization requests against externally managed policy bundles. Policy bundles can be synced via direct upload or triggered automatically from a git repository webhook.

```typescript
// Upload a policy bundle
await grantex.policies.sync({
  format: 'opa',           // 'opa' or 'cedar'
  bundle: bundleBuffer,    // policy bundle as Buffer
});

// List policy bundles
const { bundles } = await grantex.policies.bundles();
```

```python
# Upload a policy bundle
client.policies.sync(
    format="opa",
    bundle=bundle_bytes,
)

# List policy bundles
bundles = client.policies.bundles()
```

### Supported Policy Backends

| Backend | Description | Config |
|---------|-------------|--------|
| **Builtin** | Default rule engine — scope matching + delegation constraints | No config needed |
| **OPA** | Open Policy Agent — Rego policies evaluated at `POST /v1/data/grantex/authz` | `POLICY_BACKEND=opa`, `OPA_URL=...` |
| **Cedar** | AWS Cedar — Cedar policies evaluated at `POST /v1/is_authorized` | `POLICY_BACKEND=cedar`, `CEDAR_URL=...` |

### Policy-as-Code API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/policies/sync` | Upload a policy bundle (OPA or Cedar) |
| `POST` | `/v1/policies/sync/webhook` | Git webhook trigger for policy sync |
| `GET` | `/v1/policies/bundles` | List uploaded policy bundles |

</details>

---

## Local Development

Start the full stack with one command:

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex
docker compose up --build
```

Two API keys are seeded automatically:

| Key | Mode | Use for |
|-----|------|---------|
| `dev-api-key-local` | live | full consent flow with redirect |
| `sandbox-api-key-local` | sandbox | skip consent UI — get a `code` immediately |

**Sandbox mode** is designed for testing. With a sandbox key, `POST /v1/authorize` returns a `code` in the response body — no redirect required:

```bash
# Authorize + get code in one step
curl -s -X POST http://localhost:3001/v1/authorize \
  -H "Authorization: Bearer sandbox-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"<id>","principalId":"test-user","scopes":["calendar:read"]}'
# → { ..., "sandbox": true, "code": "01J..." }

# Exchange immediately for a grant token
curl -s -X POST http://localhost:3001/v1/token \
  -H "Authorization: Bearer sandbox-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"code":"<code>","agentId":"<id>"}'
```

**Developer portal** is available at [grantex.dev/dashboard](https://grantex.dev/dashboard) — sign up or enter an API key to manage agents, grants, policies, anomalies, compliance exports, and billing from the browser.

For local development, the auth service also serves a lightweight dashboard at `http://localhost:3001/dashboard`.

See the [self-hosting guide](https://grantex.dev/docs/guides/self-hosting) for production deployment guidance.

---

## Why an Open Standard?

Grantex is built as an **open protocol**, not a closed SaaS product. Here's why that matters:

**Model-neutral.** Works with OpenAI, Anthropic, Google, Llama, Mistral — any model, any framework. No single AI provider can credibly own the authorization layer for their competitors' agents.

**Framework-native.** First-class integrations for LangChain, AutoGen, CrewAI, and plain code. Install one package, get Grantex in your existing stack.

**Offline-verifiable.** Services verify tokens using published JWKS — zero runtime dependency on Grantex infrastructure. Your agent works even if our servers are down.

**Compliance-ready.** The EU AI Act, GDPR, and emerging US AI regulations will mandate auditable agent actions. Grantex gives you that on day one.

---

## Scope Naming Convention

Grantex defines a standard scope format: `resource:action[:constraint]`

| Scope | Meaning |
|-------|---------|
| `calendar:read` | Read calendar events |
| `calendar:write` | Create and modify events |
| `email:send` | Send emails on user's behalf |
| `payments:initiate:max_500` | Initiate payments up to $500 |
| `files:read` | Read user files |
| `profile:read` | Read user profile |

Service providers implement scope definitions for their APIs. Agents declare which scopes they need. Users see plain-language descriptions, never raw scope strings.

---

## Integrations

| Framework | Package | Install | Status |
|-----------|---------|---------|--------|
| **Adapters** | `@grantex/adapters` | `npm install @grantex/adapters` | ✅ Shipped |
| **MCP Auth Server** | `@grantex/mcp-auth` | `npm install @grantex/mcp-auth` | ✅ Shipped |
| **Gateway** | `@grantex/gateway` | `npm install @grantex/gateway` | ✅ Shipped |
| **Express.js** | `@grantex/express` | `npm install @grantex/express` | ✅ Shipped |
| **FastAPI** | `grantex-fastapi` | `pip install grantex-fastapi` | ✅ Shipped |
| **LangChain** | `@grantex/langchain` | `npm install @grantex/langchain` | ✅ Shipped |
| **AutoGen / OpenAI** | `@grantex/autogen` | `npm install @grantex/autogen` | ✅ Shipped |
| **CrewAI** | `grantex-crewai` | `pip install grantex-crewai` | ✅ Shipped |
| **OpenAI Agents SDK** | `grantex-openai-agents` | `pip install grantex-openai-agents` | ✅ Shipped |
| **Google ADK** | `grantex-adk` | `pip install grantex-adk` | ✅ Shipped |
| **Vercel AI SDK** | `@grantex/vercel-ai` | `npm install @grantex/vercel-ai` | ✅ Shipped |
| **TypeScript SDK** | `@grantex/sdk` | `npm install @grantex/sdk` | ✅ Shipped |
| **Python SDK** | `grantex` | `pip install grantex` | ✅ Shipped |
| **Go SDK** | `grantex-go` | `go get github.com/mishrasanjeev/grantex-go` | ✅ Shipped |
| **CLI** | `@grantex/cli` | `npm install -g @grantex/cli` | ✅ Shipped |
| **Conformance Suite** | `@grantex/conformance` | `npm install -g @grantex/conformance` | ✅ Shipped |
| **A2A Bridge (TS)** | `@grantex/a2a` | `npm install @grantex/a2a` | ✅ Shipped |
| **A2A Bridge (Py)** | `grantex-a2a` | `pip install grantex-a2a` | ✅ Shipped |
| **Event Destinations** | `@grantex/destinations` | `npm install @grantex/destinations` | ✅ Shipped |
| **Terraform Provider** | `terraform-provider-grantex` | `terraform { required_providers { grantex = { source = "mishrasanjeev/grantex" } } }` | ✅ Shipped |

### Framework Quick Examples

**Express.js** — grant token verification + scope-based authorization:

```typescript
import express from 'express';
import { requireGrantToken, requireScopes } from '@grantex/express';

const JWKS_URI = 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json';

app.use('/api', requireGrantToken({ jwksUri: JWKS_URI }));
app.get('/api/calendar', requireScopes('calendar:read'), (req, res) => {
  res.json({ principalId: req.grant.principalId, scopes: req.grant.scopes });
});
```

**FastAPI** — dependency injection with scope enforcement:

```python
from fastapi import Depends, FastAPI
from grantex import VerifiedGrant
from grantex_fastapi import GrantexAuth, GrantexFastAPIError, grantex_exception_handler

app = FastAPI()
app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)
grantex = GrantexAuth(jwks_uri="https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json")

@app.get("/api/calendar")
async def calendar(grant: VerifiedGrant = Depends(grantex.scopes("calendar:read"))):
    return {"principalId": grant.principal_id}
```

**LangChain** — scope-enforced tools + audit callbacks:

```typescript
import { createGrantexTool } from '@grantex/langchain';

const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  grantToken,
  requiredScope: 'calendar:read',
  func: async (input) => JSON.stringify(await getCalendarEvents(input)),
});
// Use with any LangChain agent — scope checked offline from JWT
```

**Vercel AI SDK** — scope checked at construction time:

```typescript
import { createGrantexTool } from '@grantex/vercel-ai';
import { z } from 'zod';

const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: z.object({ date: z.string() }),
  grantToken,
  requiredScope: 'calendar:read',
  execute: async (args) => await getCalendarEvents(args.date),
});
// Use with generateText, streamText, etc.
```

**AutoGen / OpenAI function calling**:

```typescript
import { createGrantexFunction, GrantexFunctionRegistry } from '@grantex/autogen';

const fn = createGrantexFunction({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
  grantToken,
  requiredScope: 'calendar:read',
  func: async (args) => await getCalendarEvents(args.date),
});

// Pass fn.definition to OpenAI, call fn.execute() when selected
```

**CrewAI** (Python):

```python
from grantex_crewai import GrantexTool

tool = GrantexTool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Use with any CrewAI agent
```

**OpenAI Agents SDK** (Python):

```python
from grantex_openai_agents import create_grantex_tool

tool = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Returns a FunctionTool — use with any OpenAI Agents SDK agent
```

**Google ADK** (Python):

```python
from grantex_adk import create_grantex_tool

read_calendar = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Returns a plain function — pass directly to google.adk.Agent(tools=[...])
```

**CLI**:

```bash
grantex config set --url https://grantex-auth-dd4mtrt2gq-uc.a.run.app --key YOUR_API_KEY
grantex agents list
grantex grants list --status active
grantex audit list --since 2026-01-01
grantex anomalies detect
grantex compliance summary
```

---

## Interactive Playground

Try the full Grantex authorization flow live in your browser — no signup required:

**[grantex.dev/playground](https://grantex.dev/playground)**

Walk through all 7 steps of the protocol: register an agent, authorize, exchange tokens, verify, refresh, revoke, and verify revocation. Uses sandbox mode with your API key.

---

## Examples

| Example | Description | Run |
|---------|-------------|-----|
| [`quickstart-ts`](examples/quickstart-ts) | Core authorization flow — register, authorize, exchange, verify, audit, revoke | `npm start` |
| [`quickstart-py`](examples/quickstart-py) | Same flow in Python | `python main.py` |
| [`nextjs-starter`](examples/nextjs-starter) | **Interactive Next.js app** — full consent UI flow in the browser | `npm run dev` |
| [`langchain-agent`](examples/langchain-agent) | LangChain agent with scope-enforced tools | `npm start` |
| [`vercel-ai-chatbot`](examples/vercel-ai-chatbot) | Vercel AI SDK chatbot with Grantex tools | `npm start` |
| [`crewai-agent`](examples/crewai-agent) | CrewAI agent with Grantex authorization | `python main.py` |
| [`openai-agents`](examples/openai-agents) | OpenAI Agents SDK integration | `python main.py` |
| [`google-adk`](examples/google-adk) | Google ADK agent with Grantex tools | `python main.py` |
| [`gateway-proxy`](examples/gateway-proxy) | Gateway reverse proxy with YAML config and scope enforcement | `npm start` |
| [`adapter-google-calendar`](examples/adapter-google-calendar) | GoogleCalendarAdapter with grant token verification | `npm start` |
| [`multi-agent-delegation`](examples/multi-agent-delegation) | Parent/child delegation with cascade revocation | `npm start` |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         YOUR APPLICATION                             │
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐ │
│   │  AI Agent    │    │  Grantex SDK │    │  End User Dashboard   │ │
│   │  (any model) │◄──►│  (2 lines)   │    │  (view / revoke)      │ │
│   └──────────────┘    └──────┬───────┘    └───────────────────────┘ │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         GRANTEX PROTOCOL                             │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────┐  │
│  │  Identity   │  │     Auth     │  │   Consent   │  │  Audit   │  │
│  │  Service    │  │   Service    │  │     UI      │  │  Chain   │  │
│  │  (DID/JWKS) │  │ (token i/o)  │  │  (hosted)   │  │ (append) │  │
│  └─────────────┘  └──────────────┘  └─────────────┘  └──────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                ┌──────────────────────────┐
                │  Any Service / API       │
                │  Verifies via JWKS       │
                │  No Grantex dep needed   │
                └──────────────────────────┘
```

---

## Roadmap

All milestones through v1.0 are complete. See [ROADMAP.md](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md) for full details.

| Milestone | Highlights | Status |
|-----------|-----------|--------|
| **v0.1 — Foundation** | Protocol spec, TypeScript & Python SDKs, auth service, consent UI, audit trail, multi-agent delegation, sandbox mode | ✅ Complete |
| **v0.2 — Integrations** | LangChain, AutoGen, webhooks, Stripe billing, CLI | ✅ Complete |
| **v0.3 — Enterprise** | CrewAI, Vercel AI, compliance exports, policy engine, SCIM/SSO, anomaly detection | ✅ Complete |
| **v1.0 — Stable Protocol** | Protocol spec finalized (v1.0), security audit, SOC2, standards submission | ✅ Complete |
| **v2.0 — Platform** | MCP Auth Server, Credential Vault, 7 new adapters, webhook delivery log, examples | ✅ Complete |
| **v2.1 — Enterprise Scale** | Event streaming, budget controls, observability, Terraform provider, gateway, conformance | ✅ Complete |
| **v2.2 — Ecosystem** | OPA/Cedar policy backends, A2A protocol bridge, usage metering, custom domains, policy-as-code | ✅ Complete |
| **v2.3 — Trust & Identity** | FIDO2/WebAuthn passkeys, W3C Verifiable Credentials, SD-JWT selective disclosure, DID infrastructure, StatusList2021 revocation, Mastercard Verifiable Intent | ✅ Complete |

---

## Contributing

Grantex is open-source and welcomes contributions:

1. **Report bugs** — open a [GitHub Issue](https://github.com/mishrasanjeev/grantex/issues) with reproduction steps
2. **Propose features** — open a [GitHub Discussion](https://github.com/mishrasanjeev/grantex/discussions) with your use case
3. **Build new integrations** — add Grantex support to your favorite framework
4. **Improve docs** — better examples, tutorials, and translations

Read [CONTRIBUTING.md](https://github.com/mishrasanjeev/grantex/blob/main/CONTRIBUTING.md) before submitting a PR.

---

## Standards & Compliance

| | |
|---|---|
| **IETF** | Internet-Draft submitted to OAuth Working Group ([draft-mishra-oauth-agent-grants-01](https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/)) |
| **NIST** | NCCoE public comment filed |
| **AuthZEN** | Conformance mapped |
| **SOC 2** | Type I certification completed |
| **Protocol Spec** | [v1.0 Final](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md) — frozen, open, Apache 2.0 |

---

## Trusted By

> Using Grantex in production? [Open a PR](https://github.com/mishrasanjeev/grantex/edit/main/README.md) to add your company here.

<!--
Add your company logo here:
<a href="https://yourcompany.com"><img src="https://yourcompany.com/logo.svg" height="40" alt="YourCompany"/></a>
-->

---

## FAQ

**Is this just another auth library?**  
No. Existing auth systems (Auth0, Okta, Supabase) are built for humans logging in. Grantex is built for autonomous agents acting on behalf of humans — a fundamentally different trust model with different primitives (delegation, scope chains, agent identity, real-time revocation, action audit trails).

**Why not just use OAuth 2.0?**  
OAuth 2.0 was designed for "user grants app permission to access their data." Agents introduce new requirements: the agent needs a verifiable identity separate from its creator, grants need to be chainable across multi-agent pipelines, and every autonomous action must be attributable and auditable. We extend OAuth 2.0 concepts but add the agent-specific primitives it lacks.

**What about MCP (Model Context Protocol)?**  
MCP solves tool connectivity — how agents access data and call functions. Grantex solves trust — proving that an agent is authorized to use those tools on behalf of a specific human. They're complementary. A Grantex-authorized agent uses MCP tools.

**Who owns the standard?**  
The protocol spec is open (Apache 2.0). Grantex Inc. maintains a hosted reference implementation. Our goal is to contribute the spec to a neutral standards body (W3C, IETF, or CNCF) once it stabilizes.

**Can I self-host?**  
Yes. The reference implementation is fully open-source. Docker Compose deploy in one command. See the [self-hosting guide](https://grantex.dev/docs/guides/self-hosting).

---

## License

Protocol specification and SDKs: [Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

---

<div align="center">

**[Docs](https://grantex.dev/docs)** · **[Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)** · **[Dashboard](https://grantex.dev/dashboard)** · **[Self-Hosting](https://grantex.dev/docs/guides/self-hosting)** · **[Roadmap](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md)** · **[Contributing](https://grantex.dev/docs/community/contributing)** · **[GitHub](https://github.com/mishrasanjeev/grantex)**

<br/>

*Building the trust layer for the agentic internet.*

</div>
