# Audit Dashboard

Demonstrates how to query, filter, and analyze the Grantex audit trail with metrics computation and hash chain integrity verification.

## What it does

1. **Sets up two agents** with different scopes and generates grant tokens
2. **Generates 9 audit entries** — a mix of success, failure, and blocked statuses
3. **Displays full audit timeline** — formatted table with status icons, agent names, and timestamps
4. **Filters by agent** — shows entries for each agent separately
5. **Filters by action** — shows only `email:send` entries with metadata
6. **Computes metrics** — success rate, entries per agent, top actions by frequency
7. **Verifies hash chain integrity** — walks the chain to confirm tamper evidence

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/audit-dashboard
npm install
npm start
```

## Expected output

```
=== Audit Dashboard Demo ===

Agent A (data-reader) registered: ag_01...
Agent B (notifier) registered: ag_01...
Both agents authorized.

--- Generating audit entries ---
Generated 9 audit entries (5 success, 2 failure, 1 blocked, 1 more success).

--- Full Audit Timeline ---

  #  Status    Agent          Action              Time
  -  ------    -----          ------              ----
   1 [+] success data-reader    data:read           12:00:01
   2 [+] success data-reader    calendar:read       12:00:01
   3 [+] success data-reader    data:read           12:00:01
   4 [x] failure data-reader    data:write          12:00:01
   5 [+] success notifier       email:send          12:00:01
   6 [+] success notifier       notification:push   12:00:01
   7 [+] success notifier       email:send          12:00:01
   8 [!] blocked notifier       email:send          12:00:02
   9 [x] failure data-reader    calendar:write      12:00:02

--- Filter: Agent A (data-reader) only ---
  Entries: 5

--- Filter: Agent B (notifier) only ---
  Entries: 4

--- Filter: email:send actions only ---
  Entries: 3

--- Metrics Summary ---
  Total entries:  9
  Success:        6 (67%)
  Failure:        2 (22%)
  Blocked:        1 (11%)

  Entries per agent:
    data-reader: 5
    notifier: 4

  Top actions:
    email:send: 3
    data:read: 2
    calendar:read: 1
    ...

--- Hash Chain Integrity Check ---
  All hash chains verified: integrity PASSED
  Chain length: 9 entries

Done! Audit dashboard demo complete.
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRANTEX_URL` | `http://localhost:3001` | Base URL of the Grantex auth service |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key. Use a sandbox key for auto-approval |
