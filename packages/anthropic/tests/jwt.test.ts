import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from '../src/_jwt.js';

/** Build a minimal JWT with the given payload claims. */
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
    iat: 1700000000,
    exp: 1700003600,
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
    expect(payload.iat).toBe(1700000000);
    expect(payload.exp).toBe(1700003600);
  });

  it('extracts scopes from the scp claim', () => {
    const token = createTestToken({ scp: ['calendar:read', 'profile:read', 'email:write'] });
    const payload = decodeJwtPayload(token);

    expect(payload.scp).toEqual(['calendar:read', 'profile:read', 'email:write']);
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

  it('decodes audience claim', () => {
    const token = createTestToken({ aud: 'https://api.example.com' });
    const payload = decodeJwtPayload(token);
    expect(payload.aud).toBe('https://api.example.com');
  });

  it('handles base64url characters (+ and /) correctly', () => {
    const token = createTestToken({ note: '>>>???<<<' });
    const payload = decodeJwtPayload(token);
    expect(payload.note).toBe('>>>???<<<');
  });

  it('throws on empty string', () => {
    expect(() => decodeJwtPayload('')).toThrow('invalid JWT format');
  });

  it('throws on string with only one part', () => {
    expect(() => decodeJwtPayload('header-only')).toThrow('invalid JWT format');
  });

  it('throws on string with empty second part', () => {
    expect(() => decodeJwtPayload('header.')).toThrow('invalid JWT format');
  });

  it('throws on malformed base64 in payload', () => {
    expect(() => decodeJwtPayload('eyJhbGciOiJSUzI1NiJ9.!!!invalid!!!.fakesig')).toThrow();
  });

  it('returns Record<string, unknown> type', () => {
    const token = createTestToken({ custom: 'value' });
    const payload = decodeJwtPayload(token);
    expect(typeof payload).toBe('object');
    expect(payload.custom).toBe('value');
  });
});
