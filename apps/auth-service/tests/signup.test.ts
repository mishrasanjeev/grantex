import { describe, it, expect } from 'vitest';
import { buildTestApp, sqlMock, seedAuth, authHeader, TEST_DEVELOPER } from './helpers.js';

describe('POST /v1/signup', () => {
  it('creates a developer and returns 201 with API key', async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();

    // No auth SQL call (skipAuth: true)
    // 1st call: email uniqueness check (no email → skipped)
    // 1st call: INSERT
    sqlMock.mockResolvedValueOnce([{
      id: 'dev_TEST_NEW',
      name: 'Acme Corp',
      email: null,
      mode: 'live',
      created_at: now,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { name: 'Acme Corp' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.developerId).toBe('dev_TEST_NEW');
    expect(body.name).toBe('Acme Corp');
    expect(body.apiKey).toMatch(/^gx_live_/);
    expect(body.mode).toBe('live');
    expect(body.createdAt).toBe(now);
  });

  it('creates a developer with email', async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();

    // 1st call: email uniqueness check
    sqlMock.mockResolvedValueOnce([]);
    // 2nd call: INSERT
    sqlMock.mockResolvedValueOnce([{
      id: 'dev_TEST_EMAIL',
      name: 'Acme Corp',
      email: 'dev@acme.com',
      mode: 'live',
      created_at: now,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { name: 'Acme Corp', email: 'dev@acme.com' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('dev@acme.com');
  });

  it('returns 400 when name is missing', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 409 for duplicate email', async () => {
    const app = await buildTestApp();

    // email uniqueness check returns existing row
    sqlMock.mockResolvedValueOnce([{ id: 'dev_EXISTING' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { name: 'Acme Corp', email: 'taken@acme.com' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });

  it('does not require auth', async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();

    sqlMock.mockResolvedValueOnce([{
      id: 'dev_NO_AUTH',
      name: 'No Auth',
      email: null,
      mode: 'live',
      created_at: now,
    }]);

    // No Authorization header
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { name: 'No Auth' },
    });

    expect(res.statusCode).toBe(201);
  });
});

describe('POST /v1/keys/rotate', () => {
  it('rotates API key and returns 200', async () => {
    const app = await buildTestApp();

    // 1st call: auth check
    seedAuth();
    // 2nd call: UPDATE
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/keys/rotate',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiKey).toMatch(/^gx_live_/);
    expect(body.rotatedAt).toBeDefined();
  });

  it('returns 401 without auth', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/keys/rotate',
    });

    expect(res.statusCode).toBe(401);
  });
});
