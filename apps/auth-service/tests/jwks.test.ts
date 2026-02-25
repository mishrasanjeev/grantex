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
