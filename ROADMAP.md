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

### v2.0 Platform
- [x] MCP Authorization Server — OAuth 2.1 + PKCE, dynamic client registration, RFC 8414 metadata
- [x] Credential Vault — encrypted per-user credential store, grant-token-based exchange
- [x] 7 new service provider adapters: Google Drive, GitHub, Notion, HubSpot, Salesforce, Linear, Jira
- [x] Webhook delivery log — backend endpoint + portal page with status filtering
- [x] Complete MCP tool coverage (token refresh, principal sessions, agent CRUD)
- [x] Conformance suites for token refresh and principal sessions
- [x] Portal pages for SSO configuration and SCIM token management
- [x] Go quickstart example
- [x] Gateway proxy, adapter, and multi-agent delegation examples

---

### v2.1 Enterprise Scale
- [x] Server-Sent Events (SSE) and WebSocket event streams
- [x] Event destinations package: Datadog, Splunk, S3, BigQuery, Kafka (`@grantex/destinations`)
- [x] SIEM integration guides (Datadog, Splunk, S3/BigQuery archival)
- [x] Budget & spending controls — per-grant allocation, atomic debit, threshold alerts
- [x] Budget JWT claim (`bdg`) for downstream enforcement
- [x] Budget portal dashboard with spending visualization
- [x] Terraform provider (agents, policies, webhooks, SSO config, budgets)
- [x] Pulumi bridge documentation
- [x] Helm chart: ServiceMonitor, Grafana dashboards, OTel collector sidecar
- [x] Prometheus metrics endpoint (`GET /metrics`)
- [x] OpenTelemetry distributed tracing with custom spans
- [x] Grafana dashboard templates (overview + per-agent)

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
