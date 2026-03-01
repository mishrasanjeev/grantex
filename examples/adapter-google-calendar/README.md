# Adapter Example — Google Calendar

Demonstrates using the `GoogleCalendarAdapter` from `@grantex/adapters` with grant tokens.

## Setup

```bash
# Start the auth service
docker compose up

# Install and run
cd examples/adapter-google-calendar
npm install && npm start
```

## What it does

1. Registers an agent with `calendar:read` and `calendar:write` scopes
2. Obtains a grant token via sandbox auto-approval
3. Uses the `GoogleCalendarAdapter` to list and create events
4. Demonstrates scope enforcement — a read-only token is blocked from creating events

The adapter handles grant token verification, scope checking, and audit logging automatically.
