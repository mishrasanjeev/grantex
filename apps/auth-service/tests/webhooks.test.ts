import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const MOCK_WEBHOOK_ROW = {
  id: 'wh_TEST01',
  developer_id: 'dev_TEST',
  url: 'https://example.com/hooks',
  events: ['grant.created', 'grant.revoked'],
  created_at: new Date().toISOString(),
};

describe('POST /v1/webhooks', () => {
  it('creates a webhook and returns secret', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);              // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // webhook count → 0
    sqlMock.mockResolvedValueOnce([]);               // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeader(),
      payload: {
        url: 'https://example.com/hooks',
        events: ['grant.created', 'grant.revoked'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      url: string;
      events: string[];
      secret: string;
      createdAt: string;
    }>();
    expect(body.id).toMatch(/^wh_/);
    expect(body.url).toBe('https://example.com/hooks');
    expect(body.events).toEqual(['grant.created', 'grant.revoked']);
    expect(typeof body.secret).toBe('string');
    expect(body.secret.length).toBeGreaterThan(0);
    expect(body.createdAt).toBeDefined();
  });

  it('returns 402 when plan webhook limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription → free plan
    sqlMock.mockResolvedValueOnce([{ count: '1' }]);    // 1 webhook already (free limit)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeader(),
      payload: { url: 'https://example.com/hooks2', events: ['grant.created'] },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 400 when url is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeader(),
      payload: { events: ['grant.created'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when events array is empty', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeader(),
      payload: { url: 'https://example.com/hooks', events: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid event type', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeader(),
      payload: { url: 'https://example.com/hooks', events: ['not.a.valid.event'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('Invalid event types');
  });
});

describe('GET /v1/webhooks', () => {
  it('lists registered webhooks (secret excluded)', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([MOCK_WEBHOOK_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ webhooks: Record<string, unknown>[] }>();
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!['id']).toBe('wh_TEST01');
    expect(body.webhooks[0]!['url']).toBe('https://example.com/hooks');
    expect(body.webhooks[0]!['secret']).toBeUndefined();
  });

  it('returns empty list when no webhooks registered', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ webhooks: unknown[] }>().webhooks).toHaveLength(0);
  });
});

describe('DELETE /v1/webhooks/:id', () => {
  it('deletes a webhook and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: MOCK_WEBHOOK_ROW.id }]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${MOCK_WEBHOOK_ROW.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when webhook not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/webhooks/wh_NOTEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});
