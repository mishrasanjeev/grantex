# Multi-Agent Email Flow

End-to-end multi-agent email automation with delegation, scope enforcement, failure handling, cascade revocation, and audit trail inspection.

## What it does

1. **Registers two agents** — Agent A (planner) with `calendar:read` + `email:send`, Agent B (executor) with `email:send`
2. **Agent A obtains a grant token** via the sandbox flow
3. **Agent A reads calendar events** with offline scope verification
4. **Agent A delegates `email:send` only** to Agent B (not `calendar:read`)
5. **Agent B sends an email** using the delegated scope
6. **Failure: unauthorized scope** — Agent B tries `calendar:read` and is rejected
7. **Failure: cascade revocation** — Agent A's grant is revoked, Agent B's delegated token becomes invalid
8. **Recovery pattern** — Agent B detects revoked token, reports need for re-delegation
9. **Audit trail** — inspects all logged actions showing the success/failure timeline

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/multi-agent-email-flow
npm install
npm start
```

## Expected output

```
=== Multi-Agent Email Flow ===

Agent A (planner) registered: ag_01...
Agent B (executor) registered: ag_01...

Agent A grant token:
  grantId: grnt_01...
  scopes:  calendar:read, email:send

--- Agent A: Reading calendar ---
Scope verified offline: calendar:read
Calendar events found: 3

--- Agent A: Delegating email:send to Agent B ---
Delegated token issued:
  scopes:  email:send
  delegationDepth: 1

--- Agent B: Sending email ---
Email sent: msg_...

--- Failure: Agent B tries calendar:read (not delegated) ---
Blocked! Agent B cannot read calendar.

--- Failure: Revoking Agent A's grant (cascade to Agent B) ---
After revocation:
  Agent A token valid: false (revoked)
  Agent B token valid: false (cascade revoked)

--- Audit trail ---
  [+] Agent A calendar:read — success
  [+] Agent B email:send — success
  [x] Agent B calendar:read — failure
  [x] Agent B email:send — failure

Done! Multi-agent email flow with failure handling complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
