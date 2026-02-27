# Grantex + Vercel AI SDK — Scoped Tools with Audit Logging

Demo of Vercel AI SDK tools with Grantex scope enforcement and audit logging.

## What it does

1. Registers an agent with `calendar:read` and `email:send` scopes
2. Gets a grant token via the sandbox flow (no consent UI)
3. Creates two Vercel AI tools with Zod schemas and Grantex scope checks
4. Wraps tools with `withAuditLogging` for automatic audit trail entries
5. Invokes tools via `generateText` (with OpenAI) or directly (without)
6. Demonstrates `GrantexScopeError` thrown at construction time when a scope is missing

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

**Optional**: Set `OPENAI_API_KEY` to use `generateText` with a real LLM. Without it, the example invokes tools directly to demonstrate scope enforcement and audit logging.

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/vercel-ai-chatbot
npm install
npm start

# Or with a real LLM:
OPENAI_API_KEY=sk-... npm start
```

## Expected output

```
Agent registered: ag_01...
Grant token received, grantId: grnt_01...
Tools created: read_calendar, send_email
Audit logging attached

--- Invoking tools directly (no OPENAI_API_KEY set) ---
Calendar result: {"date":"today","events":[...]}
Email result: {"sent":true,"to":"alice@example.com",...}

--- Testing scope enforcement ---
GrantexScopeError caught:
  Required scope:  storage:delete
  Granted scopes:  calendar:read, email:send

--- Audit trail ---
  [success] tool:read_calendar — 2026-02-27T...
  [success] tool:send_email — 2026-02-27T...

Done! Vercel AI integration demo complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
| `OPENAI_API_KEY` | — | OpenAI key (optional, enables `generateText`) |
