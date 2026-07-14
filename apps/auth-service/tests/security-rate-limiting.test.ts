/**
 * Rate limiting tests (PRD §13.5)
 *
 * Verifies layered IP, route, and standard-auth developer plan limits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTestApp,
  seedAuth,
  authHeader,
  sqlMock,
  TEST_DEVELOPER,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Rate limiting', () => {
  it('returns the free-plan budget on standard developer API-key responses', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBe('99');
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('keeps the highest plan budget below the pre-auth IP ceiling', async () => {
    sqlMock.mockResolvedValueOnce([{ ...TEST_DEVELOPER, plan: 'enterprise' }]);
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('2000');
    expect(res.headers['x-ratelimit-remaining']).toBe('1999');
  });

  it('keeps public endpoints on the IP-based limiter', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/trust-registry/did:web:example.com',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-ratelimit-limit']).toBe('5000');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('keeps the JWKS endpoint exempt from throttling', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
  });

  it('uses forwarded client IPs only through an explicitly trusted proxy', async () => {
    const directApp = await buildTestApp({ trustProxy: false });
    const trustedApp = await buildTestApp({ trustProxy: ['127.0.0.1'] });

    directApp.get('/__test/direct-client-ip', { config: { skipAuth: true } }, async (request) => ({
      ip: request.ip,
    }));
    trustedApp.get('/__test/trusted-client-ip', { config: { skipAuth: true } }, async (request) => ({
      ip: request.ip,
    }));

    try {
      const directA = await directApp.inject({
        method: 'GET',
        url: '/__test/direct-client-ip',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      const directB = await directApp.inject({
        method: 'GET',
        url: '/__test/direct-client-ip',
        headers: { 'x-forwarded-for': '198.51.100.11' },
      });
      expect(directA.json()).toEqual({ ip: '127.0.0.1' });
      expect(directB.json()).toEqual({ ip: '127.0.0.1' });
      expect(directA.headers['x-ratelimit-remaining']).toBe('4999');
      expect(directB.headers['x-ratelimit-remaining']).toBe('4998');

      const trustedA = await trustedApp.inject({
        method: 'GET',
        url: '/__test/trusted-client-ip',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      const trustedB = await trustedApp.inject({
        method: 'GET',
        url: '/__test/trusted-client-ip',
        headers: { 'x-forwarded-for': '198.51.100.11' },
      });
      expect(trustedA.json()).toEqual({ ip: '198.51.100.10' });
      expect(trustedB.json()).toEqual({ ip: '198.51.100.11' });
      expect(trustedA.headers['x-ratelimit-remaining']).toBe('4999');
      expect(trustedB.headers['x-ratelimit-remaining']).toBe('4999');
    } finally {
      await directApp.close();
      await trustedApp.close();
    }
  });

  it('returns 429 with Retry-After when a route limit is exceeded', async () => {
    const freshApp = await buildTestApp();
    for (let i = 0; i < 11; i++) seedAuth();

    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await freshApp.inject({
        method: 'POST',
        url: '/v1/trust-registry/verify-dns',
        headers: authHeader(),
        payload: {},
      });
      if (lastRes.statusCode === 429) break;
    }

    expect(lastRes!.statusCode).toBe(429);
    expect(lastRes!.headers['retry-after'] ?? lastRes!.headers['x-ratelimit-reset']).toBeDefined();
  });
});
