---
title: "Why AI Agents Need Their Own Authorization Protocol (and how we built one)"
published: true
description: "OAuth 2.0 was built for humans. AI agents need scoped permissions, delegation chains, real-time revocation, and audit trails. Grantex is an open protocol that provides all of this."
tags: ai, security, opensource, webdev
cover_image: https://grantex.dev/og-image.png
canonical_url: https://grantex.mintlify.app/blog/introducing-grantex
---

AI agents are shipping fast. They book flights, send emails, move money, and deploy code. But here is the uncomfortable truth: most of them operate with all-or-nothing API keys and zero audit trail. If an agent goes rogue, you find out after the damage is done.

We built [Grantex](https://grantex.dev) to fix that.

## The Problem

Every time you click "Sign in with Google" or grant an app access to your calendar, OAuth 2.0 is doing the work. It has been the backbone of delegated authorization for over a decade. So why can't we just use it for AI agents?

The short answer: agents are not apps.

OAuth 2.0 was designed for human users clicking "Allow" on a consent screen. It works brilliantly for that. But agents operate autonomously, spawn sub-agents, and chain actions across services. OAuth was never designed for:

- **Agent identity** -- agents need their own cryptographic identity, not borrowed user credentials.
- **Delegation chains** -- a parent agent granting a sub-agent a narrower set of permissions.
- **Action-level auditing** -- knowing exactly what an agent did, not just that it authenticated.
- **Real-time revocation** -- killing a misbehaving agent's access in milliseconds, not minutes.

## The Four Gaps in Detail

### 1. Agent Identity vs. App Identity

OAuth issues tokens to registered applications. An app has a `client_id`, a redirect URI, and a set of scopes. This model assumes a fixed, known piece of software.

AI agents are different. A single orchestrator might spawn dozens of sub-agents at runtime, each with a different purpose. These agents need their own cryptographic identity -- not a shared `client_id`. Grantex assigns each agent a DID (Decentralized Identifier) backed by a key pair. The agent's identity is verifiable, rotatable, and independent of the platform it runs on.

### 2. Scope Delegation Chains

OAuth supports a flat model: a user grants scopes to an app, and that is the end of the story. But agents delegate work to other agents. A "research assistant" agent might call a "web search" sub-agent and a "summarizer" sub-agent, each of which should only get the scopes it actually needs.

Grantex models this explicitly. When a parent agent delegates to a child, the child's grant token carries `parentAgt`, `parentGrnt`, and `delegationDepth` claims. The child's scopes must be a strict subset of the parent's. This is not a convention -- it is enforced at the protocol level.

```
Root user grants: [files:read, files:write, email:send]
  └─ Parent agent:  [files:read, files:write]  (delegationDepth: 0)
       └─ Child agent:  [files:read]            (delegationDepth: 1)
```

If the parent's grant is revoked, every child grant in the chain is automatically invalidated.

### 3. Real-Time Revocation

OAuth token revocation is defined in RFC 7009, but it is advisory. Resource servers are free to keep accepting a token until it expires. For a 1-hour access token, that is a 1-hour window of exposure.

With agents performing high-stakes actions autonomously, you cannot afford that window. Grantex supports both offline verification (fast JWT validation) and online verification that checks revocation state in real time. When you revoke a grant, the very next verification call returns `valid: false`.

### 4. Action-Level Audit Trails

OAuth gives you an access log at the authorization server. You know when a token was issued and when it was refreshed. You do not know what happened next.

Grantex includes a first-class audit subsystem. Every action an agent performs can be logged, and the entries are append-only and hash-chained -- each entry references the hash of the previous one, making tampering detectable. You can query the full trail filtered by agent, grant, principal, or time range.

## The Compliance Dimension

This is not just a technical nicety. The EU AI Act (effective August 2025) requires that high-risk AI systems maintain logs of their operation, support human oversight, and provide transparency about their decision-making. Grantex's audit trail, scoped grants, and real-time revocation map directly onto these requirements.

Similarly, SOC 2 auditors want to see evidence that access is scoped, time-limited, and revocable. Grant tokens with explicit expiration, scope restrictions, and revocation support provide that evidence out of the box.

## Why Not Extend OAuth?

We considered it. The problem is that the primitives do not exist. OAuth has no concept of agent identity, delegation depth, or hash-chained audit logs. Bolting these onto OAuth would mean a constellation of non-standard extensions that no existing library supports.

Grantex is a clean-sheet protocol that speaks the same language as OAuth where it makes sense (JWTs, JWKs, RS256, scopes, authorization codes) but adds the agent-specific primitives as first-class concepts. If you know OAuth, Grantex will feel familiar. But it will also handle the cases OAuth was never designed for.

## What It Looks Like in Code

Here is the full flow in TypeScript:

```typescript
import { Grantex } from '@grantex/sdk';

const gx = new Grantex({
  apiKey: process.env.GRANTEX_API_KEY,
});

// 1. Register an agent
const agent = await gx.agents.register({
  name: 'travel-booking-agent',
  description: 'Books flights and hotels for users',
  scopes: ['flights:book', 'hotels:search'],
});

// 2. Request authorization from a user
const auth = await gx.authorize({
  agentId: agent.id,
  userId: 'user_alice',
  scopes: ['flights:book', 'hotels:search'],
  callbackUrl: 'https://app.example.com/callback',
});
// → redirect user to auth.consentUrl

// 3. Exchange the authorization code for a grant token
const token = await gx.tokens.exchange({
  code: callbackCode,
  agentId: agent.id,
});

// 4. Verify the token before acting
const result = await gx.tokens.verify(token.grantToken);
console.log(result.scopes); // ['flights:book', 'hotels:search']

// 5. Log every action to the audit trail
await gx.audit.log({
  agentId: agent.id,
  grantId: token.grantId,
  action: 'flight.booked',
  status: 'success',
  metadata: { airline: 'Air India', amount: 420 },
});
```

The same flow works in Python:

```python
from grantex import Grantex, ExchangeTokenParams

client = Grantex(api_key=os.environ["GRANTEX_API_KEY"])

agent = client.agents.register(
    name="travel-booking-agent",
    scopes=["flights:book", "hotels:search"],
)

auth = client.authorize(
    agent_id=agent.id,
    user_id="user_alice",
    scopes=["flights:book", "hotels:search"],
)
# redirect user to auth.consent_url

token = client.tokens.exchange(
    ExchangeTokenParams(code=callback_code, agent_id=agent.id)
)
print(token.scopes)  # ('flights:book', 'hotels:search')
```

## What Ships Today

- **Protocol spec v1.0** (final) -- the full specification is [public and frozen](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md).
- **TypeScript SDK** ([`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk)) and **Python SDK** ([`grantex`](https://pypi.org/project/grantex/)) -- production-ready.
- **Go SDK** ([`grantex-go`](https://pkg.go.dev/github.com/mishrasanjeev/grantex-go)) -- production-ready.
- **8 framework integrations** -- [LangChain](https://www.npmjs.com/package/@grantex/langchain), [AutoGen](https://www.npmjs.com/package/@grantex/autogen), [CrewAI](https://pypi.org/project/grantex-crewai/), [Vercel AI](https://www.npmjs.com/package/@grantex/vercel-ai), [OpenAI Agents SDK](https://pypi.org/project/grantex-openai-agents/), [Google ADK](https://pypi.org/project/grantex-adk/), an MCP server for Claude Desktop, and [Express.js](https://www.npmjs.com/package/@grantex/express) + [FastAPI](https://pypi.org/project/grantex-fastapi/) middleware.
- **CLI** ([`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli)) -- manage agents, grants, and tokens from your terminal.
- **Enterprise features** -- policy engine, SCIM/SSO, anomaly detection, compliance exports, and Stripe billing.
- **Full API Reference** with [interactive docs](https://grantex.mintlify.app/api-reference) and a [Postman collection](https://github.com/mishrasanjeev/grantex/blob/main/docs/grantex.postman_collection.json).

## Get Started

Install the SDK:

```bash
npm install @grantex/sdk        # TypeScript / Node.js
pip install grantex             # Python
go get github.com/mishrasanjeev/grantex-go  # Go
npm install -g @grantex/cli     # CLI
```

Then pick your path:

- [Quickstart guide](https://grantex.dev/docs/quickstart) -- up and running in under 5 minutes.
- [Sign up for a free account](https://grantex.dev/dashboard/signup) -- get your API key.
- [GitHub repository](https://github.com/mishrasanjeev/grantex) -- star, fork, contribute.
- [Full documentation](https://grantex.dev/docs) -- guides, SDK reference, examples.
- [API Reference](https://grantex.mintlify.app/api-reference) -- all 56 endpoints with schemas.
- [Protocol specification](https://grantex.dev/docs/protocol/specification) -- the full v1.0 spec.
- [Homepage](https://grantex.dev) -- project overview.

We believe that as agents become more capable, proper authorization becomes more critical, not less. Grantex is our answer to that challenge.

---

*Grantex is open source (Apache 2.0). If you're building agent systems and care about authorization, we'd love your feedback -- [open an issue](https://github.com/mishrasanjeev/grantex/issues) or [star the repo](https://github.com/mishrasanjeev/grantex).*
