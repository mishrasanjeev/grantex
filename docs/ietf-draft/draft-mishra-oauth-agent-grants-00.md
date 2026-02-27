---
title: "Delegated Agent Authorization Protocol (DAAP)"
abbrev: "DAAP"
docname: draft-mishra-oauth-agent-grants-00
category: info
submissiontype: IETF
ipr: trust200902
area: Security
workgroup: Web Authorization Protocol
keyword:
  - AI agents
  - authorization
  - OAuth
  - delegation
  - JWT
  - grant token

stand_alone: yes
pi: [toc, sortrefs, symrefs]

author:
  - fullname: Sanjeev Mishra
    organization: Grantex
    email: spec@grantex.dev
    uri: https://grantex.dev

normative:
  RFC2119:
  RFC8174:
  RFC7519:
  RFC7517:
  RFC7518:
  RFC6749:
  RFC6750:
  RFC7636:
  RFC8414:
  RFC4648:
  RFC3986:
  RFC8259:

informative:
  RFC7009:
  RFC7662:
  RFC8693:
  RFC7517:
  RFC8725:
  DID-CORE:
    title: "Decentralized Identifiers (DIDs) v1.0"
    target: https://www.w3.org/TR/did-core/
    author:
      org: W3C
    date: 2022-07-19
  ULID:
    title: "Universally Unique Lexicographically Sortable Identifier"
    target: https://github.com/ulid/spec
    author:
      name: Alizain Feerasta
    date: 2016

--- abstract

Artificial intelligence (AI) agents increasingly take autonomous actions — submitting forms, initiating payments, and sending communications — on behalf of human users across third-party services. This document defines the Delegated Agent Authorization Protocol (DAAP), an open, model-neutral, framework-agnostic protocol that specifies: cryptographic agent identity using Decentralized Identifiers (DIDs); a human-consent-based grant authorization flow modelled on OAuth 2.0; a signed JSON Web Token (JWT) grant token format with agent-specific claims; a revocation model with online verification; a hash-chained append-only audit trail; a policy engine for automated authorization decisions; and a multi-agent delegation model with cascade revocation. DAAP fills a gap unaddressed by existing OAuth 2.0 extensions: verifying that a specific human authorized a specific AI agent to perform a specific action, revoking that authorization in real time, and producing a tamper-evident record of what the agent did.

--- middle

# Introduction

Deployed AI agents operate across arbitrary third-party services using credentials and permissions that belong to the human users they serve. Today, no interoperable standard exists for:

1. Verifying that an agent is who it claims to be
2. Confirming that a specific human authorized a specific agent to perform a specific action
3. Revoking that authorization in real time across all active tokens
4. Producing a tamper-evident record of agent activity

OAuth 2.0 {{RFC6749}} and its extensions address authorization for applications acting on behalf of users, but were not designed for the AI agent use case, which introduces distinct requirements:

- **Agent identity**: Unlike OAuth clients, AI agents are runtime entities that may be spawned dynamically and must carry a persistent cryptographic identity independent of the authorization server.
- **Multi-agent delegation**: An agent may spawn sub-agents, each of which requires a grant scoped to a subset of the parent's permissions, with the entire delegation tree revocable by the original principal.
- **Tamper-evident audit trail**: Regulated environments require a cryptographically linked record of agent activity that is verifiable without trust in the audit log operator.
- **Policy-driven automation**: High-volume agent deployments require automated authorization decisions (auto-approve, auto-deny) without per-request human interaction, while preserving the human principal's ability to revoke at any time.

DAAP addresses these requirements as a layered extension to OAuth 2.0 concepts, reusing RFC-standard JWT and JWK primitives wherever possible.

## Requirements Language

{::boilerplate bcp14-tagged}

## Terminology

The following terms are used throughout this document:

{: vspace="1"}
Agent:
: An AI-powered software process that takes autonomous actions on behalf of a Principal. An Agent has a persistent cryptographic identity (DID) and must obtain an explicit grant from its Principal before acting on their behalf.

