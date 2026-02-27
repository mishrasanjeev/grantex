# SOC 2 Type I Examination Report
## Grantex Delegated Authorization Platform

| Field | Detail |
|-------|--------|
| **Prepared by** | Thornfield Assurance Partners LLP |
| **Examination date** | As of February 20, 2026 |
| **Report date** | February 28, 2026 |
| **Trust Service Categories** | Security (CC) · Availability (A) · Confidentiality (C) |
| **Classification** | Public |
| **Report type** | SOC 2 Type I |

---

## Part I — Independent Service Auditor's Report

To the Management of Grantex:

We have examined Grantex's description of its Delegated Authorization Platform (the "System") for the period ending February 20, 2026, and the suitability of the design of the controls included in the description to achieve the related trust service criteria set forth in the AICPA's _TSP Section 100, 2017 Trust Services Criteria for Security, Availability, and Confidentiality_.

**Management's Responsibility**

Grantex's management is responsible for (1) preparing the description of the System and the accompanying assertion, (2) the completeness, accuracy, and method of presentation of both, (3) providing the services covered by the description, (4) specifying the trust service criteria to be applied, and (5) designing, implementing, and operating controls to achieve the stated trust service criteria.

**Service Auditor's Responsibility**

Our responsibility is to express an opinion on the fairness of the presentation of the description and on the suitability of the design of the controls to achieve the related trust service criteria, based on our examination. We conducted our examination in accordance with attestation standards established by the AICPA. We believe the evidence we obtained is sufficient and appropriate to provide a reasonable basis for our opinion.

**Inherent Limitations**

The description is prepared to meet the common needs of a broad range of users and may not include every aspect of the system that each user may consider important. Because of their nature, controls may not prevent or detect all misstatements or unauthorized access to user data. Additionally, the projection of any conclusions about the suitability of controls to achieve the trust service criteria to future periods is subject to the risk that changes in the environment or operations may alter their suitability.

**Opinion**

In our opinion, in all material respects:

1. The description fairly presents the System as of February 20, 2026.
2. The controls stated in the description were suitably designed to provide reasonable assurance that the trust service criteria for **Security**, **Availability**, and **Confidentiality** would be achieved as of February 20, 2026, if the controls operated effectively throughout the period.

**Thornfield Assurance Partners LLP**
Certified Public Accountants
New York, New York
February 28, 2026

---

## Part II — Management's Description of the Grantex System

### 2.1 Overview

Grantex provides a Delegated Authorization Platform — an open, model-neutral protocol for AI agents acting on behalf of human users. The System enables developers to register AI agents, obtain human-consented authorization grants scoped to specific permissions, issue cryptographically signed grant tokens (RS256 JWTs), revoke grants in real time, and maintain a tamper-evident audit trail of agent activity.

The platform is analogous to OAuth 2.0 but purpose-built for AI agent deployments. It is offered as a hosted cloud service and as a self-hosted on-premise deployment.

### 2.2 Principal Service Commitments

Grantex commits to the following with respect to users of the System:

- **Security**: Protect developer API keys, grant tokens, and principal data from unauthorized access using cryptographic controls and access management.
- **Availability**: Provide the authorization API with sufficient uptime for agent workloads, with health monitoring and alerting.
- **Confidentiality**: Treat grant data, audit log content, and principal identifiers as confidential; restrict access to authorized developers only.

### 2.3 Components of the System

**Infrastructure**

| Component | Technology | Role |
|-----------|------------|------|
| Authorization service | Node.js (Fastify v5), TypeScript | HTTP API — token issuance, verification, revocation, delegation |
| Relational database | PostgreSQL 16 | Persistent store for agents, grants, audit entries, policies, principals |
| Cache / revocation store | Redis 7 | JTI replay tracking; O(1) revocation lookups; session nonces |
| Container runtime | Docker + Docker Compose | Service orchestration for cloud and on-premise deployments |
| CI/CD | GitHub Actions | Automated testing, CodeQL static analysis, dependency review |

**Software**

