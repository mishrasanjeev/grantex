import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The admin key must be set BEFORE config.ts is evaluated.
// vi.hoisted runs before all imports.
const ADMIN_KEY = vi.hoisted(() => {
  const key = 'test-admin-key-secret';
  process.env['ADMIN_API_KEY'] = key;
  return key;
});

import { buildTestApp, sqlMock } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /v1/admin/stats', () => {
  it('returns 401 without admin key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Unauthorized');
  });

  it('returns 401 with wrong admin key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats',
      headers: { authorization: 'Bearer wrong-key' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Unauthorized');
  });

  it('returns stats with correct admin key', async () => {
    // 7 parallel SQL queries: devTotal, dev24h, dev7d, dev30d, modeRows, agentTotal, grantTotal
    sqlMock.mockResolvedValueOnce([{ count: 42 }]);   // devTotal
    sqlMock.mockResolvedValueOnce([{ count: 3 }]);    // dev24h
    sqlMock.mockResolvedValueOnce([{ count: 10 }]);   // dev7d
    sqlMock.mockResolvedValueOnce([{ count: 25 }]);   // dev30d
    sqlMock.mockResolvedValueOnce([                    // modeRows
      { mode: 'live', count: 30 },
      { mode: 'sandbox', count: 12 },
    ]);
    sqlMock.mockResolvedValueOnce([{ count: 100 }]);  // agentTotal
    sqlMock.mockResolvedValueOnce([{ count: 500 }]);  // grantTotal

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDevelopers).toBe(42);
    expect(body.last24h).toBe(3);
    expect(body.last7d).toBe(10);
    expect(body.last30d).toBe(25);
    expect(body.byMode).toEqual({ live: 30, sandbox: 12 });
    expect(body.totalAgents).toBe(100);
    expect(body.totalGrants).toBe(500);
  });
});

describe('GET /v1/admin/developers', () => {
  it('returns 401 without admin key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/developers',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns paginated developer list with correct key', async () => {
    const now = new Date().toISOString();
    sqlMock.mockResolvedValueOnce([
      { id: 'dev_1', name: 'Dev One', email: 'one@example.com', mode: 'live', created_at: now },
      { id: 'dev_2', name: 'Dev Two', email: 'two@example.com', mode: 'sandbox', created_at: now },
    ]);
    sqlMock.mockResolvedValueOnce([{ count: 2 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/developers',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.developers).toHaveLength(2);
    expect(body.developers[0].id).toBe('dev_1');
    expect(body.developers[0].name).toBe('Dev One');
    expect(body.developers[0].email).toBe('one@example.com');
    expect(body.developers[0].mode).toBe('live');
    expect(body.developers[0].createdAt).toBe(now);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
  });

  it('respects page and pageSize query params', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 'dev_3', name: 'Dev Three', email: null, mode: 'live', created_at: new Date().toISOString() },
    ]);
    sqlMock.mockResolvedValueOnce([{ count: 11 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/developers?page=2&pageSize=5',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(5);
    expect(body.total).toBe(11);
  });

  it('clamps pageSize to 100 maximum', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: 0 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/developers?pageSize=999',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pageSize).toBe(100);
  });

  it('defaults page to 1 for invalid value', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: 0 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/developers?page=-1',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().page).toBe(1);
  });
});
