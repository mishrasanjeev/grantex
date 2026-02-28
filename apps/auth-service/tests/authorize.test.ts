import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, seedSandboxAuth, sqlMock, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/authorize', () => {
  it('creates an auth request and returns requestId + consentUrl', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                  // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // grant count → 0
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
    // Policy lookup — no policies
    sqlMock.mockResolvedValueOnce([]);
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

  it('returns 402 when plan grant limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);  // subscription → free plan
    sqlMock.mockResolvedValueOnce([{ count: '50' }]);   // grant count → at limit

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                  // subscription lookup
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // grant count
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

describe('POST /v1/authorize — sandbox mode', () => {
  it('auto-approves and returns code immediately for sandbox developer', async () => {
    seedSandboxAuth();
    sqlMock.mockResolvedValueOnce([]);                       // subscription lookup
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);         // grant count
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent lookup
    sqlMock.mockResolvedValueOnce([]);                       // policy lookup
    sqlMock.mockResolvedValueOnce([]);                       // insert

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ authRequestId: string; sandbox: boolean; code: string }>();
    expect(body.sandbox).toBe(true);
    expect(body.code).toBeDefined();
    expect(typeof body.code).toBe('string');
    expect(body.authRequestId).toBeDefined();
  });

  it('does not return code for live developer', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                       // subscription lookup
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);         // grant count
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
    sqlMock.mockResolvedValueOnce([]); // policy lookup
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['sandbox']).toBeUndefined();
    expect(body['code']).toBeUndefined();
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

describe('POST /v1/authorize — policy engine', () => {
  const DENY_POLICY = {
    id: 'pol_TEST',
    effect: 'deny',
    priority: 10,
    agent_id: null,
    principal_id: null,
    scopes: null,
    time_of_day_start: null,
    time_of_day_end: null,
  };

  const ALLOW_POLICY = {
    id: 'pol_ALLOW',
    effect: 'allow',
    priority: 10,
    agent_id: null,
    principal_id: null,
    scopes: null,
    time_of_day_start: null,
    time_of_day_end: null,
  };

  it('returns 403 when a deny policy matches', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                       // subscription lookup
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);         // grant count
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent lookup
    sqlMock.mockResolvedValueOnce([DENY_POLICY]);            // policy lookup → deny

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('POLICY_DENIED');
  });

  it('auto-approves and returns code when an allow policy matches', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                       // subscription lookup
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);         // grant count
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent lookup
    sqlMock.mockResolvedValueOnce([ALLOW_POLICY]);           // policy lookup → allow
    sqlMock.mockResolvedValueOnce([]);                       // insert

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ policyEnforced: boolean; effect: string; code: string }>();
    expect(body.policyEnforced).toBe(true);
    expect(body.effect).toBe('allow');
    expect(body.code).toBeDefined();
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