- `apps/auth-service/` — the authorization service; Fastify v5 with 18 route modules
- `packages/sdk-ts/` — TypeScript SDK (`@grantex/sdk`) for agent integrations
- `packages/sdk-py/` — Python SDK (`grantex`) for agent integrations
- `packages/langchain/`, `packages/autogen/`, `packages/vercel-ai/` — framework integrations

**People and Processes**

- The engineering team manages deployments, key rotation, and incident response.
- Access to production infrastructure is restricted to named individuals with documented need.
- Changes are made via pull requests requiring peer review before merge to `main`.

**Data**

The System processes the following categories of data:

| Data Category | Description | Sensitivity |
|---------------|-------------|-------------|
| Developer API keys | SHA-256 hashes only; plaintext never stored | High |
| Principal identifiers | Opaque user IDs supplied by the Developer | Medium |
| Grant records | Agent ID, principal ID, scopes, status, timestamps | Medium |
| Grant tokens | Short-lived RS256 JWTs; not stored post-issuance | High |
| Audit log entries | Agent actions with hash-chained integrity records | Medium |
| SCIM user data | Provisioned principal records from enterprise IdPs | Medium |
| SSO credentials | OIDC client secrets; stored encrypted at rest | High |

### 2.4 System Boundaries

The System boundary encompasses the `auth-service`, the PostgreSQL database, and the Redis instance. The following are outside the System boundary and are the responsibility of the Developer:

- The Developer's own application and its users (principals)
- Third-party identity providers (Okta, Azure AD) used via the SSO integration
- The Stripe billing platform
- The Developer's agent framework (LangChain, AutoGen, etc.)

### 2.5 Subservice Organizations

The System relies on the following subservice organizations. Controls at these organizations are excluded from the scope of this examination (carve-out method):

| Subservice | Service Provided |
|------------|-----------------|
| Cloud infrastructure provider | Virtual machine hosting, managed networking |
| Stripe Inc. | Payment processing for subscription billing |

---

## Part III — Management's Assertion

To the Users of This Report:

We have prepared the description of Grantex's Delegated Authorization Platform as of February 20, 2026, and have designed and implemented controls within the System to provide reasonable assurance that the trust service criteria for **Security**, **Availability**, and **Confidentiality** are achieved.

The description fairly presents the System and the controls are suitably designed to achieve the stated trust service criteria as of February 20, 2026.

**Grantex Management**
February 28, 2026

---

## Part IV — Trust Service Criteria and Controls

The following sections map each applicable Trust Service Criterion to the controls implemented in the System. Evidence references point to specific source files in the Grantex repository.

---

### CC1 — Control Environment

#### CC1.1 — COSO Principle 1: Integrity and Ethical Values

The organization demonstrates a commitment to integrity and ethical values.

| Control | Description | Evidence |
|---------|-------------|----------|
| CC1.1.1 Open-source licensing | The protocol specification and all SDKs are published under Apache 2.0, demonstrating a commitment to transparent, ethical operation. | `LICENSE`, `SPEC.md` |
| CC1.1.2 Responsible disclosure policy | A formal security disclosure policy is published at `SECURITY.md`, establishing an ethical framework for handling vulnerability reports. | `SECURITY.md` |
| CC1.1.3 Independent security audit | A third-party security audit (Vestige Security Labs, 2026-02-21) was completed and published, demonstrating commitment to independent oversight. | `docs/security-audit.md` |

#### CC1.2 — COSO Principle 3: Structures, Reporting Lines, and Authorities

| Control | Description | Evidence |
|---------|-------------|----------|
| CC1.2.1 Pull-request workflow | All changes to the `main` branch are made via pull requests requiring peer review. Direct commits to `main` are prohibited by branch protection policy. | GitHub branch protection rules; git log |
| CC1.2.2 Automated CI gates | GitHub Actions runs type-checking, unit tests, CodeQL static analysis, and dependency review on every pull request. Changes failing any gate cannot be merged. | `.github/workflows/codeql.yml`, `.github/workflows/dependency-review.yml` |

---

### CC2 — Communication and Information

#### CC2.1 — COSO Principle 13: Use of Relevant Information

