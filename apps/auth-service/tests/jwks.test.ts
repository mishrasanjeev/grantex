import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /.well-known/jwks.json', () => {
  it('returns 200 with a valid JWKS (no auth required)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Array<Record<string, unknown>> }>();
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0]!;
    expect(key['kty']).toBe('RSA');
    expect(key['alg']).toBe('RS256');
    expect(key['use']).toBe('sig');
    expect(typeof key['n']).toBe('string');
    expect(typeof key['e']).toBe('string');
    expect(typeof key['kid']).toBe('string');
  });

  it('does not require Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
      // No authorization header
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 for /v1/* without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /.well-known/oauth-authorization-server', () => {
  it('publishes truthful metadata for the implementation-specific profile', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['jwks_uri']).toBe('https://grantex.dev/.well-known/jwks.json');
    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
    expect(body['grantex_profile_status']).toBe('implementation-specific-extension');
    expect(body).not.toHaveProperty('authorization_endpoint');
    expect(body).not.toHaveProperty('dpop_signing_alg_values_supported');
  });
});
