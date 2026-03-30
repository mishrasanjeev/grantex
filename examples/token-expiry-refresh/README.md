# Token Expiry & Refresh

Demonstrates time-bound grant tokens with automatic expiry detection and refresh token rotation.

## What it does

1. **Registers an agent** and authorizes with a short-lived token (10 seconds)
2. **Uses the token** successfully before expiry (offline + online verification)
3. **Waits for expiry** with a visible countdown
4. **Detects expiry** — offline verification throws, online verification returns `valid: false`
5. **Refreshes the token** — gets a new JWT with the same `grantId`
6. **Uses the refreshed token** — verifies it works with full scope access
7. **Refresh token rotation** — old refresh token is rejected (single-use enforcement)

## Prerequisites

- Node.js 18+
- Docker (for the local Grantex stack)

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/token-expiry-refresh
npm install
npm start
```

## Expected output

```
=== Token Expiry & Refresh Demo ===

Agent registered: ag_01...

--- Authorizing with 10s TTL ---
Grant token received:
  grantId:      grnt_01...
  scopes:       calendar:read, email:send
  expiresAt:    2026-03-30T12:00:10.000Z
  refreshToken: ref_01HXYZ...

--- Using token before expiry ---
Offline verification: PASSED
Online verification:  valid = true

--- Waiting 12s for token to expire ---
  Token should now be expired.

--- Detecting expiry ---
Offline verification: EXPIRED
  Error: "exp" claim timestamp check failed
Online verification:  valid = false (expected: false)

--- Refreshing token ---
Token refreshed successfully!
  grantId:       grnt_01... (same as original)
  new expiresAt: 2026-03-30T12:00:22.000Z
  scopes:        calendar:read, email:send

--- Using refreshed token ---
Offline verification: PASSED
Online verification:  valid = true

--- Refresh token rotation (single-use enforcement) ---
Attempting to reuse the old refresh token...
Blocked! Old refresh token rejected.
  Reason: Refresh tokens are single-use and rotate on each refresh.

Done! Token expiry and refresh lifecycle complete.
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRANTEX_URL` | `http://localhost:3001` | Base URL of the Grantex auth service |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key. Use a sandbox key for auto-approval |
| `TOKEN_TTL` | `10s` | Grant token time-to-live (e.g. `10s`, `1m`, `1h`) |
