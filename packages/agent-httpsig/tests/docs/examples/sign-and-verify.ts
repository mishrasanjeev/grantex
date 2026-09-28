// SPDX-License-Identifier: Apache-2.0
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
