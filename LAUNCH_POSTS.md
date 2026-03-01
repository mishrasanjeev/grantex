# Grantex Launch Posts

Copy-paste ready posts for each platform. Edit as needed before posting.

---

## 1. Hacker News — Show HN

**Title:** Show HN: Grantex – Open delegated authorization protocol for AI agents (OAuth 2.0 for agents)

**URL:** https://github.com/mishrasanjeev/grantex

**Text (top comment):**

Most AI agents today operate with all-or-nothing API keys. If your LangChain agent can read your calendar, it can also delete every event. There's no scoping, no revocation, no audit trail. This is where the web was before OAuth.

Grantex is an open protocol (Apache 2.0) for delegated authorization of AI agents. The core idea: a human approves a scoped, time-limited grant for an agent, and that agent receives a signed JWT it can present to any service. Services verify locally via JWKS — no Grantex account needed.

What's different from OAuth 2.0:

- Agent identity: Every agent gets a cryptographic DID, not borrowed user credentials.
- Delegation chains: A parent agent can delegate a narrower grant to a sub-agent, with depth tracking.
- Action-level auditing: Append-only, hash-chained log of every action an agent takes.
- Real-time revocation: Kill a misbehaving agent's access in < 1 second.

What ships today:

- Protocol spec v1.0 (frozen): https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md
- TypeScript SDK (`@grantex/sdk`): https://www.npmjs.com/package/@grantex/sdk
- Python SDK (`grantex`): https://pypi.org/project/grantex/
- Go SDK (`go get github.com/mishrasanjeev/grantex-go`)
- 8 framework integrations: LangChain, AutoGen, CrewAI, Vercel AI, OpenAI Agents SDK, Google ADK, MCP server, Express.js + FastAPI middleware
- Conformance test suite for verifying spec compliance
- Auth service (Fastify, deployed on Cloud Run)
- CLI, developer portal, enterprise features (policies, SCIM/SSO, anomaly detection, compliance exports)

Links:

- Homepage: https://grantex.dev
- Docs: https://grantex.dev/docs
- API Reference: https://grantex.mintlify.app/api-reference
- Sign up (free): https://grantex.dev/dashboard/signup
- Postman collection: https://github.com/mishrasanjeev/grantex/blob/main/docs/grantex.postman_collection.json

The quickstart is ~10 lines of code:

    import { Grantex } from '@grantex/sdk';

    const gx = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });
    const agent = await gx.agents.register({ name: 'travel-agent', scopes: ['flights:book'] });
    const auth = await gx.authorize({ agentId: agent.id, userId: 'user_alice', scopes: ['flights:book'] });
    // user approves at auth.consentUrl
    const token = await gx.tokens.exchange({ code, agentId: agent.id });
    // agent now has a signed JWT — any service can verify it offline

I built this because I think the "give agents your API key" pattern is going to age very badly as agents get more capable. Happy to answer questions about the protocol design, security model, or anything else.

---

## 2. Reddit — r/MachineLearning

**Title:** [P] Grantex: Open authorization protocol for AI agents — scoped permissions, delegation chains, and audit trails

**Body:**

**TL;DR**: Grantex is an open protocol (Apache 2.0) that gives AI agents scoped, human-approved, revocable permissions instead of all-or-nothing API keys. Think OAuth 2.0, but designed for autonomous agents and multi-agent pipelines.

**The problem**: Most agent frameworks today handle auth with a shared API key. The agent has whatever access the key has — no scoping, no revocation, no record of what it did. For research prototypes this is fine. For agents booking flights, sending emails, or executing trades on behalf of real users, it's a liability.

**What Grantex does**:

1. **Agent registers** with a name and required scopes (e.g., `flights:book`, `payments:initiate:max_500`)
2. **Human approves** specific scopes via a consent UI (like an OAuth consent screen, but designed for agent use cases)
3. **Agent receives a signed JWT** — scoped, time-limited, revocable
4. **Any service verifies offline** via published JWKS — no Grantex account needed
5. **Every action is logged** in an append-only, hash-chained audit trail

