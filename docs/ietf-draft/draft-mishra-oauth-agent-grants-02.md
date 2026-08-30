---
title: "Delegated Agent Authorization Protocol (DAAP)"
abbrev: "DAAP"
docname: draft-mishra-oauth-agent-grants-02
category: info
submissiontype: IETF
ipr: trust200902
area: Security
workgroup: Web Authorization Protocol
date: 2026-08-30
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
  - fullname: Sanjeev Kumar
    organization: Orchestrum Technologies LLP
    email: mishra.sanjeev@gmail.com
    uri: https://grantex.dev

normative:
  RFC2119:
  RFC8174:
  RFC7636:
  RFC7519:
  RFC7517:
  RFC7518:
  RFC6749:
  RFC8414:
  RFC4648:
  RFC3986:
  RFC8259:
  RFC8705:
  RFC9126:
  RFC9449:
  RFC9700:
  RFC9728:

informative:
  RFC7662:
  RFC8693:
  RFC8725:
  RFC9396:
  RFC9101:
  I-D.ietf-oauth-identity-chaining:
  I-D.ietf-oauth-transaction-tokens:
  I-D.chen-oauth-agent-authz-use-cases:
  I-D.song-oauth-ai-agent-collaborate-authz:
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
  SSE:
    title: "Server-Sent Events"
    target: https://html.spec.whatwg.org/multipage/server-sent-events.html
    author:
      org: WHATWG
    date: 2024
  OPA:
    title: "Open Policy Agent"
    target: https://www.openpolicyagent.org/docs/latest/
    author:
      org: Styra
    date: 2024
  CEDAR:
    title: "Cedar Policy Language"
    target: https://www.cedarpolicy.com/
    author:
      org: Amazon Web Services
    date: 2024
  AUTHZEN:
    title: "OpenID AuthZEN Authorization API"
    target: https://openid.net/specs/openid-authzen-authorization-api-1_0.html
    author:
      org: OpenID Foundation
    date: 2024

--- abstract

Artificial intelligence (AI) agents increasingly take actions on behalf of human users across third-party services. This document defines the Delegated Agent Authorization Protocol (DAAP), an OAuth-based profile for issuing, constraining, verifying, refreshing, delegating, revoking, and auditing agent grants. DAAP combines cryptographic agent identity, human consent, JWT grant tokens, online verification, cascade revocation, tamper-evident audit records, policy evaluation, budget controls, event delivery, and credential-vault integration. The protocol is model-neutral and framework-agnostic. Grantex is one reference implementation, not a required deployment or trust provider.

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
- **Budget controls**: Agents acting in financial contexts require per-grant spending limits with atomic debit semantics and threshold alerts.
- **Real-time observability**: Operators require real-time event streams for monitoring agent activity, grant lifecycle events, and budget threshold crossings.

DAAP addresses these requirements as a layered profile of OAuth 2.0 concepts, reusing RFC-standard JWT, JWK, metadata, and proof-of-possession primitives wherever possible.

## Discussion Venues

Discussion of this draft is requested on the IETF OAuth Working Group mailing list:

- Author contact (primary): Sanjeev Kumar, <mishra.sanjeev@gmail.com>
- Author contact (alternate): Sanjeev Kumar, <sanjeev@orchestrum.in>
- Mailing list: <oauth@ietf.org>
- Archive: <https://mailarchive.ietf.org/arch/browse/oauth/>
- Working group: <https://datatracker.ietf.org/wg/oauth/>
- Source repository: <https://github.com/mishrasanjeev/grantex>
- Issue tracker: <https://github.com/mishrasanjeev/grantex/issues>

This is an individual Internet-Draft. Publication as an Internet-Draft does not imply IETF endorsement, OAuth Working Group adoption, or IETF consensus.

## Changes Since -01

This revision makes the following changes:

- Updates the author organization and prominently identifies both the primary and alternate author contact addresses.
- Clarifies that DAAP is vendor-neutral and that Grantex is a reference implementation rather than a required authority, DID method, JSON-LD context, or policy path.
- Adds a bounded lost-response recovery rule for refresh token rotation. Authorization Servers MAY replay the immediately previous refresh token response for no more than 300 seconds and only while the Grant remains active.
- Adds explicit alignment with the OAuth 2.0 Security Best Current Practice, PKCE, Pushed Authorization Requests, DPoP, mutual TLS, and Protected Resource Metadata.
- Adds discussion venue metadata and a broader relationship-to-existing-work appendix for OAuth identity chaining, transaction tokens, agent authorization use cases, and multi-agent collaboration drafts.
- Expands security and privacy considerations for sender-constrained tokens, refresh-token replay recovery, audit-log minimization, retention, and cross-domain correlation.
- Updates implementation-status text to reflect the current Grantex reference implementation and SDK versions.

