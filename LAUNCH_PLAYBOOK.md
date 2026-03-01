# Grantex — Product Hunt Launch Playbook

Complete launch plan for Grantex on Product Hunt, with copy-paste ready listing content, a pre-launch checklist, hour-by-hour launch day timeline, community outreach targets, and post-launch follow-up.

**Companion files:**
- [`LAUNCH_POSTS.md`](LAUNCH_POSTS.md) — HN, Reddit (3 subs), Twitter thread, LinkedIn post
- [`DEVTO_ARTICLE.md`](DEVTO_ARTICLE.md) — Full Dev.to blog post
- [`web/ph-gallery.html`](web/ph-gallery.html) — 6 gallery slides (1270x760px)
- [`scripts/screenshot-gallery.mjs`](scripts/screenshot-gallery.mjs) — Playwright script to generate gallery PNGs
- [`web/og-image.png`](web/og-image.png) — OG social card

---

## A. Product Hunt Listing Content

Everything below is copy-paste ready for the Product Hunt submission form.

### Product Name

```
Grantex
```

### Tagline (60 char max)

```
OAuth 2.0 for AI agents — scoped, revocable, auditable
```

> 55 characters. PH limit is 60.

### Short Description (260 char max)

```
Open authorization protocol for AI agents. Scoped, human-approved, revocable permissions via signed JWTs — not all-or-nothing API keys. SDKs for TypeScript, Python, Go. 8 integrations: LangChain, CrewAI, AutoGen, Vercel AI, OpenAI Agents, Google ADK, MCP.
```

> 257 characters. PH limit is 260.

### Full Description (Markdown)

```markdown
## The Problem

AI agents book flights, send emails, and move money on your behalf. Most run on all-or-nothing API keys — no scoping, no audit trail, no revocation. This is where the web was before OAuth 2.0.

## What is Grantex?

Grantex is an **open protocol** (Apache 2.0) for delegated authorization of AI agents. The core idea:

1. A human approves a **scoped, time-limited grant** for an agent
2. The agent receives a **signed JWT** it can present to any service
3. Services **verify offline** via JWKS — no Grantex account needed
4. Every action is logged in an **append-only, hash-chained audit trail**
5. The human can **revoke access instantly** — effective in < 1 second

## What's Different from OAuth 2.0?

- **Agent identity** — every agent gets a cryptographic DID, not borrowed user credentials
- **Delegation chains** — parent agents delegate narrower grants to sub-agents, with depth tracking
- **Action-level auditing** — append-only, hash-chained log of every action
- **Real-time revocation** — kill a misbehaving agent's access in < 1 second

## What Ships Today

- **Protocol spec v1.0** (final, frozen)
- **3 SDKs**: TypeScript, Python, Go
- **8 framework integrations**: LangChain, AutoGen, CrewAI, Vercel AI SDK, OpenAI Agents SDK, Google ADK, MCP server, Express.js + FastAPI middleware
- **CLI** for managing agents, grants, and tokens
- **Developer portal** with interactive playground
- **Enterprise features**: policy engine, SCIM/SSO, anomaly detection, compliance exports
- **Conformance test suite** for verifying spec compliance
- **End-user permission dashboard** — users view and revoke agent access

## Get Started in 10 Lines

```typescript
import { Grantex } from '@grantex/sdk';

const gx = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });
const agent = await gx.agents.register({ name: 'travel-agent', scopes: ['flights:book'] });
const auth = await gx.authorize({ agentId: agent.id, userId: 'user_alice', scopes: ['flights:book'] });
// user approves at auth.consentUrl
const token = await gx.tokens.exchange({ code, agentId: agent.id });
// agent now has a signed JWT — any service can verify it offline
```

## Install

```
npm install @grantex/sdk        # TypeScript / Node.js
pip install grantex             # Python
go get github.com/mishrasanjeev/grantex-go  # Go
```

**Open source. Apache 2.0. No vendor lock-in.**
```

### Topics

Select these in the PH submission form:

1. AI
2. Developer Tools
3. Open Source
4. Security
5. APIs

### Maker's First Comment

Post this as the first comment immediately after the listing goes live (or schedule it):