Principal:
: The human user who authorizes an Agent to act on their behalf. The Principal is the subject (`sub`) of any Grant Token issued by the authorization server.

Developer:
: The organization or individual who built and operates the Agent. The Developer authenticates to the authorization server using an API key.

Authorization Server:
: A server implementing this specification that issues Grant Tokens, maintains the grant registry, and provides the JWKS endpoint for offline verification.

Service:
: Any API or platform that receives requests from an Agent. Services MUST verify Grant Tokens before acting on agent requests.

Grant:
: A persistent record of permission given by a Principal to an Agent for a specific set of Scopes. A Grant is represented to the Agent as a Grant Token.

Grant Token:
: A signed JWT {{RFC7519}} representing a valid, non-revoked Grant. Grant Tokens are short-lived credentials carrying agent-specific claims defined in {{grant-token-format}}.

Scope:
: A named permission string following the format `resource:action[:constraint]` as defined in {{scope-format}}.

DID:
: A Decentralized Identifier {{DID-CORE}} — the Agent's cryptographic identity. In DAAP, Agent DIDs take the form `did:grantex:<agent_id>`.

Policy:
: A rule evaluated by the Policy Engine ({{policy-engine}}) that automatically approves or denies an authorization request before the consent UI is shown to the Principal.

Anomaly:
: A behavioral deviation from an agent's established activity baseline, detected by the runtime monitoring system defined in {{anomaly-detection}}.

# Agent Identity {#agent-identity}

## DID Format

Every Agent registered with a DAAP-compliant Authorization Server receives a Decentralized Identifier of the form:

~~~
did:grantex:<agent_id>
~~~

where `<agent_id>` is a ULID (Universally Unique Lexicographically Sortable Identifier) {{ULID}} prefixed with `ag_`.

Example:

~~~
did:grantex:ag_01HXYZ123abcDEF456ghi
~~~

## Identity Document

The DID resolves to an identity document at the Authorization Server. The document MUST contain the following fields:

~~~json
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
    "publicKeyJwk": { "..." : "..." }
  }]
}
~~~

## Key Management

Authorization Servers MUST adhere to the following key management requirements:

- Authorization Servers MUST use RS256 (RSASSA-PKCS1-v1_5 using SHA-256) {{RFC7518}} for signing Grant Tokens.
- Private signing keys MUST never be transmitted or stored outside the Authorization Server's trust boundary.
- Public keys MUST be published at `/.well-known/jwks.json` as a JWK Set {{RFC7517}}.
- Key rotation MUST be supported without changing the Agent's DID or invalidating existing, unexpired Grant Tokens. Rotated keys MUST remain in the JWKS until all tokens signed with them have expired.

# Scope Format and Registry {#scope-format}

## Format

Scopes are permission strings of the form:

~~~
resource:action[:constraint]
~~~

where:

- `resource` identifies the data or service being accessed (e.g., `calendar`, `payments`, `email`)
- `action` identifies the operation (e.g., `read`, `write`, `send`, `initiate`, `delete`)
- `constraint` is an optional limiting parameter (e.g., `max_500` for a spending limit)

## Standard Scope Registry

The following scopes constitute the normative standard registry. Implementations MUST support all standard scopes that are relevant to the resources they expose:

| Scope | Description |
|:------|:------------|
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

## Custom Scopes

Services MAY define custom scopes using reverse-domain notation per {{RFC3986}}:

~~~
com.stripe.charges:create:max_5000
io.github.issues:create
~~~

Custom scopes MUST use reverse-domain notation to avoid collisions with the standard registry.

## Scope Display Requirements

Authorization Servers MUST maintain a human-readable description for each scope in their registry. Consent UIs MUST display human-readable descriptions to Principals, never raw scope strings.

# Grant Authorization Flow {#grant-flow}

## Overview

The DAAP grant flow is modelled on the OAuth 2.0 Authorization Code flow {{RFC6749}} with the following adaptations: the client is always a Developer (identified by an API key), the resource owner is a Principal identified by the Developer's internal user identifier, and the resulting token carries agent-specific claims.

