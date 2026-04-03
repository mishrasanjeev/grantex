# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.5.0] — April 2026

### Added

#### Trust Registry Portal & Documentation
- Trust Registry portal screens (search, org detail, registration wizard) in developer portal
- `src/api/registry.ts` — API client for registry endpoints
- `RegistrySearch` page — filterable org card grid with verification badges and stats
- `RegistryOrgDetail` page — org profile with compliance grid, agent table, public keys, and DNS verify
- `RegisterOrgForm` page — 4-step wizard (details, contact, verification method, review)
- Trust Registry sidebar link in portal navigation
- `web/registry.html` — landing page with live search, featured orgs, verification methods, embeddable trust badge demo
- `docs/features/trust-registry.mdx` — feature documentation (data model, API endpoints, SDK usage, embeddable widget)
- `docs/guides/trust-registry-setup.mdx` — step-by-step registration and verification guide

#### @grantex/dpdp — DPDP Act 2023 & EU AI Act Compliance
- `@grantex/dpdp` package — DPDP Act 2023, GDPR, and EU AI Act compliance module for AI agent deployments
- `DPDPConsentRecord` — structured consent records with purpose mapping, retention periods, and DPDP section references
- `DPDPClient.createConsentRecord()` — create DPDP-compliant consent records linked to Grantex grants
- `DPDPClient.withdrawConsent()` — one-click consent withdrawal with instant grant revocation and cascade
- `DPDPClient.checkPurposeAdherence()` — verify agents stay within declared processing purposes
- `DPDPClient.exportAudit()` — generate framework-specific audit exports (DPDP, GDPR, EU AI Act)
- `DPDPClient.submitGrievance()` — data principal grievance mechanism with SLA tracking
- `DPDPClient.exportPrincipalData()` — data principal data export (DPDP S.11 / GDPR Art.20)
- Data principal portal with consent management, activity history, and grievance submission
- Compliance dashboard with consent status, purpose adherence, and withdrawal metrics
- DPDP Act 2023 section-by-section compliance mapping documentation
- EU AI Act article-by-article compliance mapping documentation
- DPDP compliance landing page at `grantex.dev/dpdp`
- Blog post: "DPDP Act 2023 and AI Agents: What Your Engineering Team Must Know"

#### @grantex/gemma — Offline Authorization for Gemma 4
- `createConsentBundle()`: Issue offline-capable consent bundles (online, once)
- `createOfflineVerifier()`: < 5ms JWT verification with zero network calls
- `createOfflineAuditLog()`: Ed25519-signed, hash-chained local audit log
- `auditLog.sync()`: Batch sync offline entries when connectivity restores
- `withGrantexAuth()` adapter for Google ADK tool wrapping
- LangChain adapter
- New backend endpoints: POST /v1/consent-bundles, POST /v1/audit/offline-sync,
  GET /v1/consent-bundles/:bundleId/revocation-status
- Examples: Android (Kotlin), Raspberry Pi (Python), iOS (Swift bridging)
- `grantex init gemma` CLI scaffold command

#### grantex verify CLI enhancement
- Full token inspection: scopes, expiry, delegation chain, signature
- `--check-revocation`: live revocation status check
- `--json`: machine-readable JSON output for scripting
- `--verbose`: full JWT header and claims display
- `--jwks-file`: offline verification from local JWKS file
- `--stdin`: pipe token from stdin
- `grantex decode`: decode without verify (jwt.io equivalent)
- `grantex audit inspect`: local audit log viewer
- `grantex audit verify`: hash chain integrity check
- `grantex registry lookup`: registry DID lookup from CLI
- `grantex registry verify-dns`: DNS verification from CLI

#### @grantex/mcp-auth GA — OAuth 2.1 + PKCE for MCP Servers
- `@grantex/mcp-auth` GA release — OAuth 2.1 + PKCE authorization server for any MCP server
- `createMcpAuthServer()` — single function call to register six RFC-compliant endpoints
- OAuth 2.1 authorization endpoint with mandatory PKCE S256 (no `plain`, no implicit grant)
- Dynamic Client Registration (RFC 7591) at `/register`
- Server metadata discovery (RFC 8414) at `/.well-known/oauth-authorization-server`
- Token introspection (RFC 7662) at `/introspect` with Grantex-specific claims
- Token revocation (RFC 7009) at `/revoke` with per-RFC 200 OK semantics
- Express.js middleware (`requireMcpAuth`) for JWT validation with scope enforcement
- Hono middleware (`requireMcpAuth`) with the same API surface
- `McpGrant` decoded token type with `sub`, `agentDid`, `scopes`, `grantId`, `delegationDepth`
- Custom `ClientStore` interface for persistent client registrations (Postgres, Redis, etc.)
- Consent UI customization (`appName`, `appLogo`, `privacyUrl`, `termsUrl`)
- Lifecycle hooks (`onTokenIssued`, `onRevocation`) for audit logging
- Per-endpoint rate limiting (10/min authorize, 20/min token, 30/min introspect)
- MCP Server Certification program — Bronze, Silver, and Gold tiers
- MCP Server Registry with certification badges and scope listings
- 13 automated conformance checks for MCP auth compliance
- Landing page at `grantex.dev/mcp`
- Mintlify docs: `features/mcp-auth-server` and `guides/mcp-certification`

