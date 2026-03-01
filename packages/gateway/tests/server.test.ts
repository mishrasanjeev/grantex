import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
  GrantexTokenError: class GrantexTokenError extends Error {
    constructor(message: string) {
      super(message);
      Object.setPrototypeOf(this, GrantexTokenError.prototype);
    }
  },
}));

// Mock proxy to avoid actual HTTP calls
vi.mock('../src/proxy.js', () => ({
  proxyRequest: vi.fn(),
}));

import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { createGatewayServer } from '../src/server.js';
import type { GatewayConfig } from '../src/types.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read', 'calendar:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const CONFIG: GatewayConfig = {
  upstream: 'https://api.internal.example.com',
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  port: 0,
  routes: [
    { path: '/calendar/**', methods: ['GET'], requiredScopes: ['calendar:read'] },
    { path: '/calendar/**', methods: ['POST'], requiredScopes: ['calendar:write'] },
    { path: '/payments/**', methods: ['POST'], requiredScopes: ['payments:initiate'] },
  ],
};

describe('createGatewayServer', () => {
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    server = createGatewayServer(CONFIG);
    vi.mocked(proxyRequest).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 404 for unmatched route', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/unknown/path',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('ROUTE_NOT_FOUND');
  });

  it('returns 401 when no Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_MISSING');
  });

  it('returns 401 when Authorization is not Bearer', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_MISSING');
  });

  it('returns 401 for invalid token', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Invalid signature'),
    );

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_INVALID');
  });

  it('returns 401 for expired token', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Token exp claim is in the past'),
    );

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer expired-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_EXPIRED');
  });

  it('returns 403 for insufficient scopes', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Missing required scope: payments:initiate'),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: 'Bearer token-without-payments' },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('SCOPE_INSUFFICIENT');
  });

  it('proxies request on valid token', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer valid-grant-token' },
    });

    expect(verifyGrantToken).toHaveBeenCalledWith('valid-grant-token', {
      jwksUri: CONFIG.jwksUri,
      requiredScopes: ['calendar:read'],
    });
    expect(proxyRequest).toHaveBeenCalled();
  });

  it('passes correct requiredScopes for POST', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);

    await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: {
        authorization: 'Bearer valid-grant-token',
        'content-type': 'application/json',
      },
      payload: { summary: 'Meeting' },
    });

    expect(verifyGrantToken).toHaveBeenCalledWith('valid-grant-token', {
      jwksUri: CONFIG.jwksUri,
      requiredScopes: ['calendar:write'],
    });
  });

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('DB connection lost'));

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('INTERNAL_ERROR');
  });

  it('handles DELETE method against unmatched route', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/calendar/events/123',
      headers: { authorization: 'Bearer token' },
    });

    // No DELETE route configured for /calendar/**
    expect(response.statusCode).toBe(404);
  });
});
