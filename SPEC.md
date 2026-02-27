# Grantex Protocol Specification

**Version:** 1.0
**Status:** Final
**Last updated:** February 2026 (rev 3)

> Specification is now frozen. Changes require a new version.

---

## Abstract

Grantex defines an open protocol for delegated authorization of AI agents acting on behalf of human users. It specifies: cryptographic agent identity, a human-consent-based grant flow, a signed token format, a revocation model, an append-only audit trail schema, a policy engine for automated authorization decisions, enterprise identity federation, and anomaly detection for runtime behavioral monitoring.

---

## 1. Motivation

AI agents increasingly take autonomous actions — submitting forms, initiating payments, sending communications — on behalf of humans across third-party services. No interoperable standard exists for:

1. Verifying that an agent is who it claims to be
2. Confirming that a specific human authorized a specific agent to perform a specific action
3. Revoking that authorization in real time
4. Producing a tamper-proof record of what the agent did

Grantex fills this gap as an open, model-neutral, framework-agnostic protocol.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Agent** | An AI-powered software process that takes autonomous actions on behalf of a Principal |
| **Principal** | The human user who authorizes an Agent to act on their behalf |
| **Developer** | The organization or individual who built and operates the Agent |
| **Service** | Any API or platform that receives requests from an Agent |
| **Grant** | A record of permission given by a Principal to an Agent for specific Scopes |
| **Grant Token** | A signed JWT representing a valid, non-revoked Grant |
| **Scope** | A named permission following the format `resource:action[:constraint]` |
| **DID** | Decentralized Identifier — the Agent's cryptographic identity |
| **Policy** | A rule that auto-approves or auto-denies an authorization before the consent UI is shown, evaluated by the Policy Engine |
| **Anomaly** | A detected behavioral deviation from an agent's established activity baseline |

---

## 3. Agent Identity

### 3.1 DID Format

Every Agent registered with a Grantex-compatible Identity Service receives a DID:

```
did:grantex:<agent_id>
```

Where `<agent_id>` is a ULID (Universally Unique Lexicographically Sortable Identifier).

Example: `did:grantex:ag_01HXYZ123abcDEF456ghi`

### 3.2 Identity Document

The DID resolves to an identity document containing:

```json
{
  "@context": "https://grantex.dev/v1/identity",
  "id": "did:grantex:ag_01HXYZ123abcDEF456ghi",
  "developer": "org_yourcompany",
  "name": "travel-booker",
  "description": "Books flights and hotels on behalf of users",
  "declaredScopes": ["calendar:read", "payments:initiate:max_500"],
  "status": "active",
  "createdAt": "2026-02-01T00:00:00Z",
  "verificationMethod": [{
    "id": "did:grantex:ag_01HXYZ123abcDEF456ghi#key-1",
    "type": "JsonWebKey2020",
    "publicKeyJwk": { ... }
  }]
}
```

### 3.3 Key Management

- Identity Services MUST use RS256 (RSA + SHA-256) for signing
- Private keys MUST never leave the Identity Service
- Public keys MUST be published at `/.well-known/jwks.json`
- Key rotation MUST be supported without changing the DID

---

## 4. Scopes

### 4.1 Format

```
resource:action[:constraint]
```

- `resource` — the data or service being accessed (e.g., `calendar`, `payments`, `email`)
- `action` — the operation (e.g., `read`, `write`, `send`, `initiate`, `delete`)
- `constraint` *(optional)* — a limiting parameter (e.g., `max_500` for a spending limit)

### 4.2 Standard Scope Registry

| Scope | Description |
|-------|-------------|
| `calendar:read` | Read calendar events |
| `calendar:write` | Create, modify, and delete calendar events |
| `email:read` | Read email messages |
| `email:send` | Send emails on the Principal's behalf |
| `email:delete` | Delete email messages |
| `files:read` | Read files and documents |
| `files:write` | Create and modify files |
| `payments:read` | View payment history and balances |
| `payments:initiate` | Initiate payments of any amount |
| `payments:initiate:max_N` | Initiate payments up to N in the account's base currency |
| `profile:read` | Read profile and identity information |
| `contacts:read` | Read address book and contacts |