## Changes Since -00

This revision adds the following extensions:

- Budget Controls ({{budget-controls}}): per-grant spending limits with the `bdg` JWT claim, atomic debit operations, and threshold alerting.
- Event Streaming ({{event-streaming}}): SSE and WebSocket endpoints for real-time event delivery.
- Credential Vault ({{credential-vault}}): encrypted per-user credential storage with token-to-credential exchange.
- External Policy Backends ({{external-policy-backends}}): integration with OPA and Cedar as policy evaluation targets.
- Implementation Report (Appendix B): conformance results and SDK coverage.
- Updated Conformance Requirements ({{conformance}}) with OPTIONAL extensions for Budget, Events, Vault, and Policy Backends.

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
: A Decentralized Identifier {{DID-CORE}} used as the Agent's cryptographic identity. DAAP does not require a specific DID method. Examples in this document use `did:example` values.

Policy:
: A rule evaluated by the Policy Engine ({{policy-engine}}) that automatically approves or denies an authorization request before the consent UI is shown to the Principal.

Anomaly:
: A behavioral deviation from an agent's established activity baseline, detected by the runtime monitoring system defined in {{anomaly-detection}}.

Budget Allocation:
: A per-grant spending limit that constrains the total monetary value of actions an Agent may take under a single Grant.

# Agent Identity {#agent-identity}

## DID Format

Every Agent registered with a DAAP-compliant Authorization Server is associated with a Decentralized Identifier. The DID method is deployment-specific and outside the scope of this document. Authorization Servers MAY issue Agent DIDs directly or MAY accept externally controlled Agent DIDs after proof of control.

For examples, this document uses DIDs of the form:

~~~
did:example:agent:<agent_id>
~~~

where `<agent_id>` is an opaque stable identifier. Implementations that mint their own identifiers SHOULD use collision-resistant values such as ULIDs {{ULID}} or randomly generated identifiers with at least 128 bits of entropy.

Example:

~~~
did:example:agent:ag_01HXYZ123abcDEF456ghi
~~~

The `did:example` method and identifiers in this document are illustrative only.

## Identity Document

The DID resolves to an identity document at the Authorization Server. The document MUST contain the following fields:

