# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
