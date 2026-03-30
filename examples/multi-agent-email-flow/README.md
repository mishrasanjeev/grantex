# Multi-Agent Email Flow

End-to-end multi-agent email automation with delegation, scope enforcement, failure handling, and audit trail inspection.

## What it does

1. **Registers two agents** — Agent A (planner) with `calendar:read` + `email:send`, Agent B (executor) with `email:send`
2. **Agent A obtains a grant token** via the sandbox flow
3. **Agent A reads calendar events** with offline scope verification
4. **Agent A delegates `email:send` only** to Agent B (not `calendar:read`)
5. **Agent B sends an email** using the delegated scope
6. **Failure: unauthorized scope** — Agent B tries `calendar:read` and is rejected
7. **Failure: cascade revocation** — Agent A's grant is revoked, Agent B's delegated token becomes invalid
8. **Audit trail** — inspects all logged actions showing the success/failure timeline

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

## Run

Start the local Grantex stack from the repository root:

```bash
docker compose up -d
```

In a separate terminal, run the example:

```bash
cd examples/multi-agent-email-flow
npm install
npm start
```

## Expected output

```text
=== Multi-Agent Email Flow ===

Agent A (planner) registered: ag_01...
Agent B (executor) registered: ag_01...

Agent A grant token:
  grantId: grnt_01...
  scopes:  calendar:read, email:send

--- Agent A: Reading calendar ---
Scope verified offline: calendar:read
  principalId: user-alice
Calendar events found: 3
  9:00 AM — Team standup
  2:00 PM — Design review
  4:00 PM — 1:1 with manager

--- Agent A: Delegating email:send to Agent B ---
Delegated token issued:
  grantId: grnt_01...
  scopes:  email:send
  delegationDepth: 1
  parentAgentDid: did:grantex:ag_01...

--- Agent B: Sending email ---
Scope verified offline: email:send
Email sent: msg_1234567890
  to:      team@company.com
  subject: Daily schedule summary

--- Failure: Agent B tries calendar:read (not delegated) ---
Blocked! Agent B cannot read calendar.
  Error: Grant token does not include required scope "calendar:read"...

--- Failure: Revoking Agent A's grant (cascade to Agent B) ---
Before revocation:
  Agent A token valid: true
  Agent B token valid: true

Parent grant revoked.
After revocation:
  Agent A token valid: false (revoked)
  Agent B token valid: false (cascade revoked)

Agent B tries to send email after revocation...
Blocked! Delegated token is no longer valid.
Recovery: Agent B must request a new delegation from Agent A.

--- Audit trail ---
  [+] Agent A calendar:read — success — 2026-03-30T...
  [+] Agent B email:send — success — 2026-03-30T...
  [x] Agent B calendar:read — failure — 2026-03-30T...
  [x] Agent B email:send — failure — 2026-03-30T...

Total audit entries: 4
  Success: 2
  Failure: 2

Done! Multi-agent email flow with failure handling complete.
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRANTEX_URL` | `http://localhost:3001` | Base URL of the Grantex auth service |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key. Use a sandbox key for auto-approval |
