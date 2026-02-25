# Grantex Protocol Specification

**Version:** 0.1-draft  
**Status:** Draft — seeking community feedback  
**Last updated:** February 2026

> This is a living document. Open an issue or Discussion to propose changes.

---

## Abstract

Grantex defines an open protocol for delegated authorization of AI agents acting on behalf of human users. It specifies: cryptographic agent identity, a human-consent-based grant flow, a signed token format, a revocation model, and an append-only audit trail schema.

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

### 4.4 Scope Display

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
  "state": "<csrf_token>"
}
```

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
SHA-256(entryId + agentId + grantId + action + timestamp + metadata_canonical + prevHash)
```

This makes any retrospective tampering detectable.

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
- Services MAY set a maximum delegation depth policy (recommended: 3)
- The original Principal can revoke the root Grant to invalidate the entire chain

---

## 10. Self-Hosting

Grantex-compatible implementations MUST expose:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/agents` | Register agent |
| `POST /v1/authorize` | Initiate authorization |
| `POST /v1/token` | Exchange code for token |
| `POST /v1/tokens/verify` | Verify token online |
| `POST /v1/tokens/revoke` | Revoke token |
| `GET /v1/grants` | List principal's grants |
| `DELETE /v1/grants/:id` | Revoke grant |
| `POST /v1/audit/log` | Write audit entry |
| `GET /v1/audit/entries` | Query audit log |
| `GET /.well-known/jwks.json` | Public keys for offline verification |

---

## 11. Security Considerations

- Tokens MUST be signed with RS256. Symmetric algorithms (HS256) are NOT permitted.
- The `alg: none` attack MUST be rejected by all verifiers.
- Token replay MUST be detectable via `jti` tracking.
- Consent UIs MUST validate `state` parameter to prevent CSRF.
- Redirect URIs MUST be pre-registered and exactly matched.
- Services SHOULD implement online revocation checks for high-stakes operations.
- Audit logs MUST be append-only at the API level (no update or delete endpoints).

---

## Open Questions (RFC)

The following are open for community discussion:

1. **Scope standardization** — Should Grantex maintain a canonical scope registry, or leave it to service providers?
2. **Cross-chain identity** — Should agent DIDs be portable across Grantex-compatible implementations?
3. **Offline revocation** — What is an acceptable staleness window for cached revocation state?
4. **Delegation depth** — Should the protocol mandate a maximum delegation depth?
5. **Consent UI requirements** — What minimum disclosures must a compliant consent UI show?

→ Join the discussion: [github.com/mishrasanjeev/grantex/discussions](https://github.com/mishrasanjeev/grantex/discussions)

---

## Changelog

| Version | Date | Notes |
|---------|------|-------|
| 0.1-draft | Feb 2026 | Initial draft — seeking community feedback |

---

*Grantex Protocol Specification is licensed under [Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)*
