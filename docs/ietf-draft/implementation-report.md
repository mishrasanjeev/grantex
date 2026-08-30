# DAAP Implementation Report

**Draft:** `draft-mishra-oauth-agent-grants-02` submission candidate
**Date:** 2026-08-30
**Author:** Sanjeev Kumar, Orchestrum Technologies LLP (sanjeev@orchestrum.in; mishra.sanjeev@gmail.com)

## Status

This report describes the Grantex reference implementation of the Delegated Agent Authorization Protocol (DAAP). The current Datatracker publication remains `draft-mishra-oauth-agent-grants-01` until the `-02` candidate is submitted and accepted by the IETF Datatracker.

Grantex is one implementation of DAAP. The draft is intended to remain vendor-neutral: no Grantex service, DID method, JSON-LD context, policy engine, or hosted deployment is required for another implementation to conform.

## Reference Authorization Server

**Implementation:** Grantex Auth Service
**Stack:** Fastify 5.x, PostgreSQL 16, Redis 7, Node.js
**Deployment model:** self-hosted or managed deployment
**Production deployment:** Google Cloud Run for the hosted Grantex service

### Required Endpoint Conformance

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/v1/agents` | POST | Implemented | ULID-based agent IDs, DID generation |
| `/v1/authorize` | POST | Implemented | Authorization-code-style flow, PKCE S256 support |
| `/v1/token` | POST | Implemented | RS256 JWT grant token issuance |
| `/v1/token/refresh` | POST | Implemented | Single-use rotation with 300-second lost-response recovery |
| `/v1/tokens/verify` | POST | Implemented | Online verification with revocation checks |
| `/v1/tokens/revoke` | POST | Implemented | JTI-based revocation |
| `/v1/grants` | GET | Implemented | Developer/tenant filtered |
| `/v1/grants/:id` | GET | Implemented | Single-grant lookup |
| `/v1/grants/:id` | DELETE | Implemented | Cascade revocation |
| `/v1/grants/delegate` | POST | Implemented | Scope attenuation and depth limits |
| `/v1/audit/log` | POST | Implemented | SHA-256 hash-chain audit logging |
| `/v1/audit/entries` | GET | Implemented | Paginated audit lookup |
| `/v1/audit/:id` | GET | Implemented | Single audit-entry lookup |
| `/.well-known/jwks.json` | GET | Implemented | JWKS publication and key rotation support |
| `/health` | GET | Implemented | Health check |

### Optional Extension Conformance

| Extension | Status | Details |
|-----------|--------|---------|
| Policy Engine | Implemented | Built-in rules with priority ordering and deny-first evaluation |
| Webhooks | Implemented | Persistent delivery rows with retry/backoff |
| Anomaly Detection | Implemented | Runtime anomaly records and acknowledgement flow |
| SCIM 2.0 | Implemented | Users CRUD with separate SCIM bearer-token auth |
| SSO | Implemented | OIDC Authorization Code + PKCE, LDAP/LDAPS configuration with production LDAPS enforcement |
| Budget Controls | Implemented | Atomic debit and threshold events |
| Event Streaming | Implemented | SSE and WebSocket event delivery |
| Credential Vault | Implemented | AES-256-GCM encryption and token-to-credential exchange |
| External Policy Backends | Implemented | OPA and Cedar adapters with timeout/fallback behavior |
| Policy-as-Code | Implemented | Bundle upload and git webhook sync |
| Usage Metering | Implemented | Redis counters with PostgreSQL rollups |
| Custom Domains | Implemented | DNS TXT verification |

## SDK and Tooling Coverage

| Component | Package/module | Current repo version | Status |
|-----------|----------------|----------------------|--------|
| TypeScript SDK | `@grantex/sdk` | 0.3.13 | Maintained |
| Python SDK | `grantex` | 0.3.14 | Maintained |
| Go SDK | `github.com/mishrasanjeev/grantex-go` | repository module | Maintained |
| Conformance suite | `@grantex/conformance` | 0.1.8 | Maintained |
| TypeScript integrations | LangChain, Vercel AI, Express, MCP, A2A, gateway, destinations, adapters | package-specific | Maintained |
| Python integrations | CrewAI, AutoGen, OpenAI Agents, Google ADK, FastAPI, A2A, Gemma, Strands | package-specific | Maintained |

## Conformance Suite

The `@grantex/conformance` package validates selected DAAP behavior for compatible authorization servers. The maintained suite covers:

- Required endpoint availability and response-shape checks
- PKCE S256 flow behavior
- Grant token issuance and verification
- Refresh token single-use rotation and 300-second lost-response recovery
- Cascade revocation across delegated grants
- Audit hash-chain validation
- RS256 algorithm enforcement and rejection of unsafe JWT algorithms
- Rate-limit behavior
- Budget debit behavior
- Event-stream connectivity

### Local Verification Commands

Use these commands to verify the implementation from a clean checkout:

```bash
cd apps/auth-service && npm install && npm run typecheck && npm test
cd packages/sdk-ts && npm install && npm run typecheck && npm test
cd packages/conformance && npm install && npm run typecheck && npm test
cd packages/sdk-py && python -m pip install -e .[dev] && python -m pytest
cd packages/go-sdk && go test ./...
```

For an already deployed DAAP-compatible authorization server:

```bash
npx @grantex/conformance --base-url https://server.example --api-key YOUR_KEY
```

## Notes for IETF Reviewers

This report is implementation evidence, not a claim of IETF endorsement, working-group adoption, security certification, or legal compliance. A report applies only to the tested commit, package versions, deployment configuration, and runtime environment.

The Grantex implementation intentionally includes implementation-specific paths, package names, and deployment choices. The DAAP draft should be evaluated as a vendor-neutral protocol profile; implementation-specific details are non-normative evidence that the protocol is implementable.
