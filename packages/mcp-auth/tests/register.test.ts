import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import type { McpAuthConfig } from '../src/types.js';

function createMockGrantex() {
  return {
    authorize: async () => ({
      authRequestId: 'auth-req-1',
      consentUrl: 'https://example.com/consent',
      agentId: 'agent-1',
      principalId: 'principal-1',
      scopes: ['read'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }),
    tokens: {
      exchange: async () => ({
        grantToken: 'gt_test',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read'],
        refreshToken: 'rt_test',
        grantId: 'grant-1',
      }),
      refresh: async () => ({
        grantToken: 'gt_refreshed',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read'],
        refreshToken: 'rt_new',
        grantId: 'grant-1',
      }),
    },
  } as unknown as McpAuthConfig['grantex'];
}

describe('register endpoint', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createMcpAuthServer({
      grantex: createMockGrantex(),
      agentId: 'agent-1',
      scopes: ['read'],
      issuer: 'https://auth.example.com',
    });
  });

  it('registers a client with redirect_uris', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {
        redirect_uris: ['https://app.example.com/callback'],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.redirect_uris).toEqual(['https://app.example.com/callback']);
  });

  it('returns client_id and client_secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {
        redirect_uris: ['https://app.example.com/callback'],
      },
    });

    const body = response.json();
    expect(body).toHaveProperty('client_id');
    expect(body).toHaveProperty('client_secret');
    expect(typeof body.client_id).toBe('string');
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_id.length).toBeGreaterThan(0);
    expect(body.client_secret.length).toBeGreaterThan(0);
  });

  it('returns 400 when redirect_uris is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('returns 400 when redirect_uris is empty array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {
        redirect_uris: [],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('sets default grant_types to authorization_code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {
        redirect_uris: ['https://app.example.com/callback'],
      },
    });

    const body = response.json();
    expect(body.grant_types).toEqual(['authorization_code']);
  });
});
