# Audit Trail Report

A script that writes a small, known set of audit entries for two agents, reads
them back through the SDK and turns them into a report: a timeline, per-agent
and per-action views, outcome percentages, and a check of the developer's
audit hash chain.

## Steps

1. Registers `data-reader` and `notifier`, authorizes each for `user-alice`,
   and exchanges the codes for grant tokens.
2. Records nine entries: six `success`, two `failure` (actions outside the
   granted scopes) and one `blocked` (rate limited).
3. Lists each agent's entries and prints them merged in time order.
4. Prints each agent's entries on their own, then only the `email:send` entries
   with their metadata.
5. Prints the share of each outcome, the entry count per agent, and the action
   counts, most frequent first.
6. Lists the developer's entries without a filter and checks that every
   entry's `prevHash` equals the `hash` of the entry before it. The chain is
   kept per developer, so a per-agent list would show false breaks.

## Run it

You need Node.js 24 and Docker.

```bash
# repository root: start the local stack
docker compose up -d

cd examples/audit-dashboard
npm install
npm start
```

## Sample output

Identifiers, times and hashes differ on each run.

```text
=== Audit Trail Report ===

Registered data-reader: ag_01...
Registered notifier: ag_01...
Both agents authorized.

--- Recording activity ---
Recorded 9 entries (6 success, 2 failure, 1 blocked).

--- Timeline ---
   # Mark Outcome Agent          Action              Time (UTC)
   1 [+]  success data-reader    data:read           22:39:31
   2 [+]  success data-reader    calendar:read       22:39:31
   3 [+]  success data-reader    data:read           22:39:31
   4 [x]  failure data-reader    data:write          22:39:31
   5 [+]  success notifier       email:send          22:39:31
   6 [+]  success notifier       notification:push   22:39:31
   7 [+]  success notifier       email:send          22:39:31
   8 [!]  blocked notifier       email:send          22:39:31
   9 [x]  failure data-reader    calendar:write      22:39:31

--- Only data-reader (5) ---
...
--- Only notifier (4) ---
...
--- Only email:send (3) ---
  [+] notifier: success {"to":"team@example.com"}
  [+] notifier: success {"to":"manager@example.com"}
  [!] notifier: blocked {"reason":"rate_limit_exceeded"}

--- Summary ---
  Entries: 9
  success  6 (67%)
  failure  2 (22%)
  blocked  1 (11%)
  Per agent:
    data-reader: 5
    notifier: 4
  Per action, most frequent first:
    email:send: 3
    data:read: 2
    ...

--- Hash chain ---
  Intact: 9 linked entries
  First hash 71c321237d151fb7...
  Last hash  19eb5ce92974c241...

Report complete.
```

On a database that already holds entries for the same developer, the chain
length counts those entries too.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key; a sandbox key approves consent automatically, which the script relies on |

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
