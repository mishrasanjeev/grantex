// SPDX-License-Identifier: Apache-2.0
//
// The mock's own compact JWS: what it signs verifies with node:crypto
// independently, and what it parses is strict.

import { describe, expect, it } from 'vitest';
import { ALG_FOR_KIND, keyKind, parseJws, signJws, verifySignature } from '../src/jose.ts';
import { agentKeyPair, verifiedEs256 } from './helpers.ts';

describe('compact JWS', () => {
  it('signs ES256 that node:crypto verifies independently', () => {
    const key = agentKeyPair('ec');
    const jws = signJws({ alg: 'ES256', typ: 'example+jwt' }, { sub: 'shopper-01' }, key.privateJwk);
    expect(verifiedEs256(jws, key.publicJwk).payload).toEqual({ sub: 'shopper-01' });
    expect(verifySignature('ES256', key.publicJwk, parseJws(jws)!)).toBe(true);
  });

  it('signs and verifies EdDSA', () => {
    const key = agentKeyPair('ed25519');
    expect(ALG_FOR_KIND[keyKind(key.publicJwk)!]).toBe('EdDSA');
    const jws = signJws({ alg: 'EdDSA' }, { sub: 'shopper-01' }, key.privateJwk);
    expect(verifySignature('EdDSA', key.publicJwk, parseJws(jws)!)).toBe(true);
  });

  it('fails closed on another key, another algorithm, a private key or a tampered payload', () => {
    const key = agentKeyPair('ec');
    const other = agentKeyPair('ec');
    const jws = signJws({ alg: 'ES256' }, { sub: 'shopper-01' }, key.privateJwk);
    const parsed = parseJws(jws)!;
    expect(verifySignature('ES256', other.publicJwk, parsed)).toBe(false);
    expect(verifySignature('EdDSA', key.publicJwk, parsed)).toBe(false);
    expect(verifySignature('ES256', key.privateJwk, parsed)).toBe(false);
    const [h, , s] = jws.split('.');
    const tampered = `${h}.${Buffer.from('{"sub":"other"}').toString('base64url')}.${s}`;
    expect(verifySignature('ES256', key.publicJwk, parseJws(tampered)!)).toBe(false);
  });

  it('refuses padded or non-object segments', () => {
    const key = agentKeyPair('ec');
    const jws = signJws({ alg: 'ES256' }, { sub: 'shopper-01' }, key.privateJwk);
    const [h, p, s] = jws.split('.');
    expect(parseJws(`${h}=.${p}.${s}`)).toBeNull();
    expect(parseJws(`${h}.${Buffer.from('[1]').toString('base64url')}.${s}`)).toBeNull();
    expect(parseJws(`${h}.${p}`)).toBeNull();
  });
});
