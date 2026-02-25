import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/authorize', () => {
  it('creates an auth request and returns requestId + consentUrl', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
    // Insert
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read', 'write'],
        expiresIn: '24h',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ authRequestId: string; consentUrl: string; expiresAt: string }>();
    expect(body.authRequestId).toBeDefined();
    expect(body.consentUrl).toContain('/consent?req=');
    expect(body.expiresAt).toBeDefined();
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // agent not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: 'ag_nonexistent',
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/authorize/:id/approve', () => {
  it('approves a pending request and returns code', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST',
      status: 'approved',
      code: 'TESTCODE123',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize/areq_TEST/approve',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ requestId: string; status: string; code: string }>();
    expect(body.status).toBe('approved');
    expect(body.code).toBe('TESTCODE123');
  });

  it('returns 404 when request not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize/nonexistent/approve',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/authorize/:id/deny', () => {
  it('denies a pending request', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'areq_TEST', status: 'denied' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize/areq_TEST/deny',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('denied');
  });

  it('returns 404 when request not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize/nonexistent/deny',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});
