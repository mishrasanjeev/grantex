# Gateway Proxy Example

Demonstrates the Grantex gateway as a reverse proxy with scope enforcement.

## Setup

```bash
# Start the auth service
docker compose up

# Install and run
cd examples/gateway-proxy
npm install
npm start
```

## What it does

1. Starts a mock upstream API server on port 4001
2. Registers an agent and obtains a grant token with `calendar:read` and `email:read` scopes
3. Makes requests through the gateway (port 4000) — authorized requests pass through, unauthorized requests are rejected

## Running the Gateway

In a separate terminal:

```bash
npx grantex-gateway gateway.yaml
```

The gateway reads `gateway.yaml` and enforces grant token scopes on each route.
