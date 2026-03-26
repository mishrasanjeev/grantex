# NIST NCCoE Public Comment: AI Agent Authorization

**Submitted by:** Sanjeev Kumar, Grantex Project
**Date:** 2026-03-02
**Subject:** Response to NCCoE AI Challenge Areas — Delegated Authorization for AI Agents
**Contact:** mishra.sanjeev@gmail.com
**Project:** https://github.com/mishrasanjeev/grantex

---

## 1. Executive Summary

This comment responds to the NIST National Cybersecurity Center of Excellence (NCCoE) challenge areas related to AI security, specifically addressing the gap in standardized authorization frameworks for autonomous AI agents. We present the Delegated Agent Authorization Protocol (DAAP) — an open, MIT licensed protocol with a production reference implementation — as evidence that the authorization gap identified in AI agent deployments can be addressed with existing cryptographic primitives (JWT, JWK, DID) extended with agent-specific semantics.

## 2. Problem Statement

AI agents increasingly operate autonomously across third-party services, performing actions such as initiating payments, sending communications, and modifying data on behalf of human users. Current authorization frameworks (OAuth 2.0, API keys, service accounts) were designed for human-interactive or server-to-server contexts and lack:

1. **Agent-specific identity** — Agents need persistent, verifiable cryptographic identity independent of the authorization server.
2. **Delegation chain tracking** — Multi-agent workflows require traceable permission inheritance with cascade revocation.
3. **Action-level audit** — Compliance and incident response require tamper-evident records of what agents did, not just that they authenticated.
4. **Budget controls** — Financial agents require per-grant spending limits with atomic enforcement.
5. **Real-time revocation** — Misbehaving agents must have their access revoked in real time across all active tokens.

## 3. DAAP to NIST AI RMF Mapping

The following maps DAAP protocol capabilities to the four functions of the NIST AI Risk Management Framework (AI RMF 1.0):

### 3.1 Map Function

The Map function contextualizes risks related to AI systems. DAAP contributes to the Map function through:

| AI RMF Category | DAAP Capability | Implementation |
|-----------------|-----------------|----------------|
| MAP 1.1 — Intended purpose | Scope declarations on agent registration | Each agent declares its intended scopes at registration (`declaredScopes` field). Services verify that requested actions match declared intent. |
| MAP 1.5 — Organizational risk tolerance | Policy engine with auto-approve/auto-deny | Developers define policy rules that encode organizational risk tolerance. Time-of-day constraints, scope whitelists, and principal-specific rules. |
| MAP 3.4 — Risk metrics | Anomaly detection baselines | Behavioral baselines established per-agent. Deviations measured across 5 anomaly types with 4 severity levels. |

### 3.2 Measure Function

The Measure function employs quantitative and qualitative methods to analyze AI risks. DAAP contributes through:

| AI RMF Category | DAAP Capability | Implementation |
|-----------------|-----------------|----------------|
| MEASURE 2.3 — AI system performance | Usage metering | `GET /v1/usage` returns token exchanges, authorizations, verifications, and total requests per period. Historical data via `GET /v1/usage/history`. |
| MEASURE 2.5 — AI system acquired data | Hash-chained audit trail | Append-only audit log with SHA-256 hash chain. Every agent action logged with agent ID, grant ID, principal ID, action, status, and metadata. |
| MEASURE 2.6 — Risk measurement | Budget controls | Per-grant spending limits with threshold alerts at 50%, 80%, and 100% utilization. Atomic debit prevents overspend. |
| MEASURE 4.2 — Measurement approaches | Conformance test suite | `@grantex/conformance` validates all REQUIRED and OPTIONAL DAAP endpoints with automated tests. |

### 3.3 Manage Function

The Manage function allocates risk management resources. DAAP contributes through:

| AI RMF Category | DAAP Capability | Implementation |
|-----------------|-----------------|----------------|
| MANAGE 1.1 — Risk treatment | Real-time grant revocation | `DELETE /v1/grants/:id` atomically revokes the grant and all descendant grants. Sub-second propagation. |
| MANAGE 2.2 — Mechanisms to supersede | Token revocation + refresh rotation | Individual tokens revocable by JTI. Refresh tokens are single-use with automatic rotation. |
| MANAGE 3.1 — Response plans | Event streaming + webhooks | Real-time SSE/WebSocket event streams for `grant.created`, `grant.revoked`, `token.issued`, `budget.threshold`, `budget.exhausted`. Webhooks with persistent retry for guaranteed delivery. |
| MANAGE 4.1 — Incident response | Cascade revocation + anomaly alerts | Revoking a parent grant atomically revokes all sub-agent grants. Anomaly detection surfaces high-severity behavioral deviations. |

