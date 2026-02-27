# Grantex + LangChain — Scoped Tools with Audit Logging

Demo of a LangChain agent using Grantex-scoped tools and automatic audit logging.

## What it does

1. Registers an agent with `calendar:read` and `email:send` scopes
2. Gets a grant token via the sandbox flow (no consent UI)
3. Creates two scoped tools using `createGrantexTool` (calendar read + email send)
4. Sets up `GrantexAuditHandler` for automatic tool invocation logging
5. Invokes tools and logs each action to the audit trail
6. Demonstrates scope enforcement — attempting to create a tool with an unauthorized scope fails immediately

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

**Optional**: Set `OPENAI_API_KEY` to use a real LLM. Without it, the example invokes tools directly to demonstrate the Grantex integration.

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/langchain-agent
npm install
npm start
```

## Expected output

```
Agent registered: ag_01...
Grant token received, grantId: grnt_01...
Tools created: read_calendar, send_email
Audit handler configured

--- Invoking read_calendar ---
Result: {"events":[{"title":"Team standup","time":"9:00 AM",...}]}

--- Invoking send_email ---
Result: Email sent successfully: "Meeting summary: ..."

--- Testing scope enforcement ---
Scope check blocked unauthorized tool: Grantex: agent is not authorized for scope 'account:delete'. ...

--- Audit trail ---
  [success] tool:read_calendar — 2026-02-27T...
  [success] tool:send_email — 2026-02-27T...

Done! LangChain integration demo complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
| `OPENAI_API_KEY` | — | OpenAI key (optional, for real LLM agent) |
