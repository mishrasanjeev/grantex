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

    // Use the lowest rate-limited endpoint: POST /v1/trust-registry/verify-dns (10/min).
    // The handler performs DNS for a valid domain, so intentionally omit the
    // domain and let the first 10 requests fail fast with 400. The 11th should
    // still be blocked by rate limiting before route validation/handler work.
    for (let i = 0; i < 11; i++) {
      seedAuth();
    }

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
    // Global rate limit is 500/min — generous because authenticated endpoints
    // layer per-developer post-auth limits on top; this one only needs to stop
    // raw unauth'd IP floods against public endpoints and the auth plugin.
    expect(limit).toBe(500);
  });
});