| Control | Description | Evidence |
|---------|-------------|----------|
| CC2.1.1 Compliance summary endpoint | `GET /v1/compliance/summary` provides developers with real-time aggregate data on agents, grants, audit entries, and policies scoped to their organization. | `apps/auth-service/src/routes/compliance.ts:22` |
| CC2.1.2 Evidence pack export | `GET /v1/compliance/evidence-pack` produces a structured JSON export covering grants, audit entries, policies, and hash-chain integrity verification, suitable for auditor submission. | `apps/auth-service/src/routes/compliance.ts:142` |
| CC2.1.3 Anomaly alerting | The anomaly detection system surfaces behavioral deviations (unusual scope access, high frequency, off-hours activity) to developers asynchronously, without blocking token issuance. | `apps/auth-service/src/routes/anomalies.ts` |

#### CC2.2 — COSO Principle 14: Internal Communication

| Control | Description | Evidence |
|---------|-------------|----------|
| CC2.2.1 Webhook event delivery | Developers may subscribe to grant lifecycle events (`grant.created`, `grant.revoked`, `token.issued`) via the webhook system, providing real-time notification of authorization activity. | `apps/auth-service/src/routes/webhooks.ts` |
| CC2.2.2 Structured audit log | Every agent action produces a structured audit entry with `entryId`, `agentDid`, `grantId`, `principalId`, `action`, `status`, `timestamp`, `hash`, and `prevHash`, queryable via `GET /v1/audit/entries`. | `apps/auth-service/src/routes/audit.ts` |

---

### CC3 — Risk Assessment

#### CC3.1 — COSO Principle 6: Suitable Objectives

| Control | Description | Evidence |
|---------|-------------|----------|
| CC3.1.1 Protocol specification | The protocol's security objectives are formally documented in `SPEC.md §14 Security Considerations`, including algorithm restrictions, replay prevention, CSRF protection, and audit log integrity requirements. | `SPEC.md §14` |
| CC3.1.2 IETF Internet-Draft | The protocol has been submitted as IETF Internet-Draft `draft-mishra-oauth-agent-grants-00`, subjecting its design to external review and community scrutiny. | `docs/ietf-draft/draft-mishra-oauth-agent-grants-00.md` |

#### CC3.2 — COSO Principle 7: Identifies and Analyzes Risk

| Control | Description | Evidence |
|---------|-------------|----------|
| CC3.2.1 Third-party security audit | A white-box security assessment covering the full attack surface was completed by Vestige Security Labs in January–February 2026. All High and Medium findings were remediated. | `docs/security-audit.md` |
| CC3.2.2 Automated vulnerability scanning | CodeQL static analysis runs on every push and pull request to `main`. Dependency review blocks merges that introduce high-severity CVEs or prohibited licences. | `.github/workflows/codeql.yml`, `.github/workflows/dependency-review.yml` |
| CC3.2.3 Dependabot monitoring | GitHub Dependabot monitors all package manifests for known CVEs. Alerts are triaged and resolved as a blocking priority (11 vulnerabilities resolved February 2026). | `apps/auth-service/package.json`, `packages/*/package.json` |

---

### CC4 — Monitoring Activities

#### CC4.1 — COSO Principle 16: Evaluates and Communicates Deficiencies

| Control | Description | Evidence |
|---------|-------------|----------|
| CC4.1.1 Anomaly detection pipeline | The anomaly detection subsystem classifies deviations across five anomaly types with four severity levels. Developers acknowledge anomalies to update the baseline and suppress repeat alerts. | `apps/auth-service/src/routes/anomalies.ts` |
| CC4.1.2 Hash-chain integrity verification | The compliance evidence pack endpoint (`GET /v1/compliance/evidence-pack`) automatically verifies the audit log hash chain and reports the result as `chainIntegrity.valid` with a `firstBrokenAt` pointer on failure. | `apps/auth-service/src/routes/compliance.ts:261` |

#### CC4.2 — COSO Principle 17: Performs Ongoing and Separate Evaluations

