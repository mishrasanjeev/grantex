# x402 Weather API Example

An Express resource server that uses official x402 v2 messages and the Grantex
prepaid-wallet facilitator. There is no fake payment proof and no client-supplied
amount header.

## Run

Start the Grantex Docker stack first, then run the example:

```bash
docker compose up --build -d
cd examples/x402-weather-api
npm install
npm start
```

The resource server listens on `http://localhost:3402` and uses
`http://localhost:3001/v1/x402` as its facilitator. Override
`PUBLIC_URL`, `GRANTEX_FACILITATOR_URL`, or `PORT` when needed.

## Flow

1. `GET /api/weather/forecast` returns HTTP 402 and a standard
   `PAYMENT-REQUIRED` declaration.
2. `@grantex/x402` asks the DPoP-authenticated wallet service to reserve the
   declared atomic amount.
3. The client retries with `PAYMENT-SIGNATURE`.
4. This server submits the exact payload and requirements to `/v1/x402/verify`
   and `/v1/x402/settle`.
5. A successful response includes `PAYMENT-RESPONSE` and the weather data.

For a side-effecting resource, callers should additionally send a durable HTTP
`Idempotency-Key`, and the resource server must atomically persist and replay the
business result under that key. The Grantex SDK's similarly named option protects
the wallet reservation before settlement; it does not replace merchant result
idempotency. This weather example is read-only and keeps no durable result store.

The assigned wallet must allow network `grantex:prepaid`, asset `USDC`,
recipient `merchant:weather-api`, and scope `weather:read`. It must have at least
`1000` atomic units available under both transaction and cumulative limits.

See [the integration guide](../../docs/integrations/x402.mdx) for principal and
agent setup.

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev
Kumar. Contact: mishra.sanjeev@gmail.com or sanjeev@orchestrum.in.
