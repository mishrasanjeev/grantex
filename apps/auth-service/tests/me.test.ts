import { describe, it, expect } from 'vitest';
import { buildTestApp, sqlMock, seedAuth, authHeader, TEST_DEVELOPER } from './helpers.js';

describe('GET /v1/me', () => {
  it('returns developer info with plan', async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();

    // 1st call: auth check
    seedAuth();
    // 2nd call: SELECT developer + subscription
    sqlMock.mockResolvedValueOnce([{
      id: TEST_DEVELOPER.id,
      name: TEST_DEVELOPER.name,
      email: 'dev@example.com',
      mode: 'live',
      plan: 'pro',
      created_at: now,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.developerId).toBe(TEST_DEVELOPER.id);
    expect(body.name).toBe(TEST_DEVELOPER.name);
    expect(body.email).toBe('dev@example.com');
    expect(body.mode).toBe('live');
    expect(body.plan).toBe('pro');
    expect(body.createdAt).toBe(now);
  });

  it('defaults plan to free when no subscription', async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();

    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: TEST_DEVELOPER.id,
      name: TEST_DEVELOPER.name,
      email: null,
      mode: 'live',
      plan: null,
      created_at: now,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toBe('free');
    expect(res.json().email).toBeNull();
  });

  it('returns 401 without auth', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
    });

    expect(res.statusCode).toBe(401);
  });
});
