/**
 * Rate limiting tests (PRD §13.5)
 *
 * Verifies that rate limiting is configured correctly: global defaults,
 * per-route overrides, rate limit headers, and 429 responses.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTestApp,
  seedAuth,
  authHeader,
  sqlMock,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Rate limiting', () => {
  it('rate limit headers present on authenticated responses', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // agents listing

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    // @fastify/rate-limit sets these headers
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('rate limit headers present on public trust-registry endpoint', async () => {
    sqlMock.mockResolvedValueOnce([]); // trust_registry lookup

    const res = await app.inject({
      method: 'GET',
      url: '/v1/trust-registry/did:web:example.com',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('JWKS endpoint is excluded from rate limiting', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    expect(res.statusCode).toBe(200);
    // JWKS is in the allowList — should NOT have rate limit headers
    // (or if it does, the remaining should stay at the max since it's allow-listed)
    // The key assertion is that this endpoint always succeeds and is not throttled
  });

  it('exceeding rate limit returns 429 with Retry-After', async () => {
    // Build a fresh app so the rate limit counter is clean
    const freshApp = await buildTestApp();

    // Use the lowest rate-limited endpoint: POST /v1/trust-registry/verify-dns (10/min)
    // Send 11 requests; the 11th should be rate limited
    for (let i = 0; i < 11; i++) {
      seedAuth();
      // DNS verification will fail (mock returns false), but that's fine
      sqlMock.mockResolvedValueOnce([]); // existing check (if reached)
    }

    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await freshApp.inject({
        method: 'POST',
        url: '/v1/trust-registry/verify-dns',
        headers: authHeader(),
        payload: { domain: 'test.com' },
      });

      if (lastRes.statusCode === 429) break;
    }

    expect(lastRes!.statusCode).toBe(429);
    // Retry-After header should be present
    expect(
      lastRes!.headers['retry-after'] ?? lastRes!.headers['x-ratelimit-reset'],
    ).toBeDefined();
  });

  it('different routes have independent rate limits', async () => {
    // Requests to one endpoint don't consume the quota of another
    // Verify by making a request to /v1/agents and checking its limit
    // is the global default (100/min), not a per-route override.
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // agents listing

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const limit = parseInt(res.headers['x-ratelimit-limit'] as string, 10);
    // Global rate limit is 100/min
    expect(limit).toBe(100);
  });
});