### 4.3 Custom Scopes

Services MAY define custom scopes using reverse-domain notation:

```
com.stripe.charges:create:max_5000
io.github.issues:create
```

### 4.4 Scope Governance

Grantex maintains the canonical scope registry in §4.2 as normative. Implementations MUST support all standard scopes. Custom scopes MUST use reverse-domain notation. The Grantex working group governs additions to the standard registry.

### 4.5 Scope Display

Identity Services MUST maintain a human-readable description for each scope. Consent UIs MUST display human-readable descriptions, never raw scope strings.

---

## 5. Grant Flow

### 5.1 Overview

```
Developer App          Grantex                    Principal
     │                    │                           │
     │  POST /authorize    │                           │
     │  {agentId, scopes,  │                           │
     │   redirectUri}      │                           │
     │────────────────────►│                           │
     │                     │                           │
     │◄────────────────────│                           │
     │  {consentUrl}        │                           │
     │                     │                           │
     │  redirect user ─────────────────────────────►  │
     │                     │  consent UI displayed     │
     │                     │◄──────────────────────────│
     │                     │  Principal approves       │
     │                     │                           │
     │◄────────────────────────────────────────────────│
     │  redirectUri?code=AUTH_CODE                     │
     │                     │                           │
     │  POST /token        │                           │
     │  {code}             │                           │
     │────────────────────►│                           │
     │◄────────────────────│                           │
     │  {grantToken,        │                           │
     │   refreshToken}      │                           │
```

### 5.2 Authorization Request

```http
POST /v1/authorize
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "agentId": "ag_01HXYZ123abc",
  "principalId": "user_abc123",
  "scopes": ["calendar:read", "payments:initiate:max_500"],
  "expiresIn": "24h",
  "redirectUri": "https://yourapp.com/auth/callback",
  "state": "<csrf_token>",
  "audience": "https://api.targetservice.com"
}
```

`audience` is optional. When provided, it is embedded as the `aud` claim in the issued Grant Token (see §6.2). Services that accept tokens MUST reject tokens whose `aud` does not match their own identifier (§6.4).

Response:

```json
{
  "authRequestId": "areq_01HXYZ...",
  "consentUrl": "https://consent.grantex.dev/authorize?req=eyJ...",
  "expiresAt": "2026-02-01T00:15:00Z"
}
```

### 5.3 Token Exchange

After Principal approves, Grantex calls `redirectUri?code=AUTH_CODE&state=STATE`.

```http
POST /v1/token
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "code": "AUTH_CODE",
  "agentId": "ag_01HXYZ123abc"
}
```

Response:

```json
{
  "grantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "refreshToken": "ref_01HXYZ...",
  "grantId": "grnt_01HXYZ...",
  "scopes": ["calendar:read", "payments:initiate:max_500"],
  "expiresAt": "2026-02-02T00:00:00Z"
}
```

---

## 6. Grant Token Format

