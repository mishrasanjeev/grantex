// SPDX-License-Identifier: Apache-2.0
//
// Property tests for the hash rule and the key rule. Cases come from a seeded
// generator, so a failure replays with the same inputs.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PassportError,
  createKeyBindingJwt,
  externalCredentialHash,
  issuePassport,
  jwkThumbprint,
  keysEqual,
  type Jwk,
} from '../src/index.ts';
import { ed25519KeyPair, p256KeyPair, passportParams, prng, shuffle } from './helpers.ts';

const issuer = p256KeyPair('mock-issuer-2026');
const holder = p256KeyPair();
const CASES = 200;

describe('hash rule: externalCredentialHash', () => {
  it("is 'sha-256:' + base64url(sha256(the issuer-signed JWT))", () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const expected = 'sha-256:' + createHash('sha256').update(issued.issuerJwt, 'ascii').digest('base64url');
    expect(externalCredentialHash(issued.compact)).toBe(expected);
    expect(externalCredentialHash(`${issued.issuerJwt}~`)).toBe(expected);
  });

  it('never changes when disclosures are added, removed or reordered, or a KB-JWT is attached', () => {
    const random = prng(0x5d1a);
    const issued = issuePassport(passportParams(issuer, holder));
    const expected = externalCredentialHash(issued.compact);
    const all = issued.disclosures.map((d) => d.encoded);
    for (let i = 0; i < CASES; i += 1) {
      const subset = shuffle(all, random).filter(() => random() < 0.6);
      // Repeats and foreign disclosures are refused by verifyPassport, but the hash
      // is a pure function of the issuer-signed JWT and must not see them either.
      if (random() < 0.3 && subset.length > 0) subset.push(subset[0] as string);
      if (random() < 0.3) subset.push(Buffer.from(JSON.stringify(['s', 'x', i])).toString('base64url'));
      let compact = `${issued.issuerJwt}~${subset.map((d) => `${d}~`).join('')}`;
      if (random() < 0.5) {
        compact = createKeyBindingJwt({
          sdJwt: compact,
          holderKey: holder.privateJwk,
          aud: 'https://merchant.example',
          nonce: `n${i}`,
          iat: 1_790_000_000 + i,
        });
      }
      expect(externalCredentialHash(compact)).toBe(expected);
    }
  });

  it('changes when any character of the issuer-signed JWT changes', () => {
    const random = prng(0x7e57);
    const issued = issuePassport(passportParams(issuer, holder));
    const expected = externalCredentialHash(issued.compact);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const jwt = issued.issuerJwt;
    for (let i = 0; i < CASES; i += 1) {
      const at = Math.floor(random() * jwt.length);
      if (jwt[at] === '.') continue;
      let replacement = jwt[at] as string;
      while (replacement === jwt[at]) replacement = alphabet[Math.floor(random() * alphabet.length)] as string;
      const mutated = jwt.slice(0, at) + replacement + jwt.slice(at + 1);
      expect(externalCredentialHash(`${mutated}~`)).not.toBe(expected);
    }
    // Two passports with the same claims differ (fresh salts, fresh signature).
    expect(externalCredentialHash(issuePassport(passportParams(issuer, holder)).compact)).not.toBe(expected);
  });

  it('refuses input that is not an SD-JWT', () => {
    const issued = issuePassport(passportParams(issuer, holder));
    for (const bad of [issued.issuerJwt, '', '~', 'a.b~', `${issued.issuerJwt} ~`, 'é.b.c~']) {
      expect(() => externalCredentialHash(bad)).toThrow(PassportError);
    }
  });
});

describe('key rule: jwkThumbprint and keysEqual (RFC 7638, RFC 8037)', () => {
  it('matches the RFC 7638 section 3.1 and RFC 8037 appendix A.3 examples', () => {
    const rsa: Jwk = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
      alg: 'RS256',
      kid: '2011-04-29',
    };
    expect(jwkThumbprint(rsa)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
    const okp: Jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    expect(jwkThumbprint(okp)).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  it('ignores non-required members and member order; a public key equals its private key', () => {
    const random = prng(0x7b);
    for (let i = 0; i < 40; i += 1) {
      const pair = random() < 0.5 ? p256KeyPair() : ed25519KeyPair();
      const base = jwkThumbprint(pair.publicJwk);
      const extras: Record<string, unknown> = { kid: `k${i}`, use: 'sig', alg: 'ES256', key_ops: ['verify'], ext: true };
      const decorated: Record<string, unknown> = { ...pair.publicJwk };
      for (const [k, v] of Object.entries(extras)) if (random() < 0.5) decorated[k] = v;
      const reordered = Object.fromEntries(shuffle(Object.entries(decorated), random)) as Jwk;
      expect(jwkThumbprint(reordered)).toBe(base);
      expect(keysEqual(reordered, pair.publicJwk)).toBe(true);
      expect(keysEqual(pair.privateJwk, pair.publicJwk)).toBe(true);
    }
  });

  it('changes when any required member changes, and different keys are never equal', () => {
    const random = prng(0x99);
    const a = p256KeyPair();
    const b = p256KeyPair();
    expect(keysEqual(a.publicJwk, b.publicJwk)).toBe(false);
    expect(keysEqual(a.publicJwk, ed25519KeyPair().publicJwk)).toBe(false);
    for (let i = 0; i < CASES; i += 1) {
      const member = (['x', 'y'] as const)[Math.floor(random() * 2)] as 'x' | 'y';
      const bytes = Buffer.from(a.publicJwk[member] as string, 'base64url');
      const at = Math.floor(random() * bytes.length);
      bytes[at] = (bytes[at] as number) ^ (1 + Math.floor(random() * 255));
      const changed = { ...a.publicJwk, [member]: bytes.toString('base64url') };
      expect(jwkThumbprint(changed)).not.toBe(jwkThumbprint(a.publicJwk));
    }
    expect(jwkThumbprint({ ...a.publicJwk, crv: 'P-384' })).not.toBe(jwkThumbprint(a.publicJwk));
  });

  it('refuses keys missing a required member or of an unknown type', () => {
    const a = p256KeyPair();
    const { y: _y, ...noY } = a.publicJwk;
    expect(() => jwkThumbprint(noY as Jwk)).toThrow(PassportError);
    expect(() => jwkThumbprint({ kty: 'XYZ' })).toThrow(PassportError);
    expect(() => jwkThumbprint({ ...a.publicJwk, x: 7 } as unknown as Jwk)).toThrow(PassportError);
    expect(() => keysEqual(noY as Jwk, a.publicJwk)).toThrow(PassportError);
  });
});