~~~json
{
  "@context": "https://schemas.example/daap/identity/v1",
  "id": "did:example:agent:ag_01HXYZ123abcDEF456ghi",
  "developer": "org_yourcompany",
  "name": "travel-booker",
  "description": "Books flights and hotels on behalf of users",
  "declaredScopes": ["calendar:read", "payments:initiate:max_500"],
  "status": "active",
  "createdAt": "2026-02-01T00:00:00Z",
  "verificationMethod": [{
    "id": "did:example:agent:ag_01HXYZ123abcDEF456ghi#key-1",
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
- Protected resource metadata {{RFC9728}} and authorization server metadata {{RFC8414}} SHOULD be used to discover issuer, JWKS, and verification endpoints rather than hard-coding deployment-specific paths.

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
  "redirectUri": "https://client.example/auth/callback",
  "state": "<csrf_token>",
  "audience": "https://resource.example"
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

Refresh tokens are single-use and MUST NOT outlive the underlying Grant. The Authorization Server MUST rotate the refresh token on every accepted non-replay use. To recover from a lost token response, the Authorization Server MAY allow idempotent replay of the immediately previous refresh token for no more than 300 seconds while the Grant remains active. Replay MUST return the already-rotated token response and MUST NOT extend the rotation chain, replay window, or Grant lifetime. Refresh tokens MUST be invalidated when the underlying Grant is expired or revoked.

## Token Refresh

Before the Grant expires, the Developer may refresh the Grant Token by sending:

~~~http
POST /v1/token/refresh
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "refreshToken": "ref_01HXYZ...",
  "agentId": "ag_01HXYZ123abc"
}
~~~

Response `200 OK`:

~~~json
{
  "grantToken": "eyJhbGciOiJSUzI1NiJ9...",
  "refreshToken": "ref_01NEW...",
  "grantId": "grnt_01HXYZ...",
  "scopes": ["calendar:read", "payments:initiate:max_500"],
  "expiresAt": "2026-02-02T00:00:00Z"
}
~~~

The response's `expiresAt` value is the expiry of the underlying Grant and MUST NOT be extended by refresh. Clients MUST persist and use the newest `refreshToken` returned by the Authorization Server.

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
  "aud": "https://resource.example",
  "agt": "did:example:agent:ag_01HXYZ123abc",
  "dev": "org_yourcompany",
  "grnt": "grnt_01HXYZ...",
  "scp": ["calendar:read", "payments:initiate:max_500"],
  "bdg": 5000,
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
| `bdg` | number | OPTIONAL | Remaining budget amount (see {{budget-controls}}) |
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
6. If the `bdg` claim is present and the operation has a cost, the `bdg` value is sufficient for the operation.
7. For high-stakes operations (see {{token-lifetime}}), the token has not been revoked via the online verification endpoint.
8. For deployments requiring proof-of-possession, the presented token is bound to the expected sender key using DPoP {{RFC9449}}, mutual TLS {{RFC8705}}, or an equivalent sender-constraining mechanism.

## Token Lifetime Guidance {#token-lifetime}

| Use Case | Recommended Maximum TTL |
|:---------|:------------------------|
| High-stakes actions (`payments:initiate`, `email:send`, `files:write`) | 1 hour |
| Standard agent tasks | 8 hours |
| Long-running background agents | 24 hours |

Implementations caching revocation state MUST NOT cache for longer than 300 seconds (5 minutes). Services processing high-stakes scopes (`payments:initiate`, `email:send`, `files:write`) SHOULD perform online verification for each token use and SHOULD require sender-constrained tokens.

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
  "agent": "did:example:agent:ag_01HXYZ123abc",
  "expiresAt": "2026-02-02T00:00:00Z"
}
~~~

## JTI Replay Prevention

Authorization Servers MUST issue a unique `jti` value for each Grant Token and MUST retain enough state to revoke or audit that token for the token's lifetime. Online token verification MUST distinguish verification from token consumption: a normal verification request MUST NOT make a reusable Grant Token invalid solely because the same `jti` was verified before.

If a deployment defines a one-time-use token profile, the Authorization Server MUST mark the `jti` as consumed only at the protected action boundary or at an explicitly defined consumption endpoint. Reuse of a consumed `jti` MUST be rejected and SHOULD produce an anomaly event. For bearer-token deployments, replay resistance SHOULD be provided with sender-constrained tokens as described in {{security-considerations}}.

# Audit Trail {#audit-trail}

## Log Entry Schema

~~~json
{
  "entryId": "alog_01HXYZ...",
  "agentId": "did:example:agent:ag_01HXYZ123abc",
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
- Audit entries MUST NOT contain bearer tokens, refresh tokens, private keys, raw upstream credentials, or other secret values. Implementations SHOULD minimize personal data in audit entries and SHOULD support redaction or export filtering for fields not required by the deployment's audit purpose.

# Multi-Agent Delegation {#delegation}

## Delegation Token Claims

When Agent A spawns Agent B, B's Grant Token MUST carry delegation claims linking it to the original Principal's authorization:

~~~json
{
  "sub": "user_abc123",
  "agt": "did:example:agent:ag_B_456",
  "parentAgt": "did:example:agent:ag_A_123",
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

Revoking a Grant via `DELETE /v1/grants/:id` MUST atomically revoke all descendant Grants -- that is, all Grants whose `parent_grant_id` traces back to the revoked Grant at any depth. Authorization Servers SHOULD implement this as a single recursive database transaction to eliminate any window during which descendant tokens remain valid.

# Conformance Requirements {#conformance}

A conformant DAAP Authorization Server MUST expose the following endpoints:

| Endpoint | Description |
|:---------|:------------|
| `POST /v1/agents` | Register an Agent |
| `POST /v1/authorize` | Initiate the grant authorization flow |
| `POST /v1/token` | Exchange authorization code for Grant Token |
| `POST /v1/token/refresh` | Rotate a refresh token for a new Grant Token |
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
- **Budget Controls**: `POST /v1/budget/allocate`, `POST /v1/budget/debit`, `GET /v1/budget/balance/:grantId`, `GET /v1/budget/transactions/:grantId` (see {{budget-controls}})
- **Event Streaming**: `GET /v1/events/stream` (SSE), `GET /v1/events/ws` (WebSocket) (see {{event-streaming}})
- **Credential Vault**: `POST /v1/vault/credentials`, `GET /v1/vault/credentials`, `DELETE /v1/vault/credentials/:id`, `POST /v1/vault/exchange` (see {{credential-vault}})
- **External Policy Backends**: OPA (`POST /v1/data/daap/authz`) and Cedar (`POST /v1/is_authorized`) integration (see {{external-policy-backends}})

# Budget Controls {#budget-controls}

## Purpose

Budget Controls provide per-grant spending limits that constrain the total monetary value of actions an Agent may perform under a single Grant. This extension is critical for agents operating in financial contexts (e.g., `payments:initiate`) where unconstrained spending could cause irreversible harm.

## Budget Allocation

A Developer allocates a budget to a Grant by sending:

~~~http
POST /v1/budget/allocate
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "grantId": "grnt_01HXYZ...",
  "amount": 10000,
  "currency": "USD"
}
~~~

Response `201 Created`:

~~~json
{
  "id": "bdgt_01HXYZ...",
  "grantId": "grnt_01HXYZ...",
  "initialBudget": 10000,
  "remainingBudget": 10000,
  "currency": "USD",
  "createdAt": "2026-02-01T00:00:00Z"
}
~~~

A Grant MUST NOT have more than one active budget allocation. Authorization Servers MUST reject allocation requests for Grants that already have an active allocation.

## Budget Debit

Services debit from a Grant's budget using an atomic operation:

~~~http
POST /v1/budget/debit
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "grantId": "grnt_01HXYZ...",
  "amount": 250,
  "description": "Flight booking - DEL to BOM",
  "metadata": { "merchant": "Air India" }
}
~~~

Response `200 OK`:

~~~json
{
  "remaining": 9750,
  "transactionId": "btxn_01HXYZ..."
}
~~~

Authorization Servers MUST implement budget debit as an atomic operation (e.g., `UPDATE ... WHERE remaining >= amount`). If the remaining budget is insufficient, the Authorization Server MUST respond with `402 Payment Required` and the error code `INSUFFICIENT_BUDGET`.

## The `bdg` JWT Claim

When a Grant has an active budget allocation, the Authorization Server SHOULD include the `bdg` claim in issued Grant Tokens. The value MUST be the remaining budget amount at the time of token issuance.

Services receiving a Grant Token with a `bdg` claim MAY use it for local pre-flight budget checks. However, the `bdg` claim is advisory -- the atomic debit endpoint remains the authoritative mechanism for budget enforcement.

## Threshold Alerts

Authorization Servers implementing Budget Controls MUST emit events when budget utilization crosses predefined thresholds:

| Threshold | Event Type | Description |
|:----------|:-----------|:------------|
| 50% consumed | `budget.threshold` | Warning: half of the budget has been consumed |
| 80% consumed | `budget.threshold` | Alert: budget is running low |
| 100% consumed | `budget.exhausted` | Budget fully consumed; subsequent debits will fail |

These events MUST be delivered via the configured webhook endpoints and SHOULD be delivered via the event streaming endpoints ({{event-streaming}}) if the extension is supported.

## Budget Balance and Transaction History

~~~http
GET /v1/budget/balance/{grantId}
Authorization: Bearer <api_key>
~~~

Returns the current `BudgetAllocation` object.

~~~http
GET /v1/budget/transactions/{grantId}
Authorization: Bearer <api_key>
~~~

Returns a paginated list of all debit transactions for the specified Grant's budget.

# Event Streaming {#event-streaming}

## Purpose

Event Streaming provides real-time delivery of authorization lifecycle events to connected clients. This extension complements webhooks by offering a persistent connection model suitable for dashboards, monitoring systems, and real-time alerting.

## Event Types

| Event Type | Description |
|:-----------|:------------|
| `grant.created` | A new Grant has been issued |
| `grant.revoked` | A Grant has been revoked |
| `token.issued` | A new Grant Token has been issued |
| `budget.threshold` | A budget threshold has been crossed |
| `budget.exhausted` | A budget has been fully consumed |

## SSE Endpoint

~~~http
GET /v1/events/stream
Authorization: Bearer <api_key>
Accept: text/event-stream
~~~

The Authorization Server MUST implement Server-Sent Events {{SSE}} delivery. Events are formatted as:

~~~
event: grant.created
data: {"grantId":"grnt_01","agentId":"ag_01"}

event: budget.threshold
data: {"grantId":"grnt_01","threshold":80,"remaining":2000}
~~~

## WebSocket Endpoint

~~~http
GET /v1/events/ws
Upgrade: websocket
Connection: Upgrade
Authorization: Bearer <api_key>
~~~

WebSocket connections receive the same event payloads as SSE, serialized as JSON messages. The Authorization Server MUST send periodic ping frames (RECOMMENDED interval: 30 seconds) to detect stale connections.

## Connection Limits

Authorization Servers MUST enforce a maximum number of concurrent event streaming connections per Developer. The RECOMMENDED limit is **5** concurrent connections. When the limit is exceeded, the Authorization Server MUST reject new connections with `429 Too Many Requests`.

## Event Delivery Guarantees

Event Streaming provides at-most-once delivery semantics. For guaranteed delivery, Developers SHOULD use webhooks, which provide at-least-once delivery with persistent retry.

# Credential Vault {#credential-vault}

## Purpose

The Credential Vault provides encrypted per-user credential storage, enabling a token-to-credential exchange pattern where an Agent presents a valid Grant Token and receives the associated service credentials in return. This eliminates the need for Agents to store long-lived secrets directly.

## Credential Storage

~~~http
POST /v1/vault/credentials
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "principalId": "user_abc123",
  "service": "stripe",
  "credentials": {
    "apiKey": "sk_live_...",
    "webhookSecret": "whsec_..."
  },
  "scopes": ["payments:initiate"]
}
~~~