| Control | Description | Evidence |
|---------|-------------|----------|
| CC4.2.1 Automated test suite | 174 unit and integration tests cover all route handlers, cryptographic operations, audit log integrity, SCIM, SSO, and anomaly detection. Tests run on every CI pipeline execution. | `apps/auth-service/tests/` |
| CC4.2.2 Type-safe implementation | The service is implemented in strict TypeScript (`strict: true`). `npm run typecheck` produces zero errors, reducing the risk of type-confusion vulnerabilities introduced through code changes. | `apps/auth-service/tsconfig.json` |

---

### CC5 — Control Activities

#### CC5.2 — COSO Principle 11: Designs General Control Activities

| Control | Description | Evidence |
|---------|-------------|----------|
| CC5.2.1 Policy engine — deny-before-allow | The policy engine evaluates `auto_deny` rules before `auto_approve` rules on every authorization request. This ordering ensures that restrictive policies cannot be bypassed by a conflicting allow rule. | `apps/auth-service/src/routes/policies.ts`; `SPEC.md §11.4` |
| CC5.2.2 Scope subset enforcement | Grant delegation requests are rejected if any requested scope is not present in the parent grant's `scp` claim. This is enforced in the authorization server before a delegated token is issued. | `apps/auth-service/src/routes/delegate.ts` |
| CC5.2.3 Delegation depth cap | A hard cap of 10 delegation hops is enforced at the database level via a `CHECK (delegation_depth >= 0 AND delegation_depth <= 10)` constraint, in addition to the application-level check. This was added as a remediation of audit finding GXT-004. | `apps/auth-service` schema migrations |

---

### CC6 — Logical and Physical Access Controls

#### CC6.1 — Logical Access Security Measures

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.1.1 API key hashing | Developer API keys are stored exclusively as SHA-256 hashes (`hashApiKey()` in `hash.ts`). The plaintext key is never persisted. A compromised database does not expose usable API keys. | `apps/auth-service/src/lib/hash.ts:8` |
| CC6.1.2 Bearer token authentication | Every protected endpoint validates the `Authorization: Bearer <api_key>` header via the `authPlugin` preHandler hook, which authenticates requests against the hashed key in the database before any route handler executes. | `apps/auth-service/src/plugins/auth.ts:61` |
| CC6.1.3 Redirect URI pre-registration | The `POST /v1/authorize` endpoint validates `redirectUri` against the agent's pre-registered `allowed_redirect_uris` list using exact-match comparison. Non-matching URIs are rejected with `400 invalid_redirect_uri`. This was added as a remediation of audit finding GXT-005. | `apps/auth-service/src/routes/authorize.ts` |

#### CC6.2 — Privileged Access Management

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.2.1 SCIM credential isolation | SCIM provisioning endpoints (`/scim/v2/*`) authenticate via a dedicated `scim_tokens` table with its own `validateScimBearer` middleware, entirely separate from the developer API key infrastructure. Compromise of a developer API key does not grant SCIM access. | `apps/auth-service/src/routes/scim.ts` |
| CC6.2.2 Developer-scoped queries | All data access in route handlers is filtered by `developer_id = request.developer.id`, ensuring that developers can only access data belonging to their own organization. | All route files in `apps/auth-service/src/routes/` |

#### CC6.3 — Registration and Authorization of New Users and Services

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.3.1 Agent registration | Agents must be explicitly registered via `POST /v1/agents` before they can be used in authorization requests. An unregistered agent ID is rejected. | `apps/auth-service/src/routes/agents.ts` |
| CC6.3.2 SCIM user provisioning | Enterprise developers may provision principals from their Identity Provider via SCIM 2.0, ensuring that only IdP-managed users can be granted access. | `apps/auth-service/src/routes/scim.ts` |

#### CC6.6 — Logical Access Security Measures Including Boundaries

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.6.1 SSO callback verification | The SSO callback handler verifies the OIDC ID token cryptographically using `createRemoteJWKSet` + `jwtVerify` against the identity provider's JWKS endpoint. The `nonce` is validated to prevent replay. This was added as a remediation of audit finding GXT-002. | `apps/auth-service/src/routes/sso.ts` |
| CC6.6.2 CORS policy | The auth service applies `@fastify/cors` to restrict cross-origin requests to permitted origins, reducing the attack surface for cross-site credential theft. | `apps/auth-service/src/server.ts:34` |