### 6.1 Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "grantex-2026-02"
}
```

### 6.2 Payload

```json
{
  "iss": "https://grantex.dev",
  "sub": "user_abc123",
  "aud": "https://api.targetservice.com",
  "agt": "did:grantex:ag_01HXYZ123abc",
  "dev": "org_yourcompany",
  "grnt": "grnt_01HXYZ...",
  "scp": ["calendar:read", "payments:initiate:max_500"],
  "iat": 1709000000,
  "exp": 1709086400,
  "jti": "tok_01HXYZ987xyz"
}
```

### 6.3 Custom Claims Reference

| Claim | Type | Description |
|-------|------|-------------|
| `agt` | string | Agent DID |
| `dev` | string | Developer org ID |
| `grnt` | string | Grant ID (for revocation lookup) |
| `scp` | string[] | Granted scopes |

### 6.4 Validation Rules

Services receiving a Grant Token MUST verify:

1. Signature using the JWKS at `iss/.well-known/jwks.json`
2. `exp` has not passed
3. `aud` matches the service's identifier (if set)
4. `scp` contains the required scopes for the requested operation
5. *(Online verification only)* Token has not been revoked via the revocation endpoint

---

## 7. Revocation

### 7.1 Revoke a Grant

```http
DELETE /v1/grants/{grantId}
Authorization: Bearer <principal_token>
```

Effect: all active tokens under this Grant are immediately invalidated. The Grant record is marked `revoked` with a timestamp.

### 7.2 Revoke a Specific Token

```http
POST /v1/tokens/revoke
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "jti": "tok_01HXYZ987xyz"
}
```

### 7.3 Online Revocation Check

```http
POST /v1/tokens/verify
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "token": "eyJhbGciOiJSUzI1NiJ9..."
}
```

Response:

```json
{
  "valid": true,
  "grantId": "grnt_01HXYZ...",
  "scopes": ["calendar:read"],
  "principal": "user_abc123",
  "agent": "did:grantex:ag_01HXYZ123abc",
  "expiresAt": "2026-02-02T00:00:00Z"
}
```

### 7.4 Token Lifetime Guidance

| Use Case | Recommended TTL |
|----------|----------------|
| High-stakes actions (payments, send) | 1 hour |
| Standard agent tasks | 8 hours |
| Long-running background agents | 24 hours (max) |

Refresh tokens are single-use and rotated on every refresh.

Implementations caching revocation state MUST NOT cache for longer than **5 minutes**. High-stakes scopes (`payments:initiate`, `email:send`, `files:write`) SHOULD always use online verification.

---

## 8. Audit Trail

### 8.1 Log Entry Schema

```json
{
  "entryId": "alog_01HXYZ...",
  "agentId": "did:grantex:ag_01HXYZ123abc",
  "grantId": "grnt_01HXYZ...",
  "principalId": "user_abc123",
  "developerId": "org_yourcompany",
  "action": "payment.initiated",
  "status": "success",
  "metadata": {
    "amount": 420,
    "currency": "USD",
    "merchant": "Air India"
  },
  "timestamp": "2026-02-01T12:34:56.789Z",
  "hash": "sha256:abc123...",
  "prevHash": "sha256:xyz789..."
}
```

### 8.2 Hash Chain

Each entry's `hash` is computed as:

```
SHA-256(entryId + agentId + grantId + action + status + timestamp + metadata_canonical + prevHash)
```

Fields are serialized as a canonical JSON object with keys sorted alphabetically. `prevHash` is `null` for the first entry in a chain. This makes any retrospective tampering detectable.

### 8.3 Log Action SDK Method

```typescript
await grantex.audit.log({
  agentId: string,
  grantId: string,
  action: string,          // format: "resource.verb" e.g. "payment.initiated"
  status: 'success' | 'failure' | 'blocked',
  metadata?: Record<string, unknown>,
});
```

---

## 9. Multi-Agent Authorization

When Agent A spawns Agent B, B's Grant Token must chain back to the original Principal's authorization.

```json
{
  "sub": "user_abc123",
  "agt": "did:grantex:ag_B_456",
  "parentAgt": "did:grantex:ag_A_123",
  "parentGrnt": "grnt_parentXYZ",
  "scp": ["email:read"],
  "delegationDepth": 1
}
```

Rules:
- Sub-agent scopes MUST be a subset of the parent's scopes
- `delegationDepth` is incremented at each hop
- Implementations MUST enforce a developer-configurable delegation depth limit. The default RECOMMENDED limit is **3**. Implementations MUST enforce a hard cap of **10**.
- The original Principal can revoke the root Grant to invalidate the entire chain

### 9.1 Delegation Endpoint

```http
POST /v1/grants/delegate
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "parentGrantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "subAgentId": "ag_01HXYZ_sub",
  "scopes": ["email:read"],
  "expiresIn": "1h"
}
```

The server MUST:
1. Decode and validate the `parentGrantToken` (signature and expiry are not re-verified server-side; revocation state is checked via Redis)
2. Reject with `400` if the parent grant has been revoked
3. Reject with `400` if any requested scope is not present in the parent token's `scp` claim
4. Reject with `404` if `subAgentId` does not belong to the authenticated developer
5. Compute expiry as `min(parent token exp, now + expiresIn)`

Response `201`:

```json
{
  "grantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "grantId": "grnt_01HXYZ_sub",
  "scopes": ["email:read"],
  "expiresAt": "2026-02-01T01:00:00Z"
}
```

The issued `grantToken` carries `parentAgt`, `parentGrnt`, and `delegationDepth = parentDepth + 1`.

### 9.2 Cascade Revocation

Revoking a Grant via `DELETE /v1/grants/:id` MUST atomically revoke all descendant grants (grants whose `parent_grant_id` traces back to the revoked grant, at any depth). Implementations SHOULD use a recursive CTE or equivalent to traverse the delegation tree in a single database transaction.

---

## 10. Self-Hosting

### 10.1 Core Endpoints

All compliant Grantex implementations MUST expose the following endpoints:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/agents` | Register agent |
| `POST /v1/authorize` | Initiate authorization |
| `POST /v1/token` | Exchange code for token |
| `POST /v1/tokens/verify` | Verify token online |
| `POST /v1/tokens/revoke` | Revoke token |
| `GET /v1/grants` | List principal's grants |
| `GET /v1/grants/:id` | Get a single grant |
| `DELETE /v1/grants/:id` | Revoke grant (cascades to all descendants) |
| `POST /v1/grants/delegate` | Issue a delegated sub-agent grant |
| `POST /v1/audit/log` | Write audit entry |
| `GET /v1/audit/entries` | Query audit log |
| `GET /v1/audit/:id` | Get a single audit entry |
| `GET /.well-known/jwks.json` | Public keys for offline verification |
| `GET /health` | Health check |

