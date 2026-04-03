# @grantex/mcp-auth

[![npm version](https://img.shields.io/npm/v/@grantex/mcp-auth)](https://www.npmjs.com/package/@grantex/mcp-auth)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@grantex/mcp-auth)](https://www.npmjs.com/package/@grantex/mcp-auth)

**OAuth 2.1 + PKCE authorization server for MCP servers, powered by Grantex.**

Turn any [Model Context Protocol](https://modelcontextprotocol.io/) server into a fully-compliant OAuth 2.1 authorization server in under 10 lines of code. Built on the Grantex delegated authorization protocol, `@grantex/mcp-auth` handles token issuance, introspection, revocation, Dynamic Client Registration (DCR), and PKCE -- so you can focus on building tools, not auth infrastructure.

## Why @grantex/mcp-auth?

The MCP specification mandates OAuth 2.1 for transport-level auth. Implementing it correctly is hard:

- **PKCE S256** is mandatory (no `plain`, no implicit flow)
- **Dynamic Client Registration** (RFC 7591) for zero-config MCP clients
- **Token introspection** (RFC 7662) for resource servers to validate tokens
- **Token revocation** (RFC 7009) for secure logout
- **Rate limiting** on all sensitive endpoints
- **Grantex integration** for delegated, auditable, scope-controlled authorization

`@grantex/mcp-auth` handles all of this out of the box, with a single function call.

## Installation

```bash
npm install @grantex/mcp-auth
```

## Quick Start

### 1. Create the server

```typescript
import { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';

const grantex = new Grantex({
  baseUrl: 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app',
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

That's it. MCP clients can now discover your auth server via `/.well-known/oauth-authorization-server`, register dynamically, and obtain tokens.

## Endpoints

`createMcpAuthServer` registers the following endpoints on the Fastify instance:

| Endpoint | Method | RFC | Description |
|----------|--------|-----|-------------|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 | Authorization server metadata discovery |
| `/register` | POST | RFC 7591 | Dynamic Client Registration |
| `/authorize` | GET | OAuth 2.1 | Authorization endpoint (PKCE required) |
| `/token` | POST | OAuth 2.1 | Token endpoint (authorization_code, refresh_token) |
| `/introspect` | POST | RFC 7662 | Token introspection |
| `/revoke` | POST | RFC 7009 | Token revocation |

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
| `allowedRedirectUris` | `string[]` | No | `[]` | Allowed redirect URIs (empty = all allowed) |
| `allowedResources` | `string[]` | No | `[]` | Allowed resource indicators (RFC 8707) |
| `clientStore` | `ClientStore` | No | `InMemoryClientStore` | Custom client registration store |
| `codeExpirationSeconds` | `number` | No | `600` | Authorization code TTL in seconds |
| `consentUi` | `object` | No | - | Consent UI customization (appName, appLogo, privacyUrl, termsUrl) |
| `hooks` | `object` | No | - | Lifecycle hooks (onTokenIssued, onRevocation) |

#### Consent UI

Customize the consent page shown to users:

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

#### Lifecycle Hooks

React to authorization events:

```typescript
const server = await createMcpAuthServer({
  // ...required fields...
  hooks: {
    onTokenIssued: async (event) => {
      console.log(`Token issued for client ${event.clientId}`);
      console.log(`Scopes: ${event.scopes.join(', ')}`);
      console.log(`Grant ID: ${event.grantId}`);
      // Send to your analytics, audit log, etc.
    },
    onRevocation: async (jti) => {
      console.log(`Token ${jti} was revoked`);
      // Invalidate cached sessions, notify downstream, etc.
    },
  },
});
```

### Custom Client Store

By default, client registrations are stored in memory. For production, implement the `ClientStore` interface backed by your database:

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

Protect your Express routes with JWT validation:

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

Resource servers can validate tokens by calling the introspection endpoint:

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

Revoke tokens when a user logs out or an agent is deauthorized:

```bash
curl -X POST https://your-mcp-server.example.com/revoke \
  -u "client_id:client_secret" \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJSUzI1NiIs..."}'
```

Per RFC 7009, the endpoint always returns `200 OK`, even if the token was already revoked or unknown.

## Managed vs Self-Hosted

| Feature | Managed (Grantex Cloud) | Self-Hosted |
|---------|------------------------|-------------|
| **Setup** | `createMcpAuthServer({ grantex, ... })` | Same API, your infrastructure |
| **Client Store** | In-memory (stateless, horizontal scale) | Bring your own (Postgres, Redis, etc.) |
| **JWKS** | Hosted by Grantex | Your JWKS endpoint |
| **Token Signing** | Grantex signs tokens | Grantex signs tokens (delegated) |
| **Rate Limiting** | Built-in per-endpoint limits | Built-in, configurable |
| **Consent UI** | Grantex-hosted consent page | Custom consent page via `consentUi` config |
| **Audit Trail** | Full audit via Grantex events | Full audit via Grantex events |
| **Uptime SLA** | 99.9% | Your responsibility |
| **Compliance** | SOC 2, GDPR ready | Your responsibility |

### Managed Mode (Recommended)

Use the Grantex Cloud auth service. Zero infrastructure to manage:

```typescript
const server = await createMcpAuthServer({
  grantex: new Grantex({
    baseUrl: 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app',
    apiKey: process.env.GRANTEX_API_KEY!,
  }),
  agentId: 'ag_your_server',
  scopes: ['tools:read', 'tools:execute'],
  issuer: 'https://your-domain.example.com',
});
```

### Self-Hosted Mode

Run your own Grantex auth service and point the SDK at it:

```typescript
const server = await createMcpAuthServer({
  grantex: new Grantex({
    baseUrl: 'https://auth.your-company.internal',
    apiKey: process.env.GRANTEX_API_KEY!,
  }),
  agentId: 'ag_internal_server',
  scopes: ['internal:read', 'internal:write'],
  issuer: 'https://auth.your-company.internal',
  clientStore: new PostgresClientStore(),  // Persistent storage
});
```

## MCP Server Certification

Grantex offers a certification program for MCP servers that implement OAuth 2.1 correctly:

### Bronze

- OAuth 2.1 + PKCE S256 for all flows
- Dynamic Client Registration (RFC 7591)
- Server metadata discovery (RFC 8414)
- Rate limiting on token and authorize endpoints

### Silver

All Bronze requirements, plus:

- Token introspection (RFC 7662)
- Token revocation (RFC 7009)
- Consent UI customization
- Lifecycle hooks for audit logging

### Gold

All Silver requirements, plus:

- Custom client store (persistent, production-grade)
- Resource indicators (RFC 8707)
- Delegation support (Grantex SPEC Section 9)
- Budget enforcement
- Full Grantex conformance suite pass

Using `@grantex/mcp-auth` with all features enabled gets you to Gold certification automatically.

## Security Considerations

`@grantex/mcp-auth` enforces OAuth 2.1 security requirements:

- **PKCE S256 is mandatory.** The `plain` method and implicit grant are rejected.
- **No password grant.** The `password` grant type is not supported.
- **No implicit grant.** Only `response_type=code` is accepted.
- **Authorization codes are single-use.** Replayed codes are rejected.
- **HS256 rejected.** Only asymmetric algorithms (RS256, ES256, PS256, EdDSA) are accepted for token verification.
- **Rate limiting** is applied to all endpoints (configurable per-endpoint).
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

MCP clients discover your auth server via the well-known metadata endpoint:

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

## Full Example: MCP Server with Auth

```typescript
import { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import express from 'express';
import { requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

// 1. Create Grantex client
const grantex = new Grantex({
  baseUrl: 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app',
  apiKey: process.env.GRANTEX_API_KEY!,
});

// 2. Start OAuth 2.1 auth server
const authServer = await createMcpAuthServer({
  grantex,
  agentId: 'ag_calendar_mcp',
  scopes: ['calendar:read', 'calendar:write'],
  issuer: 'https://calendar-mcp.example.com',
  hooks: {
    onTokenIssued: async (event) => {
      await grantex.audit.log({
        action: 'mcp.token.issued',
        agentId: event.agentDid,
        grantId: event.grantId,
        scopes: event.scopes,
      });
    },
    onRevocation: async (jti) => {
      await grantex.audit.log({
        action: 'mcp.token.revoked',
        tokenId: jti,
      });
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
| `/introspect` | 30 | 1 minute |
| `/revoke` | 20 | 1 minute |
| All others | 100 | 1 minute |

## Related Packages

| Package | Description |
|---------|-------------|
| [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) | Core TypeScript SDK |
| [`@grantex/express`](https://www.npmjs.com/package/@grantex/express) | Express.js middleware for Grantex |
| [`@grantex/gateway`](https://www.npmjs.com/package/@grantex/gateway) | Reverse-proxy gateway with YAML config |
| [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) | MCP server with 13 Grantex tools |
| [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) | CLI for managing grants, tokens, and agents |
| [`@grantex/conformance`](https://www.npmjs.com/package/@grantex/conformance) | Protocol conformance test suite |

## License

Apache-2.0