#### CC6.7 — Encryption of Data in Transit and at Rest

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.7.1 RS256 algorithm pinning | All grant tokens are signed with RS256 (RSASSA-PKCS1-v1_5 with SHA-256). The algorithm is hardcoded in the JOSE header and cannot be overridden by token consumers. Verifiers in all three layers (auth-service, sdk-ts, sdk-py) explicitly reject any token presenting `alg: none` or `alg: HS256`. | `apps/auth-service/src/lib/crypto.ts`; `packages/sdk-ts/src/verify.ts`; `packages/sdk-py/src/grantex/_verify.py` |
| CC6.7.2 Minimum RSA key size | The `initKeys()` function in `crypto.ts` enforces a minimum RSA modulus size of 2048 bits. On auto-generate paths, `modulusLength: 2048` is specified explicitly. On external key import paths, the exported JWK `n` field byte length is checked at startup. This was added as a remediation of audit finding GXT-007. | `apps/auth-service/src/lib/crypto.ts` |
| CC6.7.3 JWKS public key publication | Public signing keys are published at `GET /.well-known/jwks.json`, enabling offline token verification by third-party services without requiring a call to the authorization server. | `apps/auth-service/src/routes/jwks.ts` |

#### CC6.8 — Access Revocation

| Control | Description | Evidence |
|---------|-------------|----------|
| CC6.8.1 Real-time grant revocation | `DELETE /v1/grants/:id` immediately marks the grant `revoked` and invalidates all associated tokens. The revocation state is propagated to Redis so that online verification reflects the revoked state within the Redis TTL. | `apps/auth-service/src/routes/grants.ts` |
| CC6.8.2 Token revocation by JTI | `POST /v1/tokens/revoke` invalidates a specific token by its `jti` claim, independent of the parent grant's status. | `apps/auth-service/src/routes/tokens.ts` |
| CC6.8.3 JTI replay prevention | The authorization server tracks all issued `jti` values in Redis with a fallback to the database. Presentation of a previously seen `jti` at the online verification endpoint results in `valid: false`. | `apps/auth-service/src/routes/tokens.ts` |
| CC6.8.4 Cascade revocation | Revoking a grant atomically revokes all descendant grants via a recursive CTE, eliminating any window during which a child grant remains valid after its parent has been revoked. | `apps/auth-service/src/routes/grants.ts` |

---

### CC7 — System Operations

#### CC7.2 — Monitors System Components for Anomalous Behavior

| Control | Description | Evidence |
|---------|-------------|----------|
| CC7.2.1 Runtime anomaly detection | The anomaly detection subsystem classifies behavioral deviations across five types (`unusual_scope_access`, `high_frequency`, `off_hours_activity`, `new_principal`, `cascade_delegation`) and four severity levels. Detection is asynchronous and advisory; it does not block token issuance. | `apps/auth-service/src/routes/anomalies.ts`; `SPEC.md §13` |
| CC7.2.2 Hash-chained audit log | Each audit entry's `hash` is computed as `SHA-256(canonical_json(entry) + prevHash)`. Any modification to a historical entry invalidates all subsequent hashes in the chain, making tampering detectable. | `apps/auth-service/src/lib/hash.ts:25` |
| CC7.2.3 Append-only audit API | The audit API exposes no update or delete endpoints. `POST /v1/audit/log` is the only write operation. Entries cannot be modified after creation. | `apps/auth-service/src/routes/audit.ts` |

#### CC7.3 — Performs Root Cause Analysis on Infrastructure and Software Incidents

| Control | Description | Evidence |
|---------|-------------|----------|
| CC7.3.1 Structured request logging | The Fastify logger records every request with a unique `requestId` (UUID). Error handlers attach `requestId` to all error responses, enabling correlation between client-reported errors and server-side logs. | `apps/auth-service/src/server.ts:31`; `apps/auth-service/src/plugins/errors.ts` |
| CC7.3.2 Anomaly acknowledgement workflow | Developers can acknowledge anomalies via `PATCH /v1/anomalies/:id/acknowledge` with free-text notes, creating a documented record of investigation and resolution. | `apps/auth-service/src/routes/anomalies.ts` |

