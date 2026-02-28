# @grantex/express

Express.js middleware for [Grantex](https://grantex.dev) grant token verification and scope-based authorization.

Verify Grantex JWTs and enforce scopes on any Express route with two lines of middleware.

## Install

```bash
npm install @grantex/express @grantex/sdk express
```

## Quick Start

```typescript
import express from 'express';
import { requireGrantToken, requireScopes } from '@grantex/express';

const app = express();

const JWKS_URI = 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json';

// Verify the grant token on every /api request
app.use('/api', requireGrantToken({ jwksUri: JWKS_URI }));

// Enforce specific scopes per route
app.get('/api/calendar', requireScopes('calendar:read'), (req, res) => {
  // req.grant is fully typed — contains principalId, scopes, agentDid, etc.
  res.json({ principalId: req.grant.principalId, scopes: req.grant.scopes });
});

app.post('/api/email/send', requireScopes('email:send'), (req, res) => {
  res.json({ sent: true });
});

app.listen(3000);
```

## Factory Pattern

Use `createGrantex()` to share configuration across routes:

```typescript
import { createGrantex } from '@grantex/express';

const grantex = createGrantex({
  jwksUri: JWKS_URI,
  clockTolerance: 5,
});

app.get('/api/calendar', grantex.requireToken(), grantex.requireScopes('calendar:read'), handler);
app.get('/api/email',    grantex.requireToken(), grantex.requireScopes('email:read'),    handler);
```

## API

### `requireGrantToken(options)`

Express middleware that extracts and verifies a Grantex grant token from the request.

On success, populates `req.grant` with a `VerifiedGrant` object and calls `next()`. On failure, returns a JSON error response.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `jwksUri` | `string` | *required* | JWKS endpoint URL for token verification |
| `tokenExtractor` | `(req) => string \| undefined` | Bearer header | Custom function to extract the token |
| `clockTolerance` | `number` | `0` | Seconds of clock skew tolerance |
| `audience` | `string` | — | Expected JWT `aud` claim |
| `onError` | `(err, req, res, next) => void` | JSON response | Custom error handler |

### `requireScopes(...scopes)`

Express middleware that checks the verified grant for required scopes. Must be used after `requireGrantToken()`.

Returns 403 if any scope is missing.

### `createGrantex(options)`

Factory that creates a middleware instance with shared options.

Returns `{ requireToken(overrides?), requireScopes(...scopes) }`.

### `req.grant`

After `requireGrantToken()` succeeds, `req.grant` contains:

| Field | Type | Description |
|-------|------|-------------|
| `tokenId` | `string` | JWT `jti` claim |
| `grantId` | `string` | Grant record ID |
| `principalId` | `string` | End-user who authorized the agent |
| `agentDid` | `string` | Agent's DID |
| `developerId` | `string` | Developer org ID |
| `scopes` | `string[]` | Granted scopes |
| `issuedAt` | `number` | Token issued-at (epoch seconds) |
| `expiresAt` | `number` | Token expiry (epoch seconds) |

### Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `TOKEN_MISSING` | 401 | No token found in request |
| `TOKEN_INVALID` | 401 | Token signature or format is invalid |
| `TOKEN_EXPIRED` | 401 | Token has expired |
| `SCOPE_INSUFFICIENT` | 403 | Token lacks required scopes |

## Custom Error Handling

```typescript
app.use('/api', requireGrantToken({
  jwksUri: JWKS_URI,
  onError: (err, req, res, next) => {
    if (err.code === 'TOKEN_EXPIRED') {
      res.status(401).json({ error: 'Session expired', refreshUrl: '/auth/refresh' });
    } else {
      res.status(err.statusCode).json({ error: err.message });
    }
  },
}));
```

## Custom Token Extraction

```typescript
// Read from a cookie instead of the Authorization header
app.use('/api', requireGrantToken({
  jwksUri: JWKS_URI,
  tokenExtractor: (req) => req.cookies?.grantToken,
}));

// Read from a custom header
app.use('/api', requireGrantToken({
  jwksUri: JWKS_URI,
  tokenExtractor: (req) => req.headers['x-grant-token'] as string,
}));

// Read from a query parameter (useful for WebSocket upgrades)
app.use('/ws', requireGrantToken({
  jwksUri: JWKS_URI,
  tokenExtractor: (req) => req.query.token as string,
}));
```

## TypeScript

The package exports all types for full TypeScript support:

```typescript
import type { GrantexRequest, GrantexMiddlewareOptions, VerifiedGrant } from '@grantex/express';
```

Use `GrantexRequest` to type your route handlers:

```typescript
import type { GrantexRequest } from '@grantex/express';
import type { Response } from 'express';

app.get('/api/me', requireGrantToken({ jwksUri }), (req: GrantexRequest, res: Response) => {
  // req.grant is typed without casting
  res.json({ user: req.grant.principalId });
});
```

## Requirements

- Node.js 18+
- Express 4.18+
- `@grantex/sdk` >= 0.1.0

## License

Apache-2.0
