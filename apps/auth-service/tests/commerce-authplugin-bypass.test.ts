/**
 * Decision F enforcement test: every commerce route must bypass the
 * global authPlugin (which only knows about developer API keys) and
 * route through the commerce caller resolver instead. This file proves
 * that merchant API keys and agent JWT/API-key tokens — which would all
 * be rejected by authPlugin's developer-key lookup — reach the commerce
 * resolver and are recognized.
 *
 * The proof shape: every assertion checks that the response uses the
 * COMMERCE envelope `{ error: { code, ... } }` rather than the platform
 * envelope `{ message, code, requestId }`. The platform envelope appears
 * only when authPlugin handles the request; if commerce caller takes
 * over, the commerce envelope is what surfaces.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';
import { sqlMock, mockRedis, buildTestApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function expectsCommerceEnvelope(body: unknown): { error: { code: string } } {
  // Platform envelope is { message, code, requestId } — top-level. Commerce
  // envelope nests under .error. If body has .error, it's commerce.
  expect(body).toHaveProperty('error');
  expect(body).not.toHaveProperty('requestId');
  expect((body as { error: { code: string } }).error).toHaveProperty('code');
  return body as { error: { code: string } };
}

describe('authPlugin bypass — commerce routes must skip global developer-key auth', () => {
  it('merchant API key reaches commerce resolver (not rejected by authPlugin)', async () => {
    sqlMock.mockResolvedValueOnce([]);  // merchant key lookup empty
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer grtx_sk_sandbox_AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(401);
    const body = expectsCommerceEnvelope(res.json());
    // The 401 came from commerce resolver — code is `invalid_merchant_key`
    // (commerce-namespaced), NOT `UNAUTHORIZED` (platform).
    expect(body.error.code).toBe('invalid_merchant_key');
  });

  it('agent API key reaches commerce resolver (not rejected by authPlugin)', async () => {
    sqlMock.mockResolvedValueOnce([]);  // agent lookup empty
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer grtx_agent_BBBBBBBBBBBBBBBBBBBBBBBB' },
    });
    expect(res.statusCode).toBe(401);
    const body = expectsCommerceEnvelope(res.json());
    expect(body.error.code).toBe('invalid_agent_credential');
  });

  it('agent JWT (3-segment) reaches commerce resolver (not rejected as opaque developer key)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey) as JWK;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ tenant_id: 'cten_X' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_NOPE')
      .setSubject('cag_NOPE')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);
    void jwk;
    void privateKey as unknown as KeyLike;
    sqlMock.mockResolvedValueOnce([]);   // agent lookup empty (unknown agent_id)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    const body = expectsCommerceEnvelope(res.json());
    // Reaches commerce resolver, fails at agent lookup → invalid_agent_credential.
    expect(body.error.code).toBe('invalid_agent_credential');
  });

  it('non-commerce routes still use authPlugin (control case — uses platform envelope)', async () => {
    // /v1/agents requires the global authPlugin. Posting a merchant key
    // there should produce the platform envelope, NOT the commerce one.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer grtx_sk_sandbox_NOPE_NOPE_NOPE_NOPE_NOPE' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    // Platform envelope: top-level message + code + requestId. NOT { error: { ... } }.
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('requestId');
    expect(body['code']).toBe('UNAUTHORIZED');
    expect(body).not.toHaveProperty('error');
  });

  // Use mockRedis to silence eslint about unused imports — Redis isn't
  // hit in these specific tests but the harness mock must be loaded.
  it('mockRedis is wired (sanity)', () => {
    expect(typeof mockRedis.set).toBe('function');
  });
});
