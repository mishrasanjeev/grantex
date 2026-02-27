# Grantex + CrewAI — Scoped Tools with Audit Logging

Demo of CrewAI tools with Grantex scope enforcement and automatic audit logging.

## What it does

1. Registers an agent with `calendar:read` and `email:send` scopes
2. Gets a grant token via the sandbox auto-approval flow
3. Creates scoped tools via `create_grantex_tool()` (calendar + email)
4. Wraps tools with `with_audit_logging()` for automatic audit trail
5. Invokes tools directly to demonstrate the integration
6. Shows scope enforcement — `PermissionError` when requesting an unauthorized scope
7. Inspects the audit trail

## Prerequisites

- Python 3.9+
- Docker (for the local Grantex stack)

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/crewai-agent
pip install -r requirements.txt
python main.py
```

## Expected output

```
Agent registered: ag_01...
Grant token received, grantId: grnt_01...
Tools created: read_calendar, send_email
Audit logging attached

--- Invoking read_calendar ---
Result: {"events": [{"title": "Team standup", ...}, ...]}

--- Invoking send_email ---
Result: Email sent successfully: "Meeting summary: standup at 9 AM, ..."

--- Testing scope enforcement ---
Scope check blocked unauthorized tool: ...account:delete...

--- Audit trail ---
  [success] tool.run:read_calendar — 2026-02-27T...
  [success] tool.run:send_email — 2026-02-27T...

Done! CrewAI integration demo complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