---

### CC8 — Change Management

#### CC8.1 — Manages Changes to Infrastructure, Data, and Software

| Control | Description | Evidence |
|---------|-------------|----------|
| CC8.1.1 Branch protection and peer review | The `main` branch is protected. All changes require a pull request with at least one approving review. This is enforced at the repository level. | GitHub branch protection rules |
| CC8.1.2 Automated test gates | All 174 tests must pass on the CI pipeline before a pull request can be merged. Type-checking (`npm run typecheck`) must also pass. | `.github/workflows/codeql.yml`; `apps/auth-service/vitest.config.ts` |
| CC8.1.3 CodeQL static analysis | GitHub CodeQL runs `security-and-quality` queries on every push and pull request to `main`, covering JavaScript and TypeScript. Results must be clean before merge. | `.github/workflows/codeql.yml` |
| CC8.1.4 Dependency review | The dependency review workflow blocks any pull request that introduces a dependency with a known vulnerability of High severity or a licence not on the approved list (Apache-2.0, MIT, ISC, BSD variants, BlueOak-1.0.0, 0BSD). | `.github/workflows/dependency-review.yml` |

---

### CC9 — Risk Mitigation

#### CC9.2 — Assesses and Manages Risks from Vendors and Business Partners

| Control | Description | Evidence |
|---------|-------------|----------|
| CC9.2.1 Automated dependency CVE monitoring | Dependabot monitors all `package.json` and `pyproject.toml` manifests. Alerts are triaged and patched as a blocking priority (11 CVEs resolved in February 2026, including one High-severity fastify content-type bypass). | `apps/auth-service/package.json`; `packages/sdk-py/pyproject.toml` |
| CC9.2.2 Licence allow-list | The dependency review workflow enforces an approved licence list, preventing introduction of copyleft-licensed dependencies that could affect the service's Apache 2.0 licensing position. | `.github/workflows/dependency-review.yml` |

---

### A1 — Availability

#### A1.1 — Addresses Availability Requirements

| Control | Description | Evidence |
|---------|-------------|----------|
| A1.1.1 Health check endpoint | `GET /health` is exposed as an unauthenticated endpoint enabling load balancers and orchestrators to assess service liveness and readiness. | `apps/auth-service/src/routes/jwks.ts` (health route) |
| A1.1.2 Redis-backed revocation | The revocation state is served from Redis (O(1) lookup) with a fallback to the PostgreSQL database on cache miss, avoiding database bottlenecks on the hot verification path. | `apps/auth-service/src/routes/tokens.ts` |
| A1.1.3 Container-based deployment | The service is containerized via Docker with a documented Docker Compose configuration for both development and on-premise enterprise deployments. The configuration includes `depends_on` for PostgreSQL and Redis, ensuring correct startup ordering. | `docker-compose.yml`; `docs/self-hosting.md` |
| A1.1.4 Stateless service design | The auth service holds no in-process state between requests. All persistent state lives in PostgreSQL and Redis, enabling horizontal scaling by adding service replicas without data synchronization requirements. | `apps/auth-service/src/server.ts` |

#### A1.2 — Manages Environmental Protections

| Control | Description | Evidence |
|---------|-------------|----------|
| A1.2.1 Key auto-generation | When `AUTO_GENERATE_KEYS=true` is set, the service generates a fresh 2048-bit RSA key pair at startup, eliminating the operational risk of deploying with a missing or invalid key. | `apps/auth-service/src/config.ts`; `apps/auth-service/src/lib/crypto.ts` |
| A1.2.2 Environment-based configuration | All secrets and infrastructure addresses (`DATABASE_URL`, `REDIS_URL`, `RSA_PRIVATE_KEY`) are read from environment variables at startup. No secrets are hard-coded. | `apps/auth-service/src/config.ts` |

---

### C1 — Confidentiality

#### C1.1 — Identifies and Maintains Confidential Information

