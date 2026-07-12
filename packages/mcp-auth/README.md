# @grantex/mcp-auth

[![npm version](https://img.shields.io/npm/v/@grantex/mcp-auth)](https://www.npmjs.com/package/@grantex/mcp-auth)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@grantex/mcp-auth)](https://www.npmjs.com/package/@grantex/mcp-auth)

**OAuth 2.1 + PKCE endpoint package for MCP servers, powered by Grantex.**

Current published release: **`@grantex/mcp-auth@2.0.2`**.

`createMcpAuthServer()` registers authorization-server metadata, Dynamic Client
Registration, PKCE authorization, token, introspection, and revocation routes on
a Fastify instance. The package also exports Express and Hono JWT-verification
middleware.

> [!WARNING]
> Treat `2.0.2` as a single-process evaluation release. Client registrations
> default to process memory and authorization codes always use a
> non-configurable in-memory store. `consentUi` adds metadata but no consent
> route. The Grantex authorization code returned by the SDK is not persisted for
> token exchange, so end-to-end issuance can fail against the real backend.
> Middleware and introspection verify signatures/claims but do not perform a live
> revocation lookup. See the
> [feature guide](https://docs.grantex.dev/features/mcp-auth-server) for the full
> current-status matrix.

## What 2.0.2 implements

- PKCE S256 request validation (no `plain` or implicit flow)
- Dynamic Client Registration (RFC 7591) with a replaceable client store
- Authorization, token, introspection, and revocation endpoint handlers
- Fixed Fastify rate limits on sensitive endpoints
- Express and Hono JWT signature, claim, algorithm, and scope verification
- Calls to a supplied Grantex SDK client for authorization and token operations

## Installation

```bash
npm install @grantex/mcp-auth@2.0.2 @grantex/sdk@0.3.13
```

## Quick Start

### 1. Create the server

```typescript
import { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';

const grantex = new Grantex({
  baseUrl: 'https://api.grantex.dev',
  apiKey: process.env.GRANTEX_API_KEY!,
});

const authServer = await createMcpAuthServer({
  grantex,
  agentId: 'ag_your_mcp_server',
  scopes: ['tools:read', 'tools:execute', 'resources:read'],
  issuer: 'https://your-mcp-server.example.com',
});
```

### 2. Start listening

```typescript
await authServer.listen({ port: 3001 });
console.log('MCP Auth Server running on http://localhost:3001');
```

### 3. Protect your MCP server routes

```typescript
import { requireMcpAuth } from '@grantex/mcp-auth/express';

app.use('/mcp', requireMcpAuth({
  issuer: 'https://your-mcp-server.example.com',
  scopes: ['tools:execute'],
}));
```

The server now exposes the published endpoint surface for inspection. Discovery and registration can be exercised locally; token issuance remains subject to the `2.0.2` limitations above.

## Endpoints

`createMcpAuthServer` registers the following endpoints on the Fastify instance:

| Endpoint | Method | RFC | Description |
|----------|--------|-----|-------------|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 | Authorization server metadata discovery |
| `/register` | POST | RFC 7591 | Dynamic Client Registration |
| `/authorize` | GET | OAuth 2.1 | Authorization endpoint (PKCE required) |
| `/token` | POST | OAuth 2.1 | Token endpoint (authorization_code, refresh_token) |
| `/introspect` | POST | RFC 7662 | JWT signature/claim introspection; no live revocation lookup |
| `/revoke` | POST | RFC 7009 | Requests backend revocation by JWT `jti` |

## API Reference

### `createMcpAuthServer(config)`

Creates and returns a Fastify instance with all OAuth 2.1 endpoints registered.

```typescript
import { createMcpAuthServer } from '@grantex/mcp-auth';

const server = await createMcpAuthServer(config);
```

#### `McpAuthConfig`

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `grantex` | `Grantex` | Yes | - | Grantex SDK client instance |
| `agentId` | `string` | Yes | - | Agent ID for Grantex authorization |
| `scopes` | `string[]` | Yes | - | Scopes to request from Grantex |
| `issuer` | `string` | Yes | - | Base URL for this auth server (used in metadata) |
| `allowedRedirectUris` | `string[]` | No | `[]` | Declared but not enforced in `2.0.2`; the client's registered URI is checked |
| `allowedResources` | `string[]` | No | `[]` | Allowed resource indicators (RFC 8707) |
| `clientStore` | `ClientStore` | No | `InMemoryClientStore` | Client registrations only; authorization codes stay in process memory |
| `codeExpirationSeconds` | `number` | No | `600` | Authorization code TTL in seconds |
| `consentUi` | `object` | No | - | Discovery metadata only; no consent page is created |
| `hooks` | `object` | No | - | `onRevocation` runs; declared `onTokenIssued` is not invoked in `2.0.2` |

#### Consent metadata

`consentUi` copies labels and links into
`grantex_extensions.consent_ui_config` in the discovery response. It does not
render or register the advertised `/consent` page in `2.0.2`.

```typescript
const server = await createMcpAuthServer({
  // ...required fields...
  consentUi: {
    appName: 'My MCP Server',
    appLogo: 'https://example.com/logo.png',
    privacyUrl: 'https://example.com/privacy',
    termsUrl: 'https://example.com/terms',
  },
});
```

#### Lifecycle hooks

Only `onRevocation` is invoked by `2.0.2`:

```typescript
const server = await createMcpAuthServer({
  // ...required fields...
  hooks: {
    onRevocation: async (jti) => {
      console.log(`Token ${jti} was submitted for revocation`);
    },
  },
});
```

`onTokenIssued` is present in the exported type but is not called by the token
endpoint in this release.

### Custom Client Store

By default, client registrations are stored in memory. A custom `ClientStore` can persist clients, but the authorization-code store remains process-local and non-configurable in `2.0.2`:

```typescript
import type { ClientStore, ClientRegistration } from '@grantex/mcp-auth';

class PostgresClientStore implements ClientStore {
  async get(clientId: string): Promise<ClientRegistration | undefined> {
    const row = await db.query('SELECT * FROM oauth_clients WHERE id = $1', [clientId]);
    return row ?? undefined;
  }

  async set(clientId: string, reg: ClientRegistration): Promise<void> {
    await db.query(
      'INSERT INTO oauth_clients (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      [clientId, JSON.stringify(reg)],
    );
  }

  async delete(clientId: string): Promise<boolean> {
    const result = await db.query('DELETE FROM oauth_clients WHERE id = $1', [clientId]);
    return result.rowCount > 0;
  }
}

const server = await createMcpAuthServer({
  // ...
  clientStore: new PostgresClientStore(),
});
```

## Express.js Middleware

Protect Express routes with JWT signature, claim, algorithm, and scope validation.
This middleware does not check current revocation state in 2.0.2:

```typescript
import express from 'express';
import { requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

const app = express();

// Protect all /mcp routes
app.use('/mcp', requireMcpAuth({
  issuer: 'https://your-mcp-server.example.com',
  scopes: ['tools:execute'],
}));

// Access the decoded grant in your handlers
app.post('/mcp/tools/call', (req: McpAuthRequest, res) => {
  const grant = req.mcpGrant!;
  console.log(`Agent: ${grant.agentDid}`);
  console.log(`Scopes: ${grant.scopes.join(', ')}`);
  console.log(`Subject: ${grant.sub}`);
  res.json({ result: 'tool executed' });
});

app.listen(3000);
```

### `requireMcpAuth(options)` (Express)

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `issuer` | `string` | Yes | - | Issuer URL (JWKS fetched from `{issuer}/.well-known/jwks.json`) |
| `scopes` | `string[]` | No | `[]` | Required scopes (all must be present) |
| `algorithms` | `string[]` | No | `['RS256', 'ES256', 'PS256', 'EdDSA']` | Allowed JWT algorithms |

### `McpGrant` (decoded token claims)

| Property | Type | Description |
|----------|------|-------------|
| `sub` | `string` | Subject (principal ID) |
| `iss` | `string` | Issuer |
| `jti` | `string` | Token ID |
| `scopes` | `string[]` | Granted scopes |
| `agentDid` | `string?` | Agent DID |
| `developerId` | `string?` | Developer ID |
| `grantId` | `string?` | Grant ID |
| `delegationDepth` | `number?` | Delegation depth (0 = root) |
| `exp` | `number` | Expiry (Unix timestamp) |
| `iat` | `number` | Issued at (Unix timestamp) |
| `raw` | `JWTPayload` | All raw JWT claims |

## Hono Middleware

Same protection for Hono applications:

```typescript
import { Hono } from 'hono';
import { requireMcpAuth } from '@grantex/mcp-auth/hono';

const app = new Hono();

// Protect routes
app.use('/mcp/*', requireMcpAuth({
  issuer: 'https://your-mcp-server.example.com',
  scopes: ['tools:execute'],
}));

// Access decoded grant via context
app.post('/mcp/tools/call', (c) => {
  const grant = c.get('mcpGrant');
  return c.json({
    agent: grant.agentDid,
    scopes: grant.scopes,
  });
});

export default app;
```

## Token Introspection (RFC 7662)

Resource servers can validate JWT signatures and claims by calling the introspection endpoint. It does not query Grantex for current revocation state, so a revoked but otherwise valid token can remain `active` until expiry:

```bash
curl -X POST https://your-mcp-server.example.com/introspect \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJSUzI1NiIs..."}'
```

Response for a valid token:

```json
{
  "active": true,
  "scope": "tools:read tools:execute",
  "sub": "user_abc",
  "exp": 1743670800,
  "iat": 1743667200,
  "jti": "grnt_01HXYZ",
  "token_type": "bearer",
  "grantex_agent_did": "did:grantex:ag_01HXYZ",
  "grantex_delegation_depth": 0,
  "grantex_grant_id": "grnt_01HXYZ"
}
```

Response for an invalid/expired token:

```json
{
  "active": false
}
```

### Client Authentication

Introspection optionally accepts Basic auth for client identification:

```bash
curl -X POST https://your-mcp-server.example.com/introspect \
  -u "client_id:client_secret" \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJSUzI1NiIs..."}'
```

## Token Revocation (RFC 7009)

The endpoint decodes the JWT `jti` and requests backend revocation. It returns `200 OK` even when that call fails, and local middleware/introspection do not consult the resulting state:

```bash
curl -X POST https://your-mcp-server.example.com/revoke \
  -u "client_id:client_secret" \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJSUzI1NiIs..."}'
```

Per RFC 7009, the endpoint always returns `200 OK`, even if the token was already revoked or unknown.

## Backend selection and local state

The `Grantex` SDK passed to `createMcpAuthServer()` can target Grantex Cloud or a
self-hosted API. In both cases, the MCP auth Fastify process owns its client and
code state. A custom `ClientStore` persists only registrations; `2.0.2` exposes
no custom authorization-code store. Run a single process for evaluation and do
not treat selecting Grantex Cloud as managed MCP-auth hosting.

## Conformance testing

There is currently no automated MCP certification or badge program. Validate the Grantex protocol endpoints used by your deployment with the published conformance runner:

```bash
npx @grantex/conformance \
  --base-url https://api.grantex.dev \
  --api-key "$GRANTEX_API_KEY"
```

Passing the suite is useful deployment evidence; it is not a certification or endorsement by Grantex.

## Security Considerations

`@grantex/mcp-auth` implements the following request and token-validation controls. They do not remove the deployment and issuance limitations above:

- **PKCE S256 is mandatory.** The `plain` method and implicit grant are rejected.
- **No password grant.** The `password` grant type is not supported.
- **No implicit grant.** Only `response_type=code` is accepted.
- **Authorization codes are single-use.** Replayed codes are rejected.
- **HS256 rejected.** Only asymmetric algorithms (RS256, ES256, PS256, EdDSA) are accepted for token verification.
- **Rate limiting** is applied with fixed per-endpoint values in this release.
- **Client secrets** are generated using `crypto.randomBytes(32)`.
- **JWKS verification** uses the `jose` library with remote key set fetching and caching.

### Algorithm Policy

The introspection and middleware endpoints only accept tokens signed with:

- `RS256` (RSA PKCS#1 v1.5)
- `ES256` (ECDSA P-256)
- `PS256` (RSA-PSS)
- `EdDSA` (Ed25519)

Symmetric algorithms (`HS256`, `HS384`, `HS512`) are explicitly rejected.

## Discovery

MCP clients can read the well-known metadata endpoint. Note that `2.0.2` advertises `/consent` and `/events/stream` extension URLs without registering those routes:

```bash
curl https://your-mcp-server.example.com/.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://your-mcp-server.example.com",
  "authorization_endpoint": "https://your-mcp-server.example.com/authorize",
  "token_endpoint": "https://your-mcp-server.example.com/token",
  "registration_endpoint": "https://your-mcp-server.example.com/register",
  "introspection_endpoint": "https://your-mcp-server.example.com/introspect",
  "revocation_endpoint": "https://your-mcp-server.example.com/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "scopes_supported": ["tools:read", "tools:execute", "resources:read"],
  "grantex_extensions": {
    "consent_ui": "https://your-mcp-server.example.com/consent",
    "audit_stream": "https://your-mcp-server.example.com/events/stream"
  }
}
```

## Endpoint wiring example (subject to 2.0.2 limitations)

```typescript
import { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import express from 'express';
import { requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

// 1. Create Grantex client
const grantex = new Grantex({
  baseUrl: 'https://api.grantex.dev',
  apiKey: process.env.GRANTEX_API_KEY!,
});

// 2. Start OAuth 2.1 auth server
const authServer = await createMcpAuthServer({
  grantex,
  agentId: 'ag_calendar_mcp',
  scopes: ['calendar:read', 'calendar:write'],
  issuer: 'https://calendar-mcp.example.com',
  hooks: {
    onRevocation: async (jti) => {
      console.log(`Submitted token ${jti} for revocation`);
    },
  },
});

await authServer.listen({ port: 3001 });

// 3. Create MCP tool server with auth middleware
const app = express();

app.use('/mcp', requireMcpAuth({
  issuer: 'https://calendar-mcp.example.com',
  scopes: ['calendar:read'],
}));

app.post('/mcp/tools/list', (req: McpAuthRequest, res) => {
  res.json({
    tools: [
      { name: 'get_events', description: 'Get calendar events' },
      { name: 'create_event', description: 'Create a calendar event' },
    ],
  });
});

app.post('/mcp/tools/call', requireMcpAuth({
  issuer: 'https://calendar-mcp.example.com',
  scopes: ['calendar:write'],
}), (req: McpAuthRequest, res) => {
  const grant = req.mcpGrant!;
  // grant.agentDid, grant.scopes, grant.sub are available
  res.json({ result: 'Event created' });
});

app.listen(3000, () => {
  console.log('MCP Tool Server on :3000, Auth Server on :3001');
});
```

## Troubleshooting

### "JWKS fetch failed"

The middleware fetches JWKS from `{issuer}/.well-known/jwks.json`. Ensure:

1. Your issuer URL is correct and accessible
2. The JWKS endpoint returns valid JSON with a `keys` array
3. Network connectivity allows outbound HTTPS from your server

### "Token verification failed" / `active: false`

Common causes:

- **Token expired** -- check the `exp` claim
- **Wrong issuer** -- the token's `iss` claim must match
- **Algorithm mismatch** -- only RS256, ES256, PS256, EdDSA are accepted
- **Key rotation** -- JWKS is cached; restart or wait for cache refresh

### "Invalid client" on introspect/revoke

Client authentication uses Basic auth (`Authorization: Basic base64(client_id:client_secret)`) or body parameters. Verify your client credentials match what was returned by `/register`.

### Rate limiting (429)

Default limits per endpoint:

| Endpoint | Max requests | Window |
|----------|-------------|--------|
| `/authorize` | 10 | 1 minute |
| `/token` | 20 | 1 minute |
| `/introspect` | 20 | 1 minute |
| `/revoke` | 20 | 1 minute |
| All others | 100 | 1 minute |

## Related Packages

| Package | Description |
|---------|-------------|
| [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) | Core TypeScript SDK |
| [`@grantex/express`](https://www.npmjs.com/package/@grantex/express) | Express.js middleware for Grantex |
| [`@grantex/gateway`](https://www.npmjs.com/package/@grantex/gateway) | Reverse-proxy gateway with YAML config |
| [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) | MCP tool server (17 tools in the current repository surface) |
| [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) | CLI for managing grants, tokens, and agents |
| [`@grantex/conformance`](https://www.npmjs.com/package/@grantex/conformance) | Protocol conformance test suite |

## License

Apache-2.0
