// SPDX-License-Identifier: Apache-2.0
/**
 * Containment and revocation-status routes are rate limited in buckets of
 * their own, not the developer's plan bucket. A revocation must not wait out
 * a quota that ordinary traffic used up, nor fail because the limiter's Redis
 * is unreachable; an SDK polling the revocation feed must not be starved by
 * the tenant's other calls. Ordinary routes keep the plan bucket and still
 * fail closed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  authHeader,
  seedAuth,
  sqlMock,
  mockRedis,
  TEST_DEVELOPER,
  TEST_GRANT,
} from './helpers.js';
import { CONTAINMENT_RATE_LIMIT, PLAN_RATE_LIMITS } from '../src/plugins/dynamicRateLimit.js';
import { resetFeedReadyCache } from '../src/lib/revocation-feed/store.js';

let app: FastifyInstance;

type Bucket = 'plan' | 'containment' | 'status';
const BUCKET_KEY = /^ratelimit:developer:[^:]+:([a-z]+):\d+$/;

/** Answer each bucket's counter with a fixed count, so one bucket can be exhausted while the others are not. */
function countPerBucket(counts: Partial<Record<Bucket, number>>): void {
  mockRedis.incr.mockImplementation(async (key: string) => {
    const bucket = BUCKET_KEY.exec(key)?.[1] as Bucket | undefined;
    return (bucket && counts[bucket]) ?? 1;
  });
}

function bucketsCounted(): string[] {
  return mockRedis.incr.mock.calls
    .map(([key]) => BUCKET_KEY.exec(String(key))?.[1])
    .filter((bucket): bucket is string => bucket !== undefined);
}

/** The free plan's whole minute, already spent by ordinary traffic. */
const PLAN_EXHAUSTED = { plan: PLAN_RATE_LIMITS.free + 1 };

function seedRevoke(): void {
  seedAuth();
  sqlMock.mockResolvedValueOnce([]); // shared delegate/revoke advisory lock
  sqlMock.mockResolvedValueOnce([TEST_GRANT]); // the root grant
  sqlMock.mockResolvedValueOnce([]); // no descendants
}

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('revoking a grant', () => {
  it('succeeds when the plan bucket is exhausted', async () => {
    countPerBucket(PLAN_EXHAUSTED);
    seedRevoke();

    const res = await app.inject({ method: 'DELETE', url: `/v1/grants/${TEST_GRANT.id}`, headers: authHeader() });

    expect(res.statusCode).toBe(204);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(bucketsCounted()).toEqual(['containment']);
  });

  it('succeeds when the Redis limiter is down', async () => {
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    seedRevoke();

    const res = await app.inject({ method: 'DELETE', url: `/v1/grants/${TEST_GRANT.id}`, headers: authHeader() });

    expect(res.statusCode).toBe(204);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
  });

  it('commits promptly when the Redis limiter never answers', async () => {
    mockRedis.incr.mockImplementation(() => new Promise(() => {}));
    seedRevoke();
    const started = Date.now();

    const res = await app.inject({ method: 'DELETE', url: `/v1/grants/${TEST_GRANT.id}`, headers: authHeader() });

    expect(res.statusCode).toBe(204);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('is still refused past the containment ceiling, before anything is revoked', async () => {
    countPerBucket({ containment: CONTAINMENT_RATE_LIMIT + 1 });
    seedAuth();

    const res = await app.inject({ method: 'DELETE', url: `/v1/grants/${TEST_GRANT.id}`, headers: authHeader() });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(res.headers['x-ratelimit-limit']).toBe(String(CONTAINMENT_RATE_LIMIT));
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });
});

describe('ordinary routes', () => {
  it('are still refused with 503 when the limiter is down, before the handler runs', async () => {
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    seedAuth();

    const res = await app.inject({ method: 'GET', url: '/v1/grants', headers: authHeader() });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    // The auth lookup only: the grant query never ran.
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('still share the plan bucket, including resuming a suspension', async () => {
    countPerBucket(PLAN_EXHAUSTED);
    seedAuth();

    const res = await app.inject({ method: 'POST', url: `/v1/grants/${TEST_GRANT.id}/resume`, headers: authHeader() });

    expect(res.statusCode).toBe(429);
    expect(bucketsCounted()).toEqual(['plan']);
  });

  // They can mark grants revoked, but they are compliance operations, not
  // the incident path: see the comments on the routes in routes/dpdp.ts.
  it.each([
    { name: 'DPDP consent withdrawal', url: '/v1/dpdp/consent-records/dpdp_UNKNOWN/withdraw', payload: { reason: 'withdrawn', revokeGrant: true } },
    { name: 'DPDP erasure', url: '/v1/dpdp/data-principals/user_UNKNOWN/erasure', payload: {} },
  ])('keep the plan bucket, and fail closed, for $name', async (route) => {
    countPerBucket(PLAN_EXHAUSTED);
    seedAuth();

    const limited = await app.inject({ method: 'POST', url: route.url, headers: authHeader(), payload: route.payload });

    expect(limited.statusCode).toBe(429);
    expect(bucketsCounted()).toEqual(['plan']);

    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    seedAuth();

    const unavailable = await app.inject({ method: 'POST', url: route.url, headers: authHeader(), payload: route.payload });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });
});

describe('every containment route', () => {
  const routes: Array<{ name: string; method: 'DELETE' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
    { name: 'DELETE /v1/grants/:id', method: 'DELETE', url: '/v1/grants/grnt_UNKNOWN' },
    { name: 'POST /v1/tokens/revoke', method: 'POST', url: '/v1/tokens/revoke', payload: { jti: 'tok_UNKNOWN' } },
    { name: 'POST /v1/emergency-stop', method: 'POST', url: '/v1/emergency-stop', payload: {} },
    { name: 'POST /v1/passport/:id/revoke', method: 'POST', url: '/v1/passport/pp_UNKNOWN/revoke', payload: {} },
    { name: 'POST /v1/consent-bundles/:id/revoke', method: 'POST', url: '/v1/consent-bundles/cb_UNKNOWN/revoke', payload: {} },
  ];

  it.each(routes)('$name draws on the containment bucket, not the exhausted plan bucket', async (route) => {
    countPerBucket(PLAN_EXHAUSTED);
    seedAuth();

    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: authHeader(),
      ...(route.payload ? { payload: route.payload } : {}),
    });

    expect(res.statusCode).not.toBe(429);
    expect(res.statusCode).not.toBe(503);
    expect(bucketsCounted()).toEqual(['containment']);
  });

  it.each(routes)('$name is not refused when the limiter is down', async (route) => {
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    seedAuth();

    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: authHeader(),
      ...(route.payload ? { payload: route.payload } : {}),
    });

    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).not.toBe(429);
  });
});