### 10.2 Optional Extensions

Minimal implementations MAY omit the following endpoints. Implementations that choose to support an extension MUST implement it as specified.

**Policy Engine**

| Endpoint | Description |
|----------|-------------|
| `POST /v1/policies` | Create a policy rule |
| `GET /v1/policies` | List policy rules |
| `GET /v1/policies/:id` | Get a single policy rule |
| `PATCH /v1/policies/:id` | Update a policy rule |
| `DELETE /v1/policies/:id` | Delete a policy rule |

**Webhooks**

| Endpoint | Description |
|----------|-------------|
| `POST /v1/webhooks` | Register a webhook |
| `GET /v1/webhooks` | List webhooks |
| `DELETE /v1/webhooks/:id` | Delete a webhook |

**SCIM Tokens**

| Endpoint | Description |
|----------|-------------|
| `POST /v1/scim/tokens` | Create a SCIM Bearer token |
| `GET /v1/scim/tokens` | List SCIM tokens |
| `DELETE /v1/scim/tokens/:id` | Delete a SCIM token |

**SCIM 2.0**

| Endpoint | Description |
|----------|-------------|
| `GET /scim/v2/ServiceProviderConfig` | SCIM capability discovery |
| `GET /scim/v2/Users` | List provisioned users |
| `POST /scim/v2/Users` | Provision a user |
| `GET /scim/v2/Users/:id` | Get a provisioned user |
| `PUT /scim/v2/Users/:id` | Replace a provisioned user |
| `PATCH /scim/v2/Users/:id` | Partially update a provisioned user |
| `DELETE /scim/v2/Users/:id` | Deprovision a user |

**SSO (OIDC)**

| Endpoint | Description |
|----------|-------------|
| `POST /v1/sso/config` | Configure SSO provider |
| `GET /v1/sso/config` | Get SSO configuration |
| `DELETE /v1/sso/config` | Remove SSO configuration |
| `GET /sso/login` | Initiate SSO login (redirects to IdP) |
| `GET /sso/callback` | OIDC callback handler |

**Anomaly Detection**

