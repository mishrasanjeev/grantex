# Grantex Roadmap

> Public and honest. Updated every sprint. Vote on features via [GitHub Discussions](https://github.com/mishrasanjeev/grantex/discussions).

---

## Now — v0.1 Foundation *(Active)*

Getting the core protocol working end-to-end.

- [x] Protocol specification draft (SPEC.md)
- [x] TypeScript SDK skeleton (`@grantex/sdk`)
- [x] Python SDK skeleton (`grantex`)
- [ ] Auth service — token issuance, verification, refresh, revocation
- [ ] Identity service — DID generation, JWKS endpoint, key rotation
- [ ] Hosted consent UI — plain-language, mobile-first, white-label ready
- [ ] Audit trail — append-only, hash-chained, queryable
- [ ] Developer dashboard — agent registration, API keys, usage metrics
- [ ] Sandbox mode — test integrations without real credentials
- [ ] Docker Compose self-hosting setup

**Target: End of March 2026**

---

## Next — v0.2 Integrations

Making Grantex native to every major agent framework.

- [ ] LangChain integration (`@grantex/langchain`)
- [ ] AutoGen integration (`@grantex/autogen`)
- [ ] End-user permission dashboard (view + revoke grants)
- [ ] Webhook event delivery (grant created, revoked, token issued)
- [ ] Stripe billing integration (Free / Pro / Enterprise tiers)
- [ ] `grantex` CLI tool for local development

**Target: End of May 2026**

---

## Later — v0.3 Enterprise

Compliance features that make Grantex a must-have for regulated environments.

- [ ] CrewAI integration (`grantex-crewai`)
- [ ] Vercel AI SDK integration
- [ ] Enterprise compliance dashboard (org-wide view, exports)
- [ ] SOC2/GDPR evidence pack export
- [ ] Policy engine (auto-approve / auto-deny rules)
- [ ] SCIM / SSO for enterprise developer orgs
- [ ] Anomaly detection (unusual agent behavior alerts)

**Target: End of August 2026**

---

## Future — v1.0 Stable Protocol

Protocol finalization and ecosystem maturity.

- [ ] Multi-agent chain-of-trust (sub-agent authorization)
- [ ] Protocol specification finalized and frozen
- [ ] Independent security audit
- [ ] SOC2 Type I certification
- [ ] On-premise enterprise deployment option
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