```
Hey Product Hunt! 👋

I built Grantex because I got nervous watching agents operate with all-or-nothing API keys.

I've been building in the AI agent space for a while, and every time I connected an agent to a real service — calendar, email, payments — I'd think: "this agent has way more access than it needs, and if something goes wrong, I'll have no idea what happened."

OAuth 2.0 solved this for apps 15 years ago. But agents aren't apps — they spawn sub-agents, operate autonomously, and chain actions across services. OAuth was never designed for that.

So I built Grantex from scratch. The protocol spec is public and frozen at v1.0. The key ideas:

→ Agents get their own cryptographic identity (DID), not borrowed user credentials
→ Users approve scoped, time-limited grants via a consent UI
→ Agents receive signed JWTs — any service verifies offline via JWKS
→ Parent agents can delegate narrower grants to sub-agents
→ Every action is logged in an append-only, hash-chained audit trail
→ Revocation takes effect in < 1 second

Today we're shipping SDKs for TypeScript, Python, and Go, plus integrations for every major agent framework (LangChain, CrewAI, AutoGen, Vercel AI, OpenAI Agents SDK, Google ADK, MCP).

The quickstart takes about 10 lines of code — sign up for a free account, install the SDK, and you have a working authorization flow in under 5 minutes.

I'd love to hear:
- How are you currently handling permissions for your agents?
- What scopes would be most useful for your use case?
- Anything in the protocol design you'd push back on?

Everything is open source (Apache 2.0). Happy to answer any questions about the protocol, security model, or implementation!
```

### Links for the PH Listing

| Field | URL |
|-------|-----|
| Website | `https://grantex.dev` |
| GitHub | `https://github.com/mishrasanjeev/grantex` |
| Docs | `https://grantex.dev/docs` |
| Sign up | `https://grantex.dev/dashboard/signup` |
| API Reference | `https://grantex.mintlify.app/api-reference` |
| Playground | `https://grantex.dev/playground` |

### Gallery Images

Screenshot the 6 slides from `web/ph-gallery.html` at 1270x760px:

1. **Hero** — "OAuth 2.0 for AI Agents" tagline with protocol overview
2. **The Problem** — API key vs. scoped grant comparison
3. **How It Works** — 7-step protocol flow diagram
4. **Code** — TypeScript quickstart (10 lines)
5. **Integrations** — Framework grid (LangChain, CrewAI, etc.)
6. **Enterprise** — Policies, SCIM/SSO, anomaly detection, compliance

**How to screenshot (automated):**
```bash
npx playwright install chromium
node scripts/screenshot-gallery.mjs
```

Output: 6 PNGs in `web/ph-gallery/` (gitignored, ~130–250 KB each).

**Manual alternative:** Open `web/ph-gallery.html` in Chrome → DevTools → device toolbar → 1270x760 → right-click each `.slide` → "Capture node screenshot".

### Logo

Upload a 240x240px version of the Grantex logo. Use the icon from `web/index.html` (the shield/key icon) or export from Figma.

---

## B. Pre-Launch Checklist (T-7 to T-1)

### T-7: Technical Readiness

- [x] Verify auth service is up and responding: `curl https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health` → **200 OK**
- [x] Verify all links in the PH listing work (homepage, docs, signup, playground, GitHub) → **all resolve**
- [ ] Test the full signup flow: sign up → create developer account → get API key
- [ ] Test the full onboarding flow: create agent → authorize → approve consent → exchange token → verify token
- [x] Run conformance suite against production → **39/39 tests passed**
- [ ] Verify playground works end-to-end with a fresh API key
- [x] Check npm/PyPI/Go packages install correctly → **npm 0.1.5, PyPI 0.1.5, Go 0.1.0**
- [x] JWKS endpoint live with RS256 key → **verified**
- [ ] Review error pages and rate limit responses
- [x] Resolve all Dependabot vulnerabilities → **0 open alerts**
- [x] Resolve all CodeQL security alerts → **0 open alerts** (3 fixed, 25 dismissed as false positive)

### T-5: Listing Preparation

- [x] Screenshot gallery images from `web/ph-gallery.html` → **6 PNGs generated via `scripts/screenshot-gallery.mjs`**
- [ ] Prepare 240x240px logo
- [ ] Create PH draft listing with all content from Section A
- [ ] Upload gallery images, logo, tagline, descriptions
- [ ] Set Product Hunt topics (AI, Developer Tools, Open Source, Security, APIs)
- [ ] Add all team members as makers
- [ ] Preview listing — have 2-3 people review for typos and clarity

### T-3: Scheduling and Recruitment

- [ ] Schedule launch date: **Tuesday or Wednesday, 12:01 AM PT** (highest traffic days)
- [ ] Reach out to potential hunters (if using a hunter — optional, makers can self-launch)
- [ ] Send preview link to 10-20 supporters, ask them to upvote + leave genuine comments on launch day
- [ ] Do NOT ask people to upvote — PH detects and penalizes vote rings. Ask them to "check it out and leave feedback if they find it useful"

