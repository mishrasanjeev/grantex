# x402 Agent Demo

AI agent that uses a Grantex Delegation Token (GDT) + x402 to fetch weather data.

## Prerequisites

Start the weather API server first:

```bash
cd ../x402-weather-api
npm install
npm start
```

## Run

```bash
npm install
npm start
```

## What it does

1. Generates Ed25519 key pairs for principal and agent
2. Issues a GDT with `weather:read` scope, $10 USDC/24h spend limit
3. Decodes and inspects the GDT claims
4. Verifies the GDT standalone
5. Fetches weather data via x402 (automatic 402 → pay → retry)
