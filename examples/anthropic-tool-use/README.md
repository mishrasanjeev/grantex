# Grantex + Anthropic SDK — Scoped Tool Use with Audit Logging

Demo of Anthropic SDK tool use with Grantex scope enforcement and audit logging.

## What it does

1. Registers an agent with `calendar:read` and `email:send` scopes
2. Gets a grant token via the sandbox flow (no consent UI)
3. Creates two tools with JSON Schema and Grantex scope checks
4. Uses `GrantexToolRegistry` to manage tools and dispatch `tool_use` blocks
5. Wraps tools with `handleToolCall` for automatic audit trail entries
6. Invokes tools via `client.messages.create()` (with Claude) or directly (without)
7. Demonstrates `GrantexScopeError` thrown when a scope is missing

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

**Optional**: Set `ANTHROPIC_API_KEY` to use Claude for real tool use. Without it, the example invokes tools directly to demonstrate scope enforcement and audit logging.

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/anthropic-tool-use
npm install
npm start

# Or with Claude:
ANTHROPIC_API_KEY=sk-ant-... npm start
```

## Expected output

```
Agent registered: ag_01...
Grant token received, grantId: grnt_01...
Tools created: read_calendar, send_email (registry has 2 tools)

--- Invoking tools directly (no ANTHROPIC_API_KEY set) ---
Calendar result: {"date":"today","events":[...]}
Email result: {"sent":true,"to":"alice@example.com",...}

--- Testing scope enforcement ---
GrantexScopeError caught:
  Required scope:  storage:delete
  Granted scopes:  calendar:read, email:send

--- Inspecting grant scopes ---
Scopes in token: calendar:read, email:send

--- Audit trail ---
  [success] tool:read_calendar — 2026-03-30T...
  [success] tool:send_email — 2026-03-30T...

Done! Anthropic SDK integration demo complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
| `ANTHROPIC_API_KEY` | — | Anthropic key (optional, enables Claude tool use) |
