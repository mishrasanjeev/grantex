import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/agents', () => {
  it('registers an agent and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);              // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // agent count → 0
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);     // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'My Agent', description: 'A test agent', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ agentId: string; did: string; name: string }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
    expect(body.did).toBe(TEST_AGENT.did);
    expect(body.name).toBe(TEST_AGENT.name);
  });

  it('returns 402 when plan agent limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription → free plan
    sqlMock.mockResolvedValueOnce([{ count: '3' }]);    // 3 agents already (free limit)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'One Too Many', scopes: [] },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 400 when name is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { description: 'No name' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'Agent' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/agents', () => {
  it('returns list of agents', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: Array<{ agentId: string }> }>();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.agentId).toBe(TEST_AGENT.id);
  });

  it('returns empty list when no agents', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: unknown[] }>();
    expect(body.agents).toHaveLength(0);
  });
});

describe('GET /v1/agents/:id', () => {
  it('returns agent by id', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentId: string }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/agents/:id', () => {
  it('updates agent fields', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, name: 'Updated Name' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { name: 'Updated Name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string }>();
    expect(body.name).toBe('Updated Name');
  });

  it('returns 400 when no fields provided', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/agents/:id', () => {
  it('deletes agent and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce({ count: 1 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce({ count: 0 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/nonexistent`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});
