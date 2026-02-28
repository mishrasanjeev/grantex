import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, sqlMock, mockRedis } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /health', () => {
  it('returns 200 with status ok when DB and Redis are healthy', async () => {
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockRedis.get.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 with status degraded when DB is unreachable', async () => {
    sqlMock.mockRejectedValueOnce(new Error('connection refused'));
    mockRedis.get.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.failing).toContain('db');
  });
});
