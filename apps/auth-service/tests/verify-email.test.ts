import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/signup/verify', () => {
  it('sends verification email', async () => {
    seedAuth();
    // Insert verification
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup/verify',
      headers: authHeader(),
      payload: { email: 'test@example.com' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().message).toContain('Verification email sent');
    expect(res.json().expiresAt).toBeDefined();
  });

  it('returns 400 for missing email', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup/verify',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup/verify',
      payload: { email: 'test@example.com' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/signup/verify/:token', () => {
  it('verifies a valid token', async () => {
    // Token lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'emv_1',
      developer_id: 'dev_TEST',
      email: 'test@example.com',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      verified_at: null,
    }]);
    // Update verification
    sqlMock.mockResolvedValueOnce([]);
    // Update developer
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/test-token-123',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('verified');
  });

  it('returns 404 for invalid token', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/invalid-token',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for expired token', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'emv_1',
      developer_id: 'dev_TEST',
      email: 'test@example.com',
      expires_at: new Date(Date.now() - 86400_000).toISOString(),
      verified_at: null,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/expired-token',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('TOKEN_EXPIRED');
  });

  it('returns 200 for already verified', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'emv_1',
      developer_id: 'dev_TEST',
      email: 'test@example.com',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      verified_at: new Date().toISOString(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/verified-token',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('already verified');
  });

  it('does not require authentication (skipAuth)', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'emv_1',
      developer_id: 'dev_TEST',
      email: 'test@example.com',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      verified_at: null,
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/public-token',
    });

    // Should work without auth header
    expect(res.statusCode).toBe(200);
  });
});
