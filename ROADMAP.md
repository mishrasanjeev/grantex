# Grantex Product Roadmap

> Last updated: July 14, 2026. Targets describe intended sequencing, not contractual delivery dates. Repository development progress belongs in the [Unreleased changelog](CHANGELOG.md#unreleased); current public package status belongs in [release-status.json](release-status.json) and [COMPATIBILITY.md](COMPATIBILITY.md).

## Product Direction

Grantex is the authorization and trust layer for AI agents: agent identity, scoped and time-limited authority, delegation, revocation, enforcement, and audit evidence. The next product cycle prioritizes making the existing platform dependable in production before adding more protocol surfaces.

The north-star outcome is:

> A developer can put a Grantex-enforced agent into production without package-specific workarounds, with revocation, consent, rate limits, alerts, and recovery behavior that remain correct under failure and horizontal scale.

Roadmap priorities are evaluated against four product measures:

1. **Safe enforcement:** protected actions fail closed and current revocation state reaches every enforcement point within a documented bound.
2. **Fast adoption:** a new developer can issue and verify a first live grant in 10 minutes or less using any supported primary SDK.
3. **Operational trust:** production packages have no critical documented workarounds, and managed services have tested alerting, backup, restore, and incident procedures.
4. **Truthful interoperability:** protocol and compliance claims are backed by reproducible conformance evidence or clearly labelled as mappings and previews.

## Missing-Feature Audit

The following gaps were confirmed against the repository on July 13, 2026, with source progress updated on July 14. `P0` blocks a production-ready path, `P1` blocks enterprise operation or adoption, and `P2` expands the product after the core path is dependable. "Implemented in repository source" does not mean a package has been published or the managed service has been deployed.

| Priority | Missing or incomplete capability | Evidence in the current product | Product decision |
| --- | --- | --- | --- |
| P0 | Production-grade MCP authorization | `@grantex/mcp-auth@2.0.2` uses a non-configurable in-memory authorization-code store, does not persist the Grantex code handoff, does not render consent, does not invoke `onTokenIssued`, and does not perform live revocation checks. | Replace the evaluation-only lifecycle with a durable, horizontally scalable, end-to-end tested authorization flow. |
| P0 | Published Go SDK parity | Repository source corrects all documented Agent/Audit read/write contracts, removes unsupported audit filters and phantom list metadata, and URL-encodes query values with regression coverage. Published `v0.1.10` still has every documented limitation. | Publish and verify a corrected module release, then remove the `v0.1.10` workarounds. |
| P0 | Revocation-aware enforcement | Local JWT verification proves signature and expiry but not current grant state. MCP introspection and middleware share this limitation. | Add a standard online and synchronized revocation strategy with explicit freshness and failure semantics. |
| P0 | Plan-specific throughput enforcement | Repository source resolves the plan for developer API-key requests handled by the standard auth plugin and adds Redis-backed Free/Pro/Enterprise throughput after the active Fastify per-IP default or route override. Commerce, SCIM Bearer data-plane, admin, and other custom-auth routes remain outside these plan buckets; managed-service deployment and concurrent multi-instance evidence remain open. | Define the quota policy for excluded custom-auth surfaces, release and deploy the source change, then prove all applicable limits under concurrent multi-instance traffic. |
| P0 | Production out-of-band Commerce consent | Commerce consent challenge delivery supports a test sink only; `email_otp` is reserved but intentionally fails closed outside tests. | Wire verified-email OTP delivery, retry/expiry behavior, and abuse controls before enabling a production consent journey. |
| P1 | Anomaly notification delivery | Rules and Slack/webhook/email channel records exist, but the anomaly worker detects and stores alerts without delivering them to those channels. | Add a durable delivery worker, retries, dead-letter handling, and delivery status in the portal. |
| P1 | Retention and expiry automation | DPDP records store processing and retention timestamps, but no scheduled worker enforces consent expiry or retention disposition. Audit retention is not configurable in the service despite documentation implying it is. | Add policy-driven expiry, revocation, anonymization/deletion, legal holds, and evidence reports. |
| P1 | Custom-domain runtime and TLS | Enterprise domains can be registered and DNS-verified, but API and consent traffic are not served from the verified domain. | Provision certificates and route tenant traffic only after ownership and health checks pass. |
| P1 | Usage-based billing experience | Usage counters and subscription checkout exist, but customers cannot see price estimates, included usage, overage, or invoice reconciliation in the portal. | Turn usage telemetry into a transparent billing and forecast experience. |
| P1 | Full LDAP/Active Directory integration | The built-in LDAP client supports direct bind from a restricted DN template, but not directory search, attribute lookup, or group retrieval. | Add production directory search and group-to-scope mapping without weakening current SSRF/TLS controls. |
| P1 | Recovery and regional managed cloud | Hosted Grantex is single-region, and the data-residency guide still marks a formal backup/restore runbook as follow-up work. | Prove restore objectives first, then offer demand-gated EU and India regions. |
| P2 | External standards evidence | Standards mappings and an individual IETF draft exist, but externally verifiable submission, implementation, and conformance receipts are incomplete. | Publish reproducible implementation reports and externally verifiable status without implying certification or endorsement. |

## Release 2026.08 - Production Trust Baseline

**Goal:** remove the workarounds from the primary authorization and enforcement paths.

### MCP Authorization 2.1

- [ ] Add configurable `CodeStore` and transaction-safe single-use code consumption.
- [ ] Persist the actual Grantex authorization code and complete the consent callback before issuing the MCP authorization code.
- [ ] Define a host-owned consent adapter contract; ship a secure reference consent page without coupling the package to one UI.
- [ ] Enforce server-wide redirect URI policy during registration and authorization.
- [ ] Invoke lifecycle hooks after durable issuance/revocation and define retry/idempotency behavior.
- [ ] Separate authorization-server issuer metadata from the Grantex token JWKS/issuer configuration.
- [ ] Add live or synchronized revocation checks to middleware and introspection.
- [ ] Pass an end-to-end test across at least two server processes sharing durable stores.

**Exit gate:** the release-status page no longer labels the package evaluation-only, and a real consent-to-token flow succeeds under process restart and horizontal scale.

### Primary SDK parity and release safety

- [x] Correct Go Agent/Audit read/write contracts, list envelopes, supported filters, and query encoding, with API-shaped regression tests. Implemented in repository source; not yet published after `v0.1.10`.
- [ ] Run one shared register -> authorize -> exchange -> verify -> revoke contract across TypeScript, Python, and Go in CI.
- [ ] Define supported Go toolchains for the SDK and Terraform provider and test the oldest supported versions.
- [ ] Automate package-version, compatibility-matrix, changelog, and release-status updates as one release check.
- [ ] Fail publication if a changed package reuses a published version or its quickstart does not run.

**Exit gate:** all primary SDK quickstarts run without documented workarounds, and release metadata agrees across registries and repository surfaces.

### Revocation and runtime enforcement

- [ ] Publish a revocation-check contract covering online lookup, cache TTL, outage behavior, and delegation-cascade state.
- [ ] Add a signed or authenticated revocation-delta feed for enforcement points that cannot query on every request.
- [ ] Provide cached revocation clients for the primary SDKs and MCP middleware.
- [x] Enforce throughput by developer and plan on API-key routes handled by the standard auth plugin; retain Fastify's per-IP default and route overrides. Implemented in repository source; managed-service deployment is not implied.
- [ ] Define and enforce the quota policy for Commerce, SCIM Bearer data-plane, admin, and other custom-auth identities.
- [ ] Return consistent rate-limit headers and add SDK helpers for backoff and retry timing.
- [ ] Add adversarial tests for cache staleness, Redis failure, forged developer identity, and concurrent quota use.

**Exit gate:** revocation propagation has a measured service-level objective, and plan limits are proven under concurrent multi-instance traffic.

### Production Commerce consent gate

- [ ] Deliver one-time challenges only to a verified principal email through the configured provider.
- [ ] Add send throttling, resend limits, provider timeouts, bounce/error handling, and redacted delivery audit events.
- [ ] Keep raw codes out of logs, databases, non-test responses, and analytics.
- [ ] Add a staging end-to-end test from challenge request through single-use approval and revocation.
- [ ] Keep Commerce live mode disabled when no production delivery provider is healthy.

**Exit gate:** a non-test environment completes consent without exposing the OTP to the requesting agent or developer.

## Release 2026.10 - Enterprise Operations

**Goal:** make policy and security controls operable by a real on-call team.

### Alerts and incident response

- [ ] Deliver anomaly alerts to configured Slack, webhook, and email channels.
- [ ] Persist delivery attempts with exponential backoff, idempotency, dead-letter state, and replay controls.
- [ ] Add channel test, mute windows, escalation rules, and delivery-health views to the portal.
- [ ] Publish alerting SLOs and an incident-response runbook with named severity levels.

### Retention, privacy, and audit lifecycle

- [ ] Add an expiry worker that transitions expired processing consent and revokes linked active grants.
- [ ] Add configurable retention policies by tenant/data class with safe defaults.
- [ ] Implement disposition jobs for deletion or anonymization, plus legal holds and dry-run reports.
- [ ] Preserve hash-chain verification or a signed tombstone when policy permits record disposition.
- [ ] Reconcile product behavior with DPDP, data-residency, privacy, and API documentation.

### Managed-cloud readiness

- [ ] Publish and rehearse backup/restore procedures; record recovery evidence on a schedule.
- [ ] Set initial hosted targets of RPO <= 1 hour and RTO <= 4 hours, then revise from measured drills.
- [ ] Add managed-service health, dependency, queue-lag, and restore-readiness dashboards.
- [ ] Publish a public service-status surface and customer-facing maintenance/incident communication policy.

### Custom domains and billing

- [ ] Provision, renew, and revoke TLS certificates for verified tenant domains.
- [ ] Route consent and selected API traffic by tenant with takeover and misrouting tests.
- [ ] Show included usage, current consumption, projected charges, overage, and invoice status in the portal.
- [ ] Reconcile Stripe invoice events with metered usage and expose exportable billing records.
- [ ] Alert customers before quota or spend thresholds are crossed.

**Release exit gate:** an operator can detect, communicate, recover from, and produce evidence for a simulated production incident without direct database intervention.

## Q4 2026 - Enterprise Identity and Ecosystem Confidence

**Goal:** deepen integrations only after the production trust baseline is stable.

### Enterprise directory integration

- [ ] Implement paginated LDAP/AD user search with RFC-compliant filter escaping and bounded result sizes.
- [ ] Retrieve configured identity attributes and nested group membership.
- [ ] Map groups to scopes with preview, conflict reporting, and auditable change approval.
- [ ] Add connection pooling, timeout/circuit-breaker behavior, certificate validation, and directory-specific integration tests.
- [ ] Graduate LDAP from preview only after a multi-vendor compatibility matrix is published.

### Conformance and interoperability

- [ ] Publish a machine-readable capability matrix for every SDK, middleware, adapter, and deployment mode.
- [ ] Add API-to-SDK coverage checks so undocumented or unwrapped endpoints fail CI.
- [ ] Add interoperability fixtures for MCP, A2A, OACP adapters, and offline revocation synchronization.
- [ ] Publish an implementation report for the current IETF draft and externally verifiable submission/comment receipts.
- [ ] Keep OACP adapter output labelled preview/mapping until the relevant external conformance and approval requirements are met.

### Developer experience

- [ ] Generate typed SDK contract fixtures from the canonical OpenAPI schema without erasing hand-written ergonomic APIs.
- [ ] Add first-class retry, idempotency, and rate-limit guidance to all primary SDKs.
- [ ] Provide a local production-parity environment that exercises PostgreSQL, Redis, workers, consent delivery, and revocation sync.
- [ ] Add a portal setup checklist that ends with a verified, revoked, and audited sample grant.

## H1 2027 - Regional Scale

**Goal:** offer managed deployment choices without weakening isolation or operational guarantees.

- [ ] Validate customer demand and legal requirements for EU and India regions before committing infrastructure.
- [ ] Define tenant placement, data-migration, key-management, backup, and telemetry-residency rules.
- [ ] Deploy one additional region behind the same conformance, restore, and security gates as `us-central1`.
- [ ] Add region selection and residency disclosure to onboarding and contracts.
- [ ] Test regional evacuation without silently moving restricted customer data across borders.
- [ ] Evaluate customer-managed keys only after key rotation, loss, recovery, and support boundaries are designed.

**Exit gate:** regional claims are backed by deployed storage/compute locations, tested recovery evidence, and customer-visible configuration.

## Explicit Non-Goals

These boundaries prevent the roadmap from duplicating adjacent products or overstating product authority:

- Grantex will not replace human OAuth/OIDC identity providers; it carries agent-specific delegated authority alongside them.
- Grantex will not own AgenticOrg buyer/seller runtime, merchant self-service connector execution, Shopify synchronization, or channel bridges.
- Grantex will not execute or declare payment, order, fulfillment, refund, settlement, or POS success without provider-owned evidence.
- Offline signature verification will not be described as proof of current revocation unless a bounded synchronization mechanism is configured.
- Compliance mappings and protocol adapters will not be marketed as certifications, approvals, or standards-body endorsements.

## Continuous Product Hygiene

Every roadmap feature must include:

- threat model and tenant-boundary tests;
- API, SDK, portal, documentation, and telemetry coverage where applicable;
- migration, rollback, and failure-mode documentation;
- an owner, public issue or milestone, and measurable exit criterion;
- release-status and compatibility updates at publication time.

The roadmap is reviewed monthly. Completed source-level task increments may be recorded under [Unreleased](CHANGELOG.md#unreleased) before the release exit gate; release-level items remain incomplete here until that gate is met.

## How to Influence the Roadmap

- Open a [GitHub Discussion](https://github.com/mishrasanjeev/grantex/discussions) with the use case, deployment model, security requirements, and expected scale.
- React to existing issues to signal demand.
- Contact [design@grantex.dev](mailto:design@grantex.dev) for enterprise design-partner work.
- Submit a pull request that includes tests, documentation, and the relevant roadmap exit criteria.
