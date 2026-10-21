# Grant Refresh Lifecycle

A script that walks one grant through refresh, a lost-response retry and
refresh-token rotation, then lets a second, short grant expire to show where
refresh stops and a new authorization is needed.

## Steps

1. Registers an agent and authorizes a grant for `GRANT_TTL` (default `5m`).
2. Verifies the grant token locally against the JWKS and with the service.
3. Refreshes it. The new grant token keeps the same `grantId`, and the grant's
   `expiresAt` does not move: refresh renews credentials, not the grant.
4. Verifies the refreshed token the same two ways.
5. Sends the first refresh token again straight away, as a client that lost the
   refresh response would, and checks that the service returns the refresh
   token it already rotated to.
6. Uses that rotated refresh token, then shows the first one is now refused.
7. Authorizes a second grant for `EXPIRED_GRANT_TTL` (default `3s`), waits for
   it to lapse, and shows that its token no longer verifies and that refresh is
   refused.

The script exits non-zero if any of these outcomes is different.

## Run it

You need Node.js 24 and Docker.

```bash
# repository root: start the local stack
docker compose up -d

cd examples/token-expiry-refresh
npm install
npm start
```

## Sample output

```text
=== Grant Refresh Lifecycle ===

Agent: ag_01...

--- Grant valid for 5m ---
  grantId       grnt_01...
  scopes        calendar:read, email:send
  expiresAt     2026-10-20T22:46:48.858Z
  refreshToken  ref_01...

--- Verify the first grant token ---
  local (JWKS)  ok, principal user-alice, scopes calendar:read, email:send
  service       valid=true

--- Refresh ---
  grantId       grnt_01... (unchanged)
  expiresAt     2026-10-20T22:46:48.858Z (refresh does not extend the grant)
  scopes        calendar:read, email:send

--- Verify the refreshed grant token ---
  local (JWKS)  ok, token tok_01..., scopes calendar:read, email:send
  service       valid=true

--- Recover a lost refresh response ---
  Sending the first refresh token again, as a client that never saw the reply would...
  same rotated refresh token returned: true

--- Rotation moves on ---
  Using the rotated refresh token...
  Trying the first refresh token once more...
  refused: Refresh token already used
  A refresh token is single-use; the retry window closes once the next token is used.

--- Grant valid for 3s, left to expire ---
  waiting 5s...
  service       valid=false (expected false)
  refresh refused: Grant has expired
  Refresh only renews credentials of an active grant; an expired grant needs a new authorization.

Refresh lifecycle complete.
```

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key; a sandbox key approves consent automatically, which the script relies on |
| `GRANT_TTL` | `5m` | Lifetime of the grant that is refreshed |
| `EXPIRED_GRANT_TTL` | `3s` | Lifetime of the grant that is left to expire |
| `TOKEN_TTL` | unset | Older name for `EXPIRED_GRANT_TTL`, still read when that is unset |

## Retrying a lost refresh response

If the service commits a rotation but the client never receives the reply,
the client can send the same refresh token again, with the same
`Idempotency-Key`, within five minutes and receive the refresh token it was
rotated to. Recent SDK releases reuse the key for such a retry automatically.
Once the rotated refresh token has itself been used, the earlier one is refused.
None of this extends the grant: after `expiresAt` the agent needs a new
authorization.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
