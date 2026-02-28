<div align="center">

# Grantex

### Delegated Authorization Protocol for AI Agents

**The open standard for granting, scoping, revoking, and auditing AI agent permissions —**
**what OAuth 2.0 is to humans, Grantex is to agents.**

<br/>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Spec Version](https://img.shields.io/badge/spec-v1.0--final-green)](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
[![GitHub Stars](https://img.shields.io/github/stars/mishrasanjeev/grantex?style=social)](https://github.com/mishrasanjeev/grantex)

<br/>

> **Status:** Production-ready. Protocol spec finalized (v1.0), auth service, TypeScript & Python SDKs, framework integrations (LangChain, AutoGen, CrewAI, Vercel AI), CLI, developer portal, and enterprise features (policies, anomaly detection, compliance exports) — all shipped.

```bash
npm install @grantex/sdk        # TypeScript / Node.js
pip install grantex             # Python
npm install -g @grantex/cli     # CLI
```

</div>

---

## The Problem

AI agents are acting in the world — booking travel, sending emails, executing trades, managing files — on behalf of real humans. But the foundational trust infrastructure for this doesn't exist yet:

- ❌ No standard way to grant an agent **scoped, time-limited permissions** on your behalf
- ❌ Services can't verify whether an agent is **genuinely authorized** by the claimed human
- ❌ No **auditable, tamper-proof record** of what an agent did, when, and under whose authority
- ❌ Multi-agent pipelines have no way to **chain authorization** — a sub-agent can't prove it was legitimately spawned

This is exactly where the internet was before OAuth 2.0. **Someone needs to build the standard. That's Grantex.**

---

## How It Works

Grantex introduces three primitives:

```
┌─────────────────────────────────────────────────────────────────┐
│                         GRANTEX PROTOCOL                        │
├───────────────────┬─────────────────────┬───────────────────────┤
│   Agent Identity  │   Delegated Grant   │     Audit Trail       │
│                   │                     │                       │
│  Cryptographic    │  Human-approved,    │  Append-only,         │
│  DID / JWT for    │  scoped, revocable  │  hash-chained log     │
│  every agent      │  permission tokens  │  of every action      │
└───────────────────┴─────────────────────┴───────────────────────┘
```

**The flow in 30 seconds:**

```
  Developer registers agent → declares required scopes
          │
          ▼
  Agent requests authorization from end-user
          │
          ▼
  User approves via Grantex consent UI (scoped, time-limited)
          │
          ▼
  Grantex issues signed Grant Token (RS256 JWT + custom claims)
          │
          ▼
  Agent presents token to any service → service verifies locally via JWKS
          │
          ▼
  Every action logged to immutable audit trail
          │
          ▼
  User can revoke any grant at any time → effective in < 1 second
```

---

## Quickstart

### 1. Register your agent

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const agent = await grantex.agents.register({
  name: 'travel-booker',
  description: 'Books flights and hotels on behalf of users',
  scopes: ['calendar:read', 'payments:initiate:max_500', 'email:send'],
});

console.log(agent.did);
// → did:grantex:ag_01HXYZ123abc...
```

### 2. Request authorization from a user

```typescript
const authRequest = await grantex.authorize({
  agentId: agent.id,
  userId: 'user_abc123',       // your app's user identifier
  scopes: ['calendar:read', 'payments:initiate:max_500'],
  expiresIn: '24h',
  redirectUri: 'https://yourapp.com/auth/callback',
});

// Redirect user to authRequest.consentUrl
// Grantex handles the consent UI — plain language, mobile-first
console.log(authRequest.consentUrl);
// → https://consent.grantex.dev/authorize?req=eyJ...
```

### 3. Exchange the authorization code for a grant token

```typescript
// After user approves, your redirectUri receives a `code`.
// Exchange it for a signed grant token (RS256 JWT):
const token = await grantex.tokens.exchange({
  code,                  // from the redirect callback
  agentId: agent.id,
});

console.log(token.grantToken);  // RS256 JWT — pass this to your agent
console.log(token.scopes);      // ['calendar:read', 'payments:initiate:max_500']
console.log(token.grantId);     // 'grnt_01HXYZ...'
```

### 4. Verify the token and use it

```typescript
// Verify offline — no network call needed (uses published JWKS)
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken(token.grantToken, {
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
  requiredScopes: ['calendar:read'],
});
console.log(grant.principalId); // 'user_abc123'
console.log(grant.scopes);     // ['calendar:read', 'payments:initiate:max_500']

// Pass to your agent — it's now authorized
await travelAgent.run({ grantToken: token.grantToken, task: 'Book cheapest flight to Delhi on March 1' });
```

### 5. Log every action

```typescript
// Inside your agent — one line, zero overhead
await grantex.audit.log({
  agentId: agent.id,
  grantId: token.grantId,
  action: 'payment.initiated',
  status: 'success',
  metadata: { amount: 420, currency: 'USD', merchant: 'Air India' },
});
```

### 6. Verify a token (service-side)

```typescript
// In any service that receives agent requests — no Grantex account needed
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken(token, {
  jwksUri: 'https://grantex.dev/.well-known/jwks.json',  // or cache locally
  requiredScopes: ['payments:initiate'],
});
// Throws if token is expired, revoked, tampered, or missing required scopes
```

---

## Python SDK

```python
from grantex import Grantex, ExchangeTokenParams

client = Grantex(api_key=os.environ["GRANTEX_API_KEY"])

# Register agent
agent = client.agents.register(
    name="finance-agent",
    scopes=["transactions:read", "payments:initiate:max_100"],
)

# Authorize a user
auth = client.authorize(
    agent_id=agent.id,
    user_id="user_abc123",
    scopes=["transactions:read", "payments:initiate:max_100"],
)
# Redirect user to auth.consent_url — they approve in plain language

# Exchange the authorization code for a grant token
token = client.tokens.exchange(ExchangeTokenParams(code=code, agent_id=agent.id))

# Verify the token offline — no network call needed
from grantex import verify_grant_token, VerifyGrantTokenOptions

grant = verify_grant_token(token.grant_token, VerifyGrantTokenOptions(
    jwks_uri="https://api.grantex.dev/.well-known/jwks.json",
))
print(grant.scopes)  # ('transactions:read', 'payments:initiate:max_100')

# Log an action
client.audit.log(
    agent_id=agent.id,
    grant_id=token.grant_id,
    action="transaction.read",
    status="success",
    metadata={"account_last4": "4242"},
)
```

---

## The Grant Token

Grantex tokens are standard JWTs (RS256) extended with agent-specific claims. Any service can verify them offline using the published JWKS — no dependency on Grantex at runtime:

```json
{
  "iss": "https://grantex.dev",
  "sub": "user_abc123",
  "agt": "did:grantex:ag_01HXYZ123abc",
  "dev": "org_yourcompany",
  "scp": ["calendar:read", "payments:initiate:max_500"],
  "iat": 1709000000,
  "exp": 1709086400,
  "jti": "tok_01HXYZ987xyz",
  "grnt": "grnt_01HXYZ456def"
}
```

| Claim | Meaning |
|-------|---------|
| `sub` | The end-user who authorized this agent |
| `agt` | The agent's DID — cryptographically verifiable identity |
| `dev` | The developer org that built the agent |
| `scp` | Exact scopes granted — services should check these |
| `jti` | Unique token ID — used for real-time revocation |
| `grnt` | Grant record ID — links token to the persisted grant |
| `aud` | Intended audience (optional) — services should reject tokens with a mismatched `aud` |

**Delegation claims** (present on sub-agent tokens):

| Claim | Meaning |
|-------|---------|
| `parentAgt` | DID of the parent agent that spawned this sub-agent |
| `parentGrnt` | Grant ID of the parent grant — full delegation chain is traceable |
| `delegationDepth` | How many hops from the root grant (root = 0) |

---

## Multi-Agent Delegation

Grantex supports multi-agent pipelines where a root agent spawns sub-agents with narrower scopes. Sub-agent tokens carry a full delegation chain that any service can inspect.

```typescript
// Root agent has a grant for ['calendar:read', 'calendar:write', 'email:send']
// It spawns a sub-agent that only needs calendar read access

const delegated = await grantex.grants.delegate({
  parentGrantToken: rootGrantToken,   // root agent's token
  subAgentId: subAgent.id,            // sub-agent to authorize
  scopes: ['calendar:read'],          // must be ⊆ parent scopes
  expiresIn: '1h',                    // capped at parent token's expiry
});

// delegated.grantToken is a fully signed JWT with:
//   parentAgt, parentGrnt, delegationDepth = 1
```

```python
# Python equivalent
delegated = grantex.grants.delegate(
    parent_grant_token=root_grant_token,
    sub_agent_id=sub_agent.id,
    scopes=["calendar:read"],
    expires_in="1h",
)
```

**Constraints enforced by the protocol:**
- Sub-agent scopes must be a strict subset of the parent's scopes — scope escalation is rejected with 400
- Sub-agent token expiry is `min(parent expiry, requested expiry)` — sub-agents can never outlive their parent
- Revoking a root grant cascades to all descendant grants atomically

---

## Local Development

Start the full stack with one command:

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex
docker compose up --build
```

Two API keys are seeded automatically:

| Key | Mode | Use for |
|-----|------|---------|
| `dev-api-key-local` | live | full consent flow with redirect |
| `sandbox-api-key-local` | sandbox | skip consent UI — get a `code` immediately |

**Sandbox mode** is designed for testing. With a sandbox key, `POST /v1/authorize` returns a `code` in the response body — no redirect required:

```bash
# Authorize + get code in one step
curl -s -X POST http://localhost:3001/v1/authorize \
  -H "Authorization: Bearer sandbox-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"<id>","principalId":"test-user","scopes":["calendar:read"]}'
# → { ..., "sandbox": true, "code": "01J..." }

# Exchange immediately for a grant token
curl -s -X POST http://localhost:3001/v1/token \
  -H "Authorization: Bearer sandbox-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"code":"<code>","agentId":"<id>"}'
```

**Developer portal** is available at [grantex.dev/dashboard](https://grantex.dev/dashboard) — sign up or enter an API key to manage agents, grants, policies, anomalies, compliance exports, and billing from the browser.

For local development, the auth service also serves a lightweight dashboard at `http://localhost:3001/dashboard`.

See the [self-hosting guide](https://grantex.dev/docs/guides/self-hosting) for production deployment guidance.

---

## Why an Open Standard?

Grantex is built as an **open protocol**, not a closed SaaS product. Here's why that matters:

**Model-neutral.** Works with OpenAI, Anthropic, Google, Llama, Mistral — any model, any framework. No single AI provider can credibly own the authorization layer for their competitors' agents.

**Framework-native.** First-class integrations for LangChain, AutoGen, CrewAI, and plain code. Install one package, get Grantex in your existing stack.

**Offline-verifiable.** Services verify tokens using published JWKS — zero runtime dependency on Grantex infrastructure. Your agent works even if our servers are down.

**Compliance-ready.** The EU AI Act, GDPR, and emerging US AI regulations will mandate auditable agent actions. Grantex gives you that on day one.

---

## Scope Naming Convention

Grantex defines a standard scope format: `resource:action[:constraint]`

| Scope | Meaning |
|-------|---------|
| `calendar:read` | Read calendar events |
| `calendar:write` | Create and modify events |
| `email:send` | Send emails on user's behalf |
| `payments:initiate:max_500` | Initiate payments up to $500 |
| `files:read` | Read user files |
| `profile:read` | Read user profile |

Service providers implement scope definitions for their APIs. Agents declare which scopes they need. Users see plain-language descriptions, never raw scope strings.

---

## Integrations

| Framework | Package | Install | Status |
|-----------|---------|---------|--------|
| **LangChain** | `@grantex/langchain` | `npm install @grantex/langchain` | ✅ Shipped |
| **AutoGen / OpenAI** | `@grantex/autogen` | `npm install @grantex/autogen` | ✅ Shipped |
| **CrewAI** | `grantex-crewai` | `pip install grantex-crewai` | ✅ Shipped |
| **OpenAI Agents SDK** | `grantex-openai-agents` | `pip install grantex-openai-agents` | ✅ Shipped |
| **Google ADK** | `grantex-adk` | `pip install grantex-adk` | ✅ Shipped |
| **Vercel AI SDK** | `@grantex/vercel-ai` | `npm install @grantex/vercel-ai` | ✅ Shipped |
| **TypeScript SDK** | `@grantex/sdk` | `npm install @grantex/sdk` | ✅ Shipped |
| **Python SDK** | `grantex` | `pip install grantex` | ✅ Shipped |
| **CLI** | `@grantex/cli` | `npm install -g @grantex/cli` | ✅ Shipped |

### Framework Quick Examples

**LangChain** — scope-enforced tools + audit callbacks:

```typescript
import { createGrantexTool } from '@grantex/langchain';

const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  grantToken,
  requiredScope: 'calendar:read',
  func: async (input) => JSON.stringify(await getCalendarEvents(input)),
});
// Use with any LangChain agent — scope checked offline from JWT
```

**Vercel AI SDK** — scope checked at construction time:

```typescript
import { createGrantexTool } from '@grantex/vercel-ai';
import { z } from 'zod';

const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: z.object({ date: z.string() }),
  grantToken,
  requiredScope: 'calendar:read',
  execute: async (args) => await getCalendarEvents(args.date),
});
// Use with generateText, streamText, etc.
```

**AutoGen / OpenAI function calling**:

```typescript
import { createGrantexFunction, GrantexFunctionRegistry } from '@grantex/autogen';

const fn = createGrantexFunction({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
  grantToken,
  requiredScope: 'calendar:read',
  func: async (args) => await getCalendarEvents(args.date),
});

// Pass fn.definition to OpenAI, call fn.execute() when selected
```

**CrewAI** (Python):

```python
from grantex_crewai import GrantexTool

tool = GrantexTool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Use with any CrewAI agent
```

**OpenAI Agents SDK** (Python):

```python
from grantex_openai_agents import create_grantex_tool

tool = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Returns a FunctionTool — use with any OpenAI Agents SDK agent
```

**Google ADK** (Python):

```python
from grantex_adk import create_grantex_tool

read_calendar = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
# Returns a plain function — pass directly to google.adk.Agent(tools=[...])
```

**CLI**:

```bash
grantex config set --url https://grantex-auth-dd4mtrt2gq-uc.a.run.app --key YOUR_API_KEY
grantex agents list
grantex grants list --status active
grantex audit list --since 2026-01-01
grantex anomalies detect
grantex compliance summary
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         YOUR APPLICATION                             │
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐ │
│   │  AI Agent    │    │  Grantex SDK │    │  End User Dashboard   │ │
│   │  (any model) │◄──►│  (2 lines)   │    │  (view / revoke)      │ │
│   └──────────────┘    └──────┬───────┘    └───────────────────────┘ │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         GRANTEX PROTOCOL                             │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────┐  │
│  │  Identity   │  │     Auth     │  │   Consent   │  │  Audit   │  │
│  │  Service    │  │   Service    │  │     UI      │  │  Chain   │  │
│  │  (DID/JWKS) │  │ (token i/o)  │  │  (hosted)   │  │ (append) │  │
│  └─────────────┘  └──────────────┘  └─────────────┘  └──────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                ┌──────────────────────────┐
                │  Any Service / API       │
                │  Verifies via JWKS       │
                │  No Grantex dep needed   │
                └──────────────────────────┘
```

---

## Roadmap

All milestones through v1.0 are complete. See [ROADMAP.md](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md) for full details.

| Milestone | Highlights | Status |
|-----------|-----------|--------|
| **v0.1 — Foundation** | Protocol spec, TypeScript & Python SDKs, auth service, consent UI, audit trail, multi-agent delegation, sandbox mode | ✅ Complete |
| **v0.2 — Integrations** | LangChain, AutoGen, webhooks, Stripe billing, CLI | ✅ Complete |
| **v0.3 — Enterprise** | CrewAI, Vercel AI, compliance exports, policy engine, SCIM/SSO, anomaly detection | ✅ Complete |
| **v1.0 — Stable Protocol** | Protocol spec finalized (v1.0), security audit, SOC2, standards submission | ✅ Complete |

---

## Contributing

Grantex is open-source and welcomes contributions:

1. **Report bugs** — open a [GitHub Issue](https://github.com/mishrasanjeev/grantex/issues) with reproduction steps
2. **Propose features** — open a [GitHub Discussion](https://github.com/mishrasanjeev/grantex/discussions) with your use case
3. **Build new integrations** — add Grantex support to your favorite framework
4. **Improve docs** — better examples, tutorials, and translations

Read [CONTRIBUTING.md](https://github.com/mishrasanjeev/grantex/blob/main/CONTRIBUTING.md) before submitting a PR.

---

## FAQ

**Is this just another auth library?**  
No. Existing auth systems (Auth0, Okta, Supabase) are built for humans logging in. Grantex is built for autonomous agents acting on behalf of humans — a fundamentally different trust model with different primitives (delegation, scope chains, agent identity, real-time revocation, action audit trails).

**Why not just use OAuth 2.0?**  
OAuth 2.0 was designed for "user grants app permission to access their data." Agents introduce new requirements: the agent needs a verifiable identity separate from its creator, grants need to be chainable across multi-agent pipelines, and every autonomous action must be attributable and auditable. We extend OAuth 2.0 concepts but add the agent-specific primitives it lacks.

**What about MCP (Model Context Protocol)?**  
MCP solves tool connectivity — how agents access data and call functions. Grantex solves trust — proving that an agent is authorized to use those tools on behalf of a specific human. They're complementary. A Grantex-authorized agent uses MCP tools.

**Who owns the standard?**  
The protocol spec is open (Apache 2.0). Grantex Inc. maintains a hosted reference implementation. Our goal is to contribute the spec to a neutral standards body (W3C, IETF, or CNCF) once it stabilizes.

**Can I self-host?**  
Yes. The reference implementation is fully open-source. Docker Compose deploy in one command. See the [self-hosting guide](https://grantex.dev/docs/guides/self-hosting).

---

## License

Protocol specification and SDKs: [Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

---

<div align="center">

**[Docs](https://grantex.dev/docs)** · **[Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)** · **[Dashboard](https://grantex.dev/dashboard)** · **[Self-Hosting](https://grantex.dev/docs/guides/self-hosting)** · **[Roadmap](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md)** · **[Contributing](https://grantex.dev/docs/community/contributing)** · **[GitHub](https://github.com/mishrasanjeev/grantex)**

<br/>

*Building the trust layer for the agentic internet.*

</div>
