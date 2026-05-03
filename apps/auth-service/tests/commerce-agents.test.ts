import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, buildTestApp } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const VALID_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

describe('POST /v1/commerce/agents', () => {
  it('creates a CommerceAgent with public_key_jwk and returns 201', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_NEW',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      display_name: 'Acme Sales Bot',
      agent_type: 'sales',
      public_key_jwk: VALID_JWK,
      trust_status: 'pending',
      disabled_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_A', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'Acme Sales Bot', public_key_jwk: VALID_JWK },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; trust_status: string }; audit_event_id: string }>();
    expect(body.data.trust_status).toBe('pending');
    expect(body.audit_event_id).toBe('caud_A');
  });

  it('accepts api_key_hash as the credential when public_key_jwk omitted', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: 'cag_NEW', trust_status: 'pending' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_A', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'Server Agent', api_key_hash: 'sha256:abcd1234' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects request with neither public_key_jwk nor api_key_hash (422)', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'Bare' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('public_key_jwk');
  });

  it('hardcodes trust_status=pending when caller omits the field', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: 'cag_X', trust_status: 'pending' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_A', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'X', public_key_jwk: VALID_JWK },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { trust_status: string } }>().data.trust_status).toBe('pending');

    // Verify the route INSERT bound the literal 'pending' regardless of input.
    const insertCall = sqlMock.mock.calls.find((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string' && /INSERT INTO commerce_agents/i.test(s));
    });
    expect(insertCall).toBeDefined();
    // Slice off the template strings array; the rest are the bound values.
    expect(insertCall!.slice(1)).toContain('pending');
  });

  it('accepts trust_status="pending" explicitly as a no-op (forward-compat)', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: 'cag_X', trust_status: 'pending' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_A', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'X', public_key_jwk: VALID_JWK, trust_status: 'pending' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { trust_status: string } }>().data.trust_status).toBe('pending');
  });

  it.each([
    ['trusted'],
    ['suspended'],
    ['disabled'],
    ['untrusted'],   // also covers the previous "invalid value" case
    ['admin'],
  ])('rejects caller-supplied trust_status=%s with 422 (server-controlled)', async (trust_status) => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/agents',
      headers: authHeader(),
      payload: { display_name: 'X', public_key_jwk: VALID_JWK, trust_status },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string; details: { fields: Record<string, string> } } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.fields).toHaveProperty('trust_status');
    expect(body.error.details.fields['trust_status']).toMatch(/server-controlled/i);
  });
});

describe('GET /v1/commerce/agents/:agentId', () => {
  it('returns 404 commerce envelope when missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/agents/cag_MISSING',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');
  });
});