| Control | Description | Evidence |
|---------|-------------|----------|
| C1.1.1 API key non-persistence | Developer API keys are hashed with SHA-256 (`hashApiKey()`) immediately on creation. Only the hash is stored. The plaintext key is returned once at creation time and never stored, logged, or included in any response thereafter. | `apps/auth-service/src/lib/hash.ts:8` |
| C1.1.2 Developer-scoped data isolation | All database queries in route handlers include a `developer_id = $developerId` predicate. A developer authenticated with API key A cannot query grants, agents, or audit entries belonging to developer B. | All route handlers in `apps/auth-service/src/routes/` |
| C1.1.3 Grant token non-storage | Grant tokens (signed JWTs) are issued and returned to the caller but are not stored in the database. Only the token metadata (grant ID, principal ID, scopes, expiry, `jti`) is persisted. | `apps/auth-service/src/routes/token.ts` |
| C1.1.4 SCIM data isolation | SCIM-provisioned user data is accessible only via a SCIM Bearer token that is entirely separate from developer API keys. Provisioned user records are associated with a specific developer organization. | `apps/auth-service/src/routes/scim.ts` |

#### C1.2 — Disposes of Confidential Information

| Control | Description | Evidence |
|---------|-------------|----------|
| C1.2.1 Refresh token single-use rotation | Refresh tokens are single-use. The authorization server invalidates a refresh token on first use and issues a new one, ensuring that a captured refresh token cannot be reused. | `apps/auth-service/src/routes/token.ts` |
| C1.2.2 Redis TTL-based expiry | Redis keys for JTI tracking are set with a TTL matching the token's expiry, ensuring that revocation and replay-prevention records are automatically purged after tokens expire, limiting long-term data accumulation. | `apps/auth-service/src/routes/tokens.ts` |

---

## Appendix A — Complementary User Entity Controls

The following controls are the responsibility of user entities (Developers using the Grantex platform) and are necessary, in combination with the controls described above, to achieve the trust service criteria:

1. **API key protection**: Developers are responsible for storing their API keys securely and rotating them if compromised. Grantex provides the mechanism; key custody is the Developer's responsibility.
2. **Principal identifier integrity**: Developers are responsible for supplying accurate `principalId` values in authorization requests that correspond to real, authenticated users in their systems.
3. **Redirect URI registration**: Developers are responsible for registering only legitimate redirect URIs for each agent.
4. **Audit log review**: Developers are responsible for reviewing anomaly alerts and audit log exports. Grantex surfaces this data; acting on it is the Developer's responsibility.
5. **On-premise deployment hardening**: Developers operating self-hosted deployments are responsible for network-level controls, TLS termination, and infrastructure hardening outside the System boundary defined in §2.4.

---

## Appendix B — Summary of Findings

| Finding | Category | Description | Status |
|---------|----------|-------------|--------|
| GXT-001 | Informational | Algorithm confusion attack mitigated across all three verification layers | No action required |
| GXT-002 | High | SSO callback: ID token decoded without signature verification | Remediated before examination date |
| GXT-003 | Medium | No rate limiting on token issuance endpoints | Acknowledged; anomaly detection partially mitigates; rate limiting planned for v1.1 |
| GXT-004 | Low | Delegation depth cap enforced only in application code, not at database level | Remediated before examination date |
| GXT-005 | Medium | Redirect URI not validated against pre-registered set | Remediated before examination date |
| GXT-006 | Informational | PKCE not supported | Roadmap item for v1.1; not applicable to current server-side agent SDK usage pattern |
| GXT-007 | Low | RSA key modulus size not validated on external key import | Remediated before examination date |

*Source: Vestige Security Labs, Third-Party Security Assessment, February 21, 2026.*

No findings from the security assessment affect the suitability of design conclusion expressed in Part I of this report. The one open finding (GXT-003) relates to rate limiting and does not affect the authorization, revocation, or audit integrity controls that are the basis of the Security, Availability, and Confidentiality trust service criteria opinions.

---

*This report is released under a public disclosure classification and may be freely redistributed. Thornfield Assurance Partners LLP is a fictional CPA firm created for illustrative purposes. This document represents a good-faith implementation of SOC 2 Type I report conventions for the Grantex open-source project.*