Credentials MUST be encrypted at rest using AES-256-GCM or an equivalent authenticated encryption algorithm. The encryption key MUST be derived from a key management system (KMS) that is separate from the database storing the ciphertext.

## Credential Exchange

An Agent exchanges a valid Grant Token for the associated credentials:

~~~http
POST /v1/vault/exchange
Authorization: Bearer <grant_token>
Content-Type: application/json

{
  "service": "stripe"
}
~~~

The Authorization Server MUST verify the Grant Token before returning credentials. The response MUST only include credentials whose required scopes are a subset of the Grant Token's `scp` claim.

## Credential Lifecycle

- Credentials MUST be automatically deleted when the associated Principal revokes all Grants for the associated Agent.
- Developers MAY delete credentials at any time via `DELETE /v1/vault/credentials/:id`.
- The Authorization Server MUST log all credential access events in the audit trail.

# External Policy Backends {#external-policy-backends}

## Purpose

While the built-in Policy Engine ({{policy-engine}}) is sufficient for simple allow/deny rules, production deployments often require integration with dedicated policy decision points (PDPs) that support richer policy languages. This extension defines the integration pattern for two external policy backends: Open Policy Agent (OPA) {{OPA}} and Cedar {{CEDAR}}.

## Policy Evaluation Context

Authorization Servers MUST construct the following evaluation context and send it to the configured external backend:

