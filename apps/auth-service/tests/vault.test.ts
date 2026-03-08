import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

// Mock vault-crypto module
vi.mock('../src/lib/vault-crypto.js', () => ({
  encrypt: vi.fn((val: string) => `encrypted:${val}`),
  decrypt: vi.fn((val: string) => val.replace('encrypted:', '')),
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/vault/credentials', () => {
  it('stores a credential and returns metadata', async () => {
    seedAuth();
    // INSERT ... ON CONFLICT
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials',
      headers: authHeader(),
      payload: {
        principalId: 'user_123',
        service: 'google',
        accessToken: 'ya29.access_token',
        refreshToken: 'rt_refresh',
        metadata: { email: 'test@example.com' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.principalId).toBe('user_123');
    expect(body.service).toBe('google');
    expect(body.credentialType).toBe('oauth2');
    expect(body.id).toMatch(/^vault_/);
    expect(body).not.toHaveProperty('accessToken');
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials',
      headers: authHeader(),
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('GET /v1/vault/credentials', () => {
  it('lists credentials without raw tokens', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'vault_1',
        principal_id: 'user_123',
        service: 'google',
        credential_type: 'oauth2',
        token_expires_at: '2026-04-01T00:00:00Z',
        metadata: { email: 'test@example.com' },
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].id).toBe('vault_1');
    expect(body.credentials[0].service).toBe('google');
    expect(body.credentials[0]).not.toHaveProperty('accessToken');
    expect(body.credentials[0]).not.toHaveProperty('access_token');
  });

  it('filters by principalId and service', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials?principalId=user_123&service=google',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toEqual([]);
  });
});

describe('GET /v1/vault/credentials/:id', () => {
  it('returns credential metadata', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'vault_1',
        principal_id: 'user_123',
        service: 'google',
        credential_type: 'oauth2',
        token_expires_at: null,
        metadata: {},
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials/vault_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('vault_1');
  });

  it('returns 404 for non-existent credential', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials/vault_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('DELETE /v1/vault/credentials/:id', () => {
  it('deletes a credential', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'vault_1' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/vault/credentials/vault_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for non-existent credential', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/vault/credentials/vault_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/vault/credentials/exchange', () => {
  it('exchanges grant token for upstream credential', async () => {
    // No seedAuth needed — skipAuth is true
    // Mock the grant token verification
    const { signGrantToken } = await import('../src/lib/crypto.js');
    const token = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['google:read'],
      jti: 'tok_VAULT01',
      grnt: 'grnt_VAULT01',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    sqlMock.mockResolvedValueOnce([
      {
        id: 'vault_1',
        access_token: 'encrypted:ya29.real_token',
        refresh_token: null,
        token_expires_at: '2026-04-01T00:00:00Z',
        credential_type: 'oauth2',
        metadata: {},
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: { service: 'google' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBe('ya29.real_token');
    expect(body.service).toBe('google');
  });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      payload: { service: 'google' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 without service', async () => {
    const { signGrantToken } = await import('../src/lib/crypto.js');
    const token = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['google:read'],
      jti: 'tok_VAULT02',
      grnt: 'grnt_VAULT02',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when no credential found', async () => {
    const { signGrantToken } = await import('../src/lib/crypto.js');
    const token = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['google:read'],
      jti: 'tok_VAULT03',
      grnt: 'grnt_VAULT03',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: { service: 'nonexistent' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when grant token is expired/invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: 'Bearer invalid.jwt.token' },
      payload: { service: 'google' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});
