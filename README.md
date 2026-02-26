<div align="center">

# Grantex

### Delegated Authorization Protocol for AI Agents

**The open standard for granting, scoping, revoking, and auditing AI agent permissions —**
**what OAuth 2.0 is to humans, Grantex is to agents.**

<br/>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Spec Version](https://img.shields.io/badge/spec-v0.1--draft-orange)](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
[![GitHub Stars](https://img.shields.io/github/stars/mishrasanjeev/grantex?style=social)](https://github.com/mishrasanjeev/grantex)

<br/>

> **Status:** v0.1 complete — protocol spec, auth service, both SDKs, multi-agent delegation, sandbox mode, and developer dashboard are all shipped. Not yet production-ready — hosted cloud and framework integrations are next.

```bash
npm install @grantex/sdk        # TypeScript / Node.js
pip install grantex             # Python
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

### 3. Use the grant token

```typescript
// After user approves, Grantex calls your redirectUri with a grant token
const { grantToken } = req.query;

// Verify it locally — no network call needed
const grant = await grantex.grants.verify(grantToken);
console.log(grant.scopes);
// → ['calendar:read', 'payments:initiate:max_500']

// Pass to your agent — it's now authorized
await travelAgent.run({ grantToken, task: 'Book cheapest flight to Delhi on March 1' });
```

### 4. Log every action

```typescript
// Inside your agent — one line, zero overhead
await grantex.audit.log({
  agentId: agent.id,
  grantId: grant.grantId,
  action: 'payment.initiated',
  status: 'success',
  metadata: { amount: 420, currency: 'USD', merchant: 'Air India' },
});
```

### 5. Verify a token (service-side)

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
from grantex import Grantex

grantex = Grantex(api_key=os.environ["GRANTEX_API_KEY"])

# Register agent
agent = grantex.agents.register(
    name="finance-agent",
    scopes=["transactions:read", "payments:initiate:max_100"],
)

# Verify incoming grant token
grant = grantex.grants.verify(token)

# Log an action
grantex.audit.log(
    agent_id=agent.id,
    grant_id=grant.grant_id,
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

**Developer dashboard** is available at [`http://localhost:3001/dashboard`](http://localhost:3001/dashboard) — enter either API key to browse your agents, grants, and audit log, and revoke grants directly from the UI.

See [docs/self-hosting.md](https://github.com/mishrasanjeev/grantex/blob/main/docs/self-hosting.md) for production deployment guidance.

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

| Framework | Package | Status |
|-----------|---------|--------|
| LangChain | `@grantex/langchain` | 🚧 In progress |
| AutoGen | `@grantex/autogen` | 🚧 In progress |
| CrewAI | `grantex-crewai` | 📋 Planned |
| Vercel AI SDK | `@grantex/vercel-ai` | 📋 Planned |
| Plain TypeScript | `@grantex/sdk` | ✅ Available |
| Plain Python | `grantex` | ✅ Available |

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

**v0.1 — Foundation** ✅ *Complete*
- [x] Protocol specification draft
- [x] TypeScript SDK
- [x] Python SDK
- [x] Auth service (token issuance + verification + revocation)
- [x] Identity service (DID generation + JWKS)
- [x] Hosted consent UI
- [x] Audit trail (hash-chained append-only log)
- [x] Multi-agent delegation (scope-subset enforcement + cascade revocation)
- [x] Sandbox mode (auto-approve consent for testing)
- [x] Developer dashboard (agents, grants, audit log, revoke)

**v0.2 — Integrations** *(current)*
- [ ] LangChain integration
- [ ] AutoGen integration
- [ ] End-user permission dashboard
- [ ] Webhook event delivery

**v0.3 — Enterprise**
- [ ] CrewAI integration
- [ ] Enterprise compliance dashboard + exports
- [ ] Policy engine (auto-approve / auto-deny rules)

**v1.0 — Stable Protocol**
- [ ] Protocol specification finalized
- [ ] Security audit
- [ ] SOC2 Type I

See [ROADMAP.md](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md) for full details and RFC discussions.

---

## Contributing

Grantex is in active early development. The best way to contribute right now:

1. **Join the discussion** — open a [GitHub Discussion](https://github.com/mishrasanjeev/grantex/discussions) with your use case or feedback
2. **Review the spec** — see [SPEC.md](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md) and open issues for gaps or disagreements
3. **Build an integration** — framework integrations are the highest-leverage contribution
4. **Spread the word** — star the repo, share with developers building agents

Read [CONTRIBUTING.md](https://github.com/mishrasanjeev/grantex/blob/main/CONTRIBUTING.md) before submitting a PR.

---

## Design Partners

We're looking for **3–5 companies actively deploying AI agents** to shape the v0.2 roadmap as design partners. You get:

- Direct influence on protocol design
- Early access to hosted Grantex cloud
- 12 months free on any paid tier

→ **[Apply to be a design partner](mailto:design@grantex.dev)**

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
Yes. The reference implementation is fully open-source. Docker Compose deploy in one command. See [docs/self-hosting.md](https://github.com/mishrasanjeev/grantex/blob/main/docs/self-hosting.md).

---

## License

Protocol specification and SDKs: [Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

---

<div align="center">

**[Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)** · **[Roadmap](https://github.com/mishrasanjeev/grantex/blob/main/ROADMAP.md)** · **[Contributing](https://github.com/mishrasanjeev/grantex/blob/main/CONTRIBUTING.md)** · **[GitHub](https://github.com/mishrasanjeev/grantex)**

<br/>

*Building the trust layer for the agentic internet.*

</div>