~~~ ascii-art
Developer App          Authorization Server       Principal
     |                         |                      |
     | POST /v1/authorize       |                      |
     | {agentId, principalId,  |                      |
     |  scopes, redirectUri}    |                      |
     |------------------------>|                      |
     |                         |                      |
     |<------------------------|                      |
     | {authRequestId,          |                      |
     |  consentUrl}             |                      |
     |                         |                      |
     | redirect user --------------------------------->|
     |                         | consent UI displayed |
     |                         |<---------------------|
     |                         | Principal approves   |
     |                         |                      |
     |<------------------------------------------------|
     | redirectUri?code=AUTH_CODE                      |
     |                         |                      |
     | POST /v1/token           |                      |
     | {code, agentId}          |                      |
     |------------------------>|                      |
     |<------------------------|                      |
     | {grantToken,             |                      |
     |  refreshToken}           |                      |
~~~

## Authorization Request

The Developer initiates the flow by sending:

~~~http
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
~~~

The `audience` field is OPTIONAL. When present, it MUST be embedded as the `aud` claim in the issued Grant Token. The `state` parameter is REQUIRED and MUST be validated by the Developer's callback handler to prevent CSRF attacks. The `redirectUri` MUST match a URI pre-registered for the Agent at the Authorization Server.

Authorization Servers MUST reject requests whose `redirectUri` does not exactly match a pre-registered value for the specified `agentId`.

Response `200 OK`:

~~~json
{
  "authRequestId": "areq_01HXYZ...",
  "consentUrl": "https://consent.example.com/authorize?req=eyJ...",
  "expiresAt": "2026-02-01T00:15:00Z"
}
~~~

## Consent UI Requirements

Authorization Servers MUST render a consent UI to the Principal that displays all of the following before the Principal approves or denies:

1. The Agent's registered name and description
2. The Developer's registered organization name
3. The full list of requested scopes with human-readable descriptions
4. The token expiry period
5. A prominent deny/cancel action that is at least as visually prominent as the approve action

## Token Exchange

After Principal approval, the Authorization Server calls `redirectUri?code=AUTH_CODE&state=STATE`.

~~~http
POST /v1/token
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "code": "AUTH_CODE",
  "agentId": "ag_01HXYZ123abc"
}
~~~

Response `200 OK`:

~~~json
{
  "grantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "refreshToken": "ref_01HXYZ...",
  "grantId": "grnt_01HXYZ...",
  "scopes": ["calendar:read", "payments:initiate:max_500"],
  "expiresAt": "2026-02-02T00:00:00Z"
}
~~~

Refresh tokens are single-use. The Authorization Server MUST rotate the refresh token on every use. Refresh tokens MUST be invalidated when the underlying Grant is revoked.

# Grant Token Format {#grant-token-format}

## JOSE Header

~~~json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "<key_id>"
}
~~~

The `alg` field MUST be `RS256`. Authorization Servers MUST NOT issue tokens with any other algorithm. Verifiers MUST explicitly reject tokens with any `alg` value other than `RS256`, including `none` and `HS256`.

## JWT Claims

