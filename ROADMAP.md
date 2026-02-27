# Grantex Roadmap

> Public and honest. Updated every sprint. Vote on features via [GitHub Discussions](https://github.com/mishrasanjeev/grantex/discussions).

---

## Now — v0.1 Foundation *(Wrapping up)*

Getting the core protocol working end-to-end.

- [x] Protocol specification draft (SPEC.md)
- [x] TypeScript SDK (`@grantex/sdk`)
- [x] Python SDK (`grantex`)
- [x] Auth service — token issuance, verification, refresh, revocation
- [x] Identity service — DID generation, JWKS endpoint, key rotation
- [x] Hosted consent UI — plain-language, mobile-first, white-label ready
- [x] Audit trail — append-only, hash-chained, queryable
- [x] Multi-agent delegation — scope-subset enforcement, cascade revocation
- [x] Developer dashboard — agents, grants, audit log, revoke grants
- [x] Sandbox mode — auto-approves consent flow, returns code immediately
- [x] Docker Compose self-hosting setup (config and docs)

**Target: End of March 2026** ✅ Complete

---

## Next — v0.2 Integrations

Making Grantex native to every major agent framework.

- [x] LangChain integration (`@grantex/langchain`)
- [x] AutoGen integration (`@grantex/autogen`)
- [x] End-user permission dashboard (view + revoke grants)
- [x] Webhook event delivery (grant created, revoked, token issued)
- [x] Stripe billing integration (Free / Pro / Enterprise tiers)
- [x] `grantex` CLI tool for local development

**Target: End of May 2026**

---

## Later — v0.3 Enterprise

Compliance features that make Grantex a must-have for regulated environments.

- [x] CrewAI integration (`grantex-crewai`)
- [x] Vercel AI SDK integration
- [x] Enterprise compliance dashboard (org-wide view, exports)
- [x] SOC2/GDPR evidence pack export
- [x] Policy engine (auto-approve / auto-deny rules)
- [x] SCIM / SSO for enterprise developer orgs
- [x] Anomaly detection (unusual agent behavior alerts)

**Target: End of August 2026**

---

## Future — v1.0 Stable Protocol

Protocol finalization and ecosystem maturity.

- [x] Protocol specification finalized and frozen
- [ ] Independent security audit
- [ ] SOC2 Type I certification
- [x] On-premise enterprise deployment option
- [ ] Submit protocol spec to W3C / IETF / CNCF for standardization

**Target: End of 2026**

---

## How to Influence the Roadmap

- 👍 React to issues with +1 to signal demand
- 💬 Open a [Discussion](https://github.com/mishrasanjeev/grantex/discussions) for feature proposals
- 📧 [design@grantex.dev](mailto:design@grantex.dev) for enterprise design partner conversations
- 🛠️ Submit a PR — contributions move things up the roadmap faster than anything

---

*Last updated: February 2026*
