# @grantex/x402

Official x402 v2 fetch integration for principal-controlled Grantex prepaid
wallets, plus legacy standalone GDT authorization utilities.

## Published package (legacy GDT surface)

```bash
npm install @grantex/x402 @grantex/sdk
```

The registry package does not yet contain the managed prepaid-wallet APIs below.
Those APIs are repository source in `@grantex/x402@0.2.0` and
`@grantex/sdk@0.4.0`; use this monorepo checkout for development until both
versions are published.

## Managed prepaid flow

```ts
import { PrepaidWalletAgentClient } from '@grantex/sdk';
import { createX402Agent } from '@grantex/x402';

const walletAgent = new PrepaidWalletAgentClient({
  oauthClient,          // OAuthAgentClient configured for /v1/prepaid-wallets
  accessToken,          // DPoP token with wallet:spend + the paid action scope
});

const x402 = createX402Agent({
  authorizePayment: walletAgent.x402Authorizer,
  // walletId: 'pwal_...', // optional; omit for automatic eligible selection
});

const logicalPaymentId = 'order_01JZ8Y6Q2M4N7P9T'; // persist before the first attempt
const response = await x402.fetch('https://merchant.example/paid-resource', {
  // Merchant-level recovery after settlement and a lost HTTP response.
  headers: { 'Idempotency-Key': logicalPaymentId },
  // Grantex reservation recovery before settlement.
  idempotencyKey: logicalPaymentId,
});
```

The client handles:

1. the initial resource request;
2. an official x402 v2 `PAYMENT-REQUIRED` response;
3. a DPoP-authenticated reservation from the Grantex wallet service;
4. the `PAYMENT-SIGNATURE` retry containing the signed one-time authorization;
5. the resource server's `PAYMENT-RESPONSE`.

It never fabricates a payment proof or accepts the old custom
`X-Payment-Proof` flow.

## Resource requirements

The Grantex prepaid scheme is `exact` on `grantex:prepaid`:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://merchant.example/paid-resource",
    "description": "Paid data",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "grantex:prepaid",
    "amount": "2500",
    "asset": "USDC",
    "payTo": "merchant:data-api",
    "maxTimeoutSeconds": 120,
    "extra": { "grantexScope": "data:read" }
  }]
}
```

`amount` is an atomic-unit integer string. `maxTimeoutSeconds` must be 1-300.
The wallet service is authoritative for asset, recipient, scope, available
balance, per-transaction limit, rolling cumulative limit, and principal blocks.

## API

### `createX402Agent(config)`

```ts
const agent = createX402Agent({
  authorizePayment: async (request) => walletAgent.authorizePayment(request),
  walletId: optionalDefaultWallet,
  fetch: optionalFetchImplementation,
});

await agent.fetch(url, {
  walletId: optionalPerRequestWallet,
  idempotencyKey: durableLogicalOrderId,
  method: 'POST',
  body: JSON.stringify(payload),
});
```

Per-request `walletId` and `idempotencyKey` are SDK options and are never
forwarded as HTTP fetch properties. Reuse the key only for an identical logical
payment. The normal HTTP `Idempotency-Key` header is forwarded to the merchant.
Side-effecting merchants must persist the business result under that header to
recover a response lost after settlement; the Grantex option alone covers only
reservation/authorization recovery. The server makes the final policy decision.

### `x402AgentFetch(config)`

Returns only the payment-enabled fetch function.

### Canonical headers

```ts
import { HEADERS } from '@grantex/x402';

HEADERS.PAYMENT_REQUIRED;
HEADERS.PAYMENT_SIGNATURE;
HEADERS.PAYMENT_RESPONSE;
```

## Principal controls

Use `PrincipalPrepaidWalletClient` from `@grantex/sdk` to create/fund wallets,
assign one or many wallets to agents, set per-transaction and rolling caps,
allow recipients/scopes, approve reload requests, release reservations, and
block an assignment, a wallet, or all of one agent's wallets.

`sandbox_ledger` is complete local/off-chain accounting. `external` custody
records fail closed until a provider adapter is installed; arbitrary provider
references are not treated as value.

## Legacy GDT utilities

The following remain exported for standalone signed authorization context:

```ts
import {
  generateKeyPair,
  issueGDT,
  verifyGDT,
  x402Middleware,
} from '@grantex/x402';
```

GDT verification checks signature, expiry, scope, configured amount, and an
optional revocation registry. The default logger and registry are in memory.
A GDT does not atomically reserve money or maintain cumulative spend across
requests/processes. Do not use the token's declared `spendLimit` as evidence of
a durable prepaid balance.

Server middleware must derive amount from a server-trusted route price:

```ts
app.use('/api/weather', x402Middleware({
  requiredScopes: ['weather:read'],
  requiredAmount: 0.001,
  currency: 'USDC',
}));
```

Never derive the required amount from caller-controlled `X-Payment-*` headers.

## CLI (legacy GDT)

```bash
grantex-x402 keygen --out principal.key
grantex-x402 issue --agent did:key:z6Mk... --scope weather:read --limit 10 --expiry 24h --key principal.key
grantex-x402 verify <token> --resource weather:read --amount 0.001
grantex-x402 decode <token>
```

## Verification

Repository tests cover official header encoding, 402 retry behavior, malformed
requirements, wallet pinning, authorization failures, policy races, exact
binding, idempotent settlement, reload decisions, blocks, expiry, and Docker
end-to-end execution with PostgreSQL.

Apache-2.0. Grantex is owned by Orchestrum Technologies LLP. Inventor and owner:
Sanjeev Kumar. Contact: mishra.sanjeev@gmail.com or sanjeev@orchestrum.in.
