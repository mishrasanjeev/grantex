import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import {
  dynamicRateLimitPlugin,
  getRateLimitForPlan,
  PLAN_RATE_LIMITS,
  PLAN_RATE_LIMIT_WINDOW_SECONDS,
} from '../src/plugins/dynamicRateLimit.js';
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
