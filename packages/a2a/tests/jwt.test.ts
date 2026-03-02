import { describe, it, expect } from 'vitest';
import { decodeJwtPayload, isTokenExpired } from '../src/_jwt.js';

function createTestToken(payload: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://grantex.dev',
    sub: 'user_123',
    agt: 'did:grantex:ag_TEST',
    dev: 'dev_TEST',
    scp: ['read', 'write'],
    jti: 'tok_TEST',
    grnt: 'grnt_TEST',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  })).toString('base64url');
  const sig = Buffer.from('test-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const token = createTestToken();
    const payload = decodeJwtPayload(token);

    expect(payload.iss).toBe('https://grantex.dev');
    expect(payload.sub).toBe('user_123');
    expect(payload.agt).toBe('did:grantex:ag_TEST');
    expect(payload.dev).toBe('dev_TEST');
    expect(payload.scp).toEqual(['read', 'write']);
    expect(payload.jti).toBe('tok_TEST');
    expect(payload.grnt).toBe('grnt_TEST');
  });

  it('decodes delegation claims', () => {
    const token = createTestToken({
      parentAgt: 'did:grantex:ag_PARENT',
      parentGrnt: 'grnt_PARENT',
      delegationDepth: 1,
    });
    const payload = decodeJwtPayload(token);

    expect(payload.parentAgt).toBe('did:grantex:ag_PARENT');
    expect(payload.parentGrnt).toBe('grnt_PARENT');
    expect(payload.delegationDepth).toBe(1);
  });

  it('decodes budget claim', () => {
    const token = createTestToken({ bdg: 42.50 });
    const payload = decodeJwtPayload(token);
    expect(payload.bdg).toBe(42.50);
  });

  it('throws on invalid JWT format (missing parts)', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('Invalid JWT format');
  });

  it('throws on invalid JWT format (too few parts)', () => {
    expect(() => decodeJwtPayload('header.payload')).toThrow('Invalid JWT format');
  });
});

describe('isTokenExpired', () => {
  it('returns false for non-expired token', () => {
    const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
    expect(isTokenExpired(payload)).toBe(false);
  });

  it('returns true for expired token', () => {
    const payload = { exp: Math.floor(Date.now() / 1000) - 3600 };
    expect(isTokenExpired(payload)).toBe(true);
  });

  it('returns false when no exp claim', () => {
    expect(isTokenExpired({})).toBe(false);
  });

  it('returns true when token expires exactly now', () => {
    const payload = { exp: Math.floor(Date.now() / 1000) };
    expect(isTokenExpired(payload)).toBe(true);
  });
});
