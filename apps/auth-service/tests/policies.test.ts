import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const MOCK_POLICY = {
  id: 'pol_TEST01',
  developer_id: 'dev_TEST',
  name: 'Block all',
  effect: 'deny',
  priority: 0,
  agent_id: null,
  principal_id: null,
  scopes: null,
  time_of_day_start: null,
  time_of_day_end: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('POST /v1/policies', () => {
  it('creates a policy and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                  // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // policy count → 0
    sqlMock.mockResolvedValueOnce([MOCK_POLICY]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: authHeader(),
      payload: { name: 'Block all', effect: 'deny' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; effect: string; name: string }>();
    expect(body.id).toBe('pol_TEST01');
    expect(body.effect).toBe('deny');
    expect(body.name).toBe('Block all');
  });

  it('returns 402 when plan policy limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);  // subscription → free plan
    sqlMock.mockResolvedValueOnce([{ count: '5' }]);    // policy count → at limit

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: authHeader(),
      payload: { name: 'Another policy', effect: 'deny' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 400 when name or effect is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: authHeader(),
      payload: { name: 'No effect' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid effect value', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: authHeader(),
      payload: { name: 'Bad effect', effect: 'maybe' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/policies', () => {
  it('returns list of policies', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([MOCK_POLICY]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ policies: unknown[]; total: number }>();
    expect(body.policies).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

describe('GET /v1/policies/:id', () => {
  it('returns a single policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([MOCK_POLICY]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/policies/${MOCK_POLICY.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toBe(MOCK_POLICY.id);
  });

  it('returns 404 when not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/pol_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/policies/:id', () => {
  it('updates policy name and returns updated record', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...MOCK_POLICY, name: 'Updated name' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/policies/${MOCK_POLICY.id}`,
      headers: authHeader(),
      payload: { name: 'Updated name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string }>();
    expect(body.name).toBe('Updated name');
  });

  it('returns 404 when not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/policies/pol_nonexistent',
      headers: authHeader(),
      payload: { name: 'x' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/policies/:id', () => {
  it('deletes policy and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: MOCK_POLICY.id }]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/policies/${MOCK_POLICY.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/policies/pol_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});