Key features that go beyond OAuth:

- **Delegation chains** — parent agent grants narrower permissions to sub-agents, with depth tracking (protocol spec Section 9)
- **Cryptographic agent identity** — DID-based, not borrowed user credentials
- **Real-time revocation** — revoke a misbehaving agent in < 1 second
- **Policy engine** — enforce rules like "max $500 per transaction" or "only during business hours"

**What's available today**:

- Protocol spec v1.0 (frozen, public)
- SDKs: TypeScript (`npm install @grantex/sdk`), Python (`pip install grantex`), and Go (`go get github.com/mishrasanjeev/grantex-go`)
- Integrations: LangChain, CrewAI, AutoGen, Vercel AI, OpenAI Agents SDK, Google ADK, MCP server, Express.js + FastAPI middleware
- Auth service, CLI, developer portal
- Enterprise: SCIM/SSO, anomaly detection, compliance exports

**Links**:

- Homepage: [grantex.dev](https://grantex.dev)
- GitHub: [github.com/mishrasanjeev/grantex](https://github.com/mishrasanjeev/grantex)
- Docs: [grantex.dev/docs](https://grantex.dev/docs)
- API Reference: [grantex.mintlify.app/api-reference](https://grantex.mintlify.app/api-reference)
- Sign up (free): [grantex.dev/dashboard/signup](https://grantex.dev/dashboard/signup)
- Protocol spec: [SPEC.md](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
- npm: [npmjs.com/package/@grantex/sdk](https://www.npmjs.com/package/@grantex/sdk)
- PyPI: [pypi.org/project/grantex](https://pypi.org/project/grantex/)
- Go: [pkg.go.dev/github.com/mishrasanjeev/grantex-go](https://pkg.go.dev/github.com/mishrasanjeev/grantex-go)

Interested in feedback from anyone working on agent systems, multi-agent orchestration, or AI safety. The spec is public and I'd love to see other implementations.

---

## 3. Reddit — r/LocalLLaMA

**Title:** Grantex — open protocol for giving AI agents scoped, revocable permissions (instead of just handing them your API keys)

**Body:**

Quick question: when you give your agent access to your email or calendar, how do you scope what it can do? How do you revoke it? How do you know what it actually did?

Right now the answer for most people is "I gave it my API key and hoped for the best." That works for experiments, but it's going to be a real problem as agents get more capable and start acting in the real world.

I built **Grantex** to solve this. It's an open protocol (Apache 2.0) — basically OAuth 2.0 redesigned for agents:

- Agent requests specific scopes (`email:read`, `calendar:write`, `payments:max_100`)
- Human approves via consent screen
- Agent gets a signed JWT with those scopes baked in
- Any service can verify the JWT offline (JWKS, same as OAuth)
- Human can revoke access instantly
- Everything the agent does gets logged

It also handles **delegation** — if your agent spawns a sub-agent, the sub-agent gets a narrower grant derived from the parent's, with full chain tracking.

There's a TypeScript SDK, Python SDK, Go SDK, and integrations for LangChain, CrewAI, AutoGen, Vercel AI, OpenAI Agents SDK, Google ADK, and an MCP server (so it works with Claude Desktop/Cursor/Windsurf).

Everything is open source:

- Homepage: [grantex.dev](https://grantex.dev)
- GitHub: [github.com/mishrasanjeev/grantex](https://github.com/mishrasanjeev/grantex)
- Docs: [grantex.dev/docs](https://grantex.dev/docs)
- Sign up (free): [grantex.dev/dashboard/signup](https://grantex.dev/dashboard/signup)
- npm: `npm install @grantex/sdk`
- PyPI: `pip install grantex`
- Go: `go get github.com/mishrasanjeev/grantex-go`

Would love to hear how others are handling agent permissions in their setups.

---

## 4. Reddit — r/programming

**Title:** Grantex: An open authorization protocol for AI agents — delegated grants, audit trails, and sub-agent delegation built on JWT/JWKS

**Body:**

I've been working on Grantex, an open protocol for delegated authorization of AI agents. The protocol spec is public and frozen at v1.0.

**Why this exists**: OAuth 2.0 was designed for human users clicking consent buttons. Agents have different needs — they spawn sub-agents, operate autonomously, and need permission boundaries that are narrower than "everything the API key can do." Grantex extends the OAuth model with agent-specific primitives.

**Protocol overview**:

The core primitive is a **Grant Token** — an RS256 JWT with claims for:
- `sub` — the human principal who approved the grant
- `agt` — the agent's DID (cryptographic identity)
- `scp` — approved scopes
- `exp` — expiration
- Standard JWT: `iss`, `iat`, `jti`

For delegation, child tokens add: `parentAgt`, `parentGrnt`, `delegationDepth`.

Verification is offline via JWKS (`/.well-known/jwks.json`) — receiving services don't need a Grantex account. Revocation is checked via a lightweight status endpoint or CRL.

**Implementation details**:

- Auth service: Fastify + PostgreSQL + Redis, deployed on Cloud Run
- JWT signing: RS256, JWKS endpoint, key rotation support
- Rate limiting: 10/min authorize, 20/min token exchange, 100/min global
- Audit trail: append-only, hash-chained entries
- PKCE support (S256) for public clients

**SDKs and integrations**:

- TypeScript: `@grantex/sdk` (ESM, Node 18+, native fetch)
- Python: `grantex` (httpx, PyJWT, Python 3.9+)
- Go: `github.com/mishrasanjeev/grantex-go` (Go 1.21+, stdlib + jwt)
- Framework integrations: LangChain, AutoGen, CrewAI, Vercel AI SDK, OpenAI Agents SDK, Google ADK
- MCP server for Claude Desktop / Cursor / Windsurf
- CLI tool
- OpenAPI 3.1 spec + Postman collection

Everything is Apache 2.0.

**Links**:

- Homepage: [grantex.dev](https://grantex.dev)
- GitHub: [github.com/mishrasanjeev/grantex](https://github.com/mishrasanjeev/grantex)
- Docs: [grantex.dev/docs](https://grantex.dev/docs)
- API Reference: [grantex.mintlify.app/api-reference](https://grantex.mintlify.app/api-reference)
- Sign up (free): [grantex.dev/dashboard/signup](https://grantex.dev/dashboard/signup)
- Protocol spec: [SPEC.md](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
- Postman collection: [grantex.postman_collection.json](https://github.com/mishrasanjeev/grantex/blob/main/docs/grantex.postman_collection.json)
- npm: [npmjs.com/package/@grantex/sdk](https://www.npmjs.com/package/@grantex/sdk)
- PyPI: [pypi.org/project/grantex](https://pypi.org/project/grantex/)
- Go: [pkg.go.dev/github.com/mishrasanjeev/grantex-go](https://pkg.go.dev/github.com/mishrasanjeev/grantex-go)

---

## 5. Twitter/X Thread (280 char limit, no Blue)

**Tweet 1 — hook (275 chars):**

AI agents book flights, send emails, and move money on your behalf.

Most run on all-or-nothing API keys. No scoping. No audit trail.

We built Grantex — an open authorization protocol for AI agents.

github.com/mishrasanjeev/grantex

🧵

**Tweet 2 — problem (209 chars):**

OAuth 2.0 was built for humans clicking "Allow."

Agents need more:
→ Own cryptographic identity
→ Sub-agent delegation with narrower scopes
→ Action-level audit trails
→ Instant revocation

**Tweet 3 — solution (256 chars):**

Grantex gives agents 3 things:

1/ Cryptographic identity (DID per agent)
2/ Delegated grants — scoped, time-limited JWTs approved by humans
3/ Audit trail — append-only log of every action

Services verify offline via JWKS. Zero lock-in.

**Tweet 4 — ship it (220 chars):**

Works in TypeScript, Python, and Go:

npm install @grantex/sdk
pip install grantex
go get github.com/mishrasanjeev/grantex-go

Register agent → user approves scopes → agent gets signed JWT → any service verifies offline.

**Tweet 5 — integrations (214 chars):**

8 integrations out of the box:

→ LangChain
→ CrewAI
→ AutoGen
→ Vercel AI SDK
→ OpenAI Agents SDK
→ Google ADK
→ MCP (Claude Desktop, Cursor, Windsurf)

Plus CLI, dev portal, policies, SCIM/SSO, anomaly detection.

**Tweet 6 — CTA (220 chars):**

Open source. Apache 2.0.

npm install @grantex/sdk
pip install grantex
go get github.com/mishrasanjeev/grantex-go
Docs: grantex.dev/docs

As agents get more capable, proper authorization becomes more critical — not less.

---

## 6. Dev.to Article

**Title:** Why AI Agents Need Their Own Authorization Protocol (and how we built one)

**Tags:** ai, security, opensource, webdev

**Cover image:** https://grantex.dev/og-image.png

**Body:**

*(Cross-post the content from `docs/blog/introducing-grantex.mdx` with these modifications:)*

1. Replace relative links (`/quickstart`, `/protocol/specification`) with full URLs (`https://grantex.dev/docs/quickstart`, etc.)
2. Add the `cover_image` field pointing to the OG image
3. Add a "Get Started" section at the bottom with install commands and links
4. Add the canonical URL: `canonical_url: https://grantex.mintlify.app/blog/introducing-grantex`

---

## 7. LinkedIn Post

I've been thinking about a problem that keeps coming up in AI agent development: permissions.

When you build an agent that books flights, sends emails, or moves money — how does it prove to downstream services what it's allowed to do? Right now, the answer is usually "hand it your API key and hope for the best."

That's the same mistake the web made before OAuth. And it's going to scale very badly as agents get more capable.

So I built Grantex — an open protocol for delegated authorization of AI agents.

Here's how it works:

1. An agent registers with the scopes it needs (e.g., flights:book, payments:max_500)
2. The human approves those specific scopes via a consent screen
3. The agent receives a signed JWT — scoped, time-limited, revocable
4. Any downstream service can verify that JWT offline via JWKS — no Grantex account needed
5. Every action gets logged in an append-only audit trail

What makes this different from "just use OAuth":

- Agents get their own cryptographic identity (DID-based), not borrowed user credentials
- Delegation chains let a parent agent grant narrower permissions to sub-agents, with full depth tracking
- Real-time revocation — kill a misbehaving agent's access in under a second

What's shipping today:

- Protocol spec v1.0 (frozen, public)
- SDKs in TypeScript, Python, and Go
- 8 framework integrations: LangChain, CrewAI, AutoGen, Vercel AI SDK, OpenAI Agents SDK, Google ADK, MCP server (works with Claude Desktop/Cursor/Windsurf), Express.js + FastAPI middleware
- Auth service, CLI, developer portal, conformance test suite
- Enterprise features: policy engine, SCIM/SSO, anomaly detection, compliance exports

Everything is open source under Apache 2.0.

If you're building with AI agents — whether it's a single-agent tool or a multi-agent pipeline — I'd love your feedback on the protocol design.

Get started:
npm install @grantex/sdk
pip install grantex
go get github.com/mishrasanjeev/grantex-go

Homepage: https://grantex.dev
Docs: https://grantex.dev/docs
GitHub: https://github.com/mishrasanjeev/grantex

#AI #OpenSource #Security #AIAgents #OAuth #Authorization

---

## Posting Order (recommended)

1. **Dev.to** — publish first so you have a canonical URL for cross-referencing
2. **Hacker News** — post as "Show HN" (best times: Tuesday-Thursday, 8-10am ET)
3. **Twitter/X** — post the thread, pin it
4. **Reddit r/programming** — wait 1-2 hours after HN to avoid looking spammy
5. **Reddit r/MachineLearning** — same day, different angle (focus on agent safety)
6. **Reddit r/LocalLLaMA** — most casual tone, focus on practical use case
