import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/policies/sync', () => {
  it('uploads a policy bundle', async () => {
    seedAuth();
    // Deactivate previous
    sqlMock.mockResolvedValueOnce([]);
    // Insert bundle
    sqlMock.mockResolvedValueOnce([]);

    const content = Buffer.from('package grantex.authz\ndefault allow = false').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync',
      headers: authHeader(),
      payload: { format: 'rego', version: '1.0.0', content },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.bundleId).toBeDefined();
    expect(body.format).toBe('rego');
    expect(body.version).toBe('1.0.0');
    expect(body.sha256).toBeDefined();
    expect(body.activated).toBe(true);
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid format', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync',
      headers: authHeader(),
      payload: { format: 'unknown', version: '1.0', content: 'dGVzdA==' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('uploads cedar bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const content = Buffer.from('permit(principal, action, resource);').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync',
      headers: authHeader(),
      payload: { format: 'cedar', version: '2.0.0', content, fileCount: 3 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().format).toBe('cedar');
    expect(res.json().fileCount).toBe(3);
  });

  it('allows upload without activation', async () => {
    seedAuth();
    // Insert bundle (no deactivation since activate=false)
    sqlMock.mockResolvedValueOnce([]);

    const content = Buffer.from('test').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync',
      headers: authHeader(),
      payload: { format: 'rego', version: '1.0.1', content, activate: false },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().activated).toBe(false);
  });
});

describe('GET /v1/policies/bundles', () => {
  it('lists bundles', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      { id: 'pbnd_1', developer_id: 'dev_TEST', format: 'rego', version: '1.0.0', sha256: 'abc', file_count: 1, active: true, created_at: new Date() },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/bundles',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().bundles).toHaveLength(1);
  });

  it('filters by format', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/bundles?format=cedar',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().bundles).toEqual([]);
  });
});

describe('GET /v1/policies/bundles/active', () => {
  it('returns active bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      { id: 'pbnd_1', developer_id: 'dev_TEST', format: 'rego', version: '1.0.0', sha256: 'abc', file_count: 2, active: true, created_at: new Date() },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/bundles/active?format=rego',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('pbnd_1');
  });

  it('returns 404 when no active bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/bundles/active?format=rego',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for missing format', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies/bundles/active',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/policies/sync/webhook', () => {
  it('acknowledges webhook', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/sync/webhook',
      headers: authHeader(),
      payload: { ref: 'refs/heads/main', repository: { full_name: 'org/policies' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ref).toBe('refs/heads/main');
  });
});
