import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const MOCK_DELIVERY = {
  id: 'whd_01',
  event_id: 'evt_01',
  event_type: 'grant.created',
  status: 'delivered',
  attempts: 1,
  max_attempts: 5,
  url: 'https://example.com/webhook',
  last_error: null,
  created_at: '2026-03-01T00:00:00Z',
  delivered_at: '2026-03-01T00:00:01Z',
};

describe('GET /v1/webhooks/:id/deliveries', () => {
  it('returns deliveries for an owned webhook', async () => {
    seedAuth();
    // Webhook ownership check
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    // Count
    sqlMock.mockResolvedValueOnce([{ count: '1' }]);
    // Deliveries
    sqlMock.mockResolvedValueOnce([MOCK_DELIVERY]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].id).toBe('whd_01');
    expect(body.deliveries[0].webhookId).toBe('wh_01');
    expect(body.deliveries[0].eventType).toBe('grant.created');
    expect(body.deliveries[0].status).toBe('delivered');
    expect(body.deliveries[0].deliveredAt).toBe('2026-03-01T00:00:01Z');
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
  });

  it('returns 404 for non-existent webhook', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_nonexistent/deliveries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('filters by status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries?status=failed',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toEqual([]);
  });

  it('supports pagination parameters', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    sqlMock.mockResolvedValueOnce([{ count: '50' }]);
    sqlMock.mockResolvedValueOnce([MOCK_DELIVERY]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries?page=2&pageSize=10',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(10);
    expect(body.total).toBe(50);
  });

  it('clamps pageSize to max 100', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries?pageSize=500',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pageSize).toBe(100);
  });

  it('returns empty deliveries array when none exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deliveries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('maps failed delivery fields correctly', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'wh_01' }]);
    sqlMock.mockResolvedValueOnce([{ count: '1' }]);
    sqlMock.mockResolvedValueOnce([{
      ...MOCK_DELIVERY,
      status: 'failed',
      attempts: 5,
      last_error: 'Connection refused',
      delivered_at: null,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const d = res.json().deliveries[0];
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(5);
    expect(d.lastError).toBe('Connection refused');
    expect(d.deliveredAt).toBeNull();
  });

  it('returns 401 without auth header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_01/deliveries',
    });

    expect(res.statusCode).toBe(401);
  });
});
