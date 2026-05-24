import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK, type JWTPayload } from 'jose';
import { authHeader, sqlMock, mockRedis, TEST_DEVELOPER, TEST_ADMIN_API_KEY, buildTestApp } from './helpers.js';
import { TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Commerce caller resolver — token-shape detection', () => {
  it('operator (developer key) reaches the route via operator path', async () => {
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
    sqlMock.mockResolvedValueOnce([{ tenant_id: TEST_COMMERCE_TENANT_ID, status: 'active', role: 'owner' }]);
    sqlMock.mockResolvedValueOnce([]);  // merchant lookup empty -> 404

    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X', headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('missing Authorization header → 401 commerce envelope', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('missing_authorization');
  });

  it('merchant API key (grtx_sk_sandbox_…) is detected and resolved (own merchant)', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_TEST', tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_M', environment: 'sandbox',
    }]);
    // Reading own merchant: requireOperatorOrSelfMerchant passes; route
    // hits SELECT and returns 404 because no merchant row primed.
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_M',
      headers: { authorization: 'Bearer grtx_sk_sandbox_abcd1234abcd1234abcd1234abcd1234' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('merchant API key denied on cross-merchant GET (Finding 2)', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_TEST', tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_M', environment: 'sandbox',
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_OTHER',
      headers: { authorization: 'Bearer grtx_sk_sandbox_abcd1234abcd1234abcd1234abcd1234' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('merchant API key not in DB → 401 invalid_merchant_key', async () => {
    sqlMock.mockResolvedValueOnce([]);  // key lookup empty
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer grtx_sk_live_unknownunknownunknownunknown' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_merchant_key');
  });

  it('agent API key (grtx_agent_…) untrusted agent → 403 agent_not_trusted', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_X', tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'pending', public_key_jwk: null, api_key_hash: 'h',
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer grtx_agent_xxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; details?: { trust_status?: string } } }>();
    expect(body.error.code).toBe('agent_not_trusted');
    expect(body.error.details?.trust_status).toBe('pending');
  });

  it('agent API key not in DB → 401 invalid_agent_credential', async () => {
    sqlMock.mockResolvedValueOnce([]);  // agent lookup empty
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer grtx_agent_unknownunknownunknownunknown' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
  });

  it('developer key not in DB → 401 invalid_developer_key', async () => {
    sqlMock.mockResolvedValueOnce([]);  // developer lookup empty
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: 'Bearer some-unknown-opaque-token-1234' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_developer_key');
  });

  it('platform admin key falls through to operator with isPlatformAdmin=true', async () => {
    // The vitest config generates a per-run ADMIN_API_KEY and exposes it as
    // TEST_ADMIN_API_KEY. The admin token isn't in `developers`;
    // loadDeveloperByApiKey returns [].
    sqlMock.mockResolvedValueOnce([]);  // developer lookup empty (admin only)

    // Hit a route the admin caller can use without a tenant (the
    // commerce-disabled flag check). With NO tenant context, GET merchants
    // would 404 immediately. Use POST /tenants which admin can call.
    sqlMock.mockResolvedValueOnce([
      { id: 'cten_NEW', display_name: 'X', status: 'active', metadata: {}, created_at: new Date(), updated_at: new Date() },
    ]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_T', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/tenants',
      headers: { authorization: `Bearer ${TEST_ADMIN_API_KEY}` },
      payload: { display_name: 'New Tenant' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('Commerce caller resolver — agent JWT assertion', () => {
  let agentKp: { privateKey: KeyLike; publicKey: KeyLike };
  let agentJwk: JWK;
  beforeAll(async () => {
    agentKp = await generateKeyPair('ES256');
    agentJwk = await exportJWK(agentKp.publicKey) as JWK;
  });

  async function makeAssertion(opts: {
    iss?: string; sub?: string; aud?: string; tenantId?: string;
    iat?: number; exp?: number; jti?: string;
  } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ tenant_id: opts.tenantId ?? 'cten_TEST' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(opts.iss ?? 'cag_AGENT')
      .setSubject(opts.sub ?? 'cag_AGENT')
      .setAudience(opts.aud ?? 'grantex-commerce')
      .setJti(opts.jti ?? `jti_${now}_${Math.random().toString(36).slice(2)}`)
      .setIssuedAt(opts.iat ?? now)
      .setExpirationTime(opts.exp ?? now + 60)
      .sign(agentKp.privateKey);
  }

  it('valid assertion + trusted agent + Redis SET=OK → caller resolved (reads own agent)', async () => {
    const jwt = await makeAssertion();
    // agent lookup (caller resolver)
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    // GET /agents/:agentId for OWN agent — requireOperatorOrSelfAgent passes;
    // route hits SELECT and returns 404 because no agent row primed.
    sqlMock.mockResolvedValueOnce([]);
    mockRedis.set.mockResolvedValueOnce('OK');

    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_AGENT',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');
  });

  it('agent denied on GET /merchants/:id (Finding 2)', async () => {
    const jwt = await makeAssertion();
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('replay (Redis SET returns null) → 401 agent_assertion_replay', async () => {
    const jwt = await makeAssertion();
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockResolvedValueOnce(null);  // jti already seen
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_assertion_replay');
  });

  it('Redis throws (replay infra unavailable) → 503 assertion_replay_check_unavailable (Decision E)', async () => {
    const jwt = await makeAssertion();
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string; retryable: boolean } }>().error.code)
      .toBe('assertion_replay_check_unavailable');
    expect(res.json<{ error: { retryable: boolean } }>().error.retryable).toBe(true);
  });

  it('expired assertion (exp in past) → 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const jwt = await makeAssertion({ iat: past, exp: past + 60 });
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
  });

  it('wrong audience → 401', async () => {
    const jwt = await makeAssertion({ aud: 'not-grantex-commerce' });
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('disabled agent → 403 agent_not_trusted', async () => {
    const jwt = await makeAssertion();
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_TEST', trust_status: 'disabled',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_not_trusted');
  });
});

// ----------------------------------------------------------------------
// Codex P1 — Validate numeric JWT temporal claims before lifetime check.
// Codex P2 — Scope replay cache key by tenant + agent identity so two
// different agents cannot collide on a shared jti.
// ----------------------------------------------------------------------
describe('Commerce caller resolver — agent JWT temporal claims and replay scoping', () => {
  let agentKp: { privateKey: KeyLike; publicKey: KeyLike };
  let agentJwk: JWK;
  beforeAll(async () => {
    agentKp = await generateKeyPair('ES256');
    agentJwk = await exportJWK(agentKp.publicKey) as JWK;
  });

  // Build a signed JWT from a raw payload object — bypasses SignJWT's
  // typed setters so we can produce assertions with non-numeric or
  // missing temporal claims that a syntactically-valid JWS could carry.
  async function makeRawJwt(payload: Record<string, unknown>): Promise<string> {
    return new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: 'ES256' })
      .sign(agentKp.privateKey);
  }

  function trustedAgentRow(agentId = 'cag_AGENT', tenantId = 'cten_TEST') {
    return {
      id: agentId, tenant_id: tenantId, trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    };
  }

  it('iat as string (non-numeric) → 401 invalid_agent_credential', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti: `jti_iat_str_${now}`,
      iat: 'not-a-number', exp: now + 60,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
    // Replay cache must NOT have been touched — we rejected before that point.
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('exp as string (non-numeric) → 401 invalid_agent_credential', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti: `jti_exp_str_${now}`,
      iat: now, exp: 'not-a-number',
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('missing iat → 401 invalid_agent_credential', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti: `jti_no_iat_${now}`,
      exp: now + 60,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('missing exp → 401 invalid_agent_credential', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti: `jti_no_exp_${now}`,
      iat: now,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('exp <= iat (zero or negative lifetime) → 401 invalid_agent_credential', async () => {
    // exp == iat — both in the future to satisfy jose's expiry check
    // (so the temporal-validity guard, not jose, is what rejects).
    const future = Math.floor(Date.now() / 1000) + 120;
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti: `jti_eq_${future}`,
      iat: future, exp: future,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_agent_credential');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('two different agents reusing the same jti both succeed; replay keys differ and include agent identity', async () => {
    const sharedJti = `jti_shared_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = Math.floor(Date.now() / 1000);

    // Agent A in tenant T1
    const jwtA = await makeRawJwt({
      iss: 'cag_A', sub: 'cag_A', aud: 'grantex-commerce',
      tenant_id: 'cten_T1', jti: sharedJti,
      iat: now, exp: now + 60,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow('cag_A', 'cten_T1')]);
    sqlMock.mockResolvedValueOnce([]);  // GET own agent → 404 (no row)
    mockRedis.set.mockResolvedValueOnce('OK');
    const resA = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_A',
      headers: { authorization: `Bearer ${jwtA}` },
    });
    expect(resA.statusCode).toBe(404);
    expect(resA.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');

    // Agent B in tenant T2 — same JTI
    const jwtB = await makeRawJwt({
      iss: 'cag_B', sub: 'cag_B', aud: 'grantex-commerce',
      tenant_id: 'cten_T2', jti: sharedJti,
      iat: now, exp: now + 60,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow('cag_B', 'cten_T2')]);
    sqlMock.mockResolvedValueOnce([]);  // GET own agent → 404
    mockRedis.set.mockResolvedValueOnce('OK');
    const resB = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_B',
      headers: { authorization: `Bearer ${jwtB}` },
    });
    expect(resB.statusCode).toBe(404);
    expect(resB.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');

    // Verify Redis SET keys included both tenant + agent identity and
    // differ between the two callers despite the shared jti.
    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    const keyA = mockRedis.set.mock.calls[0]?.[0] as string;
    const keyB = mockRedis.set.mock.calls[1]?.[0] as string;
    expect(keyA).toContain('cten_T1');
    expect(keyA).toContain('cag_A');
    expect(keyA).toContain(sharedJti);
    expect(keyB).toContain('cten_T2');
    expect(keyB).toContain('cag_B');
    expect(keyB).toContain(sharedJti);
    expect(keyA).not.toBe(keyB);
  });

  it('same agent reusing jti → 401 agent_assertion_replay (existing behavior preserved); key carries agent identity', async () => {
    const jti = `jti_replay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await makeRawJwt({
      iss: 'cag_AGENT', sub: 'cag_AGENT', aud: 'grantex-commerce',
      tenant_id: 'cten_TEST', jti, iat: now, exp: now + 60,
    });
    sqlMock.mockResolvedValueOnce([trustedAgentRow()]);
    mockRedis.set.mockResolvedValueOnce(null);  // jti already seen by THIS agent
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_assertion_replay');
    const setKey = mockRedis.set.mock.calls[0]?.[0] as string;
    expect(setKey).toContain('cten_TEST');
    expect(setKey).toContain('cag_AGENT');
    expect(setKey).toContain(jti);
  });
});