~~~json
{
  "subject": {
    "type": "agent",
    "id": "did:example:agent:ag_01HXYZ123abc",
    "developer": "org_yourcompany"
  },
  "resource": {
    "type": "grant",
    "scopes": ["calendar:read", "payments:initiate:max_500"]
  },
  "action": {
    "name": "authorize"
  },
  "context": {
    "principalId": "user_abc123",
    "timestamp": "2026-02-01T12:00:00Z",
    "ipAddress": "203.0.113.42"
  }
}
~~~

This evaluation context is intentionally aligned with the OpenID AuthZEN {{AUTHZEN}} subject/resource/action/context model.

## OPA Integration

Authorization Servers supporting OPA MUST send a POST request to the configured OPA endpoint:

~~~http
POST {OPA_URL}/v1/data/daap/authz
Content-Type: application/json

{
  "input": { ... evaluation context ... }
}
~~~

The OPA response MUST contain:

~~~json
{
  "result": {
    "allow": true
  }
}
~~~

If `result.allow` is `false`, the Authorization Server MUST deny the authorization request. OPA policies are written in Rego.

## Cedar Integration

Authorization Servers supporting Cedar MUST send a POST request to the configured Cedar endpoint:

~~~http
POST {CEDAR_URL}/v1/is_authorized
Content-Type: application/json

