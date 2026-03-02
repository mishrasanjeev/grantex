# Grantex Twitter/X Posts

Archive of tweet threads for paced publishing. Post with gaps between each tweet for maximum outreach.

---

## v2.2 Ecosystem Launch (2026-03-02)

### Tweet 1 — Announcement

Grantex v2.2 is live — the Ecosystem release.

Pluggable policy engines (OPA + Cedar), agent-to-agent authorization (Google A2A), usage metering, custom domains, and policy-as-code.

641 tests passing. All packages published. Deployed.

Thread with what's new:

---

### Tweet 2 — Policy Engine Integrations

Policy Engine Integrations

Your authorization decisions no longer have to live in Grantex's built-in engine.

v2.2 introduces a pluggable PolicyBackend interface with three backends:

→ Built-in (default)
→ Open Policy Agent (OPA) — write Rego policies
→ AWS Cedar — type-safe, entity-based policies

Set POLICY_BACKEND=opa or POLICY_BACKEND=cedar and point to your server. 5-second timeout with automatic fallback to built-in if your policy server is unreachable.

---

### Tweet 3 — Policy-as-Code

Policy-as-Code

Your authorization policies can now live in Git.

POST /v1/policies/sync accepts versioned bundles (Rego or Cedar). Hook it to a git webhook and every push to main automatically syncs your policies to the auth service.

Version history, rollback, and active bundle management all built in.

---

### Tweet 4 — A2A Protocol Bridge

A2A Protocol Bridge

Google's Agent-to-Agent (A2A) protocol defines how agents talk to each other. But it doesn't solve trust — who authorized this agent to act?

@grantex/a2a (TypeScript) and grantex-a2a (Python) bridge that gap:

→ Client: inject grant tokens into A2A JSON-RPC calls
→ Server middleware: validate grant tokens on incoming A2A tasks
→ Agent card builder: advertise Grantex auth in your A2A agent card

npm install @grantex/a2a
pip install grantex-a2a

---

### Tweet 5 — Managed Cloud Features

Managed Cloud Features

Usage metering — real-time Redis counters with hourly PostgreSQL rollup. Track token exchanges, authorizations, and verifications per developer. GET /v1/usage for current period, GET /v1/usage/history for daily breakdown.

Dynamic rate limiting — Free: 100/min, Pro: 500/min, Enterprise: 2,000/min. Automatically reads your plan from the request context.

Custom domains (Enterprise) — use auth.yourcompany.com instead of our API URL. DNS TXT record verification, fully automated.

---

### Tweet 6 — SDK Updates

SDK updates

Both TypeScript and Python SDKs bumped to 0.2.0 with new resource clients:

→ grantex.usage.current() / grantex.usage.history({ days: 7 })
→ grantex.domains.create({ domain }) / .verify(id) / .list() / .delete(id)

npm install @grantex/sdk@0.2.0
pip install grantex==0.2.0

---

### Tweet 7 — By the Numbers

By the numbers:

→ 4 packages published (2 npm, 2 PyPI)
→ 78 files changed, 6,750 lines added
→ 12 new API endpoints
→ 7 new documentation pages
→ 362 auth service tests, 641 total across all packages
→ 4 new database migrations
→ 0 breaking changes

Docs: grantex.dev/docs
GitHub: github.com/mishrasanjeev/grantex