~~~json
{
  "iss": "https://as.example.com",
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
~~~

The following claims are defined by this specification:

| Claim | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `iss` | string | REQUIRED | Authorization Server identifier URI |
| `sub` | string | REQUIRED | Principal identifier |
| `aud` | string | OPTIONAL | Intended audience (target service URI) |
| `agt` | string | REQUIRED | Agent DID |
| `dev` | string | REQUIRED | Developer organization identifier |
| `grnt` | string | REQUIRED | Grant identifier (used for revocation lookup) |
| `scp` | string[] | REQUIRED | Array of granted scope strings |
| `iat` | NumericDate | REQUIRED | Issued-at time |
| `exp` | NumericDate | REQUIRED | Expiration time |
| `jti` | string | REQUIRED | Unique token identifier (for replay prevention) |

## Token Validation

Services receiving a Grant Token MUST verify all of the following:

1. The token signature is valid, verified using the JWK Set published at `{iss}/.well-known/jwks.json`, with the key identified by `kid`.
2. The `alg` header value is `RS256`. Tokens with any other `alg` MUST be rejected.
3. The `exp` claim has not passed (allowing for a reasonable clock skew of no more than 300 seconds).
4. If the service has a registered audience identifier, the `aud` claim matches that identifier.
5. The `scp` array contains all scopes required for the requested operation.
6. For high-stakes operations (see {{token-lifetime}}), the token has not been revoked via the online verification endpoint.

## Token Lifetime Guidance {#token-lifetime}

| Use Case | Recommended Maximum TTL |
|:---------|:------------------------|
| High-stakes actions (`payments:initiate`, `email:send`, `files:write`) | 1 hour |
| Standard agent tasks | 8 hours |
| Long-running background agents | 24 hours |

Implementations caching revocation state MUST NOT cache for longer than 300 seconds (5 minutes). Services processing high-stakes scopes (`payments:initiate`, `email:send`, `files:write`) SHOULD perform online verification for each token use.

# Token Revocation {#revocation}

## Revoke a Grant

~~~http
DELETE /v1/grants/{grantId}
Authorization: Bearer <principal_token>
~~~

Effect: all active Grant Tokens issued under this Grant are immediately invalidated. The Grant record is marked `revoked` with a timestamp.

## Revoke a Specific Token

~~~http
POST /v1/tokens/revoke
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "jti": "tok_01HXYZ987xyz"
}
~~~

Response: `204 No Content`.

## Online Verification

~~~http
POST /v1/tokens/verify
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "token": "eyJhbGciOiJSUzI1NiJ9..."
}
~~~

Response `200 OK`:

~~~json
{
  "valid": true,
  "grantId": "grnt_01HXYZ...",
  "scopes": ["calendar:read"],
  "principal": "user_abc123",
  "agent": "did:grantex:ag_01HXYZ123abc",
  "expiresAt": "2026-02-02T00:00:00Z"
}
~~~

## JTI Replay Prevention

Authorization Servers MUST track all issued `jti` values for the lifetime of the corresponding token. If a `jti` value is presented for verification more than once within its validity window, the Authorization Server MUST return `valid: false` and SHOULD log an anomaly event.

# Audit Trail {#audit-trail}

## Log Entry Schema

~~~json
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
~~~

`action` values use the format `resource.verb` (e.g., `payment.initiated`, `email.sent`). `status` MUST be one of `success`, `failure`, or `blocked`.

## Hash Chain

Each entry's `hash` is computed as a SHA-256 digest {{RFC4648}} over a canonical representation of the entry:

~~~
hash = SHA-256(canonical_json(entry_without_hash) || prevHash)
~~~

where `canonical_json` serializes all fields as a JSON object {{RFC8259}} with keys sorted alphabetically, and `prevHash` is the `null` string for the first entry in a chain. This construction makes any retrospective modification to a historical entry detectable, as it invalidates all subsequent hashes.

## Audit Log Requirements

- Audit log entries MUST be append-only at the API level. No update or delete endpoints for audit entries are permitted.
- The Authorization Server MUST reject requests to modify or delete audit entries.
- The complete audit log for a Grant MUST remain accessible after the Grant is revoked, for a minimum retention period determined by the deployment's compliance requirements.

# Multi-Agent Delegation {#delegation}

## Delegation Token Claims

When Agent A spawns Agent B, B's Grant Token MUST carry delegation claims linking it to the original Principal's authorization:

~~~json
{
  "sub": "user_abc123",
  "agt": "did:grantex:ag_B_456",
  "parentAgt": "did:grantex:ag_A_123",
  "parentGrnt": "grnt_parentXYZ",
  "scp": ["email:read"],
  "delegationDepth": 1
}
~~~

Additional delegation claims:

| Claim | Type | Description |
|:------|:-----|:------------|
| `parentAgt` | string | DID of the delegating (parent) Agent |
| `parentGrnt` | string | Grant ID of the parent Grant |
| `delegationDepth` | integer | Number of hops from the root Grant; 0 for root Grants |

