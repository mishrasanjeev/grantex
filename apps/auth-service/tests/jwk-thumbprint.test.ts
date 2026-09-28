// SPDX-License-Identifier: Apache-2.0
/**
 * RFC 7638 JWK Thumbprints for the agent key registry.
 *
 * The two published vectors (RFC 7638 §3.1 for RSA, RFC 8037 Appendix A.3 for
 * Ed25519) pin the exact output, and the property tests pin the two rules the
 * registry depends on: the thumbprint is a function of the required members
 * only (order and extra members never change it), and every required member
 * contributes to it.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  JwkThumbprintError,
  THUMBPRINT_MEMBERS,
  jwkThumbprint,
  jwkThumbprintInput,
} from '../src/lib/registry/jwk-thumbprint.js';

// RFC 7638 §3.1, the RSA key of RFC 7517 Appendix A.1.
const RFC7638_RSA = {
  kty: 'RSA',
  n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
  e: 'AQAB',
  alg: 'RS256',
  kid: '2011-04-29',
};
const RFC7638_RSA_THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

// RFC 8037 Appendix A.2 (public key) and A.3 (thumbprint).
const RFC8037_ED25519 = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
const RFC8037_CANONICAL = '{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}';
const RFC8037_SHA256_HEX = '90facafea9b1556698540f70c0117a22ea37bd5cf3ed3c47093c1707282b4b89';
const RFC8037_THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';

/** Deterministic PRNG (mulberry32) so a failing property run can be reproduced. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function reordered(jwk: Record<string, unknown>, random: () => number): Record<string, unknown> {
  return Object.fromEntries(shuffled(Object.entries(jwk), random));
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Replace one character of a base64url string with a different one. */
function mutate(value: string, random: () => number): string {
  const index = Math.floor(random() * value.length);
  const current = value[index]!;
  let next = current;
  while (next === current) next = B64URL[Math.floor(random() * B64URL.length)]!;
  return value.slice(0, index) + next + value.slice(index + 1);
}

function freshKeys(): Record<string, unknown>[] {
  return [
    generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }),
    generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' }),
    generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }),
    generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }),
  ] as Record<string, unknown>[];
}

describe('RFC 7638 JWK thumbprints', () => {
  it('reproduces the RFC 7638 §3.1 RSA vector, ignoring alg and kid', () => {
    expect(jwkThumbprintInput(RFC7638_RSA)).toBe(`{"e":"AQAB","kty":"RSA","n":"${RFC7638_RSA.n}"}`);
    expect(jwkThumbprint(RFC7638_RSA)).toBe(RFC7638_RSA_THUMBPRINT);
  });

  it('reproduces the RFC 8037 Appendix A.3 Ed25519 vector', () => {
    expect(jwkThumbprintInput(RFC8037_ED25519)).toBe(RFC8037_CANONICAL);
    expect(createHash('sha256').update(RFC8037_CANONICAL, 'utf8').digest('hex')).toBe(RFC8037_SHA256_HEX);
    expect(jwkThumbprint(RFC8037_ED25519)).toBe(RFC8037_THUMBPRINT);
  });

  it('uses exactly the required members of each key type', () => {
    expect(THUMBPRINT_MEMBERS).toEqual({
      EC: ['crv', 'kty', 'x', 'y'],
      RSA: ['e', 'kty', 'n'],
      OKP: ['crv', 'kty', 'x'],
    });
  });

  it('agrees with an independent implementation for freshly generated keys', async () => {
    for (const jwk of freshKeys()) {
      expect(jwkThumbprint(jwk)).toBe(await calculateJwkThumbprint(jwk as never, 'sha256'));
    }
  });

  it('never changes with member order or with extra members (property)', () => {
    const random = prng(0x7638);
    const extras = ['kid', 'alg', 'use', 'key_ops', 'x5t', 'ext', 'nimbus'];
    for (let round = 0; round < 50; round += 1) {
      for (const jwk of [RFC7638_RSA, RFC8037_ED25519, ...freshKeys().slice(0, 3)]) {
        const expected = jwkThumbprint(jwk);
        const decorated: Record<string, unknown> = { ...jwk };
        for (const name of extras) {
          if (random() < 0.5) decorated[name] = name === 'key_ops' ? ['verify'] : randomBytes(6).toString('base64url');
        }
        expect(jwkThumbprint(reordered(decorated, random))).toBe(expected);
      }
    }
  });

  it('changes when any required member changes (property)', () => {
    const random = prng(0x8037);
    for (let round = 0; round < 50; round += 1) {
      for (const jwk of [RFC7638_RSA, RFC8037_ED25519, ...freshKeys().slice(0, 3)]) {
        const original = jwkThumbprint(jwk);
        const kty = jwk['kty'] as keyof typeof THUMBPRINT_MEMBERS;
        for (const member of THUMBPRINT_MEMBERS[kty]) {
          if (member === 'kty' || member === 'crv') continue;
          const changed = { ...jwk, [member]: mutate(jwk[member as keyof typeof jwk] as string, random) };
          expect(jwkThumbprint(changed)).not.toBe(original);
        }
      }
    }
    // The curve and the key type are required members too.
    const p256 = freshKeys()[0]!;
    expect(jwkThumbprint({ ...p256, crv: 'P-384' })).not.toBe(jwkThumbprint(p256));
    expect(jwkThumbprint({ ...RFC8037_ED25519, crv: 'Ed448' })).not.toBe(RFC8037_THUMBPRINT);
  });

  it('refuses private key members instead of hashing the public part', () => {
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      expect(() => jwkThumbprint({ ...RFC8037_ED25519, [member]: 'AAAA' })).toThrow(JwkThumbprintError);
    }
    const privateJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    expect(() => jwkThumbprint(privateJwk)).toThrow(/private/);
  });

  it('refuses missing, non-string and unescapable required members, symmetric and unknown key types', () => {
    const bad: unknown[] = [
      null, 'jwk', [], {},
      { kty: 'oct', k: 'AAAA' },
      { kty: 'XYZ', x: 'AAAA' },
      { kty: 'OKP', crv: 'Ed25519' },
      { kty: 'OKP', crv: 'Ed25519', x: 12 },
      { kty: 'OKP', crv: 'Ed25519', x: '' },
      { kty: 'RSA', n: RFC7638_RSA.n },
      { kty: 'EC', crv: 'P-256', x: 'AAAA' },
      { kty: 'OKP', crv: 'Ed"25519', x: 'AAAA' },
      { kty: 'OKP', crv: 'Ed25519\u0000', x: 'AAAA' },
      { kty: 'OKP', crv: 'Ed25519', x: 'AA==' },
      { kty: 'OKP', crv: 'Ed25519', x: 'AA+/' },
    ];
    for (const value of bad) {
      expect(() => jwkThumbprint(value), JSON.stringify(value)).toThrow(JwkThumbprintError);
    }
  });
});
