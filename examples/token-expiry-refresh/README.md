# Token Refresh & Rotation

Demonstrates active-grant refresh rotation, lost-response recovery, and the re-authorization boundary after a grant expires.

## What it does

1. **Registers an agent** and authorizes an active grant
2. **Uses the token** successfully while the grant is active (offline + online verification)
3. **Refreshes the token** — gets a new JWT and rotated refresh token for the same `grantId`
4. **Uses the refreshed token** — verifies it works with full scope access
5. **Refresh response recovery** — retry the previous refresh token immediately to recover the already-rotated token
6. **Refresh token rotation** — old refresh tokens cannot keep being reused
7. **Expired grant boundary** — proves that an expired grant must be re-authorized rather than refreshed

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
=== Token Refresh & Rotation Demo ===

Agent registered: ag_01...

--- Authorizing an active grant (5m) ---
Grant token received:
  grantId:      grnt_01...
  scopes:       calendar:read, email:send
  expiresAt:    2026-03-30T12:05:00.000Z
  refreshToken: ref_01HXYZ...

--- Using token before expiry ---
Offline verification: PASSED
Online verification:  valid = true

--- Refreshing token ---
Token refreshed successfully!
  grantId:   grnt_01... (same as original)
  expiresAt: 2026-03-30T12:05:00.000Z (grant lifetime unchanged)
  scopes:    calendar:read, email:send

--- Using refreshed token ---
Offline verification: PASSED
Online verification:  valid = true

--- Refresh response recovery window ---
Retrying the original refresh token immediately (simulates a lost HTTP response)...
Recovered refresh token matches first rotation: true

--- Refresh token rotation (single-use enforcement) ---
Advancing the rotation chain with the current refresh token...
Attempting to reuse the original refresh token after the chain moved forward...
Blocked! Original refresh token rejected.
  Reason: Refresh tokens are single-use; recovery only works before the rotated child is used.

--- Expired grant boundary ---
Creating a short-lived grant (3s) to show the re-authorization boundary...
Waiting 5s for the grant to expire...
Online verification after expiry: valid = false (expected: false)
Refresh after grant expiry blocked.
  Reason: Refresh rotates credentials for an active grant; expired grants require re-authorization.

Done! Token refresh lifecycle complete.
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRANTEX_URL` | `http://localhost:3001` | Base URL of the Grantex auth service |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key. Use a sandbox key for auto-approval |
| `GRANT_TTL` | `5m` | Active grant lifetime used for refresh rotation |
| `EXPIRED_GRANT_TTL` | `3s` | Short grant lifetime used only for the expired-grant boundary check |
| `TOKEN_TTL` | unset | Backward-compatible alias for `EXPIRED_GRANT_TTL` |

## Refresh boundary

`expiresIn` controls the underlying grant lifetime. Refresh rotates credentials for that active grant and does not extend the grant's `expiresAt`. If the refresh response is lost after the server commits rotation, retry the previous refresh token immediately; Grantex can return the already-rotated refresh token during the five-minute recovery window. After the grant expires, the caller must re-authorize.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in), [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
