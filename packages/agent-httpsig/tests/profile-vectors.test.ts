// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * spec/examples/agent-httpsig-profile-vectors.json: the TAP and Web Bot Auth
 * profiles and the TAP body objects, byte for byte. The Python package runs
 * the same file (tests/test_profile_vectors.py).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InMemoryNonceStore,
  buildAgenticConsumer,
  buildAgenticPaymentContainer,
  buildSignatureDirectory,
  signDirectoryResponse,
  verifyDirectoryResponse,
  jwkThumbprint,
  publicJwk,
  signWithProfile,
  verifyTapBodyObjects,
  verifyWithProfile,
} from '../src/index.js';
import type { AgentJwk, ProfileSignOptions } from '../src/index.js';
import { repoRoot, vectorPrivateKey } from './helpers.js';

interface Case {
  name: string;
  options: Record<string, unknown>;
  headers: [string, string][];
  signature_base: string;
}
const file = JSON.parse(readFileSync(`${repoRoot}spec/examples/agent-httpsig-profile-vectors.json`, 'utf8')) as {
  key: string;
  public_jwk: AgentJwk;
  thumbprint: string;
  request: { method: string; url: string; headers: [string, string][]; body: string };
  sign: Case[];
  directory: { authority: string; created: number; body: string; headers: [string, string][] };
  tap_body_objects: { nonce: string; kid: string; agenticConsumer: Record<string, unknown>; agenticPaymentContainer: Record<string, unknown> };
};

const key = vectorPrivateKey(file.key);

function options(o: Record<string, unknown>): ProfileSignOptions {
  const { signature_agent_url: url, signature_agent_type: type, ...rest } = o;
  return {
    ...(rest as Record<string, unknown>),
    key,
    ...(url ? { signatureAgent: { url: url as string, ...(type ? { type } : {}) } } : {}),
  } as unknown as ProfileSignOptions;
}

describe('profile vectors', () => {
  it('use the ed25519-1 vector key', () => {
    expect(publicJwk(key)).toEqual(file.public_jwk);
    expect(jwkThumbprint(key)).toBe(file.thumbprint);
  });

  for (const c of file.sign) {
    it(`signs: ${c.name}`, async () => {
      const req = { ...file.request };
      const signed = signWithProfile(req, options(c.options));
      expect(signed.signatureBase).toBe(c.signature_base);
      expect(Object.entries(signed.headers)).toEqual(c.headers);
      const profile = c.options['profile'] as 'tap' | 'web-bot-auth';
      const out = await verifyWithProfile(
        { ...req, headers: [...req.headers, ...c.headers] },
        {
          profile,
          expectedAuthority: 'merchant.example',
          now: (c.options['created'] as number) + 1,
          nonceStore: new InMemoryNonceStore(),
          resolveKey: () => file.public_jwk,
        },
      );
      expect(out.ok).toBe(true);
    });
  }

  it('signs and reads the key directory', () => {
    const d = file.directory;
    expect(JSON.stringify(buildSignatureDirectory([key]))).toBe(d.body);
    const headers = signDirectoryResponse(d.body, { authority: d.authority, signingKeys: [key], created: d.created });
    expect(Object.entries(headers)).toEqual(d.headers);
    const out = verifyDirectoryResponse({ status: 200, headers: d.headers, body: d.body }, { authority: d.authority, now: d.created + 1 });
    expect(out.keys.map((k) => k.kid)).toEqual([file.thumbprint]);
  });

  it('builds the TAP body objects', async () => {
    const t = file.tap_body_objects;
    const consumer = buildAgenticConsumer({
      key,
      kid: t.kid,
      nonce: t.nonce,
      idToken: t.agenticConsumer['idToken'] as string,
      contextualData: t.agenticConsumer['contextualData'] as { countryCode: string; zip: string },
    });
    const container = buildAgenticPaymentContainer({
      key,
      kid: t.kid,
      nonce: t.nonce,
      paymentCredentialsHash: t.agenticPaymentContainer['paymentCredentialsHash'] as string,
    });
    expect(consumer).toEqual(t.agenticConsumer);
    expect(container).toEqual(t.agenticPaymentContainer);
    const out = await verifyTapBodyObjects(t, { nonce: t.nonce, keyid: t.kid, resolveKey: () => file.public_jwk });
    expect(out.consumer.verified && out.paymentContainer.usableForPayment).toBe(true);
  });
});