### T-2: Content Preparation

- [x] Finalize all social posts (review `LAUNCH_POSTS.md`) → **6 platforms ready**
- [x] Finalize Dev.to article (review `DEVTO_ARTICLE.md`) → **180 lines, ready**
- [x] Draft LinkedIn post → **Section 7 in `LAUNCH_POSTS.md`, 2166 chars**
- [x] Prepare HN Show HN submission → **Section 1 in `LAUNCH_POSTS.md`**
- [ ] Queue tweets in a scheduler (or prepare to post manually)

### T-1: Final Checks

- [ ] Recheck all links one more time
- [ ] Verify auth service uptime and error rates look clean
- [ ] Recheck PH draft listing — preview mode
- [ ] Set alarm for 12:01 AM PT (launch time)
- [ ] Prepare to be online and responsive for at least the first 12 hours
- [ ] Have the maker's first comment ready to paste (Section A above)

---

## C. Launch Day Timeline (T+0)

All times Pacific (PT). Product Hunt day resets at 12:01 AM PT.

| Time (PT) | Action | Details |
|-----------|--------|---------|
| **12:01 AM** | PH listing goes live | Confirm it's visible on producthunt.com. Share link with close supporters. |
| **6:00 AM** | Post maker's first comment | Paste the comment from Section A. This is the most important piece — it's pinned at the top. |
| **7:00 AM** | Twitter/X thread | Post the 6-tweet thread from `LAUNCH_POSTS.md`. Pin it. Include PH link in a reply. |
| **7:30 AM** | LinkedIn post | Post from Section 7 in `LAUNCH_POSTS.md`. Add PH link at bottom. |
| **8:00 AM** | Hacker News — Show HN | Post from `LAUNCH_POSTS.md`. Best time for HN is 8-10 AM ET (5-7 AM PT), but 8 AM PT still works. |
| **9:00 AM** | Dev.to article | Publish from `DEVTO_ARTICLE.md`. Add PH link at the top. |
| **10:00 AM** | Reddit r/programming | Post from `LAUNCH_POSTS.md`. Add PH link at bottom. |
| **11:00 AM** | Reddit r/MachineLearning | Post from `LAUNCH_POSTS.md`. Different angle — focus on agent safety. |
| **12:00 PM** | Reddit r/LocalLLaMA | Post from `LAUNCH_POSTS.md`. Most casual tone. |
| **All day** | Respond to comments | PH comments, HN comments, Reddit threads, tweets. Be genuine, helpful, and fast. |
| **All day** | Monitor systems | Watch auth service error rates, signup funnel, API latency. Be ready to hotfix. |
| **6:00 PM** | Check-in | Review PH ranking, upvote count, comment quality. Post a thank-you update on PH if traction is good. |
| **11:59 PM** | End of PH day | PH day closes. Final position determines badge (Top 1/5/10 of the day). |

### Launch Day Tips

- **Respond to every PH comment** within 30 minutes. PH algorithm weighs engagement.
- **Don't ask for upvotes.** PH actively detects and penalizes this. Ask people to "check it out."
- **Be authentic in comments.** Share technical details, acknowledge limitations, ask questions back.
- **If something breaks**, fix it fast and be transparent. Post an update on PH.
- **Track referral sources** — watch where signups are coming from (PH, HN, Reddit, Twitter, direct).

---

## D. Community Outreach Targets

### AI Agent Framework Communities

| Community | Where | Angle |
|-----------|-------|-------|
| **LangChain** | Discord, GitHub Discussions | "We built a LangChain integration for agent authorization" |
| **CrewAI** | Discord, GitHub | "Grantex + CrewAI: scoped permissions for crew agents" |
| **AutoGen** | Discord, GitHub | "Authorization layer for AutoGen multi-agent pipelines" |
| **OpenAI Agents SDK** | OpenAI community forum | "Grantex integration for OpenAI Agents SDK" |
| **Google ADK** | Google AI Discord | "Grant-based auth for ADK agents" |
| **Vercel AI** | Vercel Discord, GitHub | "Grantex tools for Vercel AI SDK" |
| **MCP** | Anthropic Discord | "MCP server for Grantex — 13 tools for Claude Desktop/Cursor" |

### Identity / Auth Communities