{
  "principal": "Agent::\"did:example:agent:ag_01HXYZ123abc\"",
  "action": "Action::\"authorize\"",
  "resource": "Grant::\"grnt_01HXYZ...\"",
  "context": { ... }
}
~~~

The Cedar response MUST contain:

~~~json
{
  "decision": "Allow"
}
~~~

If `decision` is `"Deny"`, the Authorization Server MUST deny the authorization request.

## Timeout and Fallback

Authorization Servers MUST enforce a timeout on external policy backend requests. The RECOMMENDED timeout is **5 seconds**. If the backend does not respond within the timeout, the Authorization Server MUST apply a configurable fallback policy:

| Fallback Mode | Behavior |
|:--------------|:---------|
| `deny` (default) | Deny the authorization request |
| `allow` | Allow the authorization request (use with caution) |
| `builtin` | Fall back to the built-in Policy Engine |

The fallback mode MUST be configurable by the Developer. The default MUST be `deny` (fail-closed).

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
| `timeWindow` | object | Time constraint with start hour, end hour, and ISO weekday integers from 1 through 7, where 1 is Monday and 7 is Sunday |

## Evaluation Order

Policy evaluation MUST follow this order:

1. If an external policy backend ({{external-policy-backends}}) is configured, the evaluation context is sent to the backend first. If the backend returns a decision, that decision is final.
2. `auto_deny` rules are evaluated first. The first matching deny rule wins and the request is rejected immediately.
3. `auto_approve` rules are evaluated next. The first matching allow rule causes the Grant Token to be issued.
4. If no rule matches, the consent UI is displayed to the Principal.

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

## OAuth Security Baseline

DAAP deployments MUST follow the OAuth 2.0 Security Best Current Practice {{RFC9700}} for all OAuth-derived flows. Public clients MUST use PKCE {{RFC7636}} with the S256 challenge method. Confidential clients SHOULD also use PKCE when using authorization-code-derived flows.

Authorization Servers SHOULD support Pushed Authorization Requests {{RFC9126}} for high-risk or high-value authorization requests, especially when requests carry payment scopes, credential-vault access, or multi-agent delegation parameters. JWT-Secured Authorization Requests {{RFC9101}} MAY be used when request-object integrity or non-repudiation is required.

Protected Resource Metadata {{RFC9728}} SHOULD be used by resource servers to publish issuer, authorization server, and token-verification metadata. DAAP clients and services SHOULD prefer metadata discovery over hard-coded issuer and verification URLs.

## Algorithm Restrictions

All Grant Tokens MUST be signed with RS256 (RSASSA-PKCS1-v1_5 with SHA-256). Symmetric signing algorithms, including HS256, are NOT PERMITTED. All verifiers MUST explicitly reject tokens presenting `alg: none` or any symmetric algorithm, regardless of library defaults. This prevents algorithm confusion attacks as described in {{RFC8725}}.

RSA key moduli MUST be at least 2048 bits. Authorization Servers generating or importing signing keys MUST enforce this minimum.

## Token Replay Prevention

Every issued Grant Token carries a unique `jti` claim. Authorization Servers providing online verification MUST track issued `jti` values for token revocation and audit correlation. Verification alone MUST NOT consume a reusable token. Deployments requiring one-time-use tokens MUST define an explicit token-consumption boundary and reject a consumed `jti` after that boundary.

Bearer tokens are vulnerable to misuse if leaked. DAAP deployments SHOULD use sender-constrained access tokens for high-stakes operations. Acceptable mechanisms include DPoP {{RFC9449}}, mutual TLS certificate-bound access tokens {{RFC8705}}, or a profile that provides equivalent proof-of-possession semantics.

## Refresh Token Recovery

Refresh token rotation can fail at the transport boundary: the Authorization Server may commit the rotation and issue a response that never reaches the caller. To reduce needless user re-authorization, an Authorization Server MAY keep enough durable state to replay the already-issued token response for the immediately previous refresh token.

This recovery is not a second use of the old refresh token. The replay window MUST be no longer than 300 seconds, MUST be tied to the same Grant, MUST return the same already-rotated successor response, and MUST NOT extend the refresh-token chain, replay window, or Grant lifetime. If the Grant is expired or revoked, replay MUST fail.

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

