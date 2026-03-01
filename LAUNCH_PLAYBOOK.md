# Grantex — Product Hunt Launch Playbook

Complete launch plan for Grantex on Product Hunt, with copy-paste ready listing content, a pre-launch checklist, hour-by-hour launch day timeline, community outreach targets, and post-launch follow-up.

**Companion files:**
- [`LAUNCH_POSTS.md`](LAUNCH_POSTS.md) — HN, Reddit (3 subs), Twitter thread posts
- [`DEVTO_ARTICLE.md`](DEVTO_ARTICLE.md) — Full Dev.to blog post
- [`web/ph-gallery.html`](web/ph-gallery.html) — 6 gallery slides (1270x760px)
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

**How to screenshot:**
1. Open `web/ph-gallery.html` in Chrome
2. Open DevTools → toggle device toolbar → set viewport to 1270x760
3. Right-click each slide → "Capture node screenshot" (or use full-page screenshot and crop)
4. Alternatively: `npx playwright screenshot --viewport-size=1270,760 web/ph-gallery.html`

### Logo

Upload a 240x240px version of the Grantex logo. Use the icon from `web/index.html` (the shield/key icon) or export from Figma.

---

## B. Pre-Launch Checklist (T-7 to T-1)

### T-7: Technical Readiness

- [ ] Verify auth service is up and responding: `curl https://grantex-auth-dd4mtrt2gq-uc.a.run.app/health`
- [ ] Verify all links in the PH listing work (homepage, docs, signup, playground, GitHub)
- [ ] Test the full signup flow: sign up → create developer account → get API key
- [ ] Test the full onboarding flow: create agent → authorize → approve consent → exchange token → verify token
- [ ] Run conformance suite against production: `npx @grantex/conformance --url https://grantex-auth-dd4mtrt2gq-uc.a.run.app`
- [ ] Verify playground works end-to-end with a fresh API key
- [ ] Check npm/PyPI/Go packages install correctly
- [ ] Review error pages and rate limit responses

### T-5: Listing Preparation

- [ ] Screenshot gallery images from `web/ph-gallery.html` (6 slides, 1270x760px each)
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

- [ ] Finalize all social posts (review `LAUNCH_POSTS.md`)
- [ ] Finalize Dev.to article (review `DEVTO_ARTICLE.md`)
- [ ] Draft LinkedIn post
- [ ] Prepare HN Show HN submission
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
| **7:30 AM** | LinkedIn post | Share the launch with a personal angle. Link to PH listing. |
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
