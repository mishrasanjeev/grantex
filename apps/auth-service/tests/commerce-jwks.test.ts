import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK } from 'jose';
import { sqlMock, buildTestApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });

describe('GET /.well-known/jwks.json — RS256 platform + ES256 commerce coexist', () => {
  it('serves both the platform RS256 key and any active commerce ES256 keys', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const ecJwk = await exportJWK(publicKey);
    // The buildJwks extension queries listCommercePassportKeysForJwks
    // which selects status IN ('active','retired'). Prime two keys: one
    // active, one retired — both must show up.
    sqlMock.mockResolvedValueOnce([
      {
        kid: 'commerce-passport-20260503-aabbccdd',
        algorithm: 'ES256',
        status: 'active',
        public_key_jwk: { ...ecJwk, kid: 'commerce-passport-20260503-aabbccdd', alg: 'ES256', use: 'sig' },
        created_at: new Date(),
        retired_at: null,
      },
      {
        kid: 'commerce-passport-20260501-eeff0011',
        algorithm: 'ES256',
        status: 'retired',
        public_key_jwk: { ...ecJwk, kid: 'commerce-passport-20260501-eeff0011', alg: 'ES256', use: 'sig' },
        created_at: new Date(Date.now() - 86_400_000 * 2),
        retired_at: new Date(Date.now() - 86_400_000),
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: { kid: string; alg: string }[] }>();
    expect(Array.isArray(body.keys)).toBe(true);

    const algs = body.keys.map((k) => k.alg);
    expect(algs).toContain('RS256');                // platform grant token key still present
    expect(algs).toContain('ES256');                // commerce passport key present

    const kids = body.keys.map((k) => k.kid);
    expect(kids).toContain('commerce-passport-20260503-aabbccdd');  // active
    expect(kids).toContain('commerce-passport-20260501-eeff0011');  // retired (within grace window)
  });

  it('still serves platform RS256 key when commerce key DB query fails', async () => {
    sqlMock.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: { alg: string }[] }>();
    expect(body.keys.some((k) => k.alg === 'RS256')).toBe(true);
  });
});