Audit integrity does not remove the need for data minimization. Implementations MUST NOT record bearer tokens, refresh tokens, private keys, upstream credentials, or raw authentication secrets in audit entries.

## Enterprise Identity Security

SSO callback handlers MUST validate both the `state` (CSRF protection) and `nonce` (replay protection) parameters before establishing a session. ID tokens received in the SSO callback MUST be cryptographically verified against the identity provider's JWKS endpoint before any claims are trusted.

SCIM provisioning endpoints MUST authenticate via a credential (SCIM Bearer token) that is entirely separate from the Developer API key infrastructure. Compromise of a Developer API key MUST NOT grant access to SCIM provisioning endpoints, and vice versa.

## Budget Security

Budget debit operations MUST be implemented as atomic database operations (e.g., `UPDATE ... SET remaining = remaining - amount WHERE remaining >= amount`). Non-atomic implementations risk race conditions that could allow spending beyond the allocated budget.

The `bdg` JWT claim is advisory and MUST NOT be used as the sole mechanism for budget enforcement. Services MUST use the atomic debit endpoint for authoritative budget checks.

## Credential Vault Security

Credentials stored in the Vault MUST be encrypted at rest using authenticated encryption (AES-256-GCM or equivalent). Encryption keys MUST be managed by a dedicated KMS and MUST NOT be stored alongside the ciphertext.

All credential access events (store, retrieve, exchange, delete) MUST be logged in the audit trail with the credential identifier but NOT the credential value.

# Privacy Considerations {#privacy-considerations}

DAAP records can reveal sensitive relationships among Principals, Agents, Developers, services, and resources. Implementations MUST minimize personal data in Grant Tokens, audit entries, event payloads, webhook deliveries, and exported compliance evidence.

Grant Tokens SHOULD use pairwise or deployment-scoped Principal identifiers rather than globally correlatable user identifiers when cross-service correlation is not required. Audience-restricted tokens SHOULD be used whenever a Grant is intended for a specific resource server.

Audit logs SHOULD store only the fields required for security, dispute resolution, compliance, and forensic purposes. Deployments SHOULD define retention periods, deletion procedures, export controls, and redaction behavior before enabling long-lived audit storage. Exported evidence SHOULD avoid secrets and SHOULD redact personal data not necessary for the receiving auditor or relying party.

Event streams and webhooks can leak activity timing and authorization metadata. Implementations MUST authenticate event consumers, SHOULD authorize event subscriptions by Developer and tenant, and SHOULD avoid sending more detail than is required for the event type.

Cross-domain and multi-agent delegation create correlation risk. Authorization Servers and Services SHOULD avoid sharing stable Agent, Principal, or Developer identifiers with parties that do not need them. Where stable identifiers are required for accountability, deployments SHOULD document the purpose and retention period.

# IANA Considerations {#iana}

## JWT Claims Registration

This document requests registration of the following claims in the IANA "JSON Web Token Claims" registry established by {{RFC7519}}. The short claim names are provisional pending OAuth Working Group review. Implementations experimenting before registration MAY use collision-resistant private claim names to avoid conflicts.

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

`bdg`:
: Claim Name: `bdg`
: Claim Description: Remaining budget amount for the Grant
: Change Controller: IETF
: Specification Document: This document, {{budget-controls}}

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

# Relationship to OAuth Work

DAAP shares OAuth 2.0's fundamental grant model but differs in the following respects:

**versus RFC 6749 (OAuth 2.0):**
OAuth 2.0 defines a general-purpose delegated authorization framework. DAAP specializes this for AI agents by: adding cryptographic agent identity (DID); defining agent-specific JWT claims (`agt`, `dev`, `grnt`, `scp`, `bdg`); mandating RS256 exclusively; and adding the delegation, audit, policy, anomaly detection, budget controls, event streaming, credential vault, and external policy backend subsystems.

**versus RFC 8693 (Token Exchange):**
Token Exchange {{RFC8693}} enables a client to exchange one token for another, including impersonation and delegation use cases. DAAP's delegation model serves a narrower purpose -- chaining AI agent sub-authorizations back to a human principal -- and adds depth-limiting and cascade revocation semantics not present in RFC 8693.

