# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
