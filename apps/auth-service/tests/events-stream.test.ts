import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, mockRedis } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /v1/events/stream (SSE)', () => {
  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/stream',
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects when max connections exceeded', async () => {
    seedAuth();
    mockRedis.incr.mockResolvedValueOnce(6); // Over the limit of 5

    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/stream',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('TOO_MANY_CONNECTIONS');
    expect(mockRedis.decr).toHaveBeenCalled();
  });
});

describe('GET /v1/events/ws (WebSocket)', () => {
  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });

    expect(res.statusCode).toBe(401);
  });
});