| Endpoint | Description |
|----------|-------------|
| `POST /v1/anomalies/detect` | Submit anomaly signal |
| `GET /v1/anomalies` | List detected anomalies |
| `PATCH /v1/anomalies/:id/acknowledge` | Acknowledge an anomaly |

**Compliance**

| Endpoint | Description |
|----------|-------------|
| `GET /v1/compliance/summary` | Compliance posture summary |
| `GET /v1/compliance/evidence-pack` | Generate SOC2/GDPR evidence pack |
| `GET /v1/compliance/export/grants` | Export grant data |
| `GET /v1/compliance/export/audit` | Export audit log |

**Billing**

| Endpoint | Description |
|----------|-------------|
| `GET /v1/billing/subscription` | Get current subscription |
| `POST /v1/billing/checkout` | Create a checkout session |
| `POST /v1/billing/portal` | Create a billing portal session |

---

## 11. Policy Engine

### 11.1 Purpose

The Policy Engine evaluates rules against each authorization request before the consent UI is displayed. Policies enable developers to auto-approve routine, low-risk requests and auto-deny requests that violate organizational rules — reducing friction for Principals while maintaining control.

### 11.2 Effects

| Effect | Description |
|--------|-------------|
| `auto_approve` | Grant is issued immediately without showing the consent UI |
| `auto_deny` | Authorization request is rejected immediately with a `403` response |

### 11.3 Condition Fields

| Field | Type | Description |
|-------|------|-------------|
| `scopes` | string[] | Matches when the requested scopes are a subset of this list |
| `principalId` | string | Matches a specific Principal |
| `agentId` | string | Matches a specific Agent |
| `timeWindow` | object | Time-based constraint: `{ startHour, endHour, days[] }` where `days` is an array of ISO weekday integers (1=Monday, 7=Sunday) |

### 11.4 Evaluation Order

1. Deny rules are evaluated first. The first matching `auto_deny` rule wins.
2. Allow rules are evaluated next. The first matching `auto_approve` rule issues the grant.
3. If no rule matches, the consent UI is shown to the Principal.

### 11.5 Example Policy

Auto-deny payment requests outside business hours:

```json
{
  "name": "block-off-hours-payments",
  "effect": "auto_deny",
  "conditions": {
    "scopes": ["payments:initiate"],
    "timeWindow": {
      "startHour": 18,
      "endHour": 9,
      "days": [1, 2, 3, 4, 5]
    }
  }
}
```

### 11.6 CRUD API

```http
POST   /v1/policies         — Create a policy rule
GET    /v1/policies         — List all policy rules
GET    /v1/policies/:id     — Get a single policy rule
PATCH  /v1/policies/:id     — Update a policy rule
DELETE /v1/policies/:id     — Delete a policy rule
```

---

## 12. Enterprise Identity — SCIM & SSO

### 12.1 SCIM 2.0 User Provisioning

Enterprises may sync users from their Identity Provider (Okta, Azure AD, etc.) into Grantex as Principals using the SCIM 2.0 protocol. The SCIM base path is `/scim/v2/`.

SCIM endpoints authenticate via a dedicated SCIM Bearer token, separate from developer API keys. This ensures that IdP provisioning credentials are isolated from application credentials.

**SCIM token lifecycle:**

```http
POST /v1/scim/tokens
Authorization: Bearer <api_key>
```

Response:

```json
{
  "token": "scim_...",
  "tokenId": "scimtok_01HXYZ...",
  "createdAt": "2026-02-01T00:00:00Z"
}
```

The `token` value is passed as `Authorization: Bearer <scim_token>` on all `/scim/v2/*` requests.

### 12.2 SSO (OIDC)

Developers may configure an OIDC-compliant Identity Provider to enable single sign-on.

**Configure an IdP:**

```http
POST /v1/sso/config
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "provider": "okta",
  "clientId": "...",
  "clientSecret": "...",
  "discoveryUrl": "https://dev-123.okta.com/.well-known/openid-configuration"
}
```

**Login flow:**

