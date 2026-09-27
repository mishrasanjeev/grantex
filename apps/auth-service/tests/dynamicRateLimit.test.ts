import Fastify from 'fastify';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  CONTAINMENT_LIMITER_TIMEOUT_MS,
  CONTAINMENT_RATE_LIMIT,
  dynamicRateLimitPlugin,
  getRateLimitForPlan,
  PLAN_RATE_LIMITS,
  PLAN_RATE_LIMIT_WINDOW_SECONDS,
  STATUS_RATE_LIMIT,
} from '../src/plugins/dynamicRateLimit.js';
import { checkLocalRateLimit, resetLocalRateLimits } from '../src/lib/rate-limit.js';
import { rateLimitDecisionsTotal } from '../src/lib/metrics.js';
import { mockRedis } from './helpers.js';

async function buildPlanApp(plan: string | undefined = 'free') {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    (request as unknown as Record<string, unknown>).developer = {
      id: 'dev_1',
      name: 'Test Developer',
      mode: 'live',
      ...(plan === undefined ? {} : { plan }),
    };
  });
  await dynamicRateLimitPlugin(app);
  app.get('/test-rate', async (request) => ({ limit: request.planRateLimit }));
  await app.ready();
  return app;
}

describe('PLAN_RATE_LIMITS', () => {
  it('defines one-minute throughput for every plan', () => {
    expect(PLAN_RATE_LIMITS).toEqual({ free: 100, pro: 500, enterprise: 2000 });
    expect(PLAN_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });
});

describe('getRateLimitForPlan', () => {
  it.each([
    ['free', 100],
    ['pro', 500],
    ['enterprise', 2000],
    ['unknown', 100],
    ['', 100],
  ])('maps %s to %i requests per minute', (plan, expected) => {
    expect(getRateLimitForPlan(plan)).toBe(expected);
  });
});

describe('dynamicRateLimitPlugin', () => {
  it('registers the request decorator', async () => {
    const app = Fastify({ logger: false });
    await dynamicRateLimitPlugin(app);
    expect(app.hasRequestDecorator('planRateLimit')).toBe(true);
    await app.close();
  });

  it('enforces the standard-auth developer plan and returns budget headers', async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    const app = await buildPlanApp('pro');
    const response = await app.inject({ method: 'GET', url: '/test-rate' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ limit: 500 });
    expect(response.headers['x-ratelimit-limit']).toBe('500');
    expect(response.headers['x-ratelimit-remaining']).toBe('499');
    expect(Number(response.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    expect(mockRedis.incr).toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:developer:dev_1:plan:\d+$/),
    );
    await app.close();
  });

  it('defaults unrecognized plans to the free budget', async () => {
    const app = await buildPlanApp('legacy-plan');
    const response = await app.inject({ method: 'GET', url: '/test-rate' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe('100');
    await app.close();
  });

  it('returns a structured 429 after the plan budget is exhausted', async () => {
    mockRedis.incr.mockResolvedValueOnce(101);
    const app = await buildPlanApp('free');
    const response = await app.inject({ method: 'GET', url: '/test-rate' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(response.headers['x-ratelimit-limit']).toBe('100');
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('does not consume a plan budget without standard developer context', async () => {
    const app = Fastify({ logger: false });
    await dynamicRateLimitPlugin(app);
    app.get('/public', async () => ({ ok: true }));
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/public' });

    expect(response.statusCode).toBe(200);
    expect(mockRedis.incr).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails closed when the counter transaction cannot set its expiry', async () => {
    mockRedis.expire.mockRejectedValueOnce(new Error('redis unavailable'));
    const app = await buildPlanApp('enterprise');
    const response = await app.inject({ method: 'GET', url: '/test-rate' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    await app.close();
  });
});

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

async function buildClassApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    (request as unknown as Record<string, unknown>).developer = {
      id: 'dev_1',
      name: 'Test Developer',
      mode: 'live',
      plan: 'free',
    };
  });
  await dynamicRateLimitPlugin(app);
  app.get('/ordinary', async () => ({ ok: true }));
  app.delete('/revoke', { config: { rateLimitClass: 'containment' } }, async () => ({ ok: true }));
  app.get('/feed', { config: { rateLimitClass: 'status' } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('route rate-limit classes', () => {
  beforeEach(() => {
    resetLocalRateLimits();
    vi.mocked(rateLimitDecisionsTotal.inc).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('counts a containment route in its own bucket, never the plan bucket', async () => {
    const app = await buildClassApp();
    const response = await app.inject({ method: 'DELETE', url: '/revoke' });

    expect(response.statusCode).toBe(200);
    expect(bucketsCounted()).toEqual(['containment']);
    expect(mockRedis.incr).toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:developer:dev_1:containment:\d+$/),
    );
    expect(response.headers['x-ratelimit-limit']).toBe(String(CONTAINMENT_RATE_LIMIT));
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'containment', outcome: 'allowed' });
    await app.close();
  });

  it('lets a revocation through when the plan bucket is exhausted', async () => {
    countPerBucket({ plan: PLAN_RATE_LIMITS.free + 1 });
    const app = await buildClassApp();

    const ordinary = await app.inject({ method: 'GET', url: '/ordinary' });
    expect(ordinary.statusCode).toBe(429);

    const revoke = await app.inject({ method: 'DELETE', url: '/revoke' });
    expect(revoke.statusCode).toBe(200);
    await app.close();
  });

  it('keeps a containment ceiling: past it a revocation is refused with 429', async () => {
    countPerBucket({ containment: CONTAINMENT_RATE_LIMIT + 1 });
    const app = await buildClassApp();
    const response = await app.inject({ method: 'DELETE', url: '/revoke' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(response.headers['x-ratelimit-limit']).toBe(String(CONTAINMENT_RATE_LIMIT));
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'containment', outcome: 'limited' });
    await app.close();
  });

  it('fails a revocation open when the limiter is unavailable, and every other route closed', async () => {
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    const app = await buildClassApp();

    const revoke = await app.inject({ method: 'DELETE', url: '/revoke' });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.headers['x-ratelimit-limit']).toBe(String(CONTAINMENT_RATE_LIMIT));
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'containment', outcome: 'local_allowed' });

    const ordinary = await app.inject({ method: 'GET', url: '/ordinary' });
    expect(ordinary.statusCode).toBe(503);
    expect(ordinary.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'plan', outcome: 'unavailable' });

    const feed = await app.inject({ method: 'GET', url: '/feed' });
    expect(feed.statusCode).toBe(503);
    expect(feed.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'status', outcome: 'unavailable' });
    await app.close();
  });

  it('does not hold a revocation behind a limiter that never answers', async () => {
    // A blackholed Redis does not refuse a command; the client queues it and
    // retries for minutes. The revocation must not wait that long to commit.
    mockRedis.incr.mockImplementation(() => new Promise(() => {}));
    const app = await buildClassApp();
    const started = Date.now();
    const revoke = await app.inject({ method: 'DELETE', url: '/revoke' });

    expect(revoke.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(CONTAINMENT_LIMITER_TIMEOUT_MS + 1_000);
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'containment', outcome: 'local_allowed' });
    await app.close();
  });

  it('still bounds revocations on each instance while the limiter is unavailable', async () => {
    // Pin the clock inside one window so the counter cannot roll over mid-test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    for (let index = 0; index < CONTAINMENT_RATE_LIMIT; index += 1) {
      checkLocalRateLimit('developer:dev_1:containment', CONTAINMENT_RATE_LIMIT, PLAN_RATE_LIMIT_WINDOW_SECONDS);
    }
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    const app = await buildClassApp();
    const response = await app.inject({ method: 'DELETE', url: '/revoke' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(response.headers['retry-after']).toBe('55');
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'containment', outcome: 'local_limited' });
    await app.close();
  });

  it('counts feed and status reads in their own bucket, never the plan bucket', async () => {
    countPerBucket({ plan: PLAN_RATE_LIMITS.free + 1 });
    const app = await buildClassApp();
    const response = await app.inject({ method: 'GET', url: '/feed' });

    expect(response.statusCode).toBe(200);
    expect(bucketsCounted()).toEqual(['status']);
    expect(response.headers['x-ratelimit-limit']).toBe(String(STATUS_RATE_LIMIT));
    await app.close();
  });

  it('refuses feed reads past the status ceiling', async () => {
    countPerBucket({ status: STATUS_RATE_LIMIT + 1 });
    const app = await buildClassApp();
    const response = await app.inject({ method: 'GET', url: '/feed' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(rateLimitDecisionsTotal.inc).toHaveBeenCalledWith({ bucket: 'status', outcome: 'limited' });
    await app.close();
  });

  it('sizes both buckets at or above every plan, so no plan loses containment or polling throughput', () => {
    const largestPlan = Math.max(...Object.values(PLAN_RATE_LIMITS));
    expect(CONTAINMENT_RATE_LIMIT).toBeGreaterThanOrEqual(largestPlan);
    expect(STATUS_RATE_LIMIT).toBeGreaterThanOrEqual(largestPlan);
  });

  it('puts every route back in the plan bucket, failing closed, when RATE_LIMIT_ROUTE_CLASSES_ENABLED=false', async () => {
    vi.stubEnv('RATE_LIMIT_ROUTE_CLASSES_ENABLED', 'false');
    countPerBucket({ plan: PLAN_RATE_LIMITS.free + 1 });
    const app = await buildClassApp();

    const limited = await app.inject({ method: 'DELETE', url: '/revoke' });
    expect(limited.statusCode).toBe(429);
    expect(bucketsCounted()).toEqual(['plan']);

    mockRedis.incr.mockReset();
    mockRedis.incr.mockRejectedValue(new Error('redis unavailable'));
    const unavailable = await app.inject({ method: 'DELETE', url: '/revoke' });
    expect(unavailable.statusCode).toBe(503);
    await app.close();
  });
});

describe('checkLocalRateLimit', () => {
  beforeEach(() => {
    resetLocalRateLimits();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts per identifier within a window and refuses past the maximum', () => {
    expect(checkLocalRateLimit('developer:a:containment', 2, 60)).toEqual({ allowed: true, remaining: 1, resetSeconds: 50 });
    expect(checkLocalRateLimit('developer:a:containment', 2, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect(checkLocalRateLimit('developer:a:containment', 2, 60)).toMatchObject({ allowed: false, remaining: 0 });
    expect(checkLocalRateLimit('developer:b:containment', 2, 60)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('starts again in the next window', () => {
    for (let index = 0; index < 3; index += 1) checkLocalRateLimit('developer:a:containment', 2, 60);
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect(checkLocalRateLimit('developer:a:containment', 2, 60)).toEqual({ allowed: true, remaining: 1, resetSeconds: 60 });
  });
});
