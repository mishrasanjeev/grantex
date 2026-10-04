# @grantex/gateway

Zero-code reverse-proxy that enforces [Grantex](https://grantex.dev) grant tokens in front of any API via YAML config.

## Install

Version 0.3.0 adds opt-in data-region enforcement and credential-reference
redemption. Check [Release Status](https://docs.grantex.dev/release-status)
for the version currently available on npm.

Version 0.2.0 is a breaking release requiring Node.js 22.12+ and
`@grantex/sdk` 0.8+. Set `audience` globally or on each route. Audience-bearing
tokens fail closed when no audience is configured; mismatches return HTTP 401.
`audienceCheck: off` is an explicit unsafe migration opt-out and cannot be
combined with `audience`. This gateway verifies JWTs locally; upgrading the
SDK does not add an online revocation check to this gateway. Add service-side
current-state enforcement where needed. See the
[migration guide](https://docs.grantex.dev/migration-enforcement).

```bash
npm install @grantex/gateway @grantex/sdk
```

## Quick Start

**1. Create `gateway.yaml`:**

```yaml
upstream: https://api.internal.example.com
jwksUri: https://your-auth-server/.well-known/jwks.json
audience: https://api.merchant.example
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
2. **Token verification** — extracts the Bearer token and verifies it locally using keys retrieved from the configured JWKS endpoint
3. **Scope checking** — ensures the grant includes all required scopes for the route
4. **Proxy** — strips the Authorization header, adds upstream headers + `X-Grantex-*` context headers, forwards to upstream
5. **Response** — returns the upstream response as-is

## YAML Config Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `upstream` | string | Yes | Base URL of the upstream API |
| `jwksUri` | string | Yes | JWKS endpoint used for local signature verification |
| `port` | number | No | Listen port (default: 8080) |
| `upstreamHeaders` | object | No | Headers added to every upstream request |
| `grantexApiKey` | string | No | The gateway's own API key; needed for `currentAuthorityCheck` (or set `GRANTEX_API_KEY`) |
| `grantexBaseUrl` | string | No | The issuer the current-authority check asks (default `https://api.grantex.dev`); set it for a self-hosted issuer |
| `currentAuthorityCheck` | boolean | No | `true` asks the issuer on every request whether the grant is still active, so a revoked or stopped grant is refused on the next request rather than at token expiry. The documented default for stop-sensitive deployments; needs an audience on every route and `audienceCheck: on` |
| `routes` | array | Yes | Route definitions (see below) |
| `dataRegion` | string | No | The data region the upstream processes data in (for example `in`); a grant bound to another region is refused with `REGION_MISMATCH`, and a region-bound grant is refused with `REGION_UNCONFIGURED` when no region is set. Needs `dataRegionCheck: on`; a route's `dataRegion` overrides it |
| `dataRegionCheck` | `on` \| `off` | No | `off` in this release: a grant's `data_region` is ignored, as earlier releases did; `on` checks it |
| `credentialReference` | `on` \| `off` | No | `on` redeems a `Grantex-Credential-Ref` request header (a reference from the vault exchange with `delivery: reference`) with `grantexApiKey` against `grantexBaseUrl` and injects the credential upstream as `Authorization: Bearer`; the agent never holds the secret. `off` (default) leaves the header alone, as earlier releases did |

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

## Credentials by reference

With `credentialReference: on`, an agent that exchanged its grant token for a credential
reference (`POST /v1/vault/credentials/exchange` with `delivery: "reference"`) presents it as
`Grantex-Credential-Ref: vcr_...`. The gateway redeems the reference for the request's grant with
its own API key (`POST /v1/vault/credentials/resolve`) and forwards the request with
`Authorization: Bearer <credential>`; the agent never holds the secret. The auth service refuses
a reference that belongs to another grant, has expired, or whose grant is revoked or stopped, and
the gateway then denies the request rather than forwarding it without the credential. A request
that presents no reference is proxied as before. With the check on, the header is not forwarded
upstream; off, the gateway treats it as any other request header, as earlier releases did.

```yaml
credentialReference: on
grantexApiKey: gx_key_...
grantexBaseUrl: https://api.grantex.dev
```

## Stop-sensitive deployments

A gateway verifies a grant token's signature, claims and scopes locally. That
accepts a token until it expires: a grant revoked, or ended by an emergency stop,
a minute after the token was issued is still accepted for the rest of the token's
lifetime. With `currentAuthorityCheck: true` the gateway also asks the issuer, on
every request, whether the grant is still active, so a stopped or revoked grant is
refused on the next request. This is the documented default for stop-sensitive
deployments: anywhere an emergency stop must take effect before token expiry, turn
it on and treat a gateway without it as accepting stale authority for up to a
token lifetime. Set `GRANTEX_API_KEY` (or `grantexApiKey`), give every route an
audience, and keep `audienceCheck` on; `grantexBaseUrl` selects the issuer for a
self-hosted deployment. The issuer being unreachable denies the request: the
gateway never falls back to the signature alone.

```yaml
audience: calendar-service
currentAuthorityCheck: true
grantexBaseUrl: https://api.grantex.dev
```

## Error Responses

| Status | Error Code | When |
|--------|-----------|------|
| 404 | `ROUTE_NOT_FOUND` | No route matches the request |
| 401 | `TOKEN_MISSING` | No Bearer token in Authorization header |
| 401 | `TOKEN_INVALID` | Token signature verification failed |
| 401 | `TOKEN_EXPIRED` | Token has expired |
| 403 | `SCOPE_INSUFFICIENT` | Grant doesn't include required scopes |
| 502 | `UPSTREAM_ERROR` | Upstream API is unreachable |
| 400 | `CREDENTIAL_REF_INVALID` | `Grantex-Credential-Ref` is not a credential reference |
| 403 | `CREDENTIAL_REF_INVALID` | The auth service refused the reference: another grant's, expired, the grant no longer active, or unknown |
| 502 | `CREDENTIAL_RESOLVE_FAILED` | The auth service could not be reached, refused the gateway's key or answered without a credential |

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
- `@grantex/sdk` >= 0.3.0

## License

Apache-2.0

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).

## Source Development

Use Node.js 24 LTS and `npm ci` to build or test this checkout with Vitest 5.
Repository validation steps are in [the dependency upgrade guide](https://docs.grantex.dev/guides/dependency-updates).
Source-tooling requirements are separate from published package runtime support.
> Authority hardening requires TypeScript SDK 0.8.1 (`currentAuthority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. Verify registry availability before installation.
> See the [SDK execution authority guide](https://docs.grantex.dev/guides/sdk-execution-authority).