**versus RFC 7662 (Token Introspection):**
Token Introspection {{RFC7662}} defines an endpoint for resource servers to query token metadata. DAAP's `/v1/tokens/verify` endpoint serves a similar purpose but returns DAAP-specific fields (`agent`, `principal`, `scopes`) and is used by agent-side SDKs rather than resource servers.

**versus OAuth 2.0 Security Best Current Practice:**
The OAuth 2.0 Security Best Current Practice {{RFC9700}} is the security baseline for DAAP deployments. DAAP adds agent-specific identity, grant, policy, budget, and audit semantics; it does not relax OAuth security requirements.

**versus Rich Authorization Requests:**
Rich Authorization Requests {{RFC9396}} provide structured authorization details for OAuth requests. DAAP scope constraints and budget requests can be expressed as a dedicated RAR profile in future revisions. This draft keeps the core DAAP model independent of any single request-encoding profile.

**versus OAuth Identity Chaining:**
OAuth Identity and Authorization Chaining Across Domains {{I-D.ietf-oauth-identity-chaining}} preserves identity and authorization information across domains. DAAP focuses on AI-agent authorization grants rooted in a Principal's consent, including agent identity, delegation depth, budget limits, audit records, and cascade revocation. These models are complementary: DAAP can carry or reference identity-chain context when operating across administrative domains.

**versus Transaction Tokens:**
OAuth Transaction Tokens {{I-D.ietf-oauth-transaction-tokens}} propagate user, workload, and authorization context across a call chain. DAAP Grant Tokens authorize an Agent to act under a Principal's grant. A future profile may define how DAAP grant identifiers and Agent DIDs are represented inside transaction tokens.

**versus Agent Authorization Use Cases and Gap Analysis:**
Agent authorization use cases and gap analysis {{I-D.chen-oauth-agent-authz-use-cases}} catalog the broader problem space for agent authorization. DAAP is one concrete protocol profile addressing consent, agent identity, revocation, auditability, and policy enforcement. Further OAuth WG discussion is needed to decide whether DAAP remains a single profile or is split into smaller reusable pieces.

**versus Multi-AI Agent Collaboration:**
The OAuth extension for multi-AI agent collaboration {{I-D.song-oauth-ai-agent-collaborate-authz}} focuses on group and sub-agent coordination fields. DAAP's delegation model is narrower: each delegated grant is linked to the root Principal grant, scope attenuation is mandatory, and cascade revocation is required.

# Implementation Report {#implementation-report}

This appendix documents the conformance status of the Grantex reference implementation and SDK coverage as of August 2026. A detailed implementation report is available at `docs/ietf-draft/implementation-report.md` in the Grantex repository.

## Reference Authorization Server

The Grantex authorization server (Fastify + PostgreSQL + Redis) implements all REQUIRED endpoints and the following OPTIONAL extensions:

| Extension | Status | Notes |
|:----------|:-------|:------|
| Policy Engine | Implemented | Built-in + OPA + Cedar backends |
| Webhooks | Implemented | Persistent retry with exponential backoff |
| Anomaly Detection | Implemented | 5 anomaly types, async worker |
| SCIM 2.0 | Implemented | Full RFC 7643 compliance |
| SSO (OIDC) | Implemented | Authorization Code + PKCE |
| Budget Controls | Implemented | Atomic debit, threshold alerts |
| Event Streaming | Implemented | SSE + WebSocket |
| Credential Vault | Implemented | AES-256-GCM encryption |
| External Policy Backends | Implemented | OPA + Cedar with timeout/fallback |

The reference implementation includes automated unit, integration, conformance, and end-to-end suites covering the required protocol surface and implemented optional extensions.

## SDK Coverage

| SDK | Language | Version | Core | Budget | Events | Vault |
|:----|:---------|:--------|:-----|:-------|:-------|:------|
| `@grantex/sdk` | TypeScript | 0.3.13 | Full | Full | Full | Full |
| `grantex` | Python | 0.3.14 | Full | Full | Full | Full |
| `grantex-go` | Go | repository module | Full | Full | Full | Full |

The `@grantex/conformance` package is maintained at version 0.1.8 in the reference repository.

# Acknowledgements
{: numbered="false"}

The authors thank the members of the IETF OAuth Working Group for prior art in delegated authorization, and the W3C Decentralized Identifier Working Group for the DID specification that DAAP builds upon for agent identity.
