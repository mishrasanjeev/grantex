import { describe, it, expect, beforeAll } from 'vitest';
import { initKeys, getKeyPair, signGrantToken, buildJwks, decodeTokenClaims, parseExpiresIn } from '../src/lib/crypto.js';
import { decodeJwt } from 'jose';

beforeAll(async () => {
  process.env['AUTO_GENERATE_KEYS'] = 'true';
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  await initKeys();
});

describe('initKeys / getKeyPair', () => {
  it('generates a key pair', () => {
    const kp = getKeyPair();
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey).toBeDefined();
    expect(kp.kid).toMatch(/^grantex-\d{4}-\d{2}$/);
  });
});

describe('buildJwks', () => {
  it('returns a JWKS with one RSA key', async () => {
    const jwks = await buildJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    expect(key['kty']).toBe('RSA');
    expect(key['alg']).toBe('RS256');
    expect(key['use']).toBe('sig');
    expect(key['n']).toBeDefined();
    expect(key['e']).toBeDefined();
    expect(key['kid']).toBeDefined();
  });

  it('does not expose private key components', async () => {
    const jwks = await buildJwks();
    const key = jwks.keys[0]!;
    expect(key['d']).toBeUndefined();
    expect(key['p']).toBeUndefined();
    expect(key['q']).toBeUndefined();
  });
});

describe('signGrantToken / decodeTokenClaims', () => {
  it('signs a JWT with RS256 and correct claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;
    const jwt = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_001',
      dev: 'dev_001',
      scp: ['read', 'write'],
      jti: 'tok_001',
      grnt: 'grnt_001',
      exp,
    });

    expect(typeof jwt).toBe('string');
    expect(jwt.split('.')).toHaveLength(3);

    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString());
    expect(header.alg).toBe('RS256');

    const claims = decodeJwt(jwt);
    expect(claims.sub).toBe('user_123');
    expect(claims['agt']).toBe('did:grantex:ag_001');
    expect(claims['dev']).toBe('dev_001');
    expect(claims['scp']).toEqual(['read', 'write']);
    expect(claims.jti).toBe('tok_001');
    expect(claims['grnt']).toBe('grnt_001');
    expect(claims.exp).toBe(exp);
  });

  it('round-trips through decodeTokenClaims', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_abc',
      agt: 'did:grantex:ag_abc',
      dev: 'dev_abc',
      scp: ['read'],
      jti: 'tok_abc',
      exp,
    });

    const claims = decodeTokenClaims(jwt);
    expect(claims['sub']).toBe('user_abc');
    expect(claims['jti']).toBe('tok_abc');
  });

  it('omits grnt when not provided', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_x',
      agt: 'did:grantex:ag_x',
      dev: 'dev_x',
      scp: [],
      jti: 'tok_x',
      exp,
    });
    const claims = decodeJwt(jwt);
    expect(claims['grnt']).toBeUndefined();
  });
});

describe('parseExpiresIn', () => {
  it.each([
    ['30s', 30],
    ['5m', 300],
    ['24h', 86400],
    ['7d', 604800],
  ])('parses %s → %d seconds', (input, expected) => {
    expect(parseExpiresIn(input)).toBe(expected);
  });

  it('throws on invalid format', () => {
    expect(() => parseExpiresIn('1x')).toThrow();
    expect(() => parseExpiresIn('abc')).toThrow();
  });
});
