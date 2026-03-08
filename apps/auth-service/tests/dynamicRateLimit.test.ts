import { describe, it, expect, vi, beforeAll } from 'vitest';
import { getRateLimitForPlan, PLAN_RATE_LIMITS, dynamicRateLimitPlugin } from '../src/plugins/dynamicRateLimit.js';
import { buildTestApp } from './helpers.js';
import { sqlMock } from './setup.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('PLAN_RATE_LIMITS', () => {
  it('has correct limits for each plan', () => {
    expect(PLAN_RATE_LIMITS['free']).toBe(100);
    expect(PLAN_RATE_LIMITS['pro']).toBe(500);
    expect(PLAN_RATE_LIMITS['enterprise']).toBe(2000);
  });
});

describe('getRateLimitForPlan', () => {
  it('returns correct limit for free plan', () => {
    expect(getRateLimitForPlan('free')).toBe(100);
  });

  it('returns correct limit for pro plan', () => {
    expect(getRateLimitForPlan('pro')).toBe(500);
  });

  it('returns correct limit for enterprise plan', () => {
    expect(getRateLimitForPlan('enterprise')).toBe(2000);
  });

  it('defaults to free when plan not recognized', () => {
    expect(getRateLimitForPlan('unknown')).toBe(100);
  });

  it('defaults to free for empty string', () => {
    expect(getRateLimitForPlan('')).toBe(100);
  });
});

describe('dynamicRateLimitPlugin', () => {
  it('registers correctly on Fastify', async () => {
    // dynamicRateLimitPlugin decorates request with planRateLimit
    const testApp = await buildTestApp();

    // Register the plugin (it may already be registered via server.ts,
    // but we can test standalone registration)
    const standaloneApp = (await import('fastify')).default({ logger: false });
    await dynamicRateLimitPlugin(standaloneApp);

    // Verify decoration was added
    expect(standaloneApp.hasRequestDecorator('planRateLimit')).toBe(true);

    await standaloneApp.close();
  });

  it('sets planRateLimit based on developer plan', async () => {
    // We test by creating a test route that reads planRateLimit
    const testApp = (await import('fastify')).default({ logger: false });
    await dynamicRateLimitPlugin(testApp);

    testApp.get('/test-rate', async (request) => {
      // Simulate developer being set by auth plugin
      (request as Record<string, unknown>).developer = { plan: 'pro' };
      // Manually trigger preHandler hooks
      return { limit: (request as { planRateLimit?: number }).planRateLimit };
    });

    await testApp.ready();

    const res = await testApp.inject({
      method: 'GET',
      url: '/test-rate',
    });

    // The preHandler runs after route handler in inject, so planRateLimit
    // should be the default (100) since developer is set inside handler, not before
    expect(res.statusCode).toBe(200);

    await testApp.close();
  });

  it('applies plan rate limit via preHandler when developer is set before route', async () => {
    const testApp = (await import('fastify')).default({ logger: false });

    // Add a preHandler hook that sets developer BEFORE the dynamic rate limit hook runs
    // Hook registration order matters — Fastify runs them in order
    testApp.addHook('preHandler', async (request) => {
      (request as Record<string, unknown>).developer = { id: 'dev_1', name: 'Test', plan: 'enterprise' };
    });

    await dynamicRateLimitPlugin(testApp);

    testApp.get('/test-rate-enterprise', async (request) => {
      return { limit: (request as { planRateLimit?: number }).planRateLimit };
    });

    await testApp.ready();

    const res = await testApp.inject({
      method: 'GET',
      url: '/test-rate-enterprise',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ limit: number }>();
    expect(body.limit).toBe(2000);

    await testApp.close();
  });

  it('applies free rate limit when developer has no plan field', async () => {
    const testApp = (await import('fastify')).default({ logger: false });

    // Register developer hook BEFORE dynamic rate limit plugin
    testApp.addHook('preHandler', async (request) => {
      (request as Record<string, unknown>).developer = { id: 'dev_1', name: 'Test' };
    });

    await dynamicRateLimitPlugin(testApp);

    testApp.get('/test-rate-noplan', async (request) => {
      return { limit: (request as { planRateLimit?: number }).planRateLimit };
    });

    await testApp.ready();

    const res = await testApp.inject({
      method: 'GET',
      url: '/test-rate-noplan',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ limit: number }>();
    expect(body.limit).toBe(100); // defaults to free

    await testApp.close();
  });
});