## Delegation Rules

- Sub-agent scopes MUST be a strict subset of the parent Grant's `scp` array. Authorization Servers MUST reject delegation requests whose requested scopes are not fully contained in the parent token's `scp` claim.
- `delegationDepth` MUST be incremented by exactly 1 at each hop.
- Implementations MUST enforce a developer-configurable delegation depth limit. The RECOMMENDED default limit is **3**. Implementations MUST enforce a hard cap of **10** regardless of developer configuration.
- The expiry of a delegated Grant Token MUST NOT exceed `min(parent_token_exp, now + requested_expires_in)`.

## Delegation Endpoint

~~~http
POST /v1/grants/delegate
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "parentGrantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "subAgentId": "ag_01HXYZ_sub",
  "scopes": ["email:read"],
  "expiresIn": "1h"
}
~~~

The Authorization Server MUST:

1. Validate that the parent Grant has not been revoked.
2. Reject with `400` if any requested scope is not present in the parent token's `scp` claim.
3. Reject with `400` if the resulting `delegationDepth` would exceed the configured limit.
4. Reject with `404` if `subAgentId` does not belong to the authenticated Developer.
5. Compute expiry as `min(parent token exp, now + expiresIn)`.

Response `201 Created`:

~~~json
{
  "grantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "grantId": "grnt_01HXYZ_sub",
  "scopes": ["email:read"],
  "expiresAt": "2026-02-01T01:00:00Z"
}
~~~

## Cascade Revocation

Revoking a Grant via `DELETE /v1/grants/:id` MUST atomically revoke all descendant Grants — that is, all Grants whose `parent_grant_id` traces back to the revoked Grant at any depth. Authorization Servers SHOULD implement this as a single recursive database transaction to eliminate any window during which descendant tokens remain valid.

# Conformance Requirements {#conformance}

A conformant DAAP Authorization Server MUST expose the following endpoints:

| Endpoint | Description |
|:---------|:------------|
| `POST /v1/agents` | Register an Agent |
| `POST /v1/authorize` | Initiate the grant authorization flow |
| `POST /v1/token` | Exchange authorization code for Grant Token |
| `POST /v1/tokens/verify` | Online token verification |
| `POST /v1/tokens/revoke` | Revoke a specific token by JTI |
| `GET /v1/grants` | List a Principal's active Grants |
| `GET /v1/grants/:id` | Retrieve a single Grant |
| `DELETE /v1/grants/:id` | Revoke a Grant (cascades to all descendants) |
| `POST /v1/grants/delegate` | Issue a delegated sub-agent Grant |
| `POST /v1/audit/log` | Write an audit log entry |
| `GET /v1/audit/entries` | Query the audit log |
| `GET /v1/audit/:id` | Retrieve a single audit log entry |
| `GET /.well-known/jwks.json` | JWK Set for offline token verification |
| `GET /health` | Health check |

The following endpoints are OPTIONAL. Implementations that choose to support an optional extension MUST implement it as specified in this document:

- **Policy Engine**: `POST /v1/policies`, `GET /v1/policies`, `GET /v1/policies/:id`, `PATCH /v1/policies/:id`, `DELETE /v1/policies/:id`
- **Webhooks**: `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/:id`
- **Anomaly Detection**: `POST /v1/anomalies/detect`, `GET /v1/anomalies`, `PATCH /v1/anomalies/:id/acknowledge`
- **Enterprise SCIM 2.0**: `/scim/v2/` endpoints as defined in RFC 7642/7643/7644
- **SSO (OIDC)**: `POST /v1/sso/config`, `GET /sso/login`, `GET /sso/callback`

# Policy Engine {#policy-engine}

## Purpose

The Policy Engine evaluates developer-defined rules against each authorization request before the consent UI is displayed. Policies enable developers to auto-approve routine low-risk requests and auto-deny requests that violate organizational constraints.

## Effects

