import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── Mock DB rows ──────────────────────────────────────────────────────────

const SCIM_TOKEN_ROW = {
  id: 'scimtok_01',
  developer_id: 'dev_TEST',
};

const SCIM_USER_ROW = {
  id: 'scimuser_01',
  external_id: 'ext_abc',
  user_name: 'alice@corp.com',
  display_name: 'Alice Smith',
  active: true,
  emails: [{ value: 'alice@corp.com', primary: true }],
  created_at: '2026-02-27T00:00:00Z',
  updated_at: '2026-02-27T00:00:00Z',
};

/** Seeds a SCIM bearer token lookup (first SQL call in SCIM 2.0 routes) */
function seedScimToken() {
  sqlMock.mockResolvedValueOnce([SCIM_TOKEN_ROW]);
}

// ─── SCIM token management ─────────────────────────────────────────────────

describe('POST /v1/scim/tokens', () => {
  it('creates a SCIM token and returns the raw token once', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'scimtok_01', label: 'Okta', created_at: '2026-02-27T00:00:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/scim/tokens',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { label: 'Okta' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; label: string; token: string; createdAt: string }>();
    expect(body.id).toBe('scimtok_01');
    expect(body.label).toBe('Okta');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(16);
    expect(body.createdAt).toBeDefined();
  });

  it('returns 400 when label is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/scim/tokens',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/scim/tokens', () => {
  it('returns list of tokens without raw secret', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      { id: 'scimtok_01', label: 'Okta', created_at: '2026-02-27T00:00:00Z', last_used_at: null },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scim/tokens',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tokens: Array<{ id: string; label: string; token?: string }> }>();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]!.id).toBe('scimtok_01');
    expect(body.tokens[0]!.token).toBeUndefined();
  });
});

describe('DELETE /v1/scim/tokens/:id', () => {
  it('revokes a token and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'scimtok_01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/scim/tokens/scimtok_01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown token', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/scim/tokens/scimtok_missing',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── SCIM 2.0 ServiceProviderConfig (public) ──────────────────────────────

describe('GET /scim/v2/ServiceProviderConfig', () => {
  it('returns capabilities without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/ServiceProviderConfig',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ patch: { supported: boolean }; authenticationSchemes: unknown[] }>();
    expect(body.patch.supported).toBe(true);
    expect(body.authenticationSchemes.length).toBeGreaterThan(0);
  });
});

// ─── SCIM 2.0 Users ───────────────────────────────────────────────────────

describe('GET /scim/v2/Users', () => {
  it('lists users with SCIM list response format', async () => {
    seedScimToken();                                          // token lookup
    sqlMock.mockResolvedValueOnce([SCIM_USER_ROW]);           // users query
    sqlMock.mockResolvedValueOnce([{ total: '1' }]);          // count query

    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer scim-test-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      totalResults: number;
      startIndex: number;
      Resources: Array<{ id: string; userName: string; active: boolean }>;
    }>();
    expect(body.totalResults).toBe(1);
    expect(body.startIndex).toBe(1);
    expect(body.Resources[0]!.userName).toBe('alice@corp.com');
    expect(body.Resources[0]!.active).toBe(true);
  });

  it('returns 401 with no Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with invalid SCIM token', async () => {
    sqlMock.mockResolvedValueOnce([]); // empty = invalid token

    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /scim/v2/Users', () => {
  it('provisions a new user and returns 201', async () => {
    seedScimToken();
    sqlMock.mockResolvedValueOnce([SCIM_USER_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer scim-test-token', 'content-type': 'application/json' },
      payload: {
        userName: 'alice@corp.com',
        displayName: 'Alice Smith',
        externalId: 'ext_abc',
        emails: [{ value: 'alice@corp.com', primary: true }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; userName: string; meta: { resourceType: string } }>();
    expect(body.id).toBe('scimuser_01');
    expect(body.userName).toBe('alice@corp.com');
    expect(body.meta.resourceType).toBe('User');
  });

  it('returns 400 when userName is missing', async () => {
    seedScimToken();

    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer scim-test-token', 'content-type': 'application/json' },
      payload: { displayName: 'No Username' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /scim/v2/Users/:id', () => {
  it('returns a single user', async () => {
    seedScimToken();
    sqlMock.mockResolvedValueOnce([SCIM_USER_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users/scimuser_01',
      headers: { authorization: 'Bearer scim-test-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe('scimuser_01');
  });

  it('returns 404 for unknown user', async () => {
    seedScimToken();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users/scimuser_missing',
      headers: { authorization: 'Bearer scim-test-token' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /scim/v2/Users/:id', () => {
  it('replaces a user and returns updated resource', async () => {
    const updated = { ...SCIM_USER_ROW, display_name: 'Alice Updated', updated_at: '2026-02-27T01:00:00Z' };
    seedScimToken();
    sqlMock.mockResolvedValueOnce([updated]);

    const res = await app.inject({
      method: 'PUT',
      url: '/scim/v2/Users/scimuser_01',
      headers: { authorization: 'Bearer scim-test-token', 'content-type': 'application/json' },
      payload: { userName: 'alice@corp.com', displayName: 'Alice Updated', active: true, emails: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ displayName: string }>().displayName).toBe('Alice Updated');
  });
});

describe('PATCH /scim/v2/Users/:id', () => {
  it('applies Operations and returns updated user', async () => {
    const deactivated = { ...SCIM_USER_ROW, active: false, updated_at: '2026-02-27T02:00:00Z' };
    seedScimToken();
    sqlMock.mockResolvedValueOnce([deactivated]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/scimuser_01',
      headers: { authorization: 'Bearer scim-test-token', 'content-type': 'application/json' },
      payload: { Operations: [{ op: 'replace', path: 'active', value: false }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ active: boolean }>().active).toBe(false);
  });
});

describe('DELETE /scim/v2/Users/:id', () => {
  it('deprovisions a user and returns 204', async () => {
    seedScimToken();
    sqlMock.mockResolvedValueOnce([{ id: 'scimuser_01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/scim/v2/Users/scimuser_01',
      headers: { authorization: 'Bearer scim-test-token' },
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when user does not exist', async () => {
    seedScimToken();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/scim/v2/Users/scimuser_missing',
      headers: { authorization: 'Bearer scim-test-token' },
    });

    expect(res.statusCode).toBe(404);
  });
});
