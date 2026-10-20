# @grantex/a2a

Grantex authorization helpers for Google A2A clients and servers. The package sends grant tokens on A2A JSON-RPC requests, verifies incoming tokens against JWKS, and adds Grantex authentication metadata to Agent Cards.

## Install

```bash
npm install @grantex/a2a@0.1.4 @grantex/sdk
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

The client decodes token expiry and the optional scope only as an unverified
preflight before sending. That preflight is not an authorization decision and
can be forged. The receiving agent must verify the signature, issuer,
expiration, audience, and required scopes with `createA2AAuthMiddleware` before
executing any task.

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

PolyForm Noncommercial License 1.0.0, licensor Orchestrum Technologies LLP
([LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)).
Noncommercial self use is free. Commercial use of any sort, including internal
use by a for-profit business, hosting or SaaS, resale, embedding and paid
services, needs a written agreement with Orchestrum Technologies LLP: see
[commercial licensing](https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md)
or write to [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in). Versions
published before 21 October 2026 remain available under the Apache License 2.0
they were released with. "Grantex" is a trademark of Orchestrum Technologies LLP
([trademarks](https://github.com/mishrasanjeev/grantex/blob/main/TRADEMARKS.md)).

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
> Authority hardening requires TypeScript SDK 0.8.1 (`currentAuthority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. Verify registry availability before installation.
> See the [SDK execution authority guide](https://docs.grantex.dev/guides/sdk-execution-authority).
