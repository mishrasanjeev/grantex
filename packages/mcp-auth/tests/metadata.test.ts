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
      scopes: ['read', 'write'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }),
    tokens: {
      exchange: async () => ({
        grantToken: 'gt_test',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test',
        grantId: 'grant-1',
      }),
      refresh: async () => ({
        grantToken: 'gt_refreshed',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new',
        grantId: 'grant-1',
      }),
    },
  } as unknown as McpAuthConfig['grantex'];
}

describe('metadata endpoint', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createMcpAuthServer({
      grantex: createMockGrantex(),
      agentId: 'agent-1',
      scopes: ['read', 'write'],
      issuer: 'https://auth.example.com',
    });
  });

  it('returns well-known metadata with correct fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('issuer');
    expect(body).toHaveProperty('authorization_endpoint');
    expect(body).toHaveProperty('token_endpoint');
    expect(body).toHaveProperty('registration_endpoint');
    expect(body).toHaveProperty('response_types_supported');
    expect(body).toHaveProperty('grant_types_supported');
    expect(body).toHaveProperty('code_challenge_methods_supported');
    expect(body).toHaveProperty('token_endpoint_auth_methods_supported');
    expect(body).toHaveProperty('scopes_supported');
  });

  it('returns correct issuer and endpoints', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    const body = response.json();
    expect(body.issuer).toBe('https://auth.example.com');
    expect(body.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(body.token_endpoint).toBe('https://auth.example.com/token');
    expect(body.registration_endpoint).toBe('https://auth.example.com/register');
  });

  it('includes scopes_supported from config', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    const body = response.json();
    expect(body.scopes_supported).toEqual(['read', 'write']);
  });

  it('includes resource_indicators_supported when allowedResources configured', async () => {
    const appWithResources = await createMcpAuthServer({
      grantex: createMockGrantex(),
      agentId: 'agent-1',
      scopes: ['read'],
      issuer: 'https://auth.example.com',
      allowedResources: ['https://api.example.com'],
    });

    const response = await appWithResources.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    const body = response.json();
    expect(body.resource_indicators_supported).toBe(true);
  });

  it('omits resource_indicators_supported when no allowedResources', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    const body = response.json();
    expect(body).not.toHaveProperty('resource_indicators_supported');
  });
});