describe('revocation feed and status reads', () => {
  beforeEach(() => {
    resetFeedReadyCache();
    vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
      if (text.includes('FROM pg_trigger')) return [{ present: true }];
      if (/SELECT MAX\(seq\)/.test(text)) return [{ cursor: '7' }];
      return [];
    });
  });

  it.each([
    '/v1/revocations',
    '/v1/revocations?since=7',
    `/v1/revocations/status?grantId=${TEST_GRANT.id}`,
    '/v1/consent-bundles/cb_UNKNOWN/revocation-status',
  ])('GET %s does not consume the plan bucket', async (url) => {
    countPerBucket(PLAN_EXHAUSTED);

    const res = await app.inject({ method: 'GET', url, headers: authHeader() });

    expect(res.statusCode).not.toBe(429);
    expect(bucketsCounted()).toEqual(['status']);
  });

  it('counts the stream in the status bucket too', async () => {
    // Answered before the stream is opened, so inject() can see it; the
    // limiter has already run by then.
    vi.stubEnv('REVOCATION_FEED_ENABLED', 'false');
    countPerBucket(PLAN_EXHAUSTED);

    const res = await app.inject({ method: 'GET', url: '/v1/revocations/stream', headers: authHeader() });

    expect(res.statusCode).toBe(404);
    expect(bucketsCounted()).toEqual(['status']);
  });

  it('keep their per-address limits, and still fail closed when the limiter is down', async () => {
    // With the status bucket unreachable the plugin sets no headers of its
    // own, so the limit headers left on the response are the per-address
    // policy's: proof that it still applies to the route.
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    for (const [url, limit] of [
      ['/v1/revocations', '600'],
      [`/v1/revocations/status?grantId=${TEST_GRANT.id}`, '1200'],
      ['/v1/revocations/stream', '120'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url, headers: authHeader() });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
      expect(res.headers['x-ratelimit-limit']).toBe(limit);
    }
  });
});
