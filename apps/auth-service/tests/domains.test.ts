import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/domains', () => {
  it('creates a custom domain for enterprise plan', async () => {
    seedAuth();
    // Subscription query
    sqlMock.mockResolvedValueOnce([{ plan: 'enterprise' }]);
    // Insert domain
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: authHeader(),
      payload: { domain: 'api.example.com' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().domain).toBe('api.example.com');
    expect(res.json().verified).toBe(false);
    expect(res.json().verificationToken).toBeDefined();
    expect(res.json().instructions).toContain('_grantex');
  });

  it('rejects non-enterprise plan', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: authHeader(),
      payload: { domain: 'api.example.com' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 400 for missing domain', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/domains', () => {
  it('lists custom domains', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      { id: 'dom_1', domain: 'api.example.com', verified: true, verified_at: '2026-03-01', created_at: '2026-03-01' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/domains',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().domains).toHaveLength(1);
    expect(res.json().domains[0].domain).toBe('api.example.com');
  });

  it('returns empty list when no domains', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/domains',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().domains).toEqual([]);
  });
});

describe('DELETE /v1/domains/:id', () => {
  it('deletes a custom domain', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'dom_1' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/domains/dom_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown domain', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/domains/dom_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/domains/:id/verify', () => {
  it('returns 404 for unknown domain', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains/dom_nonexistent/verify',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns already verified for verified domains', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'dom_1',
      domain: 'api.example.com',
      verification_token: 'grantex-verify-123',
      verified: true,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains/dom_1/verify',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
  });
});

describe('Dynamic rate limiting', () => {
  it('getRateLimitForPlan returns correct values', async () => {
    const { getRateLimitForPlan } = await import('../src/plugins/dynamicRateLimit.js');
    expect(getRateLimitForPlan('free')).toBe(100);
    expect(getRateLimitForPlan('pro')).toBe(500);
    expect(getRateLimitForPlan('enterprise')).toBe(2000);
    expect(getRateLimitForPlan('unknown')).toBe(100);
  });
});
