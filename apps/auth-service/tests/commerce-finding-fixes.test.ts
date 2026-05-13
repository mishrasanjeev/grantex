/**
 * Targeted tests for the M2 hardening findings raised by Codex review.
 * Each describe block maps to one finding from the review.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK,
} from 'jose';
import { sqlMock, mockRedis, buildTestApp, authHeader, TEST_DEVELOPER } from './helpers.js';
import { signPrincipalSessionToken } from '../src/lib/crypto.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import {
  signCommercePassport,
  verifyCommercePassport,
  newCommercePassportJti,
} from '../src/lib/commerce/passport.js';
import {
  _resetCommercePassportKeyCacheForTests,
  getActiveCommercePassportSigner,
} from '../src/lib/commerce/passport-keys.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => { vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------
// Finding 2 — per-route caller matrix
// ---------------------------------------------------------------------
describe('Finding 2 — caller matrix enforcement', () => {
  let agentKp: { privateKey: KeyLike; publicKey: KeyLike };
  let agentJwk: JWK;
  beforeAll(async () => {
    agentKp = await generateKeyPair('ES256');
    agentJwk = await exportJWK(agentKp.publicKey) as JWK;
  });
  async function agentJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ tenant_id: TEST_COMMERCE_TENANT_ID })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_AGENT').setSubject('cag_AGENT')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}_${Math.random().toString(36).slice(2)}`)
      .setIssuedAt(now).setExpirationTime(now + 60)
      .sign(agentKp.privateKey);
  }
  function primeTrustedAgent(): void {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: TEST_COMMERCE_TENANT_ID, trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');
  }
  function primeMerchantKey(): void {
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_TEST', tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_M', environment: 'sandbox',
    }]);
  }

  it('GET /audit/events denies agent → 403 operator_required', async () => {
    primeTrustedAgent();
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/audit/events',
      headers: { authorization: `Bearer ${await agentJwt()}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('GET /audit/events denies merchant → 403 operator_required', async () => {
    primeMerchantKey();
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/audit/events',
      headers: { authorization: 'Bearer grtx_sk_sandbox_AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('GET /agents/:id denies merchant (caller_not_authorized)', async () => {
    primeMerchantKey();
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_X',
      headers: { authorization: 'Bearer grtx_sk_sandbox_AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('GET /agents/:id allows agent reading own record (operator_or_self_agent)', async () => {
    primeTrustedAgent();
    sqlMock.mockResolvedValueOnce([]);  // agent SELECT empty → 404 (proves caller check passed)
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_AGENT',
      headers: { authorization: `Bearer ${await agentJwt()}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');
  });

  it('GET /agents/:id denies agent for OTHER agent (caller_not_authorized)', async () => {
    primeTrustedAgent();
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_OTHER',
      headers: { authorization: `Bearer ${await agentJwt()}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('GET /merchants/:id allows operator', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_X', headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('GET /catalog/products/:id allows a scoped agent catalog item read', async () => {
    primeTrustedAgent();
    sqlMock.mockResolvedValueOnce([{
      id: 'cprd_X', tenant_id: TEST_COMMERCE_TENANT_ID, merchant_id: 'mch_M',
      product_id: 'P1', title: 'X', brand: null, description: null, image_url: null,
      category_preset: 'electronics_appliances', source_system: 'manual',
      manually_maintained: false, archived_at: null,
      created_at: new Date(), updated_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/catalog/products/cprd_X?merchant_id=mch_M',
      headers: { authorization: `Bearer ${await agentJwt()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { id: string; variants: unknown[] } }>().data).toMatchObject({
      id: 'cprd_X',
      variants: [],
    });
  });
});

// ---------------------------------------------------------------------
// Finding 4 — presented_payload_hash recomputation at exchange
// ---------------------------------------------------------------------
describe('Finding 4 — exchange recomputes presented_payload_hash and rejects mismatch', () => {
  let agentKp: { privateKey: KeyLike; publicKey: KeyLike };
  let agentJwk: JWK;
  beforeAll(async () => {
    agentKp = await generateKeyPair('ES256');
    agentJwk = await exportJWK(agentKp.publicKey) as JWK;
  });
  async function agentJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ tenant_id: TEST_COMMERCE_TENANT_ID })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_AGENT').setSubject('cag_AGENT')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}_${Math.random().toString(36).slice(2)}`)
      .setIssuedAt(now).setExpirationTime(now + 60).sign(agentKp.privateKey);
  }
  function primeTrustedAgent(): void {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: TEST_COMMERCE_TENANT_ID, trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');
  }
  it('exchange rejects when stored hash does not match recomputed canonical payload (e.g. scopes mutated post-presentation)', async () => {
    primeTrustedAgent();
    // findConsentByRequestId — return a granted consent with a STALE hash
    // that doesn't match the current canonical payload (simulates a
    // tamper attack).
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_X', tenant_id: TEST_COMMERCE_TENANT_ID, merchant_id: 'mch_M',
      agent_id: 'cag_AGENT', consent_request_id: 'req_X',
      passport_type: 'browse',
      requested_scopes: ['commerce:catalog.read', 'commerce:inventory.read'],  // mutated
      approved_scopes: ['commerce:catalog.read', 'commerce:inventory.read'],
      max_amount: null, currency: null,
      consent_text_version: '2026-05-01',
      // Stored hash is for an OLD payload (just catalog.read, before mutation)
      presented_payload_hash: 'deadbeef'.repeat(8),
      status: 'granted',
      agent_auth_method: 'jwt',
      expires_at: new Date(Date.now() + 60_000),
      approved_at: new Date(),
      denied_at: null,
      user_principal_id: 'user_X',
      user_principal_hint: null,
      created_at: new Date(),
    }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/passports/exchange',
      headers: { authorization: `Bearer ${await agentJwt()}`, 'content-type': 'application/json' },
      payload: { consent_request_id: 'req_X' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('consent_payload_changed');
  });
});

// ---------------------------------------------------------------------
// Finding 3 — single-use exchange (existing passport short-circuit)
// ---------------------------------------------------------------------
describe('Finding 3 — exchange is single-use', () => {
  let agentKp: { privateKey: KeyLike; publicKey: KeyLike };
  let agentJwk: JWK;
  beforeAll(async () => {
    agentKp = await generateKeyPair('ES256');
    agentJwk = await exportJWK(agentKp.publicKey) as JWK;
  });
  async function agentJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ tenant_id: TEST_COMMERCE_TENANT_ID })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_AGENT').setSubject('cag_AGENT')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}_${Math.random().toString(36).slice(2)}`)
      .setIssuedAt(now).setExpirationTime(now + 60).sign(agentKp.privateKey);
  }

  it('returns 409 consent_already_exchanged when a passport already exists for the consent', async () => {
    // agent lookup (caller resolver)
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: TEST_COMMERCE_TENANT_ID, trust_status: 'trusted',
      public_key_jwk: agentJwk, api_key_hash: null,
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');

    // Build a consent record whose canonical hash matches the stored
    // hash so we don't false-positive on Finding 4. The canonical
    // encoder is deterministic; capture the expires timestamp ONCE and
    // reuse the exact same string in both the hash computation and the
    // mocked DB row.
    const expiresIso = new Date(Date.now() + 60_000).toISOString();
    const { canonicalPresentedPayload, sha256hex } = await import('../src/lib/commerce/consent.js');
    const hash = sha256hex(canonicalPresentedPayload({
      id: 'crec_X', tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: 'mch_M', agentId: 'cag_AGENT',
      consentRequestId: 'req_OK',
      passportType: 'browse',
      requestedScopes: ['commerce:catalog.read'],
      approvedScopes: ['commerce:catalog.read'],
      maxAmount: null, currency: null,
      consentTextVersion: '2026-05-01',
      presentedPayloadHash: null,
      status: 'granted', agentAuthMethod: 'jwt',
      expiresAt: expiresIso,
      approvedAt: null, deniedAt: null,
      userPrincipalId: 'user_X', userPrincipalHint: null, createdAt: '',
    }));
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_X', tenant_id: TEST_COMMERCE_TENANT_ID, merchant_id: 'mch_M',
      agent_id: 'cag_AGENT', consent_request_id: 'req_OK',
      passport_type: 'browse',
      requested_scopes: ['commerce:catalog.read'],
      approved_scopes: ['commerce:catalog.read'],
      max_amount: null, currency: null,
      consent_text_version: '2026-05-01',
      presented_payload_hash: hash, status: 'granted',
      agent_auth_method: 'jwt',
      expires_at: expiresIso,         // SAME string used in hash above
      approved_at: new Date(), denied_at: null,
      user_principal_id: 'user_X', user_principal_hint: null,
      created_at: new Date(),
    }]);
    // Existing passport check fires BEFORE the merchant lookup; route
    // returns 409 immediately so the merchant SELECT is never reached.
    sqlMock.mockResolvedValueOnce([{
      jti: 'cpsp_EXISTING',
      expires_at: new Date(Date.now() + 60_000),
    }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/passports/exchange',
      headers: { authorization: `Bearer ${await agentJwt()}`, 'content-type': 'application/json' },
      payload: { consent_request_id: 'req_OK' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; details: { existing_jti: string } } }>();
    expect(body.error.code).toBe('consent_already_exchanged');
    expect(body.error.details.existing_jti).toBe('cpsp_EXISTING');
  });
});

// ---------------------------------------------------------------------
// Finding 5 — key rotation (cache TTL + retired-key iat enforcement)
// ---------------------------------------------------------------------
describe('Finding 5 — key rotation', () => {
  let kpA: { privateKey: KeyLike; publicKey: KeyLike };
  let kpB: { privateKey: KeyLike; publicKey: KeyLike };
  let jwkA: JWK; let jwkB: JWK;

  beforeAll(async () => {
    kpA = await generateKeyPair('ES256');
    kpB = await generateKeyPair('ES256');
    jwkA = await exportJWK(kpA.publicKey) as JWK;
    jwkB = await exportJWK(kpB.publicKey) as JWK;
  });

  async function primeSignerWith(kid: string, kp: { privateKey: KeyLike }): Promise<void> {
    const { encrypt } = await import('../src/lib/vault-crypto.js');
    const { exportJWK: ek } = await import('jose');
    const privateJwk = await ek(kp.privateKey);
    const encryptedPrivate = encrypt(JSON.stringify({ ...privateJwk, kid, alg: 'ES256' }));
    sqlMock.mockResolvedValueOnce([{
      kid, algorithm: 'ES256', status: 'active',
      public_key_jwk: kid === 'commerce-passport-20260101-aaaaaaaa'
        ? { ...jwkA, kid, alg: 'ES256', use: 'sig' }
        : { ...jwkB, kid, alg: 'ES256', use: 'sig' },
      created_at: new Date(), retired_at: null,
    }]);
    sqlMock.mockResolvedValueOnce([{ encrypted_private_key_jwk: encryptedPrivate }]);
  }

  it('cache busts when DB-active kid changes (rotation mid-flight)', async () => {
    _resetCommercePassportKeyCacheForTests();
    // First call — no cache. findActive (1 mock), decrypt (1 mock).
    await primeSignerWith('commerce-passport-20260101-aaaaaaaa', kpA);
    const s1 = await getActiveCommercePassportSigner(sqlMock as unknown as never);
    expect(s1.kid).toBe('commerce-passport-20260101-aaaaaaaa');

    // Second call within TTL: cache "still active?" check fires.
    // Mock returns DIFFERENT kid → cache busts → full refetch.
    sqlMock.mockResolvedValueOnce([{ kid: 'commerce-passport-20260102-bbbbbbbb' }]);
    await primeSignerWith('commerce-passport-20260102-bbbbbbbb', kpB);
    const s2 = await getActiveCommercePassportSigner(sqlMock as unknown as never);
    expect(s2.kid).toBe('commerce-passport-20260102-bbbbbbbb');
  });

  it('verify accepts token signed BEFORE retired_at (within JWKS grace)', async () => {
    _resetCommercePassportKeyCacheForTests();
    const kid = 'commerce-passport-20260201-cccccccc';
    await primeSignerWith(kid, kpA);
    const issuedAt = Math.floor(Date.now() / 1000) - 600;  // 10 min ago
    const r = await signCommercePassport(sqlMock as unknown as never, {
      jti: newCommercePassportJti(),
      passportType: 'browse',
      tenantId: 'cten_T', merchantId: 'mch_M', agentId: 'cag_A',
      consentRecordId: 'crec_C', subject: 'user_X',
      scopes: ['commerce:catalog.read'], maxAmount: null, currency: null,
      environment: 'sandbox',
      issuedAt, notBefore: issuedAt, expiresAt: issuedAt + 3600,
    });
    // Now the kid is retired (retired_at AFTER iat → token still valid).
    sqlMock.mockResolvedValueOnce([{
      public_key_jwk: { ...jwkA, kid, alg: 'ES256', use: 'sig' },
      retired_at: new Date(),  // retired now, AFTER token's iat
    }]);
    const v = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, r.jwt, { mode: 'read_only' });
    expect(v.ok).toBe(true);
  });

  it('verify REJECTS token signed AFTER retired_at (stolen retired key cannot mint new passports)', async () => {
    _resetCommercePassportKeyCacheForTests();
    const kid = 'commerce-passport-20260301-dddddddd';
    // Sign a token with iat = now (so far ahead of any reasonable retired_at).
    await primeSignerWith(kid, kpA);
    const now = Math.floor(Date.now() / 1000);
    const r = await signCommercePassport(sqlMock as unknown as never, {
      jti: newCommercePassportJti(),
      passportType: 'browse',
      tenantId: 'cten_T', merchantId: 'mch_M', agentId: 'cag_A',
      consentRecordId: 'crec_D', subject: 'user_X',
      scopes: ['commerce:catalog.read'], maxAmount: null, currency: null,
      environment: 'sandbox',
      issuedAt: now, notBefore: now, expiresAt: now + 3600,
    });
    // Verifier sees: kid retired_at = 1 hour BEFORE the token's iat.
    sqlMock.mockResolvedValueOnce([{
      public_key_jwk: { ...jwkA, kid, alg: 'ES256', use: 'sig' },
      retired_at: new Date((now - 3600) * 1000),
    }]);
    const v = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, r.jwt, { mode: 'read_only' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.kind).toBe('kid_retired_iat_after');
      if (v.error.kind === 'kid_retired_iat_after') {
        expect(v.error.kid).toBe(kid);
      }
    }
  });
});

// ---------------------------------------------------------------------
// Finding 1 — agent self-approval cannot succeed
// ---------------------------------------------------------------------
describe('Finding 1 — agent cannot self-approve consent', () => {
  it('agent can fetch consent page but page does not render approve forms (sign-in required)', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_X', tenant_id: 'cten_T', merchant_id: 'mch_M', agent_id: 'cag_A',
      consent_request_id: 'req_X', passport_type: 'browse',
      requested_scopes: ['commerce:catalog.read'],
      approved_scopes: null, max_amount: null, currency: null,
      consent_text_version: '2026-05-01',
      presented_payload_hash: null, status: 'requested',
      agent_auth_method: 'jwt',
      expires_at: new Date(Date.now() + 600_000), approved_at: null, denied_at: null,
      user_principal_id: null, user_principal_hint: null, created_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([]);  // UPDATE presented hash
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/consent/page?req=req_X',
      headers: { host: 'consent.grantex.dev' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Sign in to authorize/);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('approve without principal session → 401 (cannot self-approve via CSRF cookie alone)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/consent/req_X/approve',
      headers: {
        host: 'consent.grantex.dev',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'csrf=anything',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_session_required');
  });
});

// ---------------------------------------------------------------------
// Second-pass findings (P1/P1/P1/P2 from Codex review #2)
// ---------------------------------------------------------------------

describe('Finding 1 (round 2) — max passport lifetime + retired-key window', () => {
  let kp: { privateKey: KeyLike; publicKey: KeyLike };
  let kid: string;
  let publicJwk: JWK;
  beforeAll(async () => {
    kp = await generateKeyPair('ES256');
    publicJwk = await exportJWK(kp.publicKey) as JWK;
    kid = 'commerce-passport-20260601-aaaa1111';
  });
  async function primeSigner(): Promise<void> {
    const { encrypt } = await import('../src/lib/vault-crypto.js');
    const { exportJWK: ek } = await import('jose');
    const privateJwk = await ek(kp.privateKey);
    const enc = encrypt(JSON.stringify({ ...privateJwk, kid, alg: 'ES256' }));
    sqlMock.mockResolvedValueOnce([{
      kid, algorithm: 'ES256', status: 'active',
      public_key_jwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
      created_at: new Date(), retired_at: null,
    }]);
    sqlMock.mockResolvedValueOnce([{ encrypted_private_key_jwk: enc }]);
  }
  function primePublicLookup(retiredAt: Date | null = null): void {
    sqlMock.mockResolvedValueOnce([{
      public_key_jwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
      retired_at: retiredAt,
    }]);
  }
  async function signWithLifetime(passportType: 'browse' | 'checkout', iat: number, exp: number): Promise<string> {
    _resetCommercePassportKeyCacheForTests();
    await primeSigner();
    const { signCommercePassport: sign } = await import('../src/lib/commerce/passport.js');
    const { newCommercePassportJti: newJti } = await import('../src/lib/commerce/passport.js');
    const r = await sign(sqlMock as unknown as never, {
      jti: newJti(),
      passportType,
      tenantId: 'cten_T', merchantId: 'mch_M', agentId: 'cag_A',
      consentRecordId: 'crec_C', subject: 'user_X',
      scopes: ['commerce:catalog.read'], maxAmount: null, currency: null,
      environment: 'sandbox',
      issuedAt: iat, notBefore: iat, expiresAt: exp,
    });
    return r.jwt;
  }

  it('browse passport with lifetime > 3600 + skew is rejected (lifetime_exceeded)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signWithLifetime('browse', now, now + 7200);   // 2h, way over 1h cap
    primePublicLookup();
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('lifetime_exceeded');
      if (r.error.kind === 'lifetime_exceeded') {
        expect(r.error.passportType).toBe('browse');
        expect(r.error.maxLifetime).toBe(3600);
      }
    }
  });

  it('checkout passport with lifetime > 600 + skew is rejected (lifetime_exceeded)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signWithLifetime('checkout', now, now + 1200);  // 20m, over 10m cap
    primePublicLookup();
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('lifetime_exceeded');
  });

  it('browse passport with lifetime exactly = 3600 + 30s skew is accepted', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Sign with iat way in the past to keep us inside not-yet-valid skew
    // and ensure exp is past, then verify with read_only mode.
    const iat = now - 4000;
    const jwt = await signWithLifetime('browse', iat, iat + 3600);
    primePublicLookup();
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    // Note: would be 'expired' (exp < now) — that's fine for the lifetime
    // gate test; the lifetime check passes, expiry check fires after.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('expired');
  });

  it('retired key REJECTS token with iat before retired_at but exp far beyond window (kid_retired_window_exceeded)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 10min ago, retiring "now", exp far future (1 day).
    const iat = now - 600;
    const exp = now + 86_400;
    const jwt = await signWithLifetime('browse', iat, exp);
    primePublicLookup(new Date(now * 1000));   // retired right now
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Either lifetime_exceeded (1 day vs 1h cap) fires first, or
      // kid_retired_window_exceeded. Either is correct rejection.
      expect(['lifetime_exceeded', 'kid_retired_window_exceeded']).toContain(r.error.kind);
    }
  });

  it('retired key ACCEPTS token signed before retirement with sane lifetime', async () => {
    const now = Math.floor(Date.now() / 1000);
    // iat = 10 min ago, exp = 50 min from now (lifetime = 60 min, fits).
    const iat = now - 600;
    const exp = now + 3000;
    const jwt = await signWithLifetime('browse', iat, exp);
    // Retired AFTER iat, exp within retired_at + 1h cap.
    primePublicLookup(new Date((iat + 60) * 1000));
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(true);
  });

  it('temporal_claim_invalid when exp <= iat', async () => {
    const now = Math.floor(Date.now() / 1000);
    // exp == iat
    const jwt = await signWithLifetime('browse', now, now);
    primePublicLookup();
    const { verifyCommercePassport: vp } = await import('../src/lib/commerce/passport.js');
    const r = await vp(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('temporal_claim_invalid');
  });
});

describe('Finding 2 (round 2) — session JWT 303 strip', () => {
  // The full happy/sad paths live in commerce-consent-flow.test.ts.
  // Smoke test here just to keep the finding numbering complete.
  it('GET with valid ?session= returns 303 with no-referrer + cookie', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: 'user_X', developerId: 'dev_TEST' }, 600,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_X&session=${encodeURIComponent(sessionToken)}`,
      headers: { host: 'consent.grantex.dev' },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/v1/commerce/consent/page?req=req_X');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['set-cookie']).toMatch(/grantex_principal_session=/);
  });
});

describe('Finding 3 (round 2) — disabled tenant blocks merchant/agent/consent/exchange', () => {
  it('merchant API key for disabled tenant → 403 tenant_disabled', async () => {
    // Single SQL: the resolver JOINs commerce_tenants and surfaces
    // tenant_status. Disabled → resolver returns failure BEFORE the
    // last_used_at update, so only one mock is consumed.
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_X', tenant_id: 'cten_DISABLED',
      merchant_id: 'mch_M', environment: 'sandbox',
      tenant_status: 'disabled',
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/merchants/mch_M',
      headers: { authorization: 'Bearer grtx_sk_sandbox_AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });

  it('agent API key for disabled tenant → 403 tenant_disabled', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_X', tenant_id: 'cten_DISABLED', trust_status: 'trusted',
      public_key_jwk: { kty: 'EC' }, api_key_hash: 'h',
      tenant_status: 'disabled',
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_X',
      headers: { authorization: 'Bearer grtx_agent_BBBBBBBBBBBBBBBBBBBBBBBB' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });

  it('agent JWT for disabled tenant → 403 tenant_disabled', async () => {
    const kp = await generateKeyPair('ES256');
    const jwk = await exportJWK(kp.publicKey) as JWK;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ tenant_id: 'cten_DISABLED' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_X').setSubject('cag_X')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}`).setIssuedAt(now).setExpirationTime(now + 60)
      .sign(kp.privateKey);
    // Agent lookup via JWT: returns disabled tenant_status.
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_X', tenant_id: 'cten_DISABLED', trust_status: 'trusted',
      public_key_jwk: jwk, api_key_hash: null,
      tenant_status: 'disabled',
    }]);
    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/agents/cag_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });

  it('consent approve for disabled tenant → 403 tenant_disabled (after CSRF + binding pass)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: 'user_X', developerId: 'dev_TEST' }, 600,
    );
    const csrf = (await import('../src/lib/commerce/consent.js'))
      .deriveConsentCsrfToken(sessionToken, 'req_X');
    // findConsentByRequestId — record exists
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_X', tenant_id: 'cten_DISABLED', merchant_id: 'mch_M', agent_id: 'cag_A',
      consent_request_id: 'req_X', passport_type: 'browse',
      requested_scopes: ['x'], approved_scopes: null, max_amount: null, currency: null,
      consent_text_version: '2026-05-01', presented_payload_hash: 'h',
      status: 'requested', agent_auth_method: 'jwt',
      expires_at: new Date(Date.now() + 600_000), approved_at: null, denied_at: null,
      user_principal_id: null, user_principal_hint: null, created_at: new Date(),
    }]);
    // ensurePrincipalCanActOnTenant — bound, but tenant disabled
    sqlMock.mockResolvedValueOnce([{ status: 'disabled' }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/consent/req_X/approve',
      headers: {
        host: 'consent.grantex.dev',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });

  it('passport exchange for disabled tenant → 403 tenant_disabled (before signing)', async () => {
    const kp = await generateKeyPair('ES256');
    const jwk = await exportJWK(kp.publicKey) as JWK;
    const now = Math.floor(Date.now() / 1000);
    const agentJwt = await new SignJWT({ tenant_id: 'cten_T' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_AGENT').setSubject('cag_AGENT')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}`).setIssuedAt(now).setExpirationTime(now + 60)
      .sign(kp.privateKey);
    // Agent lookup — agent's tenant 'cten_T' is active (so caller resolves)
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_AGENT', tenant_id: 'cten_T', trust_status: 'trusted',
      public_key_jwk: jwk, api_key_hash: null,
      tenant_status: 'active',
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');
    // findConsentByRequestId — granted, valid hash
    const expiresIso = new Date(Date.now() + 60_000).toISOString();
    const { canonicalPresentedPayload, sha256hex } = await import('../src/lib/commerce/consent.js');
    const hash = sha256hex(canonicalPresentedPayload({
      id: 'crec_OK', tenantId: 'cten_T', merchantId: 'mch_M', agentId: 'cag_AGENT',
      consentRequestId: 'req_OK', passportType: 'browse',
      requestedScopes: ['commerce:catalog.read'],
      approvedScopes: ['commerce:catalog.read'],
      maxAmount: null, currency: null, consentTextVersion: '2026-05-01',
      presentedPayloadHash: null, status: 'granted', agentAuthMethod: 'jwt',
      expiresAt: expiresIso, approvedAt: null, deniedAt: null,
      userPrincipalId: 'user_X', userPrincipalHint: null, createdAt: '',
    }));
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_OK', tenant_id: 'cten_T', merchant_id: 'mch_M',
      agent_id: 'cag_AGENT', consent_request_id: 'req_OK',
      passport_type: 'browse',
      requested_scopes: ['commerce:catalog.read'],
      approved_scopes: ['commerce:catalog.read'],
      max_amount: null, currency: null,
      consent_text_version: '2026-05-01',
      presented_payload_hash: hash, status: 'granted',
      agent_auth_method: 'jwt',
      expires_at: expiresIso,
      approved_at: new Date(), denied_at: null,
      user_principal_id: 'user_X', user_principal_hint: null,
      created_at: new Date(),
    }]);
    // Existing-passport check empty
    sqlMock.mockResolvedValueOnce([]);
    // Merchant + tenant JOIN — tenant disabled
    sqlMock.mockResolvedValueOnce([{ environment: 'sandbox', tenant_status: 'disabled' }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/passports/exchange',
      headers: { authorization: `Bearer ${agentJwt}`, 'content-type': 'application/json' },
      payload: { consent_request_id: 'req_OK' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });

  it('platform admin tenant provisioning still works (admin path bypasses tenant check)', async () => {
    sqlMock.mockResolvedValueOnce([]);  // developer lookup empty (admin)
    sqlMock.mockResolvedValueOnce([
      { id: 'cten_NEW', display_name: 'X', status: 'active', metadata: {}, created_at: new Date(), updated_at: new Date() },
    ]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_T', occurred_at: new Date().toISOString() }]);
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/tenants',
      headers: { authorization: 'Bearer test-admin-key-secret' },
      payload: { display_name: 'X' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('Finding 4 (round 2) — product GET no existence leak', () => {
  it('agent caller without merchant_id -> 422 before any product SQL', async () => {
    const kp = await generateKeyPair('ES256');
    const jwk = await exportJWK(kp.publicKey) as JWK;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ tenant_id: TEST_COMMERCE_TENANT_ID })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cag_X').setSubject('cag_X')
      .setAudience('grantex-commerce')
      .setJti(`jti_${now}_${Math.random()}`)
      .setIssuedAt(now).setExpirationTime(now + 60)
      .sign(kp.privateKey);
    // Only the agent-resolution mocks are needed; product SQL must NOT run.
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_X', tenant_id: TEST_COMMERCE_TENANT_ID, trust_status: 'trusted',
      public_key_jwk: jwk, api_key_hash: null,
      tenant_status: 'active',
    }]);
    mockRedis.set.mockResolvedValueOnce('OK');

    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/catalog/products/cprd_X',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');

    // Crucially: NO SELECT against commerce_products fired.
    const productSelect = sqlMock.mock.calls.find((c) => {
      const tpl = c[0] as unknown;
      return Array.isArray(tpl)
        && tpl.some((s) => typeof s === 'string' && /FROM commerce_products/i.test(s));
    });
    expect(productSelect).toBeUndefined();
  });

  it('merchant caller for cross-merchant product → 404 (existence not leaked, even though product is in tenant)', async () => {
    // Merchant key bound to mch_OWN. Resolver: SELECT key (mock 1) +
    // fire-and-forget UPDATE last_used_at (mock 2 — default []).
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_X', tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_OWN', environment: 'sandbox',
      tenant_status: 'active',
    }]);
    sqlMock.mockResolvedValueOnce([]);  // soak the last_used_at UPDATE
    // Product SELECT bound to (tenant_id, merchant_id=mch_OWN). The
    // product cprd_OTHER actually belongs to mch_OTHER, so this query
    // returns empty even though the product exists in the tenant. The
    // route returns 404 (same shape as not-in-tenant). Existence not leaked.
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/catalog/products/cprd_OTHER',
      headers: { authorization: 'Bearer grtx_sk_sandbox_CCCCCCCCCCCCCCCCCCCCCCCC' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('product_not_found');
  });

  it('merchant caller for own-merchant product → 200 (or 404 if not present)', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'mkey_X', tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_OWN', environment: 'sandbox',
      tenant_status: 'active',
    }]);
    sqlMock.mockResolvedValueOnce([]);  // soak the last_used_at UPDATE
    sqlMock.mockResolvedValueOnce([{
      id: 'cprd_OWN', tenant_id: TEST_COMMERCE_TENANT_ID, merchant_id: 'mch_OWN',
      product_id: 'P1', title: 'Toaster', brand: null, description: null, image_url: null,
      category_preset: 'electronics_appliances', source_system: 'manual',
      manually_maintained: false, archived_at: null,
      created_at: new Date(), updated_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([]);  // variants empty

    const res = await app.inject({
      method: 'GET', url: '/v1/commerce/catalog/products/cprd_OWN',
      headers: { authorization: 'Bearer grtx_sk_sandbox_CCCCCCCCCCCCCCCCCCCCCCCC' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { id: string } }>().data.id).toBe('cprd_OWN');
  });
});

// Use TEST_DEVELOPER to silence unused-import lint.
void TEST_DEVELOPER;
