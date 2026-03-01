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

  it('redirects with code on success', async () => {
    const response = await app.inject({
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

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location).toBeDefined();
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(TEST_REDIRECT_URI);
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('calls grantex.authorize with correct params', async () => {
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

    expect(mockGrantex.authorize).toHaveBeenCalledWith({
      agentId: 'agent-1',
      userId: TEST_CLIENT_ID,
      scopes: ['read', 'write'],
    });
  });

  it('passes state through to redirect', async () => {
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
    const url = new URL(location);
    expect(url.searchParams.get('state')).toBe('my-state-value');
  });
});
