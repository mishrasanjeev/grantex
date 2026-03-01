import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryClientStore } from '../src/lib/clients.js';
import type { McpAuthConfig } from '../src/types.js';

const TEST_CLIENT_ID = 'test-client-id';
const TEST_REDIRECT_URI = 'https://app.example.com/callback';
const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const TEST_CHALLENGE = createHash('sha256').update(TEST_VERIFIER).digest('base64url');

function createMockGrantex() {
  return {
    authorize: vi.fn().mockResolvedValue({
      authRequestId: 'auth-req-1',
      consentUrl: 'https://example.com/consent',
      agentId: 'agent-1',
      principalId: 'principal-1',
      scopes: ['read', 'write'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }),
    tokens: {
      exchange: vi.fn().mockResolvedValue({
        grantToken: 'gt_test_token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test_refresh',
        grantId: 'grant-1',
      }),
      refresh: vi.fn().mockResolvedValue({
        grantToken: 'gt_refreshed_token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new_refresh',
        grantId: 'grant-1',
      }),
    },
  };
}

async function setupWithCode() {
  const clientStore = new InMemoryClientStore();
  await clientStore.set(TEST_CLIENT_ID, {
    clientId: TEST_CLIENT_ID,
    clientSecret: 'test-secret',
    redirectUris: [TEST_REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
    createdAt: new Date().toISOString(),
  });

  const mockGrantex = createMockGrantex();

  const app = await createMcpAuthServer({
    grantex: mockGrantex as unknown as McpAuthConfig['grantex'],
    agentId: 'agent-1',
    scopes: ['read', 'write'],
    issuer: 'https://auth.example.com',
    clientStore,
  });

  // Issue an authorization code via the authorize endpoint
  const authResponse = await app.inject({
    method: 'GET',
    url: '/authorize',
    query: {
      response_type: 'code',
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE,
      code_challenge_method: 'S256',
      scope: 'read write',
    },
  });

  const location = authResponse.headers['location'] as string;
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get('code')!;

  return { app, mockGrantex, code };
}

describe('token endpoint', () => {
  it('returns 400 for unsupported grant_type', async () => {
    const { app } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'client_credentials',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('returns 400 when required fields missing', async () => {
    const { app } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code: 'some-code',
        // Missing redirect_uri, client_id, code_verifier
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 401 for unknown client_id', async () => {
    const { app, code } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: 'unknown-client',
        code_verifier: TEST_VERIFIER,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBe('invalid_client');
  });

  it('returns 400 for invalid/expired code', async () => {
    const { app } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code: 'nonexistent-code',
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: TEST_VERIFIER,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_grant');
  });

  it('returns 400 for PKCE verification failure', async () => {
    const { app, code } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: 'wrong-verifier-value',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toContain('PKCE');
  });

  it('returns access_token on success', async () => {
    const { app, code } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: TEST_VERIFIER,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBe('gt_test_token');
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toBe('read write');
  });

  it('returns refresh_token when available', async () => {
    const { app, code } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: TEST_VERIFIER,
      },
    });

    const body = response.json();
    expect(body.refresh_token).toBe('rt_test_refresh');
  });

  it('handles refresh_token grant type', async () => {
    const { app } = await setupWithCode();

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: 'rt_test_refresh',
        client_id: TEST_CLIENT_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBe('gt_refreshed_token');
    expect(body.token_type).toBe('bearer');
    expect(body.refresh_token).toBe('rt_new_refresh');
  });
});