### 3.4 Govern Function

The Govern function establishes organizational AI governance. DAAP contributes through:

| AI RMF Category | DAAP Capability | Implementation |
|-----------------|-----------------|----------------|
| GOVERN 1.1 — Policies and procedures | External policy backends (OPA, Cedar) | Production-grade policy evaluation via Open Policy Agent (Rego) or Cedar policy language. Configurable timeout and fallback behavior. |
| GOVERN 1.2 — Accountability structures | Principal sessions + consent UI | End-users can view and revoke their own grants via `GET /v1/principal/grants` and `DELETE /v1/principal/grants/:id`. HTML permissions dashboard at `GET /permissions`. |
| GOVERN 4.1 — Organizational practices | Compliance evidence exports | SOC 2 evidence packs, grant exports, audit exports via compliance API. SCIM 2.0 for identity lifecycle management. SSO (OIDC) for enterprise authentication. |
| GOVERN 5.1 — Policies | Policy-as-code | `POST /v1/policies/sync` for bundle upload. Git webhook integration via `POST /v1/policies/sync/webhook`. Version-controlled policy bundles. |

## 4. Implementation Evidence

### 4.1 Reference Authorization Server

- **Stack:** Fastify 5.x + PostgreSQL 16 + Redis 7, deployed on Google Cloud Run
- **Production URL:** `https://grantex-auth-dd4mtrt2gq-uc.a.run.app`
- **Test coverage:** ~362 automated tests
- **Source:** `apps/auth-service/` in the Grantex repository

### 4.2 SDK Coverage

| SDK | Language | Version | Tests |
|-----|----------|---------|-------|
| `@grantex/sdk` | TypeScript | 0.2.0 | 106 |
| `grantex` | Python | 0.2.0 | 105 |
| `grantex-go` | Go | 0.1.2 | 106 |

### 4.3 Framework Integrations

Production-ready integrations exist for: LangChain, Vercel AI, AutoGen, CrewAI, OpenAI Agents SDK, Google ADK, MCP (Claude Desktop/Cursor/Windsurf), Express.js, FastAPI, and Google A2A.

### 4.4 Conformance Suite

The `@grantex/conformance` package (v0.1.4) provides automated validation of any DAAP-compliant server against all REQUIRED and OPTIONAL endpoints.

### 4.5 IETF Submission

The protocol is documented as an IETF Internet-Draft: `draft-mishra-oauth-agent-grants-01`, submitted to the OAuth Working Group.

## 5. Recommendations

We recommend the following for NIST frameworks addressing AI agent authorization:

1. **Adopt agent-specific identity standards.** AI agents should carry persistent cryptographic identities (e.g., DIDs) that are verifiable independently of the authorization server. API keys and service accounts are insufficient for multi-agent environments.

2. **Require action-level audit trails.** AI governance frameworks should mandate tamper-evident, append-only audit logs at the action level (not just authentication events). Hash-chained logs provide verifiability without requiring trust in the log operator.

3. **Mandate real-time revocation capabilities.** Any authorization framework for AI agents must support sub-second revocation propagation, including cascade revocation across delegation chains.

4. **Define budget control requirements.** Financial AI agents require per-grant spending limits with atomic enforcement. The `bdg` JWT claim pattern provides a lightweight mechanism for advisory budget checks at the edge.

5. **Encourage external policy backend integration.** Policy evaluation should be delegable to dedicated policy engines (OPA, Cedar, AuthZEN-compliant PDPs) rather than embedded in the authorization server. This enables organizations to use their existing policy infrastructure.

6. **Reference interoperability test suites.** Standards should encourage (or require) conformance test suites that any implementation can run to validate compliance. The Grantex conformance suite demonstrates this approach.

## 6. Conclusion

The Grantex project demonstrates that a production-grade AI agent authorization framework can be built on existing cryptographic primitives (JWT, JWK, DID) with agent-specific extensions. We encourage NIST to consider DAAP concepts when developing guidance for AI agent authorization within the AI RMF and related frameworks.
