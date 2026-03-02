import { describe, it, expect } from 'vitest';
import { createA2AAuthMiddleware, A2AAuthError } from '../src/server.js';

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

describe('createA2AAuthMiddleware', () => {
  const middleware = createA2AAuthMiddleware({
    jwksUri: 'https://grantex.dev/.well-known/jwks.json',
  });

  it('extracts grant from valid token', () => {
    const token = createTestToken();
    const grant = middleware({ headers: { authorization: `Bearer ${token}` } });

    expect(grant.grantId).toBe('grnt_TEST');
    expect(grant.agentDid).toBe('did:grantex:ag_TEST');
    expect(grant.principalId).toBe('user_123');
    expect(grant.developerId).toBe('dev_TEST');
    expect(grant.scopes).toEqual(['read', 'write']);
  });

  it('throws on missing Authorization header', () => {
    expect(() => middleware({ headers: {} })).toThrow(A2AAuthError);
    try {
      middleware({ headers: {} });
    } catch (e) {
      expect((e as A2AAuthError).statusCode).toBe(401);
    }
  });

  it('throws on non-Bearer auth', () => {
    expect(() => middleware({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })).toThrow('Missing or invalid Authorization header');
  });

  it('throws on expired token', () => {
    const token = createTestToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => middleware({
      headers: { authorization: `Bearer ${token}` },
    })).toThrow('expired');
  });

  it('throws on invalid JWT format', () => {
    expect(() => middleware({
      headers: { authorization: 'Bearer not-a-jwt' },
    })).toThrow('Invalid grant token format');
  });

  it('validates required scopes', () => {
    const scopedMiddleware = createA2AAuthMiddleware({
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      requiredScopes: ['admin'],
    });

    const token = createTestToken({ scp: ['read'] });
    expect(() => scopedMiddleware({
      headers: { authorization: `Bearer ${token}` },
    })).toThrow('Missing required scopes: admin');
  });

  it('passes when all required scopes present', () => {
    const scopedMiddleware = createA2AAuthMiddleware({
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      requiredScopes: ['read'],
    });

    const token = createTestToken({ scp: ['read', 'write'] });
    const grant = scopedMiddleware({
      headers: { authorization: `Bearer ${token}` },
    });

    expect(grant.scopes).toContain('read');
  });

  it('includes delegation depth when present', () => {
    const token = createTestToken({ delegationDepth: 1 });
    const grant = middleware({ headers: { authorization: `Bearer ${token}` } });

    expect(grant.delegationDepth).toBe(1);
  });

  it('handles token without grnt claim (falls back to jti)', () => {
    const token = createTestToken({ grnt: undefined });
    const grant = middleware({ headers: { authorization: `Bearer ${token}` } });

    expect(grant.grantId).toBe('tok_TEST');
  });
});

describe('A2AAuthError', () => {
  it('has correct properties', () => {
    const err = new A2AAuthError(403, 'Forbidden');
    expect(err.name).toBe('A2AAuthError');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Forbidden');
    expect(err).toBeInstanceOf(Error);
  });
});