| Community | Where | Angle |
|-----------|-------|-------|
| **OAuth working group** | IETF mailing list | "New protocol for agent-specific delegated auth" |
| **Identity community** | Identiverse, Identity Week | "Extending OAuth for autonomous AI agents" |
| **CNCF / cloud-native** | Slack, Reddit | "Open-source agent authorization for cloud-native stacks" |

### Developer Communities

| Community | Where | Angle |
|-----------|-------|-------|
| **Indie Hackers** | Forum | "Launched an open protocol for AI agent auth" |
| **Dev.to** | Article (already prepared) | Technical deep-dive |
| **Hashnode** | Cross-post Dev.to article | Broader reach |
| **Lobsters** | Submission | Technical audience, similar to HN |

### Personal Network

- [ ] LinkedIn post — personal story + launch announcement
- [ ] Direct messages to 20-30 people who work in AI/auth/security
- [ ] Email to any newsletter editors who cover AI tools (The Batch, TLDR AI, Ben's Bites, AI Breakfast)
- [ ] Notify any early users or beta testers

### Newsletters to Pitch

| Newsletter | Focus | Contact |
|------------|-------|---------|
| TLDR AI | AI news | Submit via tldr.tech |
| Ben's Bites | AI tools | Submit via bensbites.co |
| The Batch | Andrew Ng's newsletter | Submit via deeplearning.ai |
| AI Breakfast | AI tools roundup | Submit via aibreakfast.com |
| Console.dev | Developer tools | Submit via console.dev |
| Changelog | Open source | Submit via changelog.com/news |

---

## E. Post-Launch (T+1 to T+7)

### T+1: Follow-Up

- [ ] Post thank-you on Twitter — tag supporters, share PH result
- [ ] Reply to any unanswered HN/Reddit/PH comments
- [ ] Check GitHub for new stars, issues, forks
- [ ] Check npm/PyPI/Go download stats
- [ ] Check signup metrics in the portal

### T+2 to T+3: Momentum

- [ ] Write a "Launch Day Retrospective" Twitter thread with numbers (signups, stars, upvotes)
- [ ] Follow up on any promising conversations from HN/Reddit
- [ ] Respond to GitHub issues promptly (< 24 hours)
- [ ] Cross-post Dev.to article to Hashnode and Medium (with canonical URL)
- [ ] Submit to newsletters that didn't cover launch day

### T+4 to T+7: Sustain

- [ ] Share user testimonials / interesting use cases on Twitter
- [ ] If featured in any newsletter, amplify it on social
- [ ] Track and share metrics: GitHub stars, npm downloads, signups
- [ ] Plan the next feature announcement to maintain momentum
- [ ] Consider a "Week 1 update" post on PH

### Metrics to Track

| Metric | Tool |
|--------|------|
| PH upvotes + ranking | Product Hunt dashboard |
| GitHub stars | GitHub insights |
| npm downloads | npmjs.com/package/@grantex/sdk |
| PyPI downloads | pypistats.org/packages/grantex |
| Go proxy hits | pkg.go.dev/github.com/mishrasanjeev/grantex-go |
| Signups | Firebase Analytics / portal |
| Auth service requests | Cloud Run metrics |
| Twitter impressions | Twitter analytics |
| Dev.to views/reactions | Dev.to dashboard |

---

## F. Incident Response Plan (Launch Day)

If things break under traffic, here is the escalation playbook.

### Severity Levels

| Level | Definition | Response Time | Example |
|-------|-----------|---------------|---------|
| **SEV-1** | Auth service is down, users cannot sign up or use the product | **Immediate** (drop everything) | Cloud Run crash, DB connection pool exhausted |
| **SEV-2** | Feature is broken but core flow works | **< 30 min** | Playground broken, consent page CSS broken, webhook delivery failing |
| **SEV-3** | Cosmetic or non-blocking issue | **< 2 hours** | Typo on landing page, wrong link in a social post, 404 on a docs page |

### SEV-1: Auth Service Down

1. Check Cloud Run logs: `gcloud run services logs read grantex-auth --project grantex-prod --limit 50`
2. Check Cloud Run status: `gcloud run services describe grantex-auth --project grantex-prod`
3. If OOM or crash loop — increase memory/CPU: `gcloud run services update grantex-auth --memory 1Gi --cpu 2`
4. If DB issue — check Cloud SQL connections and restart if needed
5. If Redis issue — check Memorystore instance status
6. **Communication**: Post on PH thread: "We're seeing elevated errors and are on it. Back shortly."
7. **Rollback**: `gcloud run services update-traffic grantex-auth --to-revisions=PREVIOUS_REVISION=100`

### SEV-2: Feature Broken

1. Identify the broken feature from error reports / monitoring
2. Hotfix on a branch, test locally, push to main → auto-deploys to Cloud Run
3. Monitor for 10 minutes after deploy
4. **Communication**: Reply to affected users individually if they reported the issue

### SEV-3: Cosmetic

1. Fix when you have a moment — don't interrupt SEV-1/2 response
2. For social post typos: delete and repost, or reply with correction

### Monitoring Commands (Launch Day)

```bash
# Auth service health
curl -s https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health | jq .

# Cloud Run request count and latency (last hour)
gcloud run services logs read grantex-auth --project grantex-prod --limit 100

# Check error rate in logs
gcloud logging read 'resource.type="cloud_run_revision" severity>=ERROR' --project grantex-prod --limit 20

# Conformance suite (quick smoke test)
cd packages/conformance && node dist/index.js \
  --base-url https://grantex-auth-dd4mtrt2gq-uc.a.run.app \
  --api-key $GRANTEX_API_KEY --bail

# Check npm download count (updates daily)
npm view @grantex/sdk --json | jq .dist-tags
```

---

## G. Newsletter / Email Outreach Templates

### Template 1: AI Newsletter Pitch (TLDR AI, Ben's Bites, AI Breakfast)

```
Subject: Open-source authorization protocol for AI agents — Grantex

Hi [Name],

I launched Grantex today — an open protocol (Apache 2.0) that gives AI agents
scoped, human-approved, revocable permissions instead of all-or-nothing API keys.

Think OAuth 2.0, redesigned for agents: cryptographic agent identity, delegation
chains for multi-agent pipelines, real-time revocation, and hash-chained audit
trails.

Ships with SDKs for TypeScript, Python, and Go, plus integrations for LangChain,
CrewAI, AutoGen, Vercel AI, OpenAI Agents SDK, Google ADK, and an MCP server.

Product Hunt: [PH link]
GitHub: https://github.com/mishrasanjeev/grantex
Docs: https://grantex.dev/docs

Would love to be included in your next edition. Happy to provide any details.

Thanks,
Sanjeev
```

### Template 2: Developer Tools Newsletter (Console.dev, Changelog)

```
Subject: Grantex — delegated auth for AI agents (JWT/JWKS, open protocol)

Hi [Name],

Grantex is a new open-source protocol for agent authorization. It extends the
OAuth 2.0 model with agent-specific primitives: DID-based identity, scope
delegation chains, action-level audit logging, and sub-second revocation.

Technical details:
- RS256 JWTs with agent/delegation claims, offline verification via JWKS
- Protocol spec v1.0 (frozen): https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md
- Auth service: Fastify + PostgreSQL + Redis on Cloud Run
- 39/39 conformance tests passing against production
- 3 SDKs (TS, Python, Go) + 8 framework integrations
- Apache 2.0

Product Hunt: [PH link]
GitHub: https://github.com/mishrasanjeev/grantex

Cheers,
Sanjeev
```

### Template 3: Direct Message to AI/Auth Contacts

```
Hey [Name]!

I just launched something I think you'd find interesting — Grantex, an open
authorization protocol for AI agents (think OAuth for agents).

I know you work on [agent systems / auth / security] so I'd really value
your perspective. No pressure to upvote or anything — just genuinely curious
what you think of the protocol design.

Product Hunt: [PH link]
GitHub: https://github.com/mishrasanjeev/grantex

Would love your honest feedback!
```

---

## H. Launch Day Operations Runbook

### Pre-Launch Verification (T-30 min)

Run this checklist 30 minutes before PH listing goes live:

```bash
# 1. Auth service health
curl -sf https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health | jq .status
# Expected: "ok"

# 2. JWKS endpoint
curl -sf https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json | jq '.keys | length'
# Expected: 1 (or more)

# 3. Homepage
curl -sf -o /dev/null -w "%{http_code}" https://grantex.dev
# Expected: 200

# 4. Docs redirect
curl -sf -o /dev/null -w "%{http_code}" https://grantex.dev/docs
# Expected: 302

# 5. Signup page
curl -sf -o /dev/null -w "%{http_code}" https://grantex.dev/dashboard/signup
# Expected: 200

# 6. npm package
npm view @grantex/sdk version
# Expected: 0.1.5

# 7. PyPI package
pip index versions grantex 2>&1 | head -1
# Expected: grantex (0.1.5)

# 8. Go module
curl -sf "https://proxy.golang.org/github.com/mishrasanjeev/grantex-go/@v/v0.1.0.info" | jq .Version
# Expected: "v0.1.0"

# 9. Conformance smoke test (optional — takes ~75 seconds)
cd packages/conformance && node dist/index.js \
  --base-url https://grantex-auth-dd4mtrt2gq-uc.a.run.app \
  --api-key $GRANTEX_API_KEY --bail
# Expected: 39 passed
```

### Hourly Health Check (Launch Day)

Every 2-3 hours during launch day, run:

```bash
curl -sf https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health | jq .
```

Watch for:
- Response time > 2s (normally ~300ms) → potential load issue
- Non-200 response → check Cloud Run logs immediately
- Database connection errors → check Cloud SQL connection limits

### Post-Launch Metrics Snapshot (T+24h)

Collect and record these numbers for the retrospective:

| Metric | Where to check | Value |
|--------|---------------|-------|
| PH upvotes | Product Hunt dashboard | |
| PH ranking | Product Hunt dashboard | |
| GitHub stars | github.com/mishrasanjeev/grantex | |
| npm downloads (7d) | npmjs.com/package/@grantex/sdk | |
| PyPI downloads (7d) | pypistats.org/packages/grantex | |
| Dev portal signups | Firebase Analytics | |
| Auth service requests (24h) | Cloud Run metrics | |
| HN points | news.ycombinator.com | |
| Twitter impressions | Twitter analytics | |
| Dev.to views | Dev.to dashboard | |
| Reddit upvotes (combined) | Reddit posts | |

---

## I. Competitive Positioning (FAQ / Objection Handling)

Common questions and how to answer them in PH comments, HN threads, and Reddit.

### "How is this different from OAuth 2.0?"

> OAuth was designed for human users clicking consent buttons. Grantex extends that model with agent-specific primitives: cryptographic agent identity (DID), delegation chains for multi-agent pipelines, action-level hash-chained audit trails, and sub-second revocation. If you know OAuth, Grantex will feel familiar — but it handles the cases OAuth was never designed for.

### "Why not just use OAuth scopes?"

> OAuth scopes are flat — a user grants scopes to an app, end of story. Agents delegate work to sub-agents. In Grantex, a parent agent can grant a narrower subset of its scopes to a child agent, with the delegation depth tracked in the JWT. Revoking the parent cascades to all children. OAuth has no concept of this.

### "Can't I just build this myself with JWTs?"

> You can build the token part yourself. But you'd also need: a consent flow, PKCE, refresh token rotation, hash-chained audit logging, delegation chain enforcement, a JWKS endpoint, revocation checking, rate limiting, anomaly detection, and conformance testing. Grantex provides all of this as an open protocol with production-ready SDKs.

### "Is this vendor lock-in? What if you shut down?"

> No lock-in. The protocol spec is public and frozen at v1.0 (Apache 2.0). Verification is offline via JWKS — services never talk to Grantex. You can run your own auth server. The conformance suite lets you verify any implementation against the spec.

### "Who is using this?"

> We just launched publicly today. The protocol spec is designed to be implemented independently — any team can build a conformant auth server. We've shipped SDKs and integrations for every major agent framework to make adoption easy.

### "How does this work with MCP / Claude / GPT?"

> We have an MCP server with 13 tools that works with Claude Desktop, Cursor, and Windsurf. For OpenAI, we have an Agents SDK integration. The protocol is framework-agnostic — any agent that can make HTTP requests can use Grantex.

---

## Quick Reference: All Links

| Resource | URL |
|----------|-----|
| Homepage | https://grantex.dev |
| GitHub | https://github.com/mishrasanjeev/grantex |
| Docs | https://grantex.dev/docs |
| API Reference | https://grantex.mintlify.app/api-reference |
| Sign up | https://grantex.dev/dashboard/signup |
| Playground | https://grantex.dev/playground |
| Protocol Spec | https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md |
| npm (TS SDK) | https://www.npmjs.com/package/@grantex/sdk |
| PyPI (Python SDK) | https://pypi.org/project/grantex/ |
| Go SDK | https://pkg.go.dev/github.com/mishrasanjeev/grantex-go |
| Postman Collection | https://github.com/mishrasanjeev/grantex/blob/main/docs/grantex.postman_collection.json |
| PH Gallery Source | `web/ph-gallery.html` (local, screenshot for upload) |
| OG Image | https://grantex.dev/og-image.png |