### Changed
- Dashboard: New Bundles section for consent bundle management
- API: `POST /v1/authorize` accepts optional `offlineTTL` parameter

### Security
- Offline verifier: algorithm confusion attack (alg:none, HS256) blocked
- PKCE code_verifier comparison: timing-safe across all runtimes

## [0.2.4-mpp] - 2026-03-20

### Added
- `@grantex/mpp` package — agent identity and delegation for MPP (Machine Payments Protocol)
- `AgentPassportCredential` — W3C VC 2.0 credential type for MPP agent identity
- `POST /v1/passport/issue` — issue an agent passport credential
- `GET /v1/passport/:id` — retrieve a passport
- `POST /v1/passport/:id/revoke` — revoke a passport (flips StatusList2021 bit)
- `GET /v1/trust-registry/:orgDID` — public org trust record lookup
- `verifyPassport()` — merchant-side offline passport verification (<50ms on warm cache)
- `requireAgentPassport()` — Express middleware for passport verification
- `createMppPassportMiddleware()` — fetch middleware to attach passport headers
- `lookupOrgTrust()` — trust registry client with in-memory caching
- `grantex.passports` namespace in `@grantex/sdk` (issue, get, revoke, list)
- `agent-passport` as a valid `credentialFormat` in `POST /v1/token`
- MPP Payment Scopes (`payments:mpp:*`) in SPEC.md §4.2
- SPEC.md §15 — MPP Agent Passport specification
- Trust registry database table with 5 seeded demo orgs
- MPP demo service (`apps/mpp-demo-service/`) — MPP 402 flow simulator
- MPP demo UI (`apps/mpp-demo/`) — 3-screen interactive demo (issue, flow, verify)
- W3C JSON-LD context document at `grantex.dev/contexts/mpp/v1`
- E2E test for full MPP passport lifecycle

## [0.1.3] - 2026-02-28

### Added
- PKCE (S256) support in authorization and token exchange flows
- `generatePkce()` helper in TypeScript SDK
- `generate_pkce()` helper in Python SDK
- Rate limiting on auth-service (100/min global, 20/min token, 10/min authorize)
- CHANGELOG.md, CODE_OF_CONDUCT.md, issue templates, PR template

### Changed
- Bumped `@grantex/sdk` to 0.1.3 and `grantex` (Python) to 0.1.3

### Fixed
- "ML-based detection" copy corrected to "Pattern-based detection" on landing page

## [0.1.2] - 2026-02-27

### Added
- `tokens.exchange()` method to TypeScript and Python SDKs for exchanging authorization codes for grant tokens
- Python examples for the token exchange flow
- OpenAI Agents SDK integration (`grantex-openai-agents`)
- Google ADK integration (`grantex-adk`)
- MCP server package (`@grantex/mcp`) with 13 tools for Claude Desktop / Cursor / Windsurf
- Health endpoint (`GET /health`) in auth-service
- CLI commands for policies, billing, SCIM, and SSO
- Portal webhooks management page
- Webhook retry with exponential backoff (persistent delivery table + background worker)
- Anomaly detection background worker (runs every 60 minutes)
- Plan limit enforcement for grants, audit entries, and policies

### Changed
- Bumped `@grantex/sdk` and `grantex` (Python) to 0.1.2
- Webhook delivery is now persistent with retry instead of fire-and-forget

## [0.1.1] - 2026-02-26

### Added
- CrewAI integration (`grantex-crewai`) published to PyPI
- Vercel AI SDK integration (`@grantex/vercel-ai`)
- AutoGen integration (`@grantex/autogen`)
- CLI tool (`@grantex/cli`) with commands for agents, grants, tokens, audit, and anomalies
- LangChain integration (`@grantex/langchain`)
- Example apps: quickstart-ts, quickstart-py, langchain-agent, crewai-agent, vercel-ai-chatbot
- Developer portal with React dashboard (agents, grants, audit, policies, anomalies, compliance, billing, settings)
- Landing page deployed to Firebase Hosting at grantex.dev
- Comprehensive documentation across all packages

### Changed
- Bumped integration packages to 0.1.1

### Fixed
- Compliance timestamptz cast using null instead of empty string
- Startup migration runner for production DB schema

## [0.1.0] - 2026-02-25

### Added
- Protocol specification v1.0 (SPEC.md)
- Auth service (Fastify + PostgreSQL + Redis) with full API surface:
  - Authorization flow (`POST /v1/authorize`, consent, approve/deny)
  - Token exchange, verification, and revocation
  - Grant management with delegation support
  - Tamper-evident audit log with hash chaining
  - Anomaly detection (rate spikes, high failure rates, new principals, off-hours activity)
  - Policy engine (allow/deny rules with priority, scopes, time-of-day constraints)
  - SCIM provisioning (users + tokens)
  - SSO configuration (OIDC)
  - Billing integration (Stripe)
  - Webhook registration and delivery
  - JWKS endpoint for offline token verification
- TypeScript SDK (`@grantex/sdk`) published to npm
- Python SDK (`grantex`) published to PyPI
- CI/CD pipelines (GitHub Actions): CI, deploy, CodeQL, dependency review
- Cloud Run deployment configuration
- Docker Compose for local development
