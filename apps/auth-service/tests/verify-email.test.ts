import { describe, it, expect, beforeAll, vi } from 'vitest';
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

  it('succeeds even when email sending fails', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // INSERT email_verification

    // Mock sendEmail to throw
    const { sendEmail } = await import('../src/lib/email.js');
    const sendEmailMock = vi.mocked(sendEmail);
    sendEmailMock.mockRejectedValueOnce(new Error('SMTP connection failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup/verify',
      headers: authHeader(),
      payload: { email: 'test@example.com' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().message).toBe('Verification email sent');
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
    // Conflict check — no other developer owns this email
    sqlMock.mockResolvedValueOnce([]);
    // Update verification
    sqlMock.mockResolvedValueOnce([]);
    // Update developer (sets email_verified=TRUE and email=verifiedEmail)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/test-token-123',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('verified');
    expect(res.json().email).toBe('test@example.com');
  });

  it('returns 409 EMAIL_TAKEN when another developer already verified the same address', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'emv_1',
      developer_id: 'dev_TEST',
      email: 'shared@example.com',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      verified_at: null,
    }]);
    // Conflict check — another developer already owns this verified email
    sqlMock.mockResolvedValueOnce([{ id: 'dev_OTHER' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/signup/verify/conflict-token',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_TAKEN');
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
    // Conflict check, then two updates
    sqlMock.mockResolvedValueOnce([]);
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