| Effect | Description |
|:-------|:------------|
| `auto_approve` | Grant Token issued immediately without showing the consent UI |
| `auto_deny` | Authorization request rejected immediately with `403 Forbidden` |

## Condition Fields

| Field | Type | Description |
|:------|:-----|:------------|
| `scopes` | string[] | Matches when the requested scopes are a subset of this list |
| `principalId` | string | Matches a specific Principal identifier |
| `agentId` | string | Matches a specific Agent identifier |
| `timeWindow` | object | Time constraint: `{ "startHour": N, "endHour": N, "days": [1..7] }` where days are ISO weekday integers (1=Monday, 7=Sunday) |

## Evaluation Order

Policy evaluation MUST follow this order:

1. `auto_deny` rules are evaluated first. The first matching deny rule wins and the request is rejected immediately.
2. `auto_approve` rules are evaluated next. The first matching allow rule causes the Grant Token to be issued.
3. If no rule matches, the consent UI is displayed to the Principal.

This ordering ensures that restrictive policies cannot be bypassed by a conflicting allow rule.

# Anomaly Detection {#anomaly-detection}

## Purpose

The anomaly detection system monitors Agent behavior at runtime against each Agent's established activity baseline. It identifies behavioral deviations and surfaces them to Developers for review.

## Non-Blocking Requirement

Anomaly detection MUST NOT block token issuance. Detection operates asynchronously as an advisory layer. Authorization Servers MUST NOT delay Grant Token responses pending anomaly analysis.

## Anomaly Types

| Type | Description |
|:-----|:------------|
| `unusual_scope_access` | Agent requested scopes outside its established pattern |
| `high_frequency` | Token issuance rate significantly exceeds the agent's baseline |
| `off_hours_activity` | Activity detected outside the Principal's normal active hours |
| `new_principal` | Agent is requesting access for a previously unserved Principal |
| `cascade_delegation` | Delegation chain depth approaching or exceeding configured limits |

## Severity Levels

Anomaly severity MUST be one of: `low`, `medium`, `high`, `critical`.

# Security Considerations {#security-considerations}

## Algorithm Restrictions

All Grant Tokens MUST be signed with RS256 (RSASSA-PKCS1-v1_5 with SHA-256). Symmetric signing algorithms, including HS256, are NOT PERMITTED. All verifiers MUST explicitly reject tokens presenting `alg: none` or any symmetric algorithm, regardless of library defaults. This prevents algorithm confusion attacks as described in {{RFC8725}}.

RSA key moduli MUST be at least 2048 bits. Authorization Servers generating or importing signing keys MUST enforce this minimum.

## Token Replay Prevention

Every issued Grant Token carries a unique `jti` claim. Authorization Servers providing online verification MUST track issued `jti` values and reject any verification request presenting a `jti` that has already been used, for the full lifetime of the token.

## CSRF and Redirect URI Security

The `state` parameter in the authorization request MUST be a cryptographically random, unpredictable value generated per-request. Developer callback handlers MUST validate the returned `state` value against the value sent in the original request.

Redirect URIs MUST be pre-registered by the Developer for each Agent. Authorization Servers MUST perform exact-match comparison of the `redirectUri` in each authorization request against the pre-registered set. Prefix matching and wildcard matching are NOT PERMITTED.

## Scope Reduction for Delegation

Delegated Grant Tokens MUST carry a scope set that is a strict subset of the parent Grant's scope set. Authorization Servers MUST enforce this at token issuance time; it MUST NOT be enforced only at verification time.

## Revocation Propagation

Authorization Servers MUST propagate grant revocation to all descendant grants atomically. The maximum allowable latency between a revocation request and the invalidation of all descendant tokens via the online verification endpoint is implementation-defined, but implementations SHOULD target sub-second propagation.

Implementations caching revocation state MUST NOT cache for longer than 300 seconds.

## Consent UI Integrity

