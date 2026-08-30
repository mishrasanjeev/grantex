# DAAP Implementation Report

**Draft:** `draft-mishra-oauth-agent-grants-02` working candidate

**Date:** 2026-08-30

**Author:** Sanjeev Kumar, Orchestrum Technologies LLP

**Contact:** mishra.sanjeev@gmail.com; sanjeev@orchestrum.in

## Status

Grantex is an implementation-specific authorization system informed by the
DAAP work. It is not currently conformant with the OAuth profile proposed by
the `-02` working candidate. This report distinguishes implemented controls
from missing interoperability work so that code evidence is not mistaken for
IETF endorsement, OAuth Working Group adoption, or complete conformance.

The current Datatracker publication remains
`draft-mishra-oauth-agent-grants-01` until a revised document is submitted and
confirmed. The `-02` source must render and pass the repository's review gates
before upload.

## Core Profile Matrix

| Profile requirement | Status | Evidence and remaining work |
|:--------------------|:-------|:----------------------------|
| Standard OAuth authorization endpoint | Missing | Grantex uses an authenticated JSON `POST /v1/authorize`, not the browser-facing OAuth endpoint defined by RFC 6749. |
| Pushed Authorization Requests | Missing | No RFC 9126 PAR endpoint or request URI lifecycle is implemented. |
| Exact registered redirect URI | Partial | Profile-aware agents can register exact redirects and Grantex enforces equality in its custom authorize and token routes. Legacy agents can omit this metadata. |
| `state` binding | Partial | The custom authorization request accepts and returns state with redirect responses. A standard client-side OAuth callback flow is not implemented. |
| PKCE S256 | Partial | The custom flow verifies S256. Standard OAuth endpoint integration remains missing. |
| Independently authenticated Principal consent | Partial | Live approval and denial require a verified WebAuthn assertion. Passkey enrollment is still developer-session initiated and is not yet anchored to an independent IdP or Principal account ceremony. |
| Policy cannot replace live consent | Implemented | A live policy `allow` records policy evaluation but no longer emits an authorization code. Sandbox auto-approval remains isolated behavior. |
| Registered resource indicator | Partial | Profile-aware agents register allowed HTTPS resource servers and the custom flow enforces exact audience matching. RFC 8707 request processing at a standard endpoint is missing. |
| Standard OAuth token endpoint | Missing | Grantex uses JSON `POST /v1/token`, not the form-encoded OAuth token endpoint. |
| RFC 9068 JWT access-token profile | Partial | Tokens carry `iss`, `sub`, `aud` when requested, `exp`, `iat`, `jti`, `client_id`, and standard `scope`; they retain private Grantex claims for compatibility and are issued through a non-standard token endpoint. |
| Sender-constrained access token | Partial | A registered key thumbprint is emitted as `cnf.jkt`. Grantex does not yet verify a DPoP proof during enrollment, token issuance, or protected-resource access. |
| Resolvable agent identity | Partial | Keyed agents receive a public `did:web` document containing their public JWK. Legacy agents retain non-resolvable `did:grantex` identifiers. Key possession is not yet proven. |
| RFC 8693 Token Exchange delegation | Missing | Grantex has a custom delegation endpoint with scope attenuation, audience inheritance, `act`, key binding, and depth limits; it is not an RFC 8693 token endpoint. |
| Refresh rotation | Implemented on custom API | Refresh tokens rotate atomically and cannot outlive the grant. |
| Lost-response refresh recovery | Implemented on custom API | The same authenticated developer, agent, old refresh token, and `Idempotency-Key` can retrieve the exact stored token response for at most 300 seconds while the child remains unused. A different key or expired window fails. |
| RFC 8414 metadata | Partial | `/.well-known/oauth-authorization-server` truthfully publishes `issuer`, `jwks_uri`, S256, and namespaced Grantex extension endpoints. It deliberately does not advertise missing standard endpoints or DPoP support. |

## Operational Extension Matrix

These features are not DAAP core conformance requirements.

| Extension | Status | Security boundary |
|:----------|:-------|:------------------|
| Audit hash chain | Implemented | Append-only API and per-developer SHA-256 chain. This alone is not operator-independent evidence. |
| Signed audit checkpoint | Implemented | The authorization server signs the current chain head. `witnessRequired: true` makes clear that an external timestamp, transparency log, or countersignature is still needed. |
| Financial budget | Implemented | Atomic debit is authoritative. Refreshed tokens include structured amount and ISO-style currency authorization details; the legacy numeric `bdg` claim remains private and advisory. |
| Policy engine | Implemented | Built-in, OPA, and Cedar paths exist. Policy cannot bypass live Principal verification. |
| Event delivery | Implemented | Webhooks, SSE, and WebSocket facilities are Grantex APIs, not protocol requirements. |
| Credential vault | Implemented | Encrypted storage and token-to-credential exchange are implementation-specific. |
| Enterprise integrations | Implemented | SCIM, SSO, domains, usage, and related controls are product features outside the draft. |

## Maintained Client Coverage

| Component | Repository version | Hardened API coverage |
|:----------|:-------------------|:----------------------|
| TypeScript SDK (`@grantex/sdk`) | 0.3.13 | Agent security metadata, redirect URI exchange binding, refresh idempotency, signed audit checkpoints |
| Python SDK (`grantex`) | 0.3.14 | Same custom API features |
| Go SDK | repository module | Same custom API features |
| Conformance package (`@grantex/conformance`) | 0.1.8 | Grantex API regression suite, including exact refresh recovery; not an OAuth/DAAP certification suite |

## Verification Commands

```bash
cd apps/auth-service && npm run typecheck && npm test
cd packages/sdk-ts && npm run typecheck && npm test
cd packages/conformance && npm run typecheck && npm test
cd packages/sdk-py && python -m pip install -e .[dev] && python -m pytest
cd packages/go-sdk && go test ./...
```

The database-backed integration tests must also apply migration
`089_daap_security_hardening.sql`. Deployment verification must confirm that
the migration lands before the new application revision receives traffic.

## Work Required for a Conformance Claim

1. Implement standard OAuth authorization, PAR, and token endpoints.
2. Bind live Principal enrollment and authentication to an independent account
   or identity-provider ceremony.
3. Require profile metadata for conforming agent registrations and retire the
   legacy path from that conformance mode.
4. Validate DPoP proofs or mutual-TLS sender binding end to end, including at
   protected resources.
5. Emit and validate the complete RFC 9068 claim set without relying on private
   aliases.
6. Implement delegation through RFC 8693 Token Exchange.
7. Build a separate standards conformance suite instead of re-labeling the
   current Grantex product API suite.

## Reviewer Note

This report applies only to the tested source revision and configuration. It
is not a security certification, legal opinion, standards approval, or claim
that the hosted Grantex deployment has enabled every optional control.
