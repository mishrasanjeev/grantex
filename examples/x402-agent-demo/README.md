# Managed Prepaid-Wallet x402 Agent

This example uses the official x402 v2 flow backed by an assigned Grantex
prepaid wallet. It does not fabricate payment proofs or use the legacy GDT-only
payment path.

## Prerequisites

1. Start the Grantex Docker stack and the `x402-weather-api` example.
2. Create and assign a funded `sandbox_ledger` wallet to an agent.
3. Complete the OAuth Agent Grants flow for resource
   `http://localhost:3001/v1/prepaid-wallets` with `wallet:read`,
   `wallet:spend`, and `weather:read` scopes.
4. Persist the agent's ES256 private JWK with the resulting DPoP-bound access
   token. Do not log or commit either value.

Set these environment variables before running:

```text
GRANTEX_OAUTH_CLIENT_ID
GRANTEX_OAUTH_REDIRECT_URI
GRANTEX_OAUTH_PRIVATE_JWK
GRANTEX_ACCESS_TOKEN
```

Optional variables are `GRANTEX_ISSUER` (defaults to
`http://localhost:3001`), `GRANTEX_WALLET_ID`, and `WEATHER_API_URL`.

```bash
npm ci
npm run typecheck
npm start
```

The example lists the agent's assigned wallets, receives the merchant's
official `PAYMENT-REQUIRED` challenge, obtains a DPoP-authenticated Grantex
reservation, retries with `PAYMENT-SIGNATURE`, and verifies the HTTP result.
The same durable idempotency key is sent to Grantex and the merchant. An exact
principal-approval request is reported without weakening wallet policy.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev
Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in)
or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
