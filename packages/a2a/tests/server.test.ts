import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { createA2AAuthMiddleware, A2AAuthError } from '../src/server.js';
import { verifyGrantToken, type VerifiedGrant as SdkVerifiedGrant } from '@grantex/sdk';

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

  beforeEach(() => {
    vi.mocked(verifyGrantToken).mockReset();
  });

  function mockVerifiedGrant(overrides: Partial<SdkVerifiedGrant> = {}): void {
    vi.mocked(verifyGrantToken).mockResolvedValue({
      tokenId: 'tok_TEST',
      grantId: 'grnt_TEST',
      agentDid: 'did:grantex:ag_TEST',
      principalId: 'user_123',
      developerId: 'dev_TEST',
      scopes: ['read', 'write'],
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });
  }

  it('extracts grant from a verified token', async () => {
    mockVerifiedGrant();
    const token = createTestToken();
    const grant = await middleware({ headers: { authorization: `Bearer ${token}` } });

    expect(grant.grantId).toBe('grnt_TEST');
    expect(grant.agentDid).toBe('did:grantex:ag_TEST');
    expect(grant.principalId).toBe('user_123');
    expect(grant.developerId).toBe('dev_TEST');
    expect(grant.scopes).toEqual(['read', 'write']);
    expect(verifyGrantToken).toHaveBeenCalledWith(token, {
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
    });
  });

  it('throws on missing Authorization header', async () => {
    await expect(middleware({ headers: {} })).rejects.toThrow(A2AAuthError);
    try {
      await middleware({ headers: {} });
    } catch (e) {
      expect((e as A2AAuthError).statusCode).toBe(401);
    }
  });

  it('throws on non-Bearer auth', async () => {
    await expect(middleware({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })).rejects.toThrow('Missing or invalid Authorization header');
  });

  it('throws on expired token', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('JWT expired'));
    const token = createTestToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(middleware({
      headers: { authorization: `Bearer ${token}` },
    })).rejects.toThrow('JWT expired');
  });

  it('throws on invalid JWT format', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('Invalid Compact JWS'));
    await expect(middleware({
      headers: { authorization: 'Bearer not-a-jwt' },
    })).rejects.toThrow('Grant token verification failed');
  });

  it('validates required scopes', async () => {
    const scopedMiddleware = createA2AAuthMiddleware({
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      requiredScopes: ['admin'],
    });

    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('Grant token is missing required scopes: admin'));
    const token = createTestToken({ scp: ['read'] });
    await expect(scopedMiddleware({
      headers: { authorization: `Bearer ${token}` },
    })).rejects.toThrow('missing required scopes: admin');
  });

  it('passes when all required scopes present', async () => {
    const scopedMiddleware = createA2AAuthMiddleware({
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      requiredScopes: ['read'],
    });

    mockVerifiedGrant({ scopes: ['read', 'write'] });
    const token = createTestToken({ scp: ['read', 'write'] });
    const grant = await scopedMiddleware({
      headers: { authorization: `Bearer ${token}` },
    });

    expect(grant.scopes).toContain('read');
    expect(verifyGrantToken).toHaveBeenCalledWith(token, {
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      requiredScopes: ['read'],
    });
  });

  it('includes delegation depth when present', async () => {
    mockVerifiedGrant({ delegationDepth: 1 });
    const token = createTestToken({ delegationDepth: 1 });
    const grant = await middleware({ headers: { authorization: `Bearer ${token}` } });

    expect(grant.delegationDepth).toBe(1);
  });

  it('handles token without grnt claim (falls back to jti)', async () => {
    mockVerifiedGrant({ grantId: 'tok_TEST' });
    const token = createTestToken({ grnt: undefined });
    const grant = await middleware({ headers: { authorization: `Bearer ${token}` } });

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
