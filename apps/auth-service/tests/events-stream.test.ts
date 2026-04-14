import { describe, it, expect, beforeAll, vi } from 'vitest';
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
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it('uses guarded decrement when rejecting over-limit connections', async () => {
    seedAuth();
    mockRedis.incr.mockResolvedValueOnce(6);
    mockRedis.eval.mockClear();

    await app.inject({
      method: 'GET',
      url: '/v1/events/stream',
      headers: authHeader(),
    });

    // Plain DECR can drive the gauge negative after TTL-based drift.
    // The route must use the eval-backed safe decrement that clamps at 0.
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("DECR"),
      1,
      expect.stringContaining('sse:connections:'),
    );
  });

  // NOTE: The SSE happy path (lines 37-75) uses reply.hijack() which causes
  // Fastify's inject() to hang indefinitely. These lines can only be tested
  // with a real HTTP connection (e.g., supertest with a running server).
  // The connection limit (429) path and auth (401) path above are the
  // testable branches via inject().
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
