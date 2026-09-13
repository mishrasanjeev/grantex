import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryClientStore } from '../src/lib/clients.js';
import type { McpAuthConfig } from '../src/types.js';

function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const TEST_CLIENT_ID = 'test-client-id';
const TEST_REDIRECT_URI = 'https://app.example.com/callback';
const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const TEST_CHALLENGE = computeS256Challenge(TEST_VERIFIER);

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
        grantToken: 'gt_test',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test',
        grantId: 'grant-1',
      }),
      refresh: vi.fn().mockResolvedValue({
        grantToken: 'gt_refreshed',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new',
        grantId: 'grant-1',
      }),
    },
  };
}

async function createTestApp(overrides: Partial<McpAuthConfig> = {}) {
  const clientStore = new InMemoryClientStore();
  await clientStore.set(TEST_CLIENT_ID, {
    clientId: TEST_CLIENT_ID,
    clientSecret: 'test-secret',
    redirectUris: [TEST_REDIRECT_URI],
    grantTypes: ['authorization_code'],
    createdAt: new Date().toISOString(),
  });

  const mockGrantex = createMockGrantex();

  const app = await createMcpAuthServer({
    grantex: mockGrantex as unknown as McpAuthConfig['grantex'],
    agentId: 'agent-1',
    scopes: ['read', 'write'],
    issuer: 'https://auth.example.com',
    clientStore,
    ...overrides,
  });

  return { app, mockGrantex, clientStore };
}

describe('authorize endpoint', () => {
  let app: FastifyInstance;
  let mockGrantex: ReturnType<typeof createMockGrantex>;

  beforeEach(async () => {
    const testCtx = await createTestApp();
    app = testCtx.app;
    mockGrantex = testCtx.mockGrantex;
  });

  it('returns 400 for unsupported response_type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'token',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('unsupported_response_type');
  });

  it('returns 400 when PKCE is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('PKCE');
  });

  it('returns 400 for unknown client_id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: 'unknown-client',
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_client');
  });

  it('returns 400 for unregistered redirect_uri', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: 'https://evil.example.com/callback',
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('redirect_uri');
  });

  it('returns 400 for invalid resource indicator', async () => {
    const { app: appWithResources } = await createTestApp({
      allowedResources: ['https://api.example.com'],
    });

    const response = await appWithResources.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        resource: 'https://evil.example.com/api',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_target');
  });

  it('live mode: redirects to the Grantex consent flow and issues no code before approval', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        state: 'my-state-value',
      },
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    // The user-agent is sent to Grantex consent, not back to the client.
    expect(location).toBe('https://example.com/consent');
    expect(new URL(location).searchParams.get('code')).toBeNull();
  });

  it('calls grantex.authorize with our consent callback, an opaque state and the resource as audience', async () => {
    await app.inject({
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

    expect(mockGrantex.authorize).toHaveBeenCalledTimes(1);
    const params = mockGrantex.authorize.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      agentId: 'agent-1',
      userId: TEST_CLIENT_ID,
      scopes: ['read', 'write'],
      redirectUri: 'https://auth.example.com/callback',
    });
    expect(typeof params['state']).toBe('string');
    expect((params['state'] as string).length).toBeGreaterThanOrEqual(32);
  });

  it('consent callback issues the client code bound to the Grantex code and echoes client state', async () => {
    const authResponse = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        state: 'my-state-value',
      },
    });
    expect(authResponse.statusCode).toBe(302);
    const grantexState = (mockGrantex.authorize.mock.calls[0]![0] as { state: string }).state;

    // Grantex consent approved → redirect to our callback with its code.
    const callback = await app.inject({
      method: 'GET',
      url: '/callback',
      query: { code: 'GRANTEX_LIVE_CODE', state: grantexState },
    });
    expect(callback.statusCode).toBe(302);
    const url = new URL(callback.headers['location'] as string);
    expect(url.origin + url.pathname).toBe(TEST_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('my-state-value');
    const code = url.searchParams.get('code');
    expect(code).toBeTruthy();

    // The callback is single-use.
    const replay = await app.inject({
      method: 'GET',
      url: '/callback',
      query: { code: 'GRANTEX_LIVE_CODE', state: grantexState },
    });
    expect(replay.statusCode).toBe(400);

    // Exchanging the client code forwards the Grantex code from the callback.
    const token = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        client_secret: 'test-secret',
        code_verifier: TEST_VERIFIER,
      },
    });
    expect(token.statusCode).toBe(200);
    expect(mockGrantex.tokens.exchange).toHaveBeenCalledWith({ code: 'GRANTEX_LIVE_CODE', agentId: 'agent-1' });
  });

  it('consent callback with error redirects the client with access_denied and no code', async () => {
    await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        state: 's1',
      },
    });
    const grantexState = (mockGrantex.authorize.mock.calls[0]![0] as { state: string }).state;
    const callback = await app.inject({
      method: 'GET',
      url: '/callback',
      query: { error: 'access_denied', state: grantexState },
    });
    expect(callback.statusCode).toBe(302);
    const url = new URL(callback.headers['location'] as string);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
    expect(url.searchParams.get('state')).toBe('s1');
  });

  it('rejects a callback with an unknown state', async () => {
    const callback = await app.inject({
      method: 'GET',
      url: '/callback',
      query: { code: 'x', state: 'unknown' },
    });
    expect(callback.statusCode).toBe(400);
  });

  it('sandbox auto-approve is refused unless sandboxAutoApprove is enabled', async () => {
    const ctx = await createTestApp();
    ctx.mockGrantex.authorize.mockResolvedValue({
      ...(await ctx.mockGrantex.authorize()),
      status: 'approved' as const,
      sandbox: true,
      code: 'GRANTEX_SANDBOX_CODE',
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('server_error');
  });

  it('sandbox auto-approve short path redirects with code when explicitly enabled', async () => {
    const ctx = await createTestApp({ sandboxAutoApprove: true });
    ctx.mockGrantex.authorize.mockResolvedValue({
      ...(await ctx.mockGrantex.authorize()),
      status: 'approved' as const,
      sandbox: true,
      code: 'GRANTEX_SANDBOX_CODE',
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        state: 'my-state-value',
      },
    });
    expect(response.statusCode).toBe(302);
    const url = new URL(response.headers['location'] as string);
    expect(url.origin + url.pathname).toBe(TEST_REDIRECT_URI);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('my-state-value');
  });
});
