# @grantex/gateway

Zero-code reverse-proxy that enforces [Grantex](https://grantex.dev) grant tokens in front of any API via YAML config.

## Install

```bash
npm install @grantex/gateway @grantex/sdk
```

## Quick Start

**1. Create `gateway.yaml`:**

```yaml
upstream: https://api.internal.example.com
jwksUri: https://your-auth-server/.well-known/jwks.json
port: 8080
upstreamHeaders:
  X-Internal-Auth: "secret-key"
routes:
  - path: /calendar/**
    methods: [GET]
    requiredScopes: [calendar:read]
  - path: /calendar/**
    methods: [POST, PUT, PATCH]
    requiredScopes: [calendar:write]
  - path: /payments/**
    methods: [POST]
    requiredScopes: [payments:initiate]
```

**2. Start the gateway:**

```bash
npx @grantex/gateway --config gateway.yaml
```

**3. Make requests with grant tokens:**

```bash
curl -H "Authorization: Bearer <grant-token>" \
  http://localhost:8080/calendar/events
```

## How It Works

```
Client → Gateway (verify token + check scopes) → Upstream API
```

1. **Route matching** — finds the first route matching the request method + path
2. **Token verification** — extracts Bearer token and verifies offline via JWKS
3. **Scope checking** — ensures the grant includes all required scopes for the route
4. **Proxy** — strips the Authorization header, adds upstream headers + `X-Grantex-*` context headers, forwards to upstream
5. **Response** — returns the upstream response as-is

## YAML Config Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `upstream` | string | Yes | Base URL of the upstream API |
| `jwksUri` | string | Yes | JWKS endpoint for offline token verification |
| `port` | number | No | Listen port (default: 8080) |
| `upstreamHeaders` | object | No | Headers added to every upstream request |
| `grantexApiKey` | string | No | API key for audit logging |
| `routes` | array | Yes | Route definitions (see below) |

### Route Definition

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | URL path pattern (`*` = single segment, `**` = any depth) |
| `methods` | string[] | HTTP methods (GET, POST, PUT, PATCH, DELETE) |
| `requiredScopes` | string[] | Scopes that must be present in the grant token |

## Context Headers

The gateway adds these headers to upstream requests:

| Header | Value |
|--------|-------|
| `X-Grantex-Principal` | Principal ID from the grant token |
| `X-Grantex-Agent` | Agent DID from the grant token |
| `X-Grantex-GrantId` | Grant ID from the grant token |

## Error Responses

| Status | Error Code | When |
|--------|-----------|------|
| 404 | `ROUTE_NOT_FOUND` | No route matches the request |
| 401 | `TOKEN_MISSING` | No Bearer token in Authorization header |
| 401 | `TOKEN_INVALID` | Token signature verification failed |
| 401 | `TOKEN_EXPIRED` | Token has expired |
| 403 | `SCOPE_INSUFFICIENT` | Grant doesn't include required scopes |
| 502 | `UPSTREAM_ERROR` | Upstream API is unreachable |

## Library API

Use the gateway programmatically:

```typescript
import { createGatewayServer, loadConfig } from '@grantex/gateway';

const config = loadConfig('./gateway.yaml');
const server = createGatewayServer(config);

await server.listen({ port: config.port });
```

## Docker

```bash
docker build -t grantex-gateway packages/gateway/
docker run -p 8080:8080 -v ./gateway.yaml:/etc/grantex/gateway.yaml grantex-gateway
```

## Requirements

- Node.js 18+
- `@grantex/sdk` >= 0.1.0

## License

Apache-2.0
