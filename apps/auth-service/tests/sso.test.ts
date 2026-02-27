import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Mock DB rows ──────────────────────────────────────────────────────────

const SSO_CONFIG_ROW = {
  developer_id: 'dev_TEST',
  issuer_url: 'https://idp.example.com',
  client_id: 'client_abc',
  client_secret: 'secret_xyz',
  redirect_uri: 'https://app.grantex.dev/sso/callback',
  created_at: '2026-02-27T00:00:00Z',
  updated_at: '2026-02-27T00:00:00Z',
};

// ─── SSO config management ─────────────────────────────────────────────────

describe('POST /v1/sso/config', () => {
  it('creates SSO config and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/config',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {
        issuerUrl: 'https://idp.example.com',
        clientId: 'client_abc',
        clientSecret: 'secret_xyz',
        redirectUri: 'https://app.grantex.dev/sso/callback',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ issuerUrl: string; clientId: string; redirectUri: string }>();
    expect(body.issuerUrl).toBe('https://idp.example.com');
    expect(body.clientId).toBe('client_abc');
    expect(body.redirectUri).toBe('https://app.grantex.dev/sso/callback');
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/config',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { issuerUrl: 'https://idp.example.com' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/sso/config', () => {
  it('returns SSO config without client secret', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/config',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ issuerUrl: string; clientId: string; clientSecret?: string }>();
    expect(body.issuerUrl).toBe('https://idp.example.com');
    expect(body.clientSecret).toBeUndefined();
  });

  it('returns 404 when not configured', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/config',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/sso/config', () => {
  it('removes SSO config and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ developer_id: 'dev_TEST' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/config',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when config does not exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/config',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── SSO flow (public routes) ──────────────────────────────────────────────

describe('GET /sso/login', () => {
  it('returns OIDC authorize URL with correct params', async () => {
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_TEST',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ authorizeUrl: string }>();
    expect(body.authorizeUrl).toContain('https://idp.example.com/authorize');
    expect(body.authorizeUrl).toContain('client_id=client_abc');
    expect(body.authorizeUrl).toContain('response_type=code');
    expect(body.authorizeUrl).toContain('openid');
    expect(body.authorizeUrl).toContain('state=');
  });

  it('returns 400 when org param is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sso/login',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when org has no SSO config', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_UNKNOWN',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /sso/callback', () => {
  it('exchanges code and returns user info', async () => {
    const state = Buffer.from(JSON.stringify({ org: 'dev_TEST' })).toString('base64url');
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    // Mock the IdP token endpoint
    const idTokenPayload = Buffer.from(
      JSON.stringify({ sub: 'idp_user_01', email: 'alice@corp.com', name: 'Alice Smith' }),
    ).toString('base64url');
    const mockIdToken = `header.${idTokenPayload}.sig`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: mockIdToken, access_token: 'at_xxx' }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=auth_code_xyz&state=${state}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ email: string; name: string; developerId: string }>();
    expect(body.email).toBe('alice@corp.com');
    expect(body.name).toBe('Alice Smith');
    expect(body.developerId).toBe('dev_TEST');
  });

  it('returns 400 when code or state is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sso/callback?code=xyz',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid state encoding', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sso/callback?code=xyz&state=!!notbase64!!',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when IdP token exchange fails', async () => {
    const state = Buffer.from(JSON.stringify({ org: 'dev_TEST' })).toString('base64url');
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=bad_code&state=${state}`,
    });

    expect(res.statusCode).toBe(502);
  });
});
