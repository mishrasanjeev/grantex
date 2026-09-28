// SPDX-License-Identifier: Apache-2.0
/**
 * The shared vectors in spec/examples/agent-httpsig-vectors.json. The Python
 * package (packages/agent-httpsig-py/tests/test_vectors.py) runs the same
 * file, so the two libraries sign identically and refuse the same requests
 * with the same code and reason.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_PAYER_AUTH_TAG,
  COVERED_COMPONENTS,
  DEFAULT_CLOCK_SKEW_SECONDS,
  INLINE_PRESENTATION_MAX_OCTETS,
  InMemoryNonceStore,
  MAX_SIGNATURE_WINDOW_SECONDS,
  SIGNATURE_PARAMETERS,
  contentDigest,
  jwkThumbprint,
  publicJwk,
  sign,
  verify,
} from '../src/index.js';
import { vectorPrivateKey, vectors } from './helpers.js';

describe('profile constants', () => {
  it('match the vectors', () => {
    expect(AGENT_PAYER_AUTH_TAG).toBe(vectors.profile.tag);
    expect([...COVERED_COMPONENTS]).toEqual(vectors.profile.covered_components);
    expect([...SIGNATURE_PARAMETERS]).toEqual(vectors.profile.parameters);
    expect(MAX_SIGNATURE_WINDOW_SECONDS).toBe(vectors.profile.max_window_seconds);
    expect(DEFAULT_CLOCK_SKEW_SECONDS).toBe(vectors.profile.default_clock_skew_seconds);
    expect(INLINE_PRESENTATION_MAX_OCTETS).toBe(vectors.profile.inline_presentation_max_octets);
  });
});

describe('keys and thumbprints', () => {
  it('derives the Ed25519 vector key and its RFC 7638 thumbprint', () => {
    const key = vectorPrivateKey('ed25519-1');
    expect(publicJwk(key)).toEqual(vectors.keys['ed25519-1']!.public_jwk);
    expect(jwkThumbprint(key)).toBe(vectors.keys['ed25519-1']!.thumbprint);
    expect(jwkThumbprint(vectors.keys['p256-1']!.public_jwk)).toBe(vectors.keys['p256-1']!.thumbprint);
  });

  for (const [i, t] of vectors.thumbprints.entries()) {
    it(`thumbprint ${i}`, () => {
      expect(jwkThumbprint(t.jwk)).toBe(t.thumbprint);
    });
  }
});

describe('content digest (RFC 9530)', () => {
  for (const c of vectors.content_digest) {
    it(`digest of ${JSON.stringify(c.body)}`, () => {
      expect(contentDigest(c.body)).toBe(c.field);
    });
  }
});

describe('sign vectors (deterministic Ed25519)', () => {
  for (const v of vectors.sign) {
    it(v.name, () => {
      const result = sign(
        { method: v.request.method, url: v.request.url, body: v.request.body },
        {
          key: vectorPrivateKey(v.key),
          agentPassport: v.presentations.agent_passport,
          agentGrant: v.presentations.agent_grant,
          ...(v.presentations.agent_trust ? { agentTrust: v.presentations.agent_trust } : {}),
          created: v.params.created,
          expires: v.params.expires,
          nonce: v.params.nonce,
          label: v.params.label,
        },
      );
      expect(result.signatureBase).toBe(v.signature_base);
      expect(Object.entries(result.headers)).toEqual(v.headers);
      expect(result.keyid).toBe(vectors.keys[v.key]!.thumbprint);
    });
  }
});

describe('verify vectors', () => {
  const all = [
    ...vectors.verify,
    ...vectors.ecdsa.map((v) => ({
      name: `ecdsa vector: ${v.name}`,
      key: v.key,
      key_known: true,
      request: { ...v.request, headers: v.headers },
      expected_authority: 'merchant.example',
      now: v.params.created + 10,
      seen_nonces: [] as [string, string][],
      expected: { ok: true as const },
    })),
  ];
  for (const v of all) {
    it(v.name, async () => {
      const nonceStore = new InMemoryNonceStore(() => v.now);
      for (const [keyid, nonce] of v.seen_nonces) {
        expect(await nonceStore.checkAndStore(keyid, nonce, v.now + 3600)).toBe(true);
      }
      const key = vectors.keys[v.key]!.public_jwk;
      const result = await verify(v.request, {
        expectedAuthority: v.expected_authority,
        now: v.now,
        nonceStore,
        resolveKey: async () => (v.key_known ? key : null),
      });
      if (v.expected.ok) {
        expect(result).toMatchObject({ ok: true });
      } else {
        expect(result).toEqual({ ok: false, code: v.expected.code, reason: v.expected.reason });
      }
    });
  }
});
