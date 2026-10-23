import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateMixedSigningJwks } from '../src/jwks.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ed = generateKeyPairSync('ed25519');
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'grant', alg: 'RS256', use: 'sig' };
const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec', alg: 'ES256', use: 'sig' };
const edJwk = { ...ed.publicKey.export({ format: 'jwk' }), kid: 'ed', alg: 'EdDSA', use: 'sig' };

describe('mixed signing JWKS profile', () => {
  it('accepts valid RS256, ES256 P-256 and EdDSA Ed25519 public keys together', () => {
    expect(() => validateMixedSigningJwks({ keys: [rsaJwk, ecJwk, edJwk] })).not.toThrow();
  });

  it('retains RSA keys with optional algorithm metadata', () => {
    const { alg: _alg, ...key } = rsaJwk;
    expect(() => validateMixedSigningJwks({ keys: [key] })).not.toThrow();
  });

  it.each([
    ['symmetric key', { kty: 'oct', alg: 'HS256', k: 'ZXhhbXBsZQ' }],
    ['algorithm confusion', { ...ecJwk, alg: 'RS256' }],
    ['unknown algorithm', { ...rsaJwk, alg: 'RS512' }],
    ['wrong EC curve', { ...ecJwk, crv: 'P-384' }],
    ['key-agreement curve', { ...edJwk, crv: 'X25519' }],
    ['missing EC algorithm', { ...ecJwk, alg: undefined }],
    ['missing key material', { kty: 'RSA', alg: 'RS256', kid: 'empty' }],
    ['private key material', { ...rsa.privateKey.export({ format: 'jwk' }), kid: 'private', alg: 'RS256' }],
    ['encryption use', { ...ecJwk, use: 'enc' }],
    ['signing operation', { ...ecJwk, key_ops: ['sign'] }],
    ['malformed operations', { ...ecJwk, key_ops: 'verify' }],
    ['empty key id', { ...ecJwk, kid: '' }],
    ['duplicate key id', { ...ecJwk, kid: 'grant' }],
    ['non-object key', null],
  ])('rejects %s', (_name, key) => {
    expect(() => validateMixedSigningJwks({ keys: [rsaJwk, key] })).toThrow();
  });

  it.each([null, {}, { keys: [] }, { keys: 'invalid' }, { keys: [ecJwk, edJwk] }])(
    'rejects a missing RS256 grant key or malformed set: %j', (body) => {
      expect(() => validateMixedSigningJwks(body)).toThrow();
    },
  );

  it('rejects weak RSA keys', () => {
    // Public-only synthetic modulus: exercise rejection without generating a weak key pair.
    const weak = { kty: 'RSA', alg: 'RS256', n: Buffer.alloc(128, 0xa5).toString('base64url'), e: 'AQAB' };
    expect(() => validateMixedSigningJwks({ keys: [weak] })).toThrow(/2048/);
  });
});