1. Direct users to `GET /sso/login` — the auth service redirects to the IdP with a generated `state` and `nonce`.
2. The IdP authenticates the user and redirects to `GET /sso/callback`.
3. The callback validates the `state` (CSRF protection) and `nonce` (replay protection), then creates or updates the Principal record.

---

## 13. Anomaly Detection

### 13.1 Purpose

The Anomaly Detection system monitors agent behavior at runtime against each agent's established activity baseline. It identifies requests that deviate from normal patterns and surfaces them to developers for review.

### 13.2 Detection Trigger

After token issuance, the auth service emits an anomaly signal asynchronously. Anomaly detection MUST NOT block token issuance; it operates as an advisory layer only.

### 13.3 Anomaly Types

| Type | Description |
|------|-------------|
| `unusual_scope_access` | Agent requested scopes outside its typical pattern |
| `high_frequency` | Token issuance rate significantly exceeds the agent's baseline |
| `off_hours_activity` | Agent activity detected outside the Principal's normal active hours |
| `new_principal` | Agent is requesting access for a Principal it has never served before |
| `cascade_delegation` | Delegation chain depth approaching or exceeding configured limits |

### 13.4 Severity Levels

`low` | `medium` | `high` | `critical`

### 13.5 Acknowledge Workflow

Developers review and acknowledge anomalies to update the baseline and suppress repeat alerts:

```http
PATCH /v1/anomalies/:id/acknowledge
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "notes": "Authorized off-hours run for scheduled maintenance"
}
```

---

## 14. Security Considerations

- Tokens MUST be signed with RS256. Symmetric algorithms (HS256) are NOT permitted.
- Implementations MUST explicitly reject JWTs with `alg: none`. Both `alg: none` and HS256 MUST be rejected by all verifiers.
- Token replay MUST be detectable via `jti` tracking.
- Consent UIs MUST validate `state` parameter to prevent CSRF.
- Redirect URIs MUST be pre-registered and exactly matched.
- Services SHOULD implement online revocation checks for high-stakes operations.
- Audit logs MUST be append-only at the API level (no update or delete endpoints).
- SCIM endpoints MUST authenticate with a dedicated SCIM Bearer token, separate from developer API keys.
- SSO callbacks MUST validate OIDC `state` and `nonce` parameters to prevent CSRF and replay attacks.
- Policy engine MUST evaluate deny rules before allow rules to ensure restrictive policies are not bypassed.
- Anomaly signals MUST NOT be used to synchronously block token issuance; the detection pipeline is advisory and asynchronous.
- Consent UIs MUST display: agent name, developer name, all requested scopes with human-readable descriptions, token expiry, and a prominent deny/cancel action.

---

## Protocol Design Decisions

The following design questions that were open in v0.1-draft have been resolved for v1.0: **Scope standardization** — Grantex maintains a normative canonical scope registry (§4.2), governed by the Grantex working group; custom scopes must use reverse-domain notation. **Cross-chain identity** — Agent DIDs are scoped to the issuing Grantex-compatible implementation and are not required to be portable across implementations in v1.0. **Offline revocation** — Implementations caching revocation state MUST NOT cache for longer than 5 minutes (§7.4). **Delegation depth** — The protocol mandates a developer-configurable limit with a recommended default of 3 and a hard cap of 10 (§9). **Consent UI requirements** — Compliant consent UIs MUST display agent name, developer name, all requested scopes with human-readable descriptions, token expiry, and a prominent deny/cancel action (§14).

---

## Changelog

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | Feb 2026 | Final. §11 Policy Engine, §12 Enterprise Identity (SCIM/SSO), §13 Anomaly Detection; expanded §10 endpoint table with Core vs. Optional Extensions; resolved all open design questions; specification frozen. |
| 0.1-draft rev 2 | Feb 2026 | Add `audience` to §5.2; add `status` to §8.2 hash formula; add §9.1 delegation endpoint and §9.2 cascade revocation; expand §10 endpoint table |
| 0.1-draft | Feb 2026 | Initial draft — seeking community feedback |

---

*Grantex Protocol Specification is licensed under [Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)*
