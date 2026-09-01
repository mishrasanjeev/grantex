import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { createJwksLoader } from '../src/routes/jwks.js';

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
    expect(res.headers['cache-control']).toBe('public, max-age=5, must-revalidate');
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

describe('JWKS route cache', () => {
  it('reuses values, deduplicates concurrent loads, and refreshes after expiry', async () => {
    let now = 1_000;
    let calls = 0;
    let resolveLoad: ((value: { keys: Record<string, unknown>[] }) => void) | undefined;
    const load = () => {
      calls += 1;
      return new Promise<{ keys: Record<string, unknown>[] }>((resolve) => {
        resolveLoad = resolve;
      });
    };
    const getJwks = createJwksLoader(load, 5_000, () => now);

    const first = getJwks();
    const concurrent = getJwks();
    expect(calls).toBe(1);
    resolveLoad?.({ keys: [{ kid: 'first' }] });
    await expect(first).resolves.toEqual({ keys: [{ kid: 'first' }] });
    await expect(concurrent).resolves.toEqual({ keys: [{ kid: 'first' }] });

    await expect(getJwks()).resolves.toEqual({ keys: [{ kid: 'first' }] });
    expect(calls).toBe(1);

    now += 5_000;
    const refreshed = getJwks();
    expect(calls).toBe(2);
    resolveLoad?.({ keys: [{ kid: 'second' }] });
    await expect(refreshed).resolves.toEqual({ keys: [{ kid: 'second' }] });
  });
});

describe('GET /.well-known/oauth-authorization-server', () => {
  it('publishes the complete standards endpoint and DPoP metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['jwks_uri']).toBe('https://grantex.dev/.well-known/jwks.json');
    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
    expect(body['authorization_endpoint']).toBe('https://grantex.dev/oauth/authorize');
    expect(body['token_endpoint']).toBe('https://grantex.dev/oauth/token');
    expect(body['revocation_endpoint']).toBe('https://grantex.dev/oauth/revoke');
    expect(body['pushed_authorization_request_endpoint']).toBe('https://grantex.dev/oauth/par');
    expect(body['require_pushed_authorization_requests']).toBe(true);
    expect(body['authorization_response_iss_parameter_supported']).toBe(true);
    expect(body['grant_types_supported']).toEqual(expect.arrayContaining([
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]));
    expect(body['dpop_signing_alg_values_supported']).toEqual(expect.arrayContaining(['ES256', 'RS256']));
    expect(body['token_endpoint_auth_methods_supported']).toEqual(['none']);
  });
});
