# Grantex Quickstart — Basic Authorization Flow (Python)

End-to-end demo of the core Grantex authorization lifecycle using the Python SDK with zero framework dependencies.

## What it does

1. Registers an agent with `calendar:read` and `email:send` scopes
2. Initiates authorization in sandbox mode (auto-approved, no consent UI)
3. Exchanges the authorization code for a grant token (JWT)
4. Verifies the token offline using the local JWKS endpoint
5. Logs an audit entry for a simulated calendar read
6. Revokes the token and confirms revocation

## Prerequisites

- Python 3.9+
- Docker (for the local Grantex stack)

## Run

```bash
# Start the local Grantex stack (from repo root)
docker compose up -d

# Run the example
cd examples/quickstart-py
pip install -r requirements.txt
python main.py
```

## Expected output

```
Agent registered: ag_01... did:grantex:ag_01...
Auth request: areq_01...
Sandbox auto-approved, code: 01J...
Grant token received, grantId: grnt_01...
Scopes: calendar:read, email:send
Token verified offline:
  principalId: test-user-001
  agentDid:    did:grantex:ag_01...
  scopes:      calendar:read, email:send
Audit entry logged: aud_01...
Token revoked.
Post-revocation verify: revoked

Done! Full authorization lifecycle complete.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRANTEX_URL` | `http://localhost:3001` | Auth service base URL |
| `GRANTEX_API_KEY` | `sandbox-api-key-local` | API key (sandbox mode) |
