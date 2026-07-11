# @grantex/a2a

Grantex authorization helpers for Google A2A clients and servers. The package sends grant tokens on A2A JSON-RPC requests, verifies incoming tokens against JWKS, and adds Grantex authentication metadata to Agent Cards.

## Install

```bash
npm install @grantex/a2a @grantex/sdk
```

Requires Node.js 18+ and `@grantex/sdk` 0.3.11 or newer.

## Call an A2A agent

```typescript
import { A2AGrantexClient } from '@grantex/a2a';

const client = new A2AGrantexClient({
  agentUrl: 'https://agent.example.com/a2a',
  grantToken,
  requiredScope: 'tasks:send',
});

const task = await client.sendTask({
  message: {
    role: 'user',
    parts: [{ type: 'text', text: 'Prepare the weekly report' }],
  },
});
```

The client checks token expiry and the optional scope before sending. The receiving agent must still verify the signature and claims.

## Verify incoming requests

```typescript
import { createA2AAuthMiddleware } from '@grantex/a2a';

const authenticate = createA2AAuthMiddleware({
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
  issuer: 'https://grantex.dev',
  audience: 'https://agent.example.com',
  requiredScopes: ['tasks:send'],
});

const grant = await authenticate({ headers: request.headers });
console.log(grant.principalId, grant.agentDid, grant.scopes);
```

`createA2AAuthMiddleware` returns an async request authenticator. Adapt it to your HTTP framework and translate `A2AAuthError.statusCode` into the response status.

## Agent Cards

Use `buildGrantexAgentCard()` to publish the JWKS URI, issuer, required scopes, and delegation policy in an A2A Agent Card.

## License

Apache-2.0
