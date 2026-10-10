import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestApp, seedAuth, authHeader, mockRedis } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await buildTestApp();
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => { await app.close(); });

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
    mockRedis.incr
      .mockResolvedValueOnce(1) // Standard-auth plan budget
      .mockResolvedValueOnce(6); // Over the connection limit of 5

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
    mockRedis.incr
      .mockResolvedValueOnce(1) // Standard-auth plan budget
      .mockResolvedValueOnce(6); // Over the connection limit
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

  it('flushes a ready comment before any event or heartbeat when enabled', async () => {
    vi.stubEnv('EVENT_STREAM_READY_ENABLED', 'true');
    seedAuth();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/v1/events/stream`, {
        headers: { ...authHeader(), Origin: 'http://localhost:5173' }, signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(': connected\n\n');
      reader.releaseLock();
      expect(mockRedis.subscribe).toHaveBeenCalledWith(expect.stringContaining('grantex:events:'));
    } finally {
      clearTimeout(timeout);
      controller.abort();
      vi.unstubAllEnvs();
    }
  });

  it('does not reflect an untrusted browser origin in the streaming headers', async () => {
    vi.stubEnv('EVENT_STREAM_READY_ENABLED', 'true');
    seedAuth();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/v1/events/stream`, {
        headers: { ...authHeader(), Origin: 'https://untrusted.example' }, signal: controller.signal,
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      vi.unstubAllEnvs();
    }
  });

  it('keeps the initial response timing unchanged when the flag is absent', async () => {
    vi.stubEnv('EVENT_STREAM_READY_ENABLED', undefined);
    seedAuth();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 100);
    try {
      await expect(fetch(`${baseUrl}/v1/events/stream`, {
        headers: authHeader(), signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timeout);
      controller.abort();
      vi.unstubAllEnvs();
    }
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
