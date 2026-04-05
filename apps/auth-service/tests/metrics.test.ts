import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, mockRedis } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /metrics', () => {
  it('returns 200 with prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
  });

  it('does not require authentication', async () => {
    // No auth header — should still succeed
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
  });

  it('returns content-type for prometheus', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    // Mock registry returns 'text/plain'
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('metrics instrumentation', () => {
  it('authorize endpoint does not break with metrics', async () => {
    seedAuth();
    // sub query for plan limit
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    // count query
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    // agent exists
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // policies
    sqlMock.mockResolvedValueOnce([]);
    // insert auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
  });

  it('token exchange endpoint does not break with metrics', async () => {
    seedAuth();
    // auth request lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_1',
      agent_id: 'ag_1',
      agent_did: 'did:grantex:ag_1',
      principal_id: 'user_1',
      developer_id: 'dev_TEST',
      scopes: ['read'],
      expires_in: '24h',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      status: 'approved',
      audience: null,
      code_challenge: null,
    }]);
    // insert grant
    sqlMock.mockResolvedValueOnce([]);
    // insert grant token
    sqlMock.mockResolvedValueOnce([]);
    // insert refresh token
    sqlMock.mockResolvedValueOnce([]);
    // update auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'test-code', agentId: 'ag_1' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('grantToken');
  });

  it('token endpoint returns 400 for missing params without breaking metrics', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('authorize returns 400 for missing params without breaking metrics', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('authorize returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([]); // no agent

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_missing', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(404);
  });

  it('token refresh endpoint does not break with metrics', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      refresh_id: 'ref_1',
      grant_id: 'grnt_1',
      is_used: false,
      refresh_expires_at: new Date(Date.now() + 86400_000).toISOString(),
      agent_id: 'ag_1',
      agent_did: 'did:grantex:ag_1',
      principal_id: 'user_1',
      developer_id: 'dev_TEST',
      scopes: ['read'],
      grant_status: 'active',
      grant_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    }]);
    // mark old used
    sqlMock.mockResolvedValueOnce([]);
    // insert new token
    sqlMock.mockResolvedValueOnce([]);
    // insert new refresh
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_1', agentId: 'ag_1' },
    });

    expect(res.statusCode).toBe(201);
  });

  it('health check still works alongside metrics', async () => {
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockRedis.ping.mockResolvedValueOnce('PONG');

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });

  it('metrics endpoint handles concurrent requests', async () => {
    const [r1, r2, r3] = await Promise.all([
      app.inject({ method: 'GET', url: '/metrics' }),
      app.inject({ method: 'GET', url: '/metrics' }),
      app.inject({ method: 'GET', url: '/metrics' }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });
});
