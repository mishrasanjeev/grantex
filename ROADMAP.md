# Grantex Roadmap

> Public and honest. Updated every sprint. Vote on features via [GitHub Discussions](https://github.com/mishrasanjeev/grantex/discussions).

---

## Completed

### v0.1 Foundation
- [x] Protocol specification draft (SPEC.md)
- [x] TypeScript SDK (`@grantex/sdk`)
- [x] Python SDK (`grantex`)
- [x] Go SDK (`grantex-go`)
- [x] Auth service — token issuance, verification, refresh, revocation
- [x] Identity service — DID generation, JWKS endpoint, key rotation
- [x] Hosted consent UI — plain-language, mobile-first, white-label ready
- [x] Audit trail — append-only, hash-chained, queryable
- [x] Multi-agent delegation — scope-subset enforcement, cascade revocation
- [x] Developer dashboard — agents, grants, audit log, revoke grants
- [x] Sandbox mode — auto-approves consent flow, returns code immediately
- [x] Docker Compose self-hosting setup (config and docs)

### v0.2 Integrations
- [x] LangChain, AutoGen, CrewAI, Vercel AI SDK, OpenAI Agents, Google ADK integrations
- [x] MCP server for Claude Desktop, Cursor, Windsurf
- [x] Express.js and FastAPI middleware
- [x] Service provider adapters (Google Calendar, Gmail, Stripe, Slack)
- [x] Reverse-proxy gateway with YAML configuration
- [x] End-user permission dashboard (view + revoke grants)
- [x] Webhook event delivery (grant created, revoked, token issued)
- [x] Stripe billing integration (Free / Pro / Enterprise tiers)
- [x] CLI tool for local development
- [x] Conformance test suite (67 tests across 16 suites)

### v0.3 Enterprise
- [x] Enterprise compliance dashboard (org-wide view, exports)
- [x] SOC2/GDPR evidence pack export
- [x] Policy engine (auto-approve / auto-deny rules)
- [x] SCIM 2.0 provisioning + OIDC SSO
- [x] Anomaly detection (unusual agent behavior alerts)

### v1.0 Stable Protocol
- [x] Protocol specification finalized and frozen
- [x] Independent security audit (Vestige Security Labs)
- [x] SOC2 Type I certification (Thornfield Assurance Partners)
- [x] On-premise enterprise deployment option
- [x] IETF Internet-Draft submission

---

## Now — v2.0 Platform

Making Grantex the default authorization layer for every AI agent.

### MCP Authorization Server
- [ ] Drop-in OAuth 2.1 + PKCE auth provider for any MCP server
- [ ] Dynamic client registration support
- [ ] Resource indicators (RFC 8707) support

### Credential Vault
- [ ] Secure per-user credential store for third-party OAuth tokens
- [ ] Agents exchange Grantex grant token for upstream service credential
- [ ] Support for OAuth, API key, and custom credential types
- [ ] Automatic token refresh for stored credentials

### Service Provider Adapters
- [ ] Google Drive (`files:read`, `files:write`)
- [ ] GitHub (`repos:read`, `repos:write`, `issues:read`, `issues:write`)
- [ ] Notion (`pages:read`, `pages:write`)
- [ ] HubSpot (`contacts:read`, `contacts:write`)
- [ ] Salesforce (`crm:read`, `crm:write`)
- [ ] Linear (`issues:read`, `issues:write`)
- [ ] Jira (`issues:read`, `issues:write`)

### Quality & Completeness
- [ ] Complete MCP tool coverage (token refresh, principal sessions, agent CRUD)
- [ ] Conformance suites for token refresh and principal sessions
- [ ] Portal pages for SSO configuration and SCIM token management
- [ ] Webhook delivery history and retry log in portal
- [ ] Go quickstart example
- [ ] Gateway, adapters, and multi-agent delegation examples

**Target: End of April 2026**

---

## Next — v2.1 Enterprise Scale

Features that make Grantex indispensable for regulated, high-scale environments.

### Real-Time Event Streaming
- [ ] Server-Sent Events (SSE) and WebSocket event streams
- [ ] Event destinations: Datadog, Splunk, S3, BigQuery, Kafka
- [ ] SIEM integration guides

### Budget & Spending Controls
- [ ] First-class budget system in grant tokens
- [ ] Per-transaction budget decrement with auto-expiry
- [ ] Budget alerts and spending dashboards

### Infrastructure as Code
- [ ] Terraform provider (agents, policies, webhooks, SSO config)
- [ ] Pulumi provider
- [ ] Helm chart improvements

### Observability
- [ ] Native OpenTelemetry traces for entire grant lifecycle
- [ ] Prometheus metrics endpoint
- [ ] Grafana dashboard templates

**Target: End of June 2026**

---

## Later — v2.2 Ecosystem

Protocol interoperability and ecosystem maturity.

### A2A Protocol Bridge
- [ ] Grantex grant tokens inside Google A2A agent communication
- [ ] A2A agent discovery with Grantex authorization

### Policy Engine Integrations
- [ ] Open Policy Agent (OPA/Rego) as policy backend
- [ ] AWS Cedar as policy backend
- [ ] Policy-as-code git workflow

### Managed Cloud
- [ ] Hosted multi-tenant offering at `api.grantex.dev`
- [ ] Free tier (3 agents, 1K tokens/month)
- [ ] Usage-based pricing for Pro/Enterprise

### Standards Engagement
- [ ] NIST NCCoE public comment submission (by April 2, 2026)
- [ ] OpenID AuthZEN working group participation
- [ ] IETF draft revision with implementation report

**Target: End of September 2026**

---

## How to Influence the Roadmap

- React to issues with +1 to signal demand
- Open a [Discussion](https://github.com/mishrasanjeev/grantex/discussions) for feature proposals
- [design@grantex.dev](mailto:design@grantex.dev) for enterprise design partner conversations
- Submit a PR — contributions move things up the roadmap faster than anything

---

*Last updated: March 2026*
