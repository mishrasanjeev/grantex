# Grantex Manual QA Test Plan

**Version**: 1.0
**Date**: 2026-03-28
**Project**: Grantex — Delegated Authorization Protocol for AI Agents
**Production URL**: https://grantex-auth-dd4mtrt2gq-uc.a.run.app
**Docs**: https://docs.grantex.dev
**Landing Page**: https://grantex.dev

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Glossary](#2-glossary)
3. [Environment Setup](#3-environment-setup)
4. [Module 1: Developer Signup & Account Management](#4-module-1-developer-signup--account-management)
5. [Module 2: Agent Management](#5-module-2-agent-management)
6. [Module 3: Authorization & Consent Flow](#6-module-3-authorization--consent-flow)
7. [Module 4: Token Exchange & JWT](#7-module-4-token-exchange--jwt)
8. [Module 5: Token Verification & Revocation](#8-module-5-token-verification--revocation)
9. [Module 6: Grant Management & Delegation](#9-module-6-grant-management--delegation)
10. [Module 7: PKCE (Proof Key for Code Exchange)](#10-module-7-pkce-proof-key-for-code-exchange)
11. [Module 8: Token Refresh](#11-module-8-token-refresh)
12. [Module 9: Policy Engine](#12-module-9-policy-engine)
13. [Module 10: Webhooks](#13-module-10-webhooks)
14. [Module 11: Audit Trail](#14-module-11-audit-trail)
15. [Module 12: Anomaly Detection](#15-module-12-anomaly-detection)
16. [Module 13: Principal Sessions & Dashboard](#16-module-13-principal-sessions--dashboard)
17. [Module 14: Budgets & Spend Control](#17-module-14-budgets--spend-control)
18. [Module 15: Usage Metering](#18-module-15-usage-metering)
19. [Module 16: Custom Domains](#19-module-16-custom-domains)
20. [Module 17: FIDO2/WebAuthn](#20-module-17-fido2webauthn)
21. [Module 18: Verifiable Credentials & SD-JWT](#21-module-18-verifiable-credentials--sd-jwt)
22. [Module 19: DID Infrastructure](#22-module-19-did-infrastructure)
23. [Module 20: SCIM 2.0 Provisioning](#23-module-20-scim-20-provisioning)
24. [Module 21: SSO Configuration](#24-module-21-sso-configuration)
25. [Module 22: Billing & Subscriptions](#25-module-22-billing--subscriptions)
26. [Module 23: Compliance & Reporting](#26-module-23-compliance--reporting)
27. [Module 24: Events (SSE & WebSocket)](#27-module-24-events-sse--websocket)
28. [Module 25: Rate Limiting](#28-module-25-rate-limiting)
29. [Module 26: Developer Portal (React UI)](#29-module-26-developer-portal-react-ui)
30. [Module 27: TypeScript SDK](#30-module-27-typescript-sdk)
31. [Module 28: Python SDK](#31-module-28-python-sdk)
32. [Module 29: Go SDK](#32-module-29-go-sdk)
33. [Module 30: CLI Tool](#33-module-30-cli-tool)
34. [Module 31: Gateway (Reverse Proxy)](#34-module-31-gateway-reverse-proxy)
35. [Module 32: Express Middleware](#35-module-32-express-middleware)
36. [Module 33: FastAPI Middleware](#36-module-33-fastapi-middleware)
37. [Module 34: MCP Server](#37-module-34-mcp-server)
38. [Module 35: MCP Auth Server](#38-module-35-mcp-auth-server)
39. [Module 36: Framework Integrations](#39-module-36-framework-integrations)
40. [Module 37: Service Adapters](#40-module-37-service-adapters)
41. [Module 38: Event Destinations](#41-module-38-event-destinations)
42. [Module 39: A2A Protocol Bridges](#42-module-39-a2a-protocol-bridges)
43. [Module 40: Terraform Provider](#43-module-40-terraform-provider)
44. [Module 41: Conformance Test Suite](#44-module-41-conformance-test-suite)
45. [Module 42: Example Applications](#45-module-42-example-applications)
46. [Module 43: Landing Page & Documentation](#46-module-43-landing-page--documentation)
47. [Module 44: Deployment & Infrastructure](#47-module-44-deployment--infrastructure)
48. [Cross-Cutting: Security Testing](#48-cross-cutting-security-testing)
49. [Cross-Cutting: Error Handling](#49-cross-cutting-error-handling)
50. [Cross-Cutting: Observability](#50-cross-cutting-observability)
51. [Bug Report Template](#51-bug-report-template)
52. [Test Execution Tracker](#52-test-execution-tracker)

---

## 1. Project Overview

### What is Grantex?

Grantex is an **open delegated authorization protocol for AI agents** — think "OAuth 2.0 for AI agents." It lets human users (called **principals**) grant specific, scoped, revocable permissions to AI agents, and provides a full audit trail of what agents do with those permissions.

### Architecture at a Glance

```
Principal (Human User)
    |
    | 1. Approves via Consent Page
    v
Auth Service (Fastify + PostgreSQL + Redis)
    |
    | 2. Issues signed JWT (Grant Token)
    v
Developer's Application
    |
    | 3. Agent acts with Grant Token
    v
Service Provider (Google, Stripe, Slack, etc.)
    |
    | 4. Adapter verifies token + enforces scopes
    v
Audit Trail (immutable, hash-chained)
```

### Core Flow (Happy Path)

1. **Developer** registers and creates an **Agent** with specific **scopes**
2. Developer calls `POST /v1/authorize` to start an authorization request
3. **Principal** visits the **Consent Page** and approves (or denies)
4. Developer exchanges the authorization **code** for a **Grant Token** (JWT)
5. Agent uses the Grant Token to act on behalf of the principal
6. Token can be **verified**, **refreshed**, **delegated**, or **revoked**
7. All actions are recorded in an immutable **audit trail**

### What the QA Team Needs to Test

| Layer | What | Examples |
|-------|------|---------|
| **Auth Service API** | 40+ REST endpoints | Authorization, tokens, grants, policies, webhooks, audit, budgets, SCIM, SSO, WebAuthn, credentials |
| **Developer Portal** | React web app (28 pages) | Dashboard, agent management, grant listing, policy editor, billing |
| **Consent Page** | Server-rendered HTML | Approval/denial UI, FIDO gate, redirect handling |
| **SDKs** | TypeScript, Python, Go | Method correctness, error handling, offline verification |
| **CLI** | Terminal tool | All commands produce correct output |
| **Gateway** | Reverse proxy | Token verification, scope enforcement, upstream proxying |
| **Middleware** | Express.js, FastAPI | Token extraction, scope checking, error responses |
| **MCP Server** | Claude/Cursor integration | 13 tools work correctly |
| **Framework Integrations** | LangChain, CrewAI, Vercel AI, OpenAI Agents, Google ADK, AutoGen | Scope enforcement, audit callbacks |
| **Service Adapters** | 11 service connectors | Google, Stripe, Slack, GitHub, etc. |
| **Conformance Suite** | Black-box test runner | Validates any Grantex server implementation |
| **Examples** | 14 runnable apps | Each example completes without errors |
| **Docs & Landing Page** | Static sites | Links work, content accurate, responsive |

---

## 2. Glossary

| Term | Definition |
|------|-----------|
| **Principal** | The human user who owns the data/permissions. They approve or deny authorization requests. |
| **Agent** | An AI agent (software) that acts on behalf of a principal. Identified by a DID (`did:grantex:ag_...`). |
| **Developer** | The person/organization that builds and operates agents. Authenticated via API key (`gx_live_*` or `gx_test_*`). |
| **Grant** | A record that a principal has authorized an agent to act with specific scopes. Has status: `active`, `revoked`, `expired`. |
| **Grant Token** | A signed RS256 JWT issued after authorization. Contains claims: `sub` (principal), `agt` (agent DID), `scp` (scopes), etc. |
| **Scope** | A permission string like `calendar:read`, `email:send`. Can have constraints like `payments:initiate:max_500`. |
| **Consent Page** | The HTML page where a principal reviews and approves/denies an authorization request. |
| **Authorization Code** | A one-time code issued after consent approval. Exchanged for a Grant Token via `POST /v1/token`. |
| **PKCE** | Proof Key for Code Exchange — prevents authorization code interception. Uses S256 challenge/verifier. |
| **Refresh Token** | A single-use token to get a new Grant Token without re-authorization. Rotated on each use. |
| **Delegation** | When an agent creates a sub-grant for another agent, with scopes that are a subset of its own. |
| **Audit Entry** | An immutable, hash-chained record of an action (grant issued, token verified, etc.). |
| **Policy** | A rule that auto-approves or auto-denies authorization requests based on agent, principal, scopes, or time. |
| **Webhook** | A registered URL that receives HTTP POST notifications for events like `grant.created`, `token.issued`. |
| **DID** | Decentralized Identifier — each agent gets `did:grantex:{agentId}`. The developer gets `did:web:grantex.dev`. |
| **VC** | Verifiable Credential — a W3C standard credential (VC-JWT format) optionally issued with grant tokens. |
| **SD-JWT** | Selective Disclosure JWT — allows presenting only specific claims from a credential. |
| **SCIM** | System for Cross-domain Identity Management — enterprise user provisioning standard (v2.0). |
| **SSO** | Single Sign-On — OIDC-based configuration for enterprise authentication. |
| **Budget** | A spend allocation attached to a grant. Debits are tracked; 402 returned when exhausted. |
| **Sandbox Mode** | API key prefix `gx_test_*`. Auto-approves all authorization requests (no consent page needed). |
| **Live Mode** | API key prefix `gx_live_*`. Full consent flow required. |

---

## 3. Environment Setup

### 3.1 Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Auth service, TS SDK, CLI, portal, gateway, MCP |
| npm | 9+ | Package management |
| Python | 3.9+ | Python SDK, FastAPI middleware, CrewAI/OpenAI/ADK integrations |
| Go | 1.21+ | Go SDK, Terraform provider |
| Docker & Docker Compose | Latest | Local PostgreSQL + Redis |
| Git | Latest | Source control |
| Postman (optional) | Latest | API testing (collection provided at `docs/grantex.postman_collection.json`) |
| A modern browser | Chrome/Firefox/Edge | Portal and consent page testing |

### 3.2 Local Stack Setup

```bash
# 1. Clone the repository
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex

# 2. Start PostgreSQL and Redis via Docker
docker compose up -d

# 3. Install auth-service dependencies and run
cd apps/auth-service
npm install
npm run build
npm start
# Server starts on http://localhost:3001

# 4. Verify the server is running
curl http://localhost:3001/health
# Expected: { "status": "ok", "database": "ok", "redis": "ok" }
```

### 3.3 Seeded Test Credentials

When running locally with `SEED_API_KEY` and `SEED_SANDBOX_KEY` environment variables:

| Key | Mode | Behavior |
|-----|------|----------|
| `dev-api-key-local` | Live | Full consent flow (consent page required) |
| `sandbox-api-key-local` | Sandbox | Auto-approves all authorization requests |

### 3.4 Key URLs (Local)

| URL | Purpose |
|-----|---------|
| `http://localhost:3001` | Auth service base URL |
| `http://localhost:3001/health` | Health check |
| `http://localhost:3001/.well-known/jwks.json` | Public keys for JWT verification |
| `http://localhost:3001/consent?req={id}` | Consent page |
| `http://localhost:3001/dashboard` | Developer dashboard (server-rendered) |
| `http://localhost:3001/metrics` | Prometheus metrics |

### 3.5 Key URLs (Production)

| URL | Purpose |
|-----|---------|
| `https://grantex-auth-dd4mtrt2gq-uc.a.run.app` | Auth service |
| `https://grantex.dev` | Landing page |
| `https://docs.grantex.dev` | Documentation |
| `https://portal.grantex.dev` | Developer portal |

### 3.6 Postman Collection

Import `docs/grantex.postman_collection.json` and `docs/grantex.postman_environment.json` into Postman for pre-configured requests against all endpoints.

### 3.7 How to Run Automated Tests (for reference)

```bash
# Auth service unit tests (600+ tests)
cd apps/auth-service && npm test

# TypeScript SDK tests (156+ tests)
cd packages/sdk-ts && npm test

# Python SDK tests
cd packages/sdk-py && pytest tests/

# Go SDK tests (106 tests)
cd packages/go-sdk && go test ./...

# Conformance suite (against running server)
npx @grantex/conformance --base-url http://localhost:3001 --api-key dev-api-key-local
```

---

## 4. Module 1: Developer Signup & Account Management

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/signup` | None | Register new developer |
| GET | `/v1/me` | API Key | Get developer profile |
| PATCH | `/v1/me` | API Key | Update developer settings |
| POST | `/v1/keys/rotate` | API Key | Rotate API key |
| POST | `/v1/signup/verify` | None | Send verification email |
| GET | `/v1/signup/verify/:token` | None | Verify email token |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SIGNUP-001** | Register a new developer (happy path) | P0 | POST `/v1/signup` with `{ name, email, mode: "live" }` | 201: Returns `{ developerId, apiKey, mode, createdAt }`. API key starts with `gx_live_`. |
| **SIGNUP-002** | Register a sandbox developer | P0 | POST `/v1/signup` with `{ name, email, mode: "sandbox" }` | 201: API key starts with `gx_test_`. |
| **SIGNUP-003** | Register with missing name | P1 | POST `/v1/signup` with `{ email }` only | 400: Validation error. |
| **SIGNUP-004** | Register with missing email | P1 | POST `/v1/signup` with `{ name }` only | 400: Validation error. |
| **SIGNUP-005** | Register with duplicate email | P1 | POST `/v1/signup` twice with same email | Second call returns 409 or appropriate error. |
| **ME-001** | Get developer profile | P0 | GET `/v1/me` with valid API key in `Authorization: Bearer` header | 200: Returns `{ id, name, email, mode, createdAt }`. |
| **ME-002** | Get profile without auth | P0 | GET `/v1/me` without Authorization header | 401: `UNAUTHORIZED`. |
| **ME-003** | Get profile with invalid key | P0 | GET `/v1/me` with `Authorization: Bearer invalid-key` | 401: `UNAUTHORIZED`. |
| **ME-004** | Update developer settings | P1 | PATCH `/v1/me` with `{ fidoRequired: true }` | 200: Settings updated. Verify with subsequent GET `/v1/me`. |
| **KEY-001** | Rotate API key | P0 | POST `/v1/keys/rotate` with current API key | 200: Returns new API key. Old key stops working. New key works. |
| **KEY-002** | Old key rejected after rotation | P0 | After KEY-001, use the old key for GET `/v1/me` | 401: `UNAUTHORIZED`. |
| **VERIFY-001** | Send verification email | P2 | POST `/v1/signup/verify` with `{ email }` | 200: Email sent (verify in email logs or mock). |
| **VERIFY-002** | Verify email with valid token | P2 | GET `/v1/signup/verify/{token}` | 200: Email verified. |
| **VERIFY-003** | Verify email with invalid token | P2 | GET `/v1/signup/verify/invalid-token` | 400 or 404: Invalid token. |

---

## 5. Module 2: Agent Management

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/agents` | API Key | Register new agent |
| GET | `/v1/agents` | API Key | List agents |
| GET | `/v1/agents/:id` | API Key | Get agent details |
| PATCH | `/v1/agents/:id` | API Key | Update agent |
| DELETE | `/v1/agents/:id` | API Key | Delete agent |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **AGT-001** | Register a new agent | P0 | POST `/v1/agents` with `{ name: "EmailBot", description: "Reads emails", scopes: ["email:read", "email:send"] }` | 201: Returns `{ id, did, name, description, scopes, status: "active", createdAt }`. `did` starts with `did:grantex:`. |
| **AGT-002** | Register agent with empty scopes | P1 | POST `/v1/agents` with `{ name: "Bot", scopes: [] }` | 400: Validation error (scopes required). |
| **AGT-003** | Register agent without name | P1 | POST `/v1/agents` with `{ scopes: ["read"] }` | 400: Validation error. |
| **AGT-004** | List all agents | P0 | GET `/v1/agents` | 200: Returns array of agents belonging to this developer. |
| **AGT-005** | List agents — verify isolation | P1 | Create agents with Developer A's key. List with Developer B's key. | Developer B sees only their own agents, not Developer A's. |
| **AGT-006** | Get agent by ID | P0 | GET `/v1/agents/{agentId}` | 200: Returns full agent object. |
| **AGT-007** | Get agent with wrong developer key | P1 | GET `/v1/agents/{agentId}` using a different developer's key | 404: Agent not found (no cross-tenant access). |
| **AGT-008** | Update agent name and scopes | P1 | PATCH `/v1/agents/{id}` with `{ name: "NewName", scopes: ["calendar:read"] }` | 200: Updated fields reflected. |
| **AGT-009** | Delete an agent | P1 | DELETE `/v1/agents/{id}` | 204: No content. Subsequent GET returns 404. |
| **AGT-010** | Delete agent cascades grants | P1 | Create agent, authorize + exchange token, then delete agent | Agent deleted. Associated grants and auth requests should be cleaned up. |
| **AGT-011** | Plan limit on agents (free tier) | P2 | Create agents until hitting the free plan limit (200) | 402: `PLAN_LIMIT_EXCEEDED` with upgrade URL. |

---

## 6. Module 3: Authorization & Consent Flow

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/authorize` | API Key | Start authorization request |
| GET | `/consent?req={id}` | None | Serve consent HTML page |
| GET | `/v1/consent/:id` | None | Fetch auth request details (for consent JS) |
| POST | `/v1/consent/:id/approve` | None | Principal approves |
| POST | `/v1/consent/:id/deny` | None | Principal denies |

### Test Cases — API

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **AUTH-001** | Create authorization request (live mode) | P0 | POST `/v1/authorize` with `{ agentId, principalId: "user@example.com", scopes: ["email:read"] }` using live key | 201: Returns `{ authRequestId, consentUrl, expiresAt }`. Status is `pending`. |
| **AUTH-002** | Create authorization request (sandbox mode) | P0 | Same as AUTH-001 but with sandbox key | 201: Returns `{ authRequestId, consentUrl, expiresAt, code }`. Status is `approved`. Code is present (auto-approved). |
| **AUTH-003** | Authorize with non-existent agent | P0 | POST `/v1/authorize` with invalid `agentId` | 404: Agent not found. |
| **AUTH-004** | Authorize with scopes not on agent | P1 | Agent has `["email:read"]`, request `["email:read", "calendar:write"]` | 400: Scope `calendar:write` not registered on agent. |
| **AUTH-005** | Authorize with redirect URI | P1 | POST `/v1/authorize` with `redirectUri: "https://app.example.com/callback"` and `state: "abc123"` | 201: `consentUrl` generated. After approval, redirect includes `?code=...&state=abc123`. |
| **AUTH-006** | Authorize with custom expiresIn | P2 | POST `/v1/authorize` with `expiresIn: "1h"` | 201: `expiresAt` is ~1 hour from now (not default 24h). |
| **AUTH-007** | Authorize with audience | P2 | POST `/v1/authorize` with `audience: "https://api.example.com"` | 201: Created. Token will include `aud` claim. |
| **AUTH-008** | Authorize with budget | P2 | POST `/v1/authorize` with `budget: 100.00` | 201: Created. Budget allocation created after token exchange. |
| **AUTH-009** | Rate limit on authorize (10/min) | P1 | POST `/v1/authorize` 11 times in 1 minute | 11th request returns 429: Too Many Requests. |
| **AUTH-010** | Authorize after grant limit reached | P2 | Exhaust the free-tier grant limit (500) | 402: `PLAN_LIMIT_EXCEEDED`. |

### Test Cases — Consent Page (Browser)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **CONSENT-001** | Consent page loads | P0 | Open `{consentUrl}` in browser | Page loads with agent name, description, requested scopes, and Approve/Deny buttons. |
| **CONSENT-002** | Consent page shows correct scopes | P0 | Create auth request with `["email:read", "calendar:write"]`, open consent page | Both scopes displayed with human-readable descriptions. |
| **CONSENT-003** | Approve authorization | P0 | Click "Approve" on consent page | Success screen shown. If `redirectUri` was set, browser redirects with `?code=...&state=...`. |
| **CONSENT-004** | Deny authorization | P0 | Click "Deny" on consent page | Denied screen shown. If `redirectUri` was set, browser redirects with `?error=access_denied`. |
| **CONSENT-005** | Consent page for expired request | P1 | Wait for auth request to expire, then open consent page | Error shown: request has expired. |
| **CONSENT-006** | Consent page for already-consumed request | P1 | Approve, exchange code, then re-open consent page | Error: request already consumed. |
| **CONSENT-007** | Consent page mobile responsiveness | P2 | Open consent page on mobile viewport (375px wide) | Page is readable, buttons are tappable, no horizontal scroll. |
| **CONSENT-008** | Consent page with FIDO required | P2 | Set `fidoRequired: true` on developer, create auth request, open consent page | FIDO authentication step appears before Approve button is active. |
| **CONSENT-009** | Double-click approve | P1 | Click "Approve" twice rapidly | Only one approval processed. No duplicate grants. |

---

## 7. Module 4: Token Exchange & JWT

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/token` | API Key | Exchange code for grant token |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **TOK-001** | Exchange code for grant token | P0 | 1. Create auth request (sandbox). 2. POST `/v1/token` with `{ code, agentId }` | 200: Returns `{ grantToken, expiresAt, refreshToken, grantId, scopes }`. |
| **TOK-002** | Verify JWT structure | P0 | Decode the `grantToken` from TOK-001 | JWT has claims: `iss`, `sub` (principalId), `agt` (agent DID), `dev` (developerId), `scp` (scopes array), `jti`, `grnt`, `iat`, `exp`. Algorithm is RS256. |
| **TOK-003** | Verify JWT signature | P0 | Fetch JWKS from `/.well-known/jwks.json`. Verify JWT signature using the public key. | Signature is valid. `kid` in JWT header matches a key in JWKS. |
| **TOK-004** | Exchange with wrong agentId | P0 | POST `/v1/token` with valid code but wrong agentId | 400 or 403: Agent mismatch. |
| **TOK-005** | Exchange with wrong developer key | P0 | POST `/v1/token` with valid code but a different developer's API key | 400 or 403: Developer mismatch. |
| **TOK-006** | Exchange code twice (replay) | P0 | POST `/v1/token` with same code twice | First: 200. Second: 400 or 409 — code already consumed. |
| **TOK-007** | Exchange expired code | P1 | Wait for code to expire, then attempt exchange | 400: Code expired. |
| **TOK-008** | Exchange with non-existent code | P1 | POST `/v1/token` with `{ code: "nonexistent", agentId }` | 400 or 404: Invalid code. |
| **TOK-009** | Token includes audience claim | P2 | Create auth request with `audience`, approve, exchange | JWT `aud` claim matches the requested audience. |
| **TOK-010** | Token includes budget claim | P2 | Create auth request with `budget: 50`, approve, exchange | JWT `bdg` claim is `50`. |
| **TOK-011** | Rate limit on token exchange (20/min) | P1 | POST `/v1/token` 21 times in 1 minute | 21st request returns 429. |
| **TOK-012** | Token with VC format | P2 | POST `/v1/token` with `credentialFormat: "vc-jwt"` or similar | Response includes a Verifiable Credential alongside the grant token. |

---

## 8. Module 5: Token Verification & Revocation

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/tokens/verify` | API Key | Verify a grant token |
| POST | `/v1/tokens/revoke` | API Key | Revoke a token by JTI |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **VER-001** | Verify a valid token | P0 | POST `/v1/tokens/verify` with `{ token: "<valid JWT>" }` | 200: `{ valid: true, grantId, scopes, principal, agent, expiresAt }`. |
| **VER-002** | Verify an expired token | P0 | Wait for token to expire, then verify | 200: `{ valid: false }` or appropriate error. |
| **VER-003** | Verify a revoked token | P0 | Revoke token (REV-001), then verify | 200: `{ valid: false }`. |
| **VER-004** | Verify a malformed token | P1 | POST `/v1/tokens/verify` with `{ token: "not-a-jwt" }` | 400 or 200 with `{ valid: false }`. |
| **VER-005** | Verify token with tampered payload | P1 | Modify a JWT payload (change scopes), keep same signature | 200: `{ valid: false }` — signature mismatch. |
| **REV-001** | Revoke a token | P0 | POST `/v1/tokens/revoke` with `{ jti: "<tokenId>" }` | 204: No content. |
| **REV-002** | Revoke already-revoked token | P1 | Revoke same JTI twice | Second call: 204 (idempotent) or appropriate response. |
| **REV-003** | Revoke non-existent token | P1 | POST `/v1/tokens/revoke` with `{ jti: "nonexistent" }` | 404 or 204. |

---

## 9. Module 6: Grant Management & Delegation

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/v1/grants` | API Key | List grants |
| GET | `/v1/grants/:id` | API Key | Get grant details |
| DELETE | `/v1/grants/:id` | API Key | Revoke a grant |
| POST | `/v1/grants/delegate` | API Key | Create delegated sub-grant |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **GRN-001** | List grants | P0 | GET `/v1/grants` | 200: Array of grants for this developer. |
| **GRN-002** | List grants filtered by agentId | P1 | GET `/v1/grants?agentId={id}` | 200: Only grants for the specified agent. |
| **GRN-003** | List grants filtered by status | P1 | GET `/v1/grants?status=active` | 200: Only active grants. |
| **GRN-004** | Get grant by ID | P0 | GET `/v1/grants/{grantId}` | 200: Full grant object with `id, agentId, principalId, scopes, status, issuedAt, expiresAt`. |
| **GRN-005** | Get grant from another developer | P1 | GET `/v1/grants/{grantId}` with different developer's key | 404: Not found. |
| **GRN-006** | Revoke a grant | P0 | DELETE `/v1/grants/{grantId}` | 204: Grant status becomes `revoked`. Token verification returns `valid: false`. |
| **GRN-007** | Revoke already-revoked grant | P1 | DELETE same grant ID twice | Second call: 204 (idempotent) or 404. |
| **DEL-001** | Delegate a grant | P0 | POST `/v1/grants/delegate` with `{ grantToken: "<parent JWT>", agentId: "<child agent>", scopes: ["email:read"], expiresIn: "1h" }` | 200: `{ grantToken, expiresAt, scopes, grantId }`. New JWT has `parentAgt`, `parentGrnt`, `delegationDepth: 1`. |
| **DEL-002** | Delegate with scope escalation | P0 | Parent has `["email:read"]`. Delegate with `["email:read", "email:send"]` | 400: Cannot delegate scopes not in parent grant. |
| **DEL-003** | Delegate with expiry beyond parent | P1 | Parent expires in 1h. Delegate with `expiresIn: "24h"` | 400 or auto-capped: child expiry <= parent expiry. |
| **DEL-004** | Multi-level delegation | P1 | A delegates to B, B delegates to C | C's JWT has `delegationDepth: 2`. Each level's scopes are subset of parent. |
| **DEL-005** | Revoke parent cascades to child | P0 | Create delegation chain A→B. Revoke A's grant. Verify B's token. | B's token is invalid (parent revoked). |

---

## 10. Module 7: PKCE (Proof Key for Code Exchange)

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PKCE-001** | Authorization with PKCE | P0 | 1. Generate `codeVerifier` (43-128 char random string). 2. Compute `codeChallenge` = base64url(SHA256(codeVerifier)). 3. POST `/v1/authorize` with `{ ..., codeChallenge, codeChallengeMethod: "S256" }`. 4. Approve. 5. POST `/v1/token` with `{ code, agentId, codeVerifier }`. | Token exchanged successfully. |
| **PKCE-002** | Token exchange without verifier (when PKCE was used) | P0 | Create auth request with PKCE. Approve. POST `/v1/token` without `codeVerifier`. | 400: PKCE verifier required. |
| **PKCE-003** | Token exchange with wrong verifier | P0 | Create auth request with PKCE. Approve. POST `/v1/token` with wrong `codeVerifier`. | 400: PKCE verification failed. |
| **PKCE-004** | Authorization without PKCE still works | P1 | POST `/v1/authorize` without `codeChallenge`. Approve. Exchange code without `codeVerifier`. | Works normally (PKCE is optional). |

---

## 11. Module 8: Token Refresh

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/token/refresh` | API Key | Refresh a grant token |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **REF-001** | Refresh a token | P0 | POST `/v1/token/refresh` with `{ refreshToken, agentId }` | 200: New `{ grantToken, expiresAt, refreshToken, grantId, scopes }`. Same `grantId`. New `refreshToken`. |
| **REF-002** | Old refresh token invalid after use | P0 | Use refresh token. Try using the same refresh token again. | Second attempt: 400 or 401 — refresh token already used. |
| **REF-003** | Refresh with wrong agentId | P1 | POST `/v1/token/refresh` with valid refresh token but wrong agentId | 400 or 403: Agent mismatch. |
| **REF-004** | Refresh after grant revoked | P1 | Revoke the grant. Try to refresh. | 400 or 403: Grant is revoked. |
| **REF-005** | New JWT has same grantId | P0 | Compare `grantId` from original token exchange and refresh | Same `grantId` in both responses. |
| **REF-006** | Refresh with expired refresh token | P1 | Wait for refresh token to expire, then attempt refresh | 400: Refresh token expired. |

---

## 12. Module 9: Policy Engine

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/policies` | API Key | Create policy |
| GET | `/v1/policies` | API Key | List policies |
| GET | `/v1/policies/:id` | API Key | Get policy |
| PATCH | `/v1/policies/:id` | API Key | Update policy |
| DELETE | `/v1/policies/:id` | API Key | Delete policy |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **POL-001** | Create an allow policy | P0 | POST `/v1/policies` with `{ name: "Allow Email Bot", effect: "allow", agentId: "{id}", scopes: ["email:read"] }` | 201: Policy created with `id`, `priority`, `effect: "allow"`. |
| **POL-002** | Create a deny policy | P0 | POST `/v1/policies` with `{ name: "Block After Hours", effect: "deny", timeOfDayStart: "18:00", timeOfDayEnd: "08:00" }` | 201: Policy created. |
| **POL-003** | Allow policy auto-approves authorization | P0 | Create allow policy for agentId + scopes. POST `/v1/authorize` matching those criteria (live mode). | Authorization auto-approved (code returned without consent page). |
| **POL-004** | Deny policy blocks authorization | P0 | Create deny policy for agentId. POST `/v1/authorize` for that agent (live mode). | Authorization denied automatically. |
| **POL-005** | Policy priority ordering | P1 | Create deny policy (priority 10) and allow policy (priority 20) for same agent. Authorize. | Higher priority wins. Allow policy (priority 20) takes precedence. |
| **POL-006** | Time-of-day policy | P2 | Create deny policy with `timeOfDayStart: "00:00"` and `timeOfDayEnd: "23:59"`. Authorize. | Authorization denied (within blocked time window). |
| **POL-007** | List policies (ordered by priority DESC) | P1 | GET `/v1/policies` | 200: Policies ordered by descending priority. |
| **POL-008** | Update policy | P1 | PATCH `/v1/policies/{id}` with `{ priority: 50 }` | 200: Priority updated. |
| **POL-009** | Delete policy | P1 | DELETE `/v1/policies/{id}` | 204: Policy removed. No longer affects authorization. |
| **POL-010** | Policy with principal filter | P2 | Create allow policy with specific `principalId`. Authorize for that principal vs. different principal. | Only matching principal auto-approved. |
| **POL-011** | Plan limit on policies | P2 | Create more than 10 policies (free tier limit) | 402: `PLAN_LIMIT_EXCEEDED`. |

---

## 13. Module 10: Webhooks

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/webhooks` | API Key | Register webhook |
| GET | `/v1/webhooks` | API Key | List webhooks |
| DELETE | `/v1/webhooks/:id` | API Key | Delete webhook |
| GET | `/v1/webhooks/:id/deliveries` | API Key | View delivery history |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **WHK-001** | Register a webhook | P0 | POST `/v1/webhooks` with `{ url: "https://webhook.site/...", events: ["grant.created", "token.issued"] }` | 201: Returns `{ id, url, events, secret }`. `secret` is the HMAC signing key. |
| **WHK-002** | Webhook fires on grant.created | P0 | Register webhook for `grant.created`. Create an authorization and exchange token. | POST received at webhook URL with event payload. `X-Grantex-Signature` header present. |
| **WHK-003** | Verify webhook signature | P0 | Receive webhook. Compute `HMAC-SHA256(body, secret)`. Compare with `X-Grantex-Signature` header. | Signatures match. |
| **WHK-004** | Webhook fires on token.issued | P1 | Register webhook for `token.issued`. Exchange a code for token. | POST received with token event payload. |
| **WHK-005** | Webhook fires on grant.revoked | P1 | Register webhook for `grant.revoked`. Revoke a grant. | POST received with revocation event payload. |
| **WHK-006** | List webhooks | P1 | GET `/v1/webhooks` | 200: Array of registered webhooks. |
| **WHK-007** | Delete webhook | P1 | DELETE `/v1/webhooks/{id}` | 204: Deleted. No more deliveries to this URL. |
| **WHK-008** | View delivery history | P1 | GET `/v1/webhooks/{id}/deliveries` | 200: List of deliveries with `status`, `statusCode`, `attemptedAt`. |
| **WHK-009** | Webhook with unreachable URL | P2 | Register webhook with `url: "https://nonexistent.invalid/hook"`. Trigger event. | Delivery recorded as failed. Retry mechanism activates. |
| **WHK-010** | Plan limit on webhooks | P2 | Create more than 5 webhooks (free tier) | 402: `PLAN_LIMIT_EXCEEDED`. |

---

## 14. Module 11: Audit Trail

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/audit/log` | API Key | Log an audit entry |
| GET | `/v1/audit/entries` | API Key | Query audit log |
| GET | `/v1/audit/entries/:id` | API Key | Get single entry |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **AUD-001** | Log an audit entry | P0 | POST `/v1/audit/log` with `{ agentId, grantId, principalId, action: "email.read", metadata: { count: 5 }, status: "success" }` | 201: Returns audit entry with `id`, `hash`, `previousHash`, `timestamp`. |
| **AUD-002** | Verify hash chain integrity | P0 | Log 3 audit entries. Fetch all. Verify: entry[1].previousHash == entry[0].hash, entry[2].previousHash == entry[1].hash. | Chain is intact. Each entry's `hash` is SHA256 of (fields + previousHash). |
| **AUD-003** | Query audit entries by agentId | P1 | GET `/v1/audit/entries?agentId={id}` | 200: Only entries for that agent. |
| **AUD-004** | Query audit entries by grantId | P1 | GET `/v1/audit/entries?grantId={id}` | 200: Only entries for that grant. |
| **AUD-005** | Query audit entries by action | P1 | GET `/v1/audit/entries?action=email.read` | 200: Only entries with that action. |
| **AUD-006** | Get single audit entry | P0 | GET `/v1/audit/entries/{id}` | 200: Full entry with all fields. |
| **AUD-007** | Audit entries are immutable | P1 | Try to update or delete an audit entry (no endpoint exists) | No update/delete endpoints. Entries cannot be modified. |
| **AUD-008** | System-generated audit entries | P1 | Perform token exchange. Check audit entries. | Automatic entries created for `grant.created`, `token.issued`. |
| **AUD-009** | Audit entry with failure status | P2 | POST `/v1/audit/log` with `status: "failure"` | 201: Entry recorded with failure status. |
| **AUD-010** | Audit entry with blocked status | P2 | POST `/v1/audit/log` with `status: "blocked"` | 201: Entry recorded with blocked status. |

---

## 15. Module 12: Anomaly Detection

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/anomalies/detect` | API Key | Run anomaly detection |
| GET | `/v1/anomalies` | API Key | List detected anomalies |
| PATCH | `/v1/anomalies/:id/acknowledge` | API Key | Acknowledge anomaly |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **ANOM-001** | Run anomaly detection | P1 | POST `/v1/anomalies/detect` | 200: Returns detected anomalies (rate spikes, high failure rates, new principals, off-hours activity). |
| **ANOM-002** | List anomalies | P1 | GET `/v1/anomalies` | 200: Array of anomalies with `id`, `type`, `severity`, `acknowledged`. |
| **ANOM-003** | List unacknowledged anomalies | P2 | GET `/v1/anomalies?unacknowledged=true` | 200: Only unacknowledged anomalies. |
| **ANOM-004** | Acknowledge an anomaly | P1 | PATCH `/v1/anomalies/{id}/acknowledge` | 200: Anomaly marked as acknowledged. |

---

## 16. Module 13: Principal Sessions & Dashboard

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/principal-sessions` | API Key | Create session for end-user |
| GET | `/v1/principal/grants` | Session JWT | List principal's grants |
| GET | `/v1/principal/audit` | Session JWT | List principal's audit entries |
| DELETE | `/v1/principal/grants/:id` | Session JWT | Principal revokes a grant |
| GET | `/permissions` | None | HTML permissions page |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PSESS-001** | Create principal session | P0 | POST `/v1/principal-sessions` with `{ principalId: "user@example.com" }` | 201: `{ sessionToken, dashboardUrl, expiresAt }`. |
| **PSESS-002** | Create session with custom expiry | P2 | POST `/v1/principal-sessions` with `{ principalId, expiresIn: "1h" }` | 201: `expiresAt` is ~1h from now. |
| **PSESS-003** | List principal's grants | P0 | GET `/v1/principal/grants` with `Authorization: Bearer {sessionToken}` | 200: `{ grants, principalId }` — only grants for this principal. |
| **PSESS-004** | Principal revokes own grant | P0 | DELETE `/v1/principal/grants/{grantId}` with session token | 204: Grant revoked. |
| **PSESS-005** | Principal views audit trail | P1 | GET `/v1/principal/audit` with session token | 200: `{ entries }` — only entries for this principal. |
| **PSESS-006** | Expired session token rejected | P1 | Wait for session to expire, then call `/v1/principal/grants` | 401: Session expired. |
| **PSESS-007** | Permissions page loads | P2 | GET `/permissions` in browser | HTML page renders with permission information. |

---

## 17. Module 14: Budgets & Spend Control

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/budget/allocate` | API Key | Allocate budget to grant |
| POST | `/v1/budget/debit` | API Key | Debit from budget |
| GET | `/v1/budget/allocations` | API Key | List all allocations |
| GET | `/v1/budget/balance/:grantId` | API Key | Get balance for grant |
| GET | `/v1/budget/transactions/:grantId` | API Key | Get transaction history |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **BUD-001** | Allocate budget to a grant | P0 | POST `/v1/budget/allocate` with `{ grantId, amount: 100.00, currency: "USD" }` | 200: `{ id, grantId, initialBudget: 100, remainingBudget: 100 }`. |
| **BUD-002** | Debit from budget | P0 | POST `/v1/budget/debit` with `{ grantId, amount: 25.50, description: "API call" }` | 200: `{ remaining: 74.50, transactionId }`. |
| **BUD-003** | Debit exceeding budget | P0 | Budget has 10.00 remaining. Debit 50.00. | 402: `INSUFFICIENT_BUDGET`. |
| **BUD-004** | Get budget balance | P0 | GET `/v1/budget/balance/{grantId}` | 200: `BudgetAllocation` with current `remainingBudget`. |
| **BUD-005** | Get transaction history | P1 | GET `/v1/budget/transactions/{grantId}` | 200: `{ transactions, total }`. Each transaction has `amount`, `description`, `createdAt`. |
| **BUD-006** | List all allocations | P1 | GET `/v1/budget/allocations` | 200: `{ allocations }` — all budget allocations for this developer. |
| **BUD-007** | Budget depletes to zero exactly | P1 | Allocate 100. Debit 100. | Remaining is 0. Next debit returns 402. |
| **BUD-008** | Budget with decimal precision | P2 | Allocate 10.0001. Debit 5.0001. Check balance. | Remaining: 5.0000 (4 decimal places). |

---

## 18. Module 15: Usage Metering

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/v1/usage` | API Key | Current period usage |
| GET | `/v1/usage/history` | API Key | Historical usage |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **USG-001** | Get current usage | P1 | GET `/v1/usage` | 200: `{ developerId, period, tokenExchanges, authorizations, verifications, totalRequests }`. |
| **USG-002** | Usage increments after operations | P1 | Perform a token exchange. Check usage. | `tokenExchanges` count has increased by 1. |
| **USG-003** | Get usage history | P1 | GET `/v1/usage/history?days=7` | 200: `{ entries }` — daily breakdown for last 7 days. |

---

## 19. Module 16: Custom Domains

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/domains` | API Key | Add custom domain |
| GET | `/v1/domains` | API Key | List domains |
| POST | `/v1/domains/:id/verify` | API Key | Verify domain ownership |
| DELETE | `/v1/domains/:id` | API Key | Remove domain |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **DOM-001** | Add a custom domain | P2 | POST `/v1/domains` with `{ domain: "auth.mycompany.com" }` | 200: `{ id, domain, verified: false, verificationToken, instructions }`. |
| **DOM-002** | List domains | P2 | GET `/v1/domains` | 200: `{ domains }` array. |
| **DOM-003** | Verify domain (DNS TXT record) | P2 | Add the TXT record from `instructions`. POST `/v1/domains/{id}/verify`. | 200: `{ verified: true }`. |
| **DOM-004** | Verify domain without TXT record | P2 | POST `/v1/domains/{id}/verify` without adding TXT record | 200: `{ verified: false }` or error. |
| **DOM-005** | Delete domain | P2 | DELETE `/v1/domains/{id}` | 204: Domain removed. |

---

## 20. Module 17: FIDO2/WebAuthn

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/webauthn/register/options` | API Key | Registration challenge |
| POST | `/v1/webauthn/register/verify` | API Key | Verify registration |
| GET | `/v1/webauthn/credentials` | API Key | List credentials |
| DELETE | `/v1/webauthn/credentials/:id` | API Key | Delete credential |
| POST | `/v1/webauthn/assert/options` | None | Assertion challenge |
| POST | `/v1/webauthn/assert/verify` | None | Verify assertion |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **FIDO-001** | Get registration options | P1 | POST `/v1/webauthn/register/options` with `{ principalId }` | 200: Returns `challenge`, `rp` (relying party info), `user`, `pubKeyCredParams`, `timeout`. |
| **FIDO-002** | Register a credential | P1 | Perform WebAuthn registration ceremony (browser required). POST `/v1/webauthn/register/verify` with attestation response. | 200: Credential stored. |
| **FIDO-003** | List credentials for principal | P1 | GET `/v1/webauthn/credentials?principalId={id}` | 200: Array of credentials with `id`, `deviceName`, `createdAt`, `lastUsedAt`. |
| **FIDO-004** | Delete credential | P2 | DELETE `/v1/webauthn/credentials/{id}` | 204: Credential removed. |
| **FIDO-005** | Get assertion options | P1 | POST `/v1/webauthn/assert/options` with `{ principalId }` | 200: Returns challenge for authentication. |
| **FIDO-006** | Verify assertion | P1 | Perform WebAuthn authentication ceremony. POST `/v1/webauthn/assert/verify`. | 200: Authentication successful. |
| **FIDO-007** | Consent with FIDO gate | P2 | Set `fidoRequired: true`. Create auth request. Open consent page. Approve without FIDO. | 403: FIDO verification required before approval. |
| **FIDO-008** | Challenge expires after 5 minutes | P2 | Get registration options. Wait 5+ minutes. Attempt verify. | 400: Challenge expired. |

---

## 21. Module 18: Verifiable Credentials & SD-JWT

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/v1/credentials/:id` | API Key | Get VC by ID |
| GET | `/v1/credentials` | API Key | List VCs |
| POST | `/v1/credentials/verify` | None | Verify VC-JWT |
| POST | `/v1/credentials/present` | None | Verify SD-JWT presentation |
| GET | `/v1/credentials/status/:listId` | None | StatusList2021 credential |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **VC-001** | List verifiable credentials | P2 | GET `/v1/credentials` | 200: Array of credentials with `id`, `type`, `issuer`, `subject`, `status`. |
| **VC-002** | Get credential by ID | P2 | GET `/v1/credentials/{id}` | 200: Full credential object including JWT. |
| **VC-003** | Verify a valid VC-JWT | P2 | POST `/v1/credentials/verify` with `{ vcJwt: "..." }` | 200: Verification result with `valid: true`. |
| **VC-004** | Verify invalid VC-JWT | P2 | POST `/v1/credentials/verify` with tampered JWT | 200: `valid: false`. |
| **VC-005** | Present SD-JWT (selective disclosure) | P2 | POST `/v1/credentials/present` with `{ sdJwt, disclosures: [...] }` | 200: Presentation verified with only disclosed claims. |
| **VC-006** | StatusList2021 endpoint | P2 | GET `/v1/credentials/status/{listId}` | 200: StatusList2021 credential (for revocation checking). |

---

## 22. Module 19: DID Infrastructure

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/.well-known/did.json` | None | DID document |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **DID-001** | Fetch DID document | P2 | GET `/.well-known/did.json` | 200: Valid DID document with `id: "did:web:grantex.dev"`, `verificationMethod` array, `authentication`, `assertionMethod`. |
| **DID-002** | DID document includes Ed25519 key | P2 | Check `verificationMethod` in DID document | Contains `Ed25519VerificationKey2020` entry (if configured). |
| **DID-003** | DID document is publicly accessible | P2 | GET `/.well-known/did.json` without any auth | 200: No authentication required. |

---

## 23. Module 20: SCIM 2.0 Provisioning

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/scim/tokens` | API Key | Create SCIM token |
| GET | `/v1/scim/tokens` | API Key | List SCIM tokens |
| DELETE | `/v1/scim/tokens/:id` | API Key | Revoke SCIM token |
| GET | `/scim/v2/ServiceProviderConfig` | None | SCIM service metadata |
| GET | `/scim/v2/Users` | SCIM Token | List users |
| POST | `/scim/v2/Users` | SCIM Token | Create user |
| GET | `/scim/v2/Users/:id` | SCIM Token | Get user |
| PATCH | `/scim/v2/Users/:id` | SCIM Token | Update user |
| DELETE | `/scim/v2/Users/:id` | SCIM Token | Delete user |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SCIM-001** | Create SCIM token | P2 | POST `/v1/scim/tokens` with `{ label: "Okta Integration" }` | 201: Returns `{ id, token, label }`. Token is bearer token for SCIM endpoints. |
| **SCIM-002** | List SCIM tokens | P2 | GET `/v1/scim/tokens` | 200: Array of tokens with `id`, `label`, `lastUsedAt`. |
| **SCIM-003** | SCIM ServiceProviderConfig | P2 | GET `/scim/v2/ServiceProviderConfig` | 200: SCIM 2.0 metadata (schemas, patch support, filter support). |
| **SCIM-004** | Create user via SCIM | P2 | POST `/scim/v2/Users` with SCIM user payload `{ userName, displayName, emails }` | 201: SCIM user created with `id`, `externalId`. |
| **SCIM-005** | List users via SCIM | P2 | GET `/scim/v2/Users` with SCIM token | 200: `{ totalResults, Resources: [...] }`. |
| **SCIM-006** | Get user by ID | P2 | GET `/scim/v2/Users/{id}` | 200: Full SCIM user object. |
| **SCIM-007** | Update user via PATCH | P2 | PATCH `/scim/v2/Users/{id}` with `{ Operations: [{ op: "replace", path: "displayName", value: "New Name" }] }` | 200: User updated. |
| **SCIM-008** | Delete user | P2 | DELETE `/scim/v2/Users/{id}` | 204: User deprovisioned. |
| **SCIM-009** | SCIM auth with invalid token | P2 | Call `/scim/v2/Users` with invalid bearer token | 401: Unauthorized. |
| **SCIM-010** | Revoke SCIM token | P2 | DELETE `/v1/scim/tokens/{id}`. Then use revoked token. | Token deleted. Subsequent SCIM calls with it return 401. |

---

## 24. Module 21: SSO Configuration

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/sso/config` | API Key | Set OIDC SSO config |
| GET | `/v1/sso/config` | API Key | Get SSO config |
| DELETE | `/v1/sso/config` | API Key | Remove SSO config |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SSO-001** | Set SSO config | P2 | POST `/v1/sso/config` with `{ issuerUrl, clientId, clientSecret, redirectUri }` | 200: Config saved. |
| **SSO-002** | Get SSO config | P2 | GET `/v1/sso/config` | 200: Returns saved config (clientSecret redacted or omitted). |
| **SSO-003** | Delete SSO config | P2 | DELETE `/v1/sso/config` | 204: Config removed. |
| **SSO-004** | Get SSO config when none exists | P2 | DELETE config, then GET | 404: No SSO configuration. |

---

## 25. Module 22: Billing & Subscriptions

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/billing/checkout` | API Key | Create Stripe checkout session |
| POST | `/v1/billing/portal` | API Key | Create billing portal session |
| POST | `/v1/billing/webhook` | Stripe Sig | Stripe webhook receiver |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **BILL-001** | Create checkout session | P2 | POST `/v1/billing/checkout` with `{ plan: "pro" }` | 200: Returns Stripe checkout URL. |
| **BILL-002** | Create billing portal session | P2 | POST `/v1/billing/portal` | 200: Returns Stripe billing portal URL. |
| **BILL-003** | Free tier limits enforced | P1 | On free plan, exceed agent/grant/webhook/policy limits | 402: `PLAN_LIMIT_EXCEEDED` with plan comparison. |
| **BILL-004** | Pro tier limits higher | P2 | On pro plan, verify higher limits (1000 agents, 10k grants, etc.) | Operations succeed within pro limits. |

---

## 26. Module 23: Compliance & Reporting

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/v1/compliance/policies` | API Key | List compliance policies |
| GET | `/v1/compliance/report` | API Key | Generate compliance report |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **COMP-001** | Get compliance summary | P2 | GET `/v1/compliance/summary` (or `/report`) | 200: Report with grant counts, policy counts, audit summary. |
| **COMP-002** | Export grants | P2 | GET `/v1/compliance/export/grants?format=json` | 200: JSON export of all grants. |
| **COMP-003** | Export audit trail | P2 | GET `/v1/compliance/export/audit?format=json` | 200: JSON export of audit entries. |
| **COMP-004** | Generate evidence pack | P2 | GET `/v1/compliance/evidence-pack?framework=soc2` | 200: Bundled evidence for SOC 2 compliance. |

---

## 27. Module 24: Events (SSE & WebSocket)

### Endpoints Under Test

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/v1/events/stream` | Bearer | SSE event stream |
| GET | `/v1/events/ws` | Bearer | WebSocket event stream |

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **EVT-001** | Connect to SSE stream | P1 | GET `/v1/events/stream` with `Authorization: Bearer {apiKey}` and `Accept: text/event-stream` | 200: SSE connection established. `Content-Type: text/event-stream`. |
| **EVT-002** | Receive event via SSE | P1 | Connect to SSE stream. Perform a token exchange. | Receive `data: {...}` event with type `token.issued`. |
| **EVT-003** | SSE without auth | P1 | GET `/v1/events/stream` without Authorization | 401: Unauthorized. |
| **EVT-004** | Connect to WebSocket | P2 | Connect to `/v1/events/ws` with auth | WebSocket connection established. |
| **EVT-005** | Receive event via WebSocket | P2 | Connect WebSocket. Trigger an event. | JSON message received with event data. |

---

## 28. Module 25: Rate Limiting

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **RATE-001** | Global rate limit (100/min) | P1 | Send 101 requests to any endpoint within 1 minute | 101st request returns 429 with `Retry-After` header. |
| **RATE-002** | Authorize rate limit (10/min) | P1 | POST `/v1/authorize` 11 times in 1 minute | 11th returns 429. |
| **RATE-003** | Token exchange rate limit (20/min) | P1 | POST `/v1/token` 21 times in 1 minute | 21st returns 429. |
| **RATE-004** | Rate limit headers present | P1 | Send any request | Response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |
| **RATE-005** | JWKS endpoint exempt from rate limiting | P2 | Fetch `/.well-known/jwks.json` many times rapidly | Never rate limited. |

---

## 29. Module 26: Developer Portal (React UI)

### Test Cases — Navigation & Auth

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PORT-001** | Login with valid API key | P0 | Navigate to portal login page. Enter valid API key. Submit. | Redirected to dashboard. Developer name shown. |
| **PORT-002** | Login with invalid API key | P0 | Enter invalid API key. Submit. | Error message: "Invalid API key" or similar. Stay on login page. |
| **PORT-003** | Signup from portal | P1 | Click "Sign up". Fill in name, email. Submit. | Account created. API key displayed (must be copied). Redirect to dashboard. |
| **PORT-004** | Logout | P1 | Click logout button | Redirected to login page. Protected pages inaccessible. |
| **PORT-005** | Protected page without auth | P0 | Navigate directly to `/dashboard/agents` without logging in | Redirected to login page. |

### Test Cases — Dashboard

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PORT-006** | Dashboard loads stats | P0 | Login and view dashboard | Shows 4 stat cards: Agents count, Active Grants count, Audit Entries count, Anomalies count. |
| **PORT-007** | Dashboard recent activity | P1 | View dashboard | Recent activity table shows latest events. |

### Test Cases — Agent Management

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PORT-008** | Create agent via portal | P0 | Navigate to Agents. Click "Create Agent". Fill name, description, scopes. Submit. | Agent appears in list with correct details. |
| **PORT-009** | View agent details | P0 | Click on an agent | Detail view shows name, DID, description, scopes, status, dates. |
| **PORT-010** | Edit agent | P1 | Click edit on agent. Change name. Save. | Name updated in list and detail view. |
| **PORT-011** | Delete agent via portal | P1 | Click delete on agent. Confirm. | Agent removed from list. |

### Test Cases — Grants, Audit, Policies, Webhooks

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PORT-012** | View grants list | P0 | Navigate to Grants page | Lists all grants with agent, principal, scopes, status. |
| **PORT-013** | Revoke grant via portal | P0 | Click revoke on an active grant. Confirm. | Grant status changes to "revoked". |
| **PORT-014** | View audit log | P0 | Navigate to Audit page | Lists entries with filters for agent, grant, principal, action. |
| **PORT-015** | Filter audit by action | P1 | Apply action filter | Only matching entries shown. |
| **PORT-016** | Create policy via portal | P1 | Navigate to Policies. Create a new policy. | Policy appears in list. |
| **PORT-017** | Create webhook via portal | P1 | Navigate to Webhooks. Add webhook URL and events. | Webhook appears in list. |
| **PORT-018** | View webhook deliveries | P1 | Click on a webhook. View deliveries tab. | Delivery history with status codes shown. |

### Test Cases — Advanced Features

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **PORT-019** | View anomalies page | P1 | Navigate to Anomalies | Lists detected anomalies with severity and acknowledgement status. |
| **PORT-020** | View budgets page | P1 | Navigate to Budgets | Shows allocations by grant with remaining amounts. |
| **PORT-021** | View usage dashboard | P1 | Navigate to Usage | API usage metrics displayed. |
| **PORT-022** | Manage SCIM tokens | P2 | Navigate to Settings > SCIM | Create, list, revoke SCIM tokens. |
| **PORT-023** | Configure SSO | P2 | Navigate to Settings > SSO | Set OIDC issuer, client ID, redirect URI. |
| **PORT-024** | View credentials page | P2 | Navigate to Credentials | Lists verifiable credentials with type, issuer, status. |
| **PORT-025** | View domains page | P2 | Navigate to Domains | Lists custom domains with verification status. |
| **PORT-026** | Billing page | P2 | Navigate to Billing | Shows current plan, upgrade options, billing portal link. |
| **PORT-027** | Compliance page | P2 | Navigate to Compliance | Summary view with export buttons. |
| **PORT-028** | Events page | P2 | Navigate to Events | Event log viewer with event data. |
| **PORT-029** | WebAuthn credentials page | P2 | Navigate to WebAuthn | Lists FIDO2 credentials with management options. |
| **PORT-030** | API key rotation from portal | P1 | Navigate to Settings. Click "Rotate API Key". | New key generated. Old key invalidated. Must re-login with new key. |

---

## 30. Module 27: TypeScript SDK

### How to Test

```bash
cd packages/sdk-ts
npm install && npm test   # Run 156+ unit tests
```

### Manual Verification

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SDKTS-001** | Instantiate client | P0 | `const grantex = new Grantex({ apiKey: "..." })` | No error. Client created. |
| **SDKTS-002** | Full authorization flow | P0 | `grantex.authorize(...)` → approve → `grantex.tokens.exchange(...)` → `grantex.tokens.verify(...)` | Each step returns expected response shape. |
| **SDKTS-003** | Register and list agents | P0 | `grantex.agents.register(...)` → `grantex.agents.list()` | Agent appears in list. |
| **SDKTS-004** | Offline token verification | P0 | `import { verifyGrantToken } from '@grantex/sdk'` → `verifyGrantToken(token, jwksUri)` | Returns `VerifiedGrant` with `principalId`, `scopes`, etc. |
| **SDKTS-005** | Webhook signature verification | P1 | `import { verifyWebhookSignature } from '@grantex/sdk'` → verify with body + secret + signature | Returns true for valid, false for tampered. |
| **SDKTS-006** | PKCE generation | P1 | `import { generatePkce } from '@grantex/sdk'` | Returns `{ codeVerifier, codeChallenge }`. Challenge is base64url(SHA256(verifier)). |
| **SDKTS-007** | Error types | P1 | Trigger a 401 error | Throws `GrantexAuthError` with `statusCode`, `code`, `message`. |
| **SDKTS-008** | All resource clients accessible | P0 | Access `grantex.agents`, `grantex.grants`, `grantex.tokens`, `grantex.audit`, `grantex.webhooks`, `grantex.policies`, `grantex.budgets`, `grantex.events`, `grantex.usage`, `grantex.domains`, `grantex.webauthn`, `grantex.credentials`, `grantex.principalSessions` | All are defined objects with expected methods. |
| **SDKTS-009** | Token refresh flow | P1 | `grantex.tokens.refresh({ refreshToken, agentId })` | Returns new grantToken + new refreshToken + same grantId. |
| **SDKTS-010** | Grant delegation | P1 | `grantex.grants.delegate(...)` | Returns child grantToken with delegation claims. |

---

## 31. Module 28: Python SDK

### How to Test

```bash
cd packages/sdk-py
pip install -e . && pytest tests/
```

### Manual Verification

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SDKPY-001** | Instantiate client | P0 | `client = Grantex(api_key="...")` | No error. |
| **SDKPY-002** | Full authorization flow | P0 | `client.authorize(...)` → approve → `client.tokens.exchange(...)` → `client.tokens.verify(...)` | Each step returns expected types. |
| **SDKPY-003** | Context manager | P1 | `with Grantex(api_key="...") as client: ...` | Client opens and closes cleanly. |
| **SDKPY-004** | Offline token verification | P0 | `from grantex import verify_grant_token` → `verify_grant_token(token, jwks_uri)` | Returns verified grant object. |
| **SDKPY-005** | Webhook signature verification | P1 | `from grantex import verify_webhook_signature` → verify | Returns True/False. |
| **SDKPY-006** | PKCE generation | P1 | `from grantex import generate_pkce` | Returns `(code_verifier, code_challenge)`. |
| **SDKPY-007** | Error handling | P1 | Trigger 401 | Raises `GrantexAuthError`. |
| **SDKPY-008** | Token refresh | P1 | `client.tokens.refresh(RefreshTokenParams(...))` | Returns new token pair. |
| **SDKPY-009** | Principal sessions | P1 | `client.principal_sessions.create(CreatePrincipalSessionParams(...))` | Returns session token + dashboard URL. |

---

## 32. Module 29: Go SDK

### How to Test

```bash
cd packages/go-sdk
go test ./...   # Run 106 tests
```

### Manual Verification

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SDKGO-001** | Create client | P0 | `client := grantex.NewClient("api-key")` | Client created without error. |
| **SDKGO-002** | Full authorization flow | P0 | `Authorize` → `ExchangeToken` → `VerifyToken` | Each method returns expected struct. |
| **SDKGO-003** | Offline JWT verification | P0 | `grantex.VerifyGrantToken(token, jwksUri)` | Returns `*VerifiedGrant`. |
| **SDKGO-004** | Webhook HMAC verification | P1 | `grantex.VerifyWebhookSignature(body, secret, sig)` | Returns `true` for valid. |
| **SDKGO-005** | PKCE S256 generation | P1 | `grantex.GeneratePKCE()` | Returns verifier and challenge. |

---

## 33. Module 30: CLI Tool

### How to Test

```bash
cd packages/cli
npm install && npm run build
npx grantex --help
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **CLI-001** | Configure CLI | P0 | `grantex config set --url http://localhost:3001 --key {apiKey}` | Config saved to `~/.grantex/config.json`. |
| **CLI-002** | Show config | P1 | `grantex config show` | Displays current URL and key (masked). |
| **CLI-003** | List agents | P0 | `grantex agents list` | Table of agents with ID, name, scopes. |
| **CLI-004** | Register agent | P0 | `grantex agents register --name "Bot" --scopes "email:read,calendar:write"` | Agent created. ID displayed. |
| **CLI-005** | Get agent | P1 | `grantex agents get {id}` | Agent details displayed. |
| **CLI-006** | Update agent | P1 | `grantex agents update {id} --name "NewBot"` | Agent updated. |
| **CLI-007** | Delete agent | P1 | `grantex agents delete {id}` | Agent deleted. |
| **CLI-008** | List grants | P0 | `grantex grants list` | Table of grants. |
| **CLI-009** | Revoke grant | P0 | `grantex grants revoke {id}` | Grant revoked. |
| **CLI-010** | Verify token | P0 | `grantex tokens verify {jwt}` | Token validity, scopes, principal displayed. |
| **CLI-011** | Revoke token | P1 | `grantex tokens revoke {jti}` | Token revoked. |
| **CLI-012** | List audit entries | P1 | `grantex audit list` | Table of audit entries. |
| **CLI-013** | Filter audit by agent | P1 | `grantex audit list --agent {id}` | Only entries for that agent. |
| **CLI-014** | List webhooks | P1 | `grantex webhooks list` | Table of webhooks. |
| **CLI-015** | Create webhook | P1 | `grantex webhooks create --url "https://..." --events "grant.created"` | Webhook created. Secret displayed. |
| **CLI-016** | Compliance summary | P2 | `grantex compliance summary` | Compliance summary displayed. |
| **CLI-017** | Compliance export | P2 | `grantex compliance export grants --format json --output grants.json` | JSON file written. |
| **CLI-018** | Evidence pack | P2 | `grantex compliance evidence-pack --framework soc2 --output evidence.zip` | ZIP file created. |
| **CLI-019** | Detect anomalies | P2 | `grantex anomalies detect` | Anomaly detection results. |
| **CLI-020** | No config error | P1 | Delete config file. Run `grantex agents list`. | Clear error: "Not configured. Run `grantex config set`". |
| **CLI-021** | Me / whoami | P0 | `grantex me` | Shows developer profile: id, name, email, mode, plan. |
| **CLI-022** | Authorize command | P0 | `grantex authorize --agent ag_... --principal user@test.com --scopes email:read` | Returns authRequestId, consentUrl (sandbox: code). |
| **CLI-023** | Token exchange | P0 | `grantex tokens exchange --code {code} --agent-id ag_...` | Returns grantToken, refreshToken, grantId, scopes. |
| **CLI-024** | Token refresh | P0 | `grantex tokens refresh --refresh-token {token} --agent-id ag_...` | Returns new grantToken, new refreshToken, same grantId. |
| **CLI-025** | Grants get | P1 | `grantex grants get {grantId}` | Shows full grant details. |
| **CLI-026** | Grants delegate | P0 | `grantex grants delegate --grant-token {jwt} --agent-id ag_child --scopes email:read` | Returns child grantToken with delegation claims. |
| **CLI-027** | Audit log | P1 | `grantex audit log --agent-id ag_... --agent-did did:grantex:ag_... --grant-id grnt_... --principal-id user@test.com --action email.read` | Audit entry created with hash. |
| **CLI-028** | Audit get | P1 | `grantex audit get {entryId}` | Shows full entry with hash chain. |
| **CLI-029** | Budgets allocate | P1 | `grantex budgets allocate --grant-id grnt_... --amount 100` | Budget allocated. |
| **CLI-030** | Budgets debit | P1 | `grantex budgets debit --grant-id grnt_... --amount 25 --description "test"` | Debit applied. Remaining shown. |
| **CLI-031** | Budgets balance | P1 | `grantex budgets balance grnt_...` | Shows remaining budget. |
| **CLI-032** | Usage current | P2 | `grantex usage current` | Shows current period metrics. |
| **CLI-033** | Events stream | P2 | `grantex events stream` | Streams events via SSE (Ctrl+C to stop). |
| **CLI-034** | Domains add | P2 | `grantex domains add --domain auth.example.com` | Domain added with verification instructions. Enterprise plan required. |
| **CLI-035** | Principal sessions | P2 | `grantex principal-sessions create --principal-id user@test.com` | Returns sessionToken + dashboardUrl. |
| **CLI-036** | Policies create | P1 | `grantex policies create --name "Allow" --effect allow --scopes email:read` | Policy created. |
| **CLI-037** | Vault store | P1 | `grantex vault store --principal-id user@test.com --service google --access-token ya29...` | Credential stored (encrypted). |
| **CLI-038** | Vault list | P1 | `grantex vault list` | Lists stored credentials. |
| **CLI-039** | Vault exchange | P1 | `grantex vault exchange --grant-token {jwt} --service google` | Returns decrypted access token. |
| **CLI-040** | WebAuthn list | P2 | `grantex webauthn list user@test.com` | Lists FIDO2 credentials for principal. |
| **CLI-041** | Credentials list | P2 | `grantex credentials list` | Lists verifiable credentials. |
| **CLI-042** | Credentials verify | P2 | `grantex credentials verify --vc-jwt eyJ...` | Returns valid/invalid with credential info. |
| **CLI-043** | Passports issue | P1 | `grantex passports issue --agent-id ag_... --grant-id grnt_... --categories compute --max-amount 100` | Passport issued with credential. |
| **CLI-044** | Passports list | P1 | `grantex passports list --agent-id ag_...` | Lists passports. |
| **CLI-045** | Passports revoke | P1 | `grantex passports revoke pp_...` | Passport revoked. |
| **CLI-046** | JSON output | P0 | `grantex --json agents list` | All output as valid JSON (no ANSI, no tables). |
| **CLI-047** | SCIM user create | P2 | `grantex scim users create --user-name john@co.com --display-name "John"` | User provisioned. |
| **CLI-048** | SSO callback | P2 | `grantex sso callback --code CODE --state STATE` | Returns email, name, developerId. |
| **CLI-049** | Billing status | P2 | `grantex billing status` | Shows current plan. |
| **CLI-050** | Full workflow (E2E) | P0 | Run: config → me → agents register → authorize → tokens exchange → verify → refresh → delegate → audit log → grants revoke | All steps complete without errors. |

---

## 34. Module 31: Gateway (Reverse Proxy)

### How to Test

```bash
cd packages/gateway
npm install && npm test
# Run with a config file:
npx @grantex/gateway --config gateway.yaml
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **GW-001** | Start gateway with valid config | P0 | Create `gateway.yaml` with upstream, jwksUri, routes. Run gateway. | Server starts on configured port. |
| **GW-002** | Request with valid token and matching scope | P0 | Send GET to a route requiring `calendar:read` with valid grant token that has `calendar:read` scope | 200: Upstream response returned. |
| **GW-003** | Request without token | P0 | Send GET without Authorization header | 401: `TOKEN_MISSING`. |
| **GW-004** | Request with expired token | P0 | Send request with expired JWT | 401: `TOKEN_EXPIRED`. |
| **GW-005** | Request with invalid token signature | P1 | Send request with tampered JWT | 401: `TOKEN_INVALID`. |
| **GW-006** | Request with insufficient scopes | P0 | Token has `calendar:read`, route requires `calendar:write` | 403: `SCOPE_INSUFFICIENT`. |
| **GW-007** | Unmatched route | P1 | Send request to a path not in config | 404: `ROUTE_NOT_FOUND`. |
| **GW-008** | Upstream headers forwarded | P1 | Check upstream receives `X-Grantex-Principal`, `X-Grantex-Agent`, `X-Grantex-GrantId` headers | All three headers present with correct values from JWT. |
| **GW-009** | Upstream unreachable | P2 | Configure gateway with non-existent upstream URL | 502: `UPSTREAM_ERROR`. |
| **GW-010** | Wildcard route matching | P1 | Configure route `/api/**`. Send request to `/api/foo/bar` | Route matched. Token verified. |

---

## 35. Module 32: Express Middleware

### How to Test

```bash
cd packages/express
npm install && npm test
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **EXP-001** | Valid token populates req.grant | P0 | Apply `requireGrantToken({ jwksUri })` middleware. Send request with valid token. | `req.grant` has `principalId`, `agentDid`, `scopes`, `grantId`. |
| **EXP-002** | Missing token returns 401 | P0 | Send request without Authorization header | 401: `TOKEN_MISSING`. |
| **EXP-003** | Scope enforcement | P0 | Apply `requireScopes('calendar:read')`. Token has `email:read` only. | 403: `SCOPE_INSUFFICIENT`. |
| **EXP-004** | Scope enforcement passes | P0 | Apply `requireScopes('calendar:read')`. Token has `calendar:read`. | Request proceeds. `req.grant` available. |
| **EXP-005** | Custom token extractor | P1 | Use `tokenExtractor: (req) => req.cookies.grantToken` | Token extracted from cookie. |
| **EXP-006** | Clock tolerance | P2 | Token expired 5 seconds ago. `clockTolerance: 10`. | Token accepted (within tolerance). |

---

## 36. Module 33: FastAPI Middleware

### How to Test

```bash
cd packages/fastapi
pip install -e .[dev] && pytest tests/
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **FAPI-001** | Valid token returns VerifiedGrant | P0 | Use `Depends(grantex)`. Send request with valid token. | Route receives `VerifiedGrant` object. |
| **FAPI-002** | Missing token returns 401 | P0 | Send request without token | 401: `TOKEN_MISSING`. |
| **FAPI-003** | Scope enforcement with `grantex.scopes()` | P0 | Use `Depends(grantex.scopes("email:read"))`. Token lacks scope. | 403: `SCOPE_INSUFFICIENT`. |
| **FAPI-004** | Multiple scopes (all required) | P1 | `grantex.scopes("email:read", "email:send")`. Token has only `email:read`. | 403: Missing `email:send`. |

---

## 37. Module 34: MCP Server

### How to Test

```bash
cd packages/mcp
npm install && npm test
# Run standalone:
GRANTEX_API_KEY=... npx grantex-mcp
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **MCP-001** | Server starts | P0 | Run `grantex-mcp` with valid env vars | MCP server starts, lists 13 tools. |
| **MCP-002** | Register agent tool | P0 | Call `grantex_agent_register` with `{ name, description, scopes }` | Agent created. Returns agent details. |
| **MCP-003** | List agents tool | P0 | Call `grantex_agent_list` | Returns array of agents. |
| **MCP-004** | Authorize tool | P0 | Call `grantex_authorize` with `{ agentId, userId, scopes }` | Returns authRequestId + consentUrl. |
| **MCP-005** | Token exchange tool | P0 | Call `grantex_token_exchange` with `{ code, agentId }` | Returns grantToken + refreshToken. |
| **MCP-006** | Token verify tool | P0 | Call `grantex_token_verify` with `{ token }` | Returns validity + scopes. |
| **MCP-007** | Grant delegate tool | P1 | Call `grantex_grant_delegate` | Returns child grant token. |
| **MCP-008** | Audit log tool | P1 | Call `grantex_audit_log` with action and metadata | Audit entry created. |
| **MCP-009** | All 13 tools listed | P0 | Connect MCP client. List tools. | All 13 tools present with correct schemas. |
| **MCP-010** | Missing API key | P1 | Run without `GRANTEX_API_KEY` | Clear error message about missing configuration. |

---

## 38. Module 35: MCP Auth Server

### How to Test

```bash
cd packages/mcp-auth
npm install && npm test
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **MCPAUTH-001** | OAuth metadata endpoint | P1 | GET `/.well-known/oauth-authorization-server` | 200: Returns issuer, authorization_endpoint, token_endpoint, etc. |
| **MCPAUTH-002** | Client registration | P1 | POST `/register` with `{ redirect_uris: [...] }` | 200: Returns `client_id`, `client_secret`. |
| **MCPAUTH-003** | Authorization code flow | P1 | GET `/authorize?client_id=...&redirect_uri=...&code_challenge=...` | Initiates Grantex auth. Returns authorization code. |
| **MCPAUTH-004** | Token exchange with PKCE | P1 | POST `/token` with `{ code, client_id, code_verifier }` | 200: Returns Grantex grant token. |
| **MCPAUTH-005** | Invalid redirect URI rejected | P1 | Attempt authorization with non-whitelisted redirect URI | 400: `invalid_request`. |
| **MCPAUTH-006** | Code expiration (default 600s) | P2 | Wait > 10 minutes. Try to exchange code. | 400: `invalid_code`. |

---

## 39. Module 36: Framework Integrations

### Test Cases — LangChain (`packages/langchain/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **LC-001** | Create scoped tool | P1 | `createGrantexTool({ grantToken, requiredScope: "email:read", func, ... })` with valid token | Tool created. |
| **LC-002** | Tool blocks missing scope | P0 | Create tool requiring `calendar:write`. Token has `email:read`. Invoke tool. | `GrantexScopeError` thrown before `func` executes. |
| **LC-003** | Audit callback logs tool usage | P1 | Use `GrantexAuditHandler`. Invoke agent. | Audit entries created for each tool call. |

### Test Cases — OpenAI Agents (`packages/openai-agents/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **OAI-001** | Create scoped tool | P1 | `create_grantex_tool(grant_token=..., required_scope="email:read", func=...)` | Tool created. |
| **OAI-002** | Tool blocks missing scope | P0 | Create tool with scope not in token | `PermissionError` at creation time. |

### Test Cases — Google ADK (`packages/google-adk/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **ADK-001** | Create scoped tool | P1 | `create_grantex_tool(...)` with valid token and scope | Function created with correct `__name__` and `__doc__`. |
| **ADK-002** | Tool blocks missing scope | P0 | Create with unauthorized scope | `PermissionError`. |

### Test Cases — CrewAI (`packages/crewai/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **CREW-001** | Create scoped tool with Pydantic schema | P1 | `create_grantex_tool(..., args_schema=MyModel)` | `BaseTool` subclass created with schema. |
| **CREW-002** | Audit logging wrapper | P1 | `with_audit_logging(tool, client, ...)` | Tool invocations logged to Grantex audit trail. |

### Test Cases — Vercel AI (`packages/vercel-ai/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **VAI-001** | Create tool with Zod schema | P1 | `createGrantexTool({ parameters: z.object({...}), ... })` | Tool created with typed parameters. |
| **VAI-002** | Scope enforcement | P0 | Create tool with missing scope | `GrantexScopeError`. |

### Test Cases — AutoGen (`packages/autogen/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **AUTOGEN-001** | Create function with definition | P1 | `createGrantexFunction(...)` | Returns `{ definition, execute }`. Definition has OpenAI function schema. |
| **AUTOGEN-002** | Registry dispatch | P1 | Register multiple functions. `registry.execute(name, args)`. | Correct function executed. |

---

## 40. Module 37: Service Adapters

### Available Adapters

Google Calendar, Gmail, Google Drive, Stripe, Slack, GitHub, Notion, HubSpot, Salesforce, Linear, Jira

### Test Cases (per adapter)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **ADAPT-001** | Valid token + matching scope | P1 | Call adapter method with valid token and correct scope | Upstream API called. Result returned. |
| **ADAPT-002** | Missing scope rejected | P0 | Call adapter method with token lacking required scope | Error: `SCOPE_MISSING`. Upstream NOT called. |
| **ADAPT-003** | Expired token rejected | P0 | Call with expired JWT | Error: `TOKEN_INVALID`. |
| **ADAPT-004** | Constraint enforcement (Stripe) | P1 | Token has `payments:initiate:max_500`. Attempt to initiate $600 payment. | Error: `CONSTRAINT_VIOLATED`. |
| **ADAPT-005** | Constraint within limit | P1 | Token has `payments:initiate:max_500`. Initiate $300 payment. | Payment proceeds. |
| **ADAPT-006** | Audit logging callback | P2 | Provide `onAudit` callback. Call adapter. | Callback invoked with grant, action, status. |
| **ADAPT-007** | Upstream timeout | P2 | Configure short timeout. Upstream is slow. | Error: `UPSTREAM_ERROR` after timeout. |
| **ADAPT-008** | Invalid credentials | P2 | Provide wrong upstream API credentials | Error: `CREDENTIAL_ERROR`. |

---

## 41. Module 38: Event Destinations

### Available Destinations

Datadog, Splunk, AWS S3, Google BigQuery, Apache Kafka

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **DEST-001** | Connect to SSE source | P2 | Start EventSource with valid API key | SSE connection established. |
| **DEST-002** | Events dispatched to destination | P2 | Configure a destination. Trigger events. | Events appear in destination (Datadog, Splunk, etc.). |
| **DEST-003** | Event type filtering | P2 | Filter for `grant.created` only. Trigger `token.issued`. | Only `grant.created` events dispatched. |
| **DEST-004** | Graceful shutdown | P2 | Call `close()` | All destinations flushed and closed. |

---

## 42. Module 39: A2A Protocol Bridges

### Test Cases — TypeScript (`packages/a2a/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **A2A-001** | Client sends task with grant token | P2 | Create `A2AGrantexClient`. Call `sendTask(...)`. | JSON-RPC 2.0 request sent with `Authorization: Bearer {grantToken}`. |
| **A2A-002** | Server middleware validates token | P2 | Start A2A server with middleware. Send request with valid token. | Request proceeds. Grant context extracted. |
| **A2A-003** | Server rejects invalid token | P2 | Send request with expired token | 401: Token invalid. |

### Test Cases — Python (`packages/a2a-py/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **A2APY-001** | Client sends task | P2 | Create `A2AGrantexClient`. Send task. | Request sent with grant token in headers. |
| **A2APY-002** | Server middleware validates | P2 | Use middleware. Send valid request. | Grant context available. |

---

## 43. Module 40: Terraform Provider

### How to Test

```bash
cd packages/terraform-provider-grantex
go test ./...
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **TF-001** | Provider configuration | P2 | `terraform init` with Grantex provider block | Provider initialized. |
| **TF-002** | Create agent resource | P2 | `terraform apply` with `grantex_agent` resource | Agent created. `agent_id` and `did` computed. |
| **TF-003** | Update agent resource | P2 | Change agent name. `terraform apply`. | Agent updated in place. |
| **TF-004** | Destroy agent resource | P2 | `terraform destroy` | Agent deleted from Grantex. |
| **TF-005** | Data source lookup | P2 | `data "grantex_agent"` with existing agent ID | Returns agent details. |
| **TF-006** | Import existing agent | P2 | `terraform import grantex_agent.foo {agentId}` | Agent imported into state. |
| **TF-007** | Invalid API key | P2 | Configure provider with bad key. `terraform plan`. | Error: authentication failed. |

---

## 44. Module 41: Conformance Test Suite

### How to Test

```bash
cd packages/conformance
npm install && npm run build
npx grantex-conformance --base-url http://localhost:3001 --api-key dev-api-key-local
```

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **CONF-001** | Run all core suites | P0 | `grantex-conformance --base-url http://localhost:3001 --api-key {key}` | All 40 core tests pass (health, agents, authorize, token, tokens, grants, delegation, audit, security, rate-limit-headers). |
| **CONF-002** | Run with optional extensions | P1 | `--include policies,webhooks,scim` | Optional suites run and pass. |
| **CONF-003** | Run specific suite | P1 | `--suite health` | Only health suite runs. |
| **CONF-004** | JSON output format | P2 | `--format json` | Valid JSON report with pass/fail counts. |
| **CONF-005** | Bail on first failure | P2 | `--bail` with a known failing test | Stops after first failure. Exit code 1. |
| **CONF-006** | Run against production | P1 | Point to production URL with valid key | All tests pass against live deployment. |

---

## 45. Module 42: Example Applications

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **EX-001** | quickstart-ts | P0 | `cd examples/quickstart-ts && npm install && npm start` | Completes full flow: register agent → authorize → exchange → verify → audit → revoke. No errors. |
| **EX-002** | quickstart-py | P0 | `cd examples/quickstart-py && pip install -r requirements.txt && python main.py` | Same flow as EX-001 in Python. No errors. |
| **EX-003** | nextjs-starter | P1 | `cd examples/nextjs-starter && npm install && npm run dev` → open browser | Next.js app loads. Consent flow works via UI. |
| **EX-004** | langchain-agent | P1 | `cd examples/langchain-agent && npm install && npm start` | LangChain agent runs with scoped tools. Scope enforcement works. |
| **EX-005** | vercel-ai-chatbot | P1 | `cd examples/vercel-ai-chatbot && npm install && npm start` | Chatbot runs with Grantex-scoped tools. |
| **EX-006** | crewai-agent | P1 | `cd examples/crewai-agent && pip install -r requirements.txt && python main.py` | CrewAI agent runs with scoped tools. |
| **EX-007** | openai-agents | P1 | `cd examples/openai-agents && pip install -r requirements.txt && python main.py` | OpenAI Agents SDK integration works. |
| **EX-008** | google-adk | P1 | `cd examples/google-adk && pip install -r requirements.txt && python main.py` | Google ADK integration works. |
| **EX-009** | multi-agent-delegation | P1 | `cd examples/multi-agent-delegation && npm install && npm start` | Parent→child delegation works. Cascade revocation demonstrated. |
| **EX-010** | gateway-proxy | P1 | `cd examples/gateway-proxy && npm install && npm start` | Gateway starts. Token verification + scope enforcement works. |
| **EX-011** | adapter-google-calendar | P2 | `cd examples/adapter-google-calendar && npm install && npm start` | Adapter integration works. |
| **EX-012** | x402-agent-demo | P2 | `cd examples/x402-agent-demo && npm install && npm start` | x402 payment flow with delegation token works. |
| **EX-013** | x402-weather-api | P2 | `cd examples/x402-weather-api && npm install && npm start` | Payment-gated API with GDT enforcement works. |

---

## 46. Module 43: Landing Page & Documentation

### Landing Page (`https://grantex.dev`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **WEB-001** | Page loads | P0 | Open `https://grantex.dev` | Page loads fully. No console errors. All sections visible. |
| **WEB-002** | Mobile responsiveness | P1 | Open on 375px viewport | No horizontal scroll. All content readable. |
| **WEB-003** | CTA buttons work | P1 | Click "Get Started", "View Docs", "Star on GitHub" | Each navigates to correct destination. |
| **WEB-004** | Code examples readable | P1 | Scroll to code examples section | Code blocks render correctly with syntax highlighting. |
| **WEB-005** | External links work | P1 | Click all outbound links (GitHub, Discord, Docs) | All open correct pages. No 404s. |
| **WEB-006** | SEO metadata | P2 | View page source | JSON-LD, OpenGraph, Twitter Card metadata present and correct. |
| **WEB-007** | Threat stats section | P1 | Scroll to "Attackers have already figured this out" section | 4 stat cards visible (18.1M, 29M, 29 min, 4 min). 4 incident cards (Shai-Hulud, SANDWORM_MODE, OpenClaw, CVE-2026-21852). Blog link works. |
| **WEB-008** | Business risk section | P1 | Scroll to "When an agent acts, who is legally responsible?" | Risk scenario card visible. 3 sub-cards ("Who authorized it?", "What did it access?", "Can you prove you tried?") with "Grantex fixes this" CTAs. |
| **WEB-009** | Alternatives table | P1 | Scroll to "Your security tools have a blind spot" | 6-row comparison table visible (Vault, AWS SM, GitGuardian, Snyk, Doppler, Grantex). No horizontal scrollbar. Grantex row highlighted green. |
| **WEB-010** | Compliance section | P1 | Scroll to "The regulatory pressure is already here" | 3 cards (OWASP, EU AI Act, NIST). Links to compliance matrix and blog post work. |
| **WEB-011** | New sections responsive | P1 | Open on 375px viewport | Stat cards stack to 2-col. Risk cards stack. Table readable (may scroll on very small screens). No content overflow. |
| **WEB-012** | New section anchor links | P2 | Navigate to `#threat-landscape`, `#business-risk`, `#alternatives`, `#compliance` | Each anchor scrolls to correct section. |

### Blog Posts (`https://docs.grantex.dev/blog/`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **BLOG-001** | Security breaches post loads | P1 | Open `docs.grantex.dev/blog/agent-security-breaches-2025-2026` | Page loads. Title, date, author visible. All 4 incident sections render. Summary table renders. Internal links work. |
| **BLOG-002** | OWASP compliance post loads | P1 | Open `docs.grantex.dev/blog/owasp-agentic-top-10-compliance` | Page loads. OWASP, EU AI Act, NIST sections render. Compliance matrix table renders. Links to compliance matrix page work. |
| **BLOG-003** | Copilot-to-autonomous post loads | P1 | Open `docs.grantex.dev/blog/from-copilot-to-autonomous-agents` | Page loads. 3-phase timeline renders. Phase comparison table renders. Internal doc links work. |
| **BLOG-004** | Blog navigation updated | P1 | Open Blog tab in docs nav | All 8 blog posts listed. New posts appear at top. |
| **BLOG-005** | Blog posts in sitemap | P2 | Fetch `grantex.dev/sitemap.xml` | 3 new blog post URLs present with `2026-03-28` lastmod. |

### Compliance Matrix (`https://docs.grantex.dev/guides/compliance-matrix`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **COMP-001** | Compliance matrix page loads | P1 | Open `docs.grantex.dev/guides/compliance-matrix` | Page loads. OWASP, EU AI Act, NIST sections visible. All tables render correctly. |
| **COMP-002** | Compliance matrix in nav | P1 | Navigate to Guides section in docs | "Compliance Matrix" appears as last item in Guides nav group. |
| **COMP-003** | Cross-links work | P2 | Click links to SOC 2 report, IETF draft, NIST comment, AuthZEN mapping | All linked pages load. No 404s. |

### Documentation (`https://docs.grantex.dev`)

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **DOC-001** | Docs site loads | P0 | Open `https://docs.grantex.dev` | Mintlify site loads with navigation. |
| **DOC-002** | Navigate all sections | P1 | Click through: Getting Started, Core Concepts, Guides, SDK docs, API Reference, Integrations, Protocol | All pages load. No 404s. |
| **DOC-003** | Code examples copyable | P1 | Click "Copy" on any code block | Code copied to clipboard. |
| **DOC-004** | Search works | P1 | Use Mintlify search (Cmd+K / Ctrl+K) for "token exchange" | Relevant results returned. |
| **DOC-005** | API Reference completeness | P1 | Open API Reference tab. Check all endpoint groups. | All 40+ endpoints documented with request/response examples. |
| **DOC-006** | Postman collection download | P2 | Download Postman collection from docs | File downloads. Imports into Postman successfully. |

---

## 47. Module 44: Deployment & Infrastructure

### Test Cases

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **DEP-001** | Health check (production) | P0 | `curl https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health` | 200: `{ status: "ok", database: "ok", redis: "ok" }`. |
| **DEP-002** | JWKS endpoint accessible | P0 | GET `/.well-known/jwks.json` on production | 200: Valid JWKS with RS256 key(s). |
| **DEP-003** | Metrics endpoint | P2 | GET `/metrics` on production | 200: Prometheus-format metrics. |
| **DEP-004** | Helm chart lint | P2 | `helm lint deploy/helm/grantex/` | No errors or warnings. |
| **DEP-005** | Docker build | P2 | `docker build -t grantex-auth apps/auth-service/` | Image builds successfully. |
| **DEP-006** | CORS headers | P1 | Send preflight OPTIONS request | Access-Control-Allow-Origin and related headers present. |

---

## 48. Cross-Cutting: Security Testing

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **SEC-001** | All protected endpoints reject missing auth | P0 | Call every protected endpoint without Authorization header | All return 401. |
| **SEC-002** | API key isolation (multi-tenancy) | P0 | Developer A creates resources. Developer B tries to access them. | Developer B gets 404 on all A's resources. |
| **SEC-003** | SQL injection in query params | P1 | Pass `'; DROP TABLE grants; --` in filter params | No SQL errors. Query treated as literal string. |
| **SEC-004** | XSS in consent page | P1 | Set agent name to `<script>alert('xss')</script>`. Open consent page. | Script is HTML-escaped. No alert fires. |
| **SEC-005** | JWT signature required | P0 | Send a JWT with `alg: "none"` | Rejected: invalid token. |
| **SEC-006** | Refresh token single-use | P0 | Use refresh token. Use same refresh token again. | Second use rejected. |
| **SEC-007** | PKCE verifier required when challenge sent | P0 | Create auth request with PKCE. Exchange code without verifier. | Rejected. |
| **SEC-008** | Rate limiting prevents brute force | P1 | Rapid-fire requests to `/v1/token` | 429 after 20/min. |
| **SEC-009** | API key not returned in GET responses | P1 | GET `/v1/me` | API key hash is NOT in response. Only developer metadata. |
| **SEC-010** | Webhook secrets are HMAC-SHA256 | P1 | Register webhook. Verify signature algorithm. | Signature matches HMAC-SHA256(body, secret). |
| **SEC-011** | Expired tokens rejected everywhere | P0 | Use expired JWT for verification, delegation, gateway | All endpoints reject expired tokens. |
| **SEC-012** | Scope escalation prevented | P0 | Delegation: request scopes not in parent. Gateway: request route beyond token scopes. | All attempts rejected with 400/403. |

---

## 49. Cross-Cutting: Error Handling

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **ERR-001** | All errors return JSON format | P0 | Trigger various errors (400, 401, 403, 404, 429, 500) | All return `{ message, code, requestId }`. |
| **ERR-002** | Request ID in every response | P1 | Check response headers/body | Every response includes a unique `requestId` (UUID). |
| **ERR-003** | 404 for unknown routes | P1 | GET `/v1/nonexistent` | 404: Not found. |
| **ERR-004** | Invalid JSON body | P1 | POST with malformed JSON body | 400: Parse error. |
| **ERR-005** | Content-Type enforcement | P1 | POST without `Content-Type: application/json` | 400 or 415: Unsupported media type. |

---

## 50. Cross-Cutting: Observability

| ID | Test Case | Priority | Steps | Expected Result |
|----|-----------|----------|-------|-----------------|
| **OBS-001** | Prometheus metrics increment | P2 | GET `/metrics` before and after making API calls | `grantex_http_request_duration_seconds` counters increase. |
| **OBS-002** | Metrics include method, route, status | P2 | Check metrics labels | Labels include `method`, `route`, `status_code`. |
| **OBS-003** | Health check reflects dependency status | P1 | Stop Redis. GET `/health`. | Reports `redis: "error"` or degraded status. |

---

## 51. Bug Report Template

When filing bugs, use this format:

```
## Bug Report

**ID**: BUG-XXXX
**Module**: (e.g., Module 3: Authorization & Consent Flow)
**Test Case**: (e.g., AUTH-005)
**Severity**: P0 (blocker) / P1 (major) / P2 (minor) / P3 (cosmetic)
**Environment**: Local / Production
**Date**: YYYY-MM-DD
**Tester**: Name

### Description
One-sentence summary of what's wrong.

### Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

### Expected Result
What should happen.

### Actual Result
What actually happened.

### Evidence
- Screenshot/video URL
- cURL command used
- Response body (redact any secrets)
- Browser console errors

### Notes
Any additional context.
```

---

## 52. Test Execution Tracker

Use this table to track test execution across modules. Copy for each test cycle.

| Module | Total Cases | Passed | Failed | Blocked | Not Run | Tester | Date |
|--------|-------------|--------|--------|---------|---------|--------|------|
| M1: Signup & Account | 13 | | | | | | |
| M2: Agent Management | 11 | | | | | | |
| M3: Authorization & Consent | 19 | | | | | | |
| M4: Token Exchange | 12 | | | | | | |
| M5: Token Verify & Revoke | 9 | | | | | | |
| M6: Grants & Delegation | 12 | | | | | | |
| M7: PKCE | 4 | | | | | | |
| M8: Token Refresh | 6 | | | | | | |
| M9: Policy Engine | 11 | | | | | | |
| M10: Webhooks | 10 | | | | | | |
| M11: Audit Trail | 10 | | | | | | |
| M12: Anomaly Detection | 4 | | | | | | |
| M13: Principal Sessions | 7 | | | | | | |
| M14: Budgets | 8 | | | | | | |
| M15: Usage Metering | 3 | | | | | | |
| M16: Custom Domains | 5 | | | | | | |
| M17: FIDO2/WebAuthn | 8 | | | | | | |
| M18: VCs & SD-JWT | 6 | | | | | | |
| M19: DID Infrastructure | 3 | | | | | | |
| M20: SCIM 2.0 | 10 | | | | | | |
| M21: SSO | 4 | | | | | | |
| M22: Billing | 4 | | | | | | |
| M23: Compliance | 4 | | | | | | |
| M24: Events (SSE/WS) | 5 | | | | | | |
| M25: Rate Limiting | 5 | | | | | | |
| M26: Developer Portal | 30 | | | | | | |
| M27: TypeScript SDK | 10 | | | | | | |
| M28: Python SDK | 9 | | | | | | |
| M29: Go SDK | 5 | | | | | | |
| M30: CLI Tool | 50 | | | | | | |
| M31: Gateway | 10 | | | | | | |
| M32: Express Middleware | 6 | | | | | | |
| M33: FastAPI Middleware | 4 | | | | | | |
| M34: MCP Server | 10 | | | | | | |
| M35: MCP Auth Server | 6 | | | | | | |
| M36: Framework Integrations | 14 | | | | | | |
| M37: Service Adapters | 8 | | | | | | |
| M38: Event Destinations | 4 | | | | | | |
| M39: A2A Bridges | 5 | | | | | | |
| M40: Terraform Provider | 7 | | | | | | |
| M41: Conformance Suite | 6 | | | | | | |
| M42: Example Applications | 13 | | | | | | |
| M43: Landing Page & Docs | 26 | | | | | | |
| M44: Deployment | 6 | | | | | | |
| Security (Cross-cutting) | 12 | | | | | | |
| Error Handling (Cross-cutting) | 5 | | | | | | |
| Observability (Cross-cutting) | 3 | | | | | | |
| **TOTAL** | **~424** | | | | | | |

---

## Priority Guide

| Priority | Meaning | When to Test |
|----------|---------|--------------|
| **P0** | Blocker — core functionality broken | Every test cycle. Must pass before release. |
| **P1** | Major — important functionality affected | Every test cycle. Should pass before release. |
| **P2** | Minor — non-critical feature or edge case | Full regression cycles only. |
| **P3** | Cosmetic — UI polish, minor UX | Time permitting. |

### Recommended Test Cycle Order

1. **Smoke Test** (30 min): Run P0 tests from Modules 1-6 + SEC-001, SEC-002
2. **Core Regression** (2-3 hours): All P0 + P1 tests across all modules
3. **Full Regression** (1 day): All P0 + P1 + P2 tests
4. **Conformance Run**: `grantex-conformance --include policies,webhooks,scim` against target environment

---

*End of Manual QA Test Plan*
