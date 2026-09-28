# @grantex/agent-httpsig

> **Not yet published.** Version 0.1.0 lives in this repository only; it is
> not on npm, and its API may change before the first release.

RFC 9421 HTTP Message Signatures for agent requests. An agent signs each
request with the key its Agent Passport is bound to and sends its Agent
Passport, its grant and, optionally, the registry's trust statement in the
`Agent-Passport`, `Agent-Grant` and `Agent-Trust` headers; a relying party
verifies the request before it looks at those credentials.

The header specification and the signing profile are in
[`spec/verification.md`](../../spec/verification.md). In short:

- covered components, exactly: `("@method" "@authority" "@path"
  "content-digest" "agent-passport" "agent-grant")`, with the parameters
  `created`, `expires`, `nonce`, `keyid` (the RFC 7638 thumbprint of the key)
  and `tag="agent-payer-auth"`, and at most 300 seconds between `created` and
  `expires`;
- `ecdsa-p256-sha256` (P-256 JWKs) and `ed25519` (Ed25519 JWKs);
- `Content-Digest` (RFC 9530) with SHA-256, computed by `sign()` and checked
  by `verify()`;
- the three headers are RFC 9651 Byte Sequences, or, for a presentation over
  6 KB, a `body` token with a `sha-256` parameter and the presentation in the
  JSON content under `agent_credentials`;
- denials are `request_signature_invalid` or `request_signature_stale`, with
  a reason from the specification's list.

The Python package `grantex-agent-httpsig` (`packages/agent-httpsig-py`)
behaves identically; both run the shared vectors in
[`spec/examples/agent-httpsig-vectors.json`](../../spec/examples/agent-httpsig-vectors.json).

## Example

<!-- snippet: packages/agent-httpsig/tests/docs/examples/sign-and-verify.ts -->
```typescript
import { generateKeyPairSync } from 'node:crypto';
import { InMemoryNonceStore, jwkThumbprint, publicJwk, sign, verify } from '@grantex/agent-httpsig';
import type { AgentJwk, VerifyResult } from '@grantex/agent-httpsig';

export async function signAndVerify(agentPassport: string, agentGrant: string): Promise<VerifyResult> {
  // The agent's key. In production it is the key its Agent Passport is bound to.
  const agentKey: AgentJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

  // Agent side: sign the request and send the headers sign() returns.
  const request = {
    method: 'POST',
    url: 'https://merchant.example/v1/checkout',
    headers: { 'content-type': 'application/json' } as Record<string, string>,
    body: JSON.stringify({ cart_id: 'c-1001' }),
  };
  const signed = sign(request, { key: agentKey, agentPassport, agentGrant });
  Object.assign(request.headers, signed.headers);

  // Relying party: verify it. The resolver returns the public key the
  // relying party trusts for the keyid, or null.
  const trustedKey = publicJwk(agentKey);
  const trustedKeyid = jwkThumbprint(trustedKey);
  return verify(request, {
    expectedAuthority: 'merchant.example',
    resolveKey: async (keyid) => (keyid === trustedKeyid ? trustedKey : null),
    nonceStore: new InMemoryNonceStore(),
  });
}
```

`verify()` answers a request that fails with `{ ok: false, code, reason }`.
It throws when the key resolver or the nonce store fails; refuse the request
then. `InMemoryNonceStore` is for one process and for tests: a deployment
with several instances needs a shared, atomic store (see section 4.4 of the
specification).

## Also exported

- `contentDigest(body)`, `jwkThumbprint(jwk)`, `publicJwk(jwk)`;
- `signatureBaseFor(message, label)` and `verifySignatureValue(jwk, base,
  signature)`: RFC 9421 section 2.5 and section 3.3 for any request or
  response whose covered components are `@method`, `@authority`, `@scheme`,
  `@path`, `@query`, `@status` or header fields without component
  parameters;
- `parseDictionary`, `parseList`, `parseItem` and the matching serializers
  (RFC 9651).

## Development

```bash
npm ci
npm run typecheck
npm test
```

License: Apache-2.0.