Consent UIs MUST display the agent name, developer name, all requested scopes with human-readable descriptions, token expiry, and a prominent deny/cancel action. This information MUST be sourced from the Authorization Server's registry, not from the authorization request itself, to prevent a malicious Developer from displaying misleading scope descriptions.

## Audit Log Integrity

The hash-chain construction defined in {{audit-trail}} ensures that any modification to a historical audit entry is detectable. Implementations MUST store audit log entries in an append-only manner and MUST expose no API for modification or deletion of audit entries. Audit log export implementations SHOULD verify the hash chain before serving exports.

## Enterprise Identity Security

SSO callback handlers MUST validate both the `state` (CSRF protection) and `nonce` (replay protection) parameters before establishing a session. ID tokens received in the SSO callback MUST be cryptographically verified against the identity provider's JWKS endpoint before any claims are trusted.

SCIM provisioning endpoints MUST authenticate via a credential (SCIM Bearer token) that is entirely separate from the Developer API key infrastructure. Compromise of a Developer API key MUST NOT grant access to SCIM provisioning endpoints, and vice versa.

# IANA Considerations {#iana}

## JWT Claims Registration

This document requests registration of the following claims in the IANA "JSON Web Token Claims" registry established by {{RFC7519}}:

{: vspace="1"}
`agt`:
: Claim Name: `agt`
: Claim Description: Agent Decentralized Identifier
: Change Controller: IETF
: Specification Document: This document, {{grant-token-format}}

`dev`:
: Claim Name: `dev`
: Claim Description: Developer organization identifier
: Change Controller: IETF
: Specification Document: This document, {{grant-token-format}}

`grnt`:
: Claim Name: `grnt`
: Claim Description: Grant identifier for revocation lookup
: Change Controller: IETF
: Specification Document: This document, {{grant-token-format}}

`scp`:
: Claim Name: `scp`
: Claim Description: Array of granted authorization scope strings
: Change Controller: IETF
: Specification Document: This document, {{grant-token-format}}

`parentAgt`:
: Claim Name: `parentAgt`
: Claim Description: DID of the delegating parent Agent
: Change Controller: IETF
: Specification Document: This document, {{delegation}}

`parentGrnt`:
: Claim Name: `parentGrnt`
: Claim Description: Grant identifier of the parent Grant
: Change Controller: IETF
: Specification Document: This document, {{delegation}}

`delegationDepth`:
: Claim Name: `delegationDepth`
: Claim Description: Number of delegation hops from the root Grant
: Change Controller: IETF
: Specification Document: This document, {{delegation}}

## Well-Known URI Registration

No new Well-Known URIs are defined by this specification. Implementations use the existing `/.well-known/jwks.json` path established by {{RFC8414}}.

--- back

# Comparison with OAuth 2.0 Extensions

DAAP shares OAuth 2.0's fundamental grant model but differs in the following respects:

**versus RFC 6749 (OAuth 2.0):**
OAuth 2.0 defines a general-purpose delegated authorization framework. DAAP specializes this for AI agents by: adding cryptographic agent identity (DID); defining agent-specific JWT claims (`agt`, `dev`, `grnt`, `scp`); mandating RS256 exclusively; and adding the delegation, audit, policy, and anomaly detection subsystems.

**versus RFC 8693 (Token Exchange):**
Token Exchange {{RFC8693}} enables a client to exchange one token for another, including impersonation and delegation use cases. DAAP's delegation model serves a narrower purpose — chaining AI agent sub-authorizations back to a human principal — and adds depth-limiting and cascade revocation semantics not present in RFC 8693.

**versus RFC 7662 (Token Introspection):**
Token Introspection {{RFC7662}} defines an endpoint for resource servers to query token metadata. DAAP's `/v1/tokens/verify` endpoint serves a similar purpose but returns DAAP-specific fields (`agent`, `principal`, `scopes`) and is used by agent-side SDKs rather than resource servers.

# Acknowledgements
{: numbered="false"}

The authors thank the members of the IETF OAuth Working Group for prior art in delegated authorization, and the W3C Decentralized Identifier Working Group for the DID specification that DAAP builds upon for agent identity.
