/**
 * Tests for the consent challenge — the user-presence credential
 * introduced to close the M2 P0 self-approval hole. The attack the
 * challenge defeats:
 *
 *   1. Trusted agent creates a consent request with hint=user_X.
 *   2. Agent's developer mints a principal session JWT for user_X
 *      (legitimate flow because user_X has an active grant).
 *   3. Agent uses ?session=… bootstrap; cookie is set.
 *   4. Agent computes csrf = sha256(session_token + ':' + reqId).
 *   5. Agent POSTs approve with no human gesture in the loop.
 *
 * The fix: a server-issued, single-use challenge that the
 * agent/developer cannot read or compute. Approve/deny consume a
 * verified challenge atomically with the consent state transition.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sqlMock, buildTestApp } from './helpers.js';
import { signPrincipalSessionToken } from '../src/lib/crypto.js';
import { deriveConsentCsrfToken } from '../src/lib/commerce/consent.js';
import { _internal as challengeInternal } from '../src/lib/commerce/consent-challenge.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => { vi.unstubAllEnvs(); });

const HOST = 'consent.grantex.dev';
const REQ = 'req_TEST';
const PRINCIPAL = 'user_X';
const DEVELOPER = 'dev_TEST';
const TENANT = 'cten_T';

function fakeConsent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'crec_TEST', tenant_id: TENANT, merchant_id: 'mch_M', agent_id: 'cag_A',
    consent_request_id: REQ, passport_type: 'browse',
    requested_scopes: ['commerce:catalog.read'],
    approved_scopes: null, max_amount: null, currency: null,
    consent_text_version: '2026-05-01',
    presented_payload_hash: null, status: 'requested',
    agent_auth_method: 'jwt',
    expires_at: new Date(Date.now() + 600_000), approved_at: null, denied_at: null,
    user_principal_id: null, user_principal_hint: null, created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// P0 — original self-approval attack now fails
// ---------------------------------------------------------------------
describe('P0 — agent/developer cannot self-approve via principal session alone', () => {
  it('agent has session + CSRF + tenant binding but no verified challenge → 403 challenge_required', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    // Mocks for the approve route up to the decideConsent call:
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                  // findConsentByRequestId
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);           // tenant binding
    // approveConsent inside sql.begin:
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                  // SELECT FOR UPDATE consent
    sqlMock.mockResolvedValueOnce([]);                               // SELECT FOR UPDATE challenge → none
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/approve`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string; retryable?: boolean } }>().error.code)
      .toBe('challenge_required');
  });

  it('GET /page with valid session but no challenge → renders challenge_request, NOT approve/deny', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                  // present FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                               // present UPDATE
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);           // tenant binding
    sqlMock.mockResolvedValueOnce([]);                               // findActiveChallenge → none

    const res = await app.inject({
      method: 'GET', url: `/v1/commerce/consent/page?req=${REQ}`,
      headers: { host: HOST, cookie: `grantex_principal_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    // The page surface offers code request, not approve/deny, until
    // the challenge is verified.
    expect(res.body).toMatch(/<form[^>]*\/challenge"/);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
  });

  it('CSRF + session alone is insufficient even when attacker knows session token and reqId', async () => {
    // Same setup as the first test — the attacker has all the inputs
    // (session, reqId, computed CSRF). The 403 confirms the challenge
    // gate cannot be bypassed by guessing or recomputing.
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([]);  // no verified challenge
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/approve`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('challenge_required');
  });

  it('challenge hash derivation includes consent_request_id + principal_id (cross-consent replay impossible)', () => {
    const codeA = '123456';
    const reqA = 'req_A';
    const reqB = 'req_B';
    const principalA = 'user_A';
    const principalB = 'user_B';
    const hAA = challengeInternal.hashChallengeCode(codeA, reqA, principalA);
    const hAB = challengeInternal.hashChallengeCode(codeA, reqA, principalB);
    const hBA = challengeInternal.hashChallengeCode(codeA, reqB, principalA);
    expect(hAA).not.toBe(hAB);
    expect(hAA).not.toBe(hBA);
    expect(hAB).not.toBe(hBA);
  });
});

// ---------------------------------------------------------------------
// Challenge create endpoint
// ---------------------------------------------------------------------
describe('POST /v1/commerce/consent/{reqId}/challenge', () => {
  it('returns test_only_code in test_sink + non-production mode', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    // Route flow: findConsentByRequestId, tenant binding, then createChallenge
    // which inside sql.begin runs an UPDATE (expire previous) + INSERT.
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                  // findConsentByRequestId
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);           // tenant binding
    sqlMock.mockResolvedValueOnce([]);                               // UPDATE expire-old
    sqlMock.mockResolvedValueOnce([]);                               // INSERT challenge
    sqlMock.mockResolvedValueOnce([{ id: 'caud_R', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { delivery_channel: string; test_only_code?: string; challenge_id: string } }>();
    expect(body.data.delivery_channel).toBe('test_sink');
    expect(typeof body.data.test_only_code).toBe('string');
    expect(body.data.test_only_code).toMatch(/^\d{6}$/);
    expect(body.data.challenge_id).toMatch(/^ccch_/);
  });

  it('fail-closed in production with no provider configured → 503 challenge_provider_unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_CONSENT_CHALLENGE_PROVIDER', '');
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: 'consent.grantex.dev',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `__Host-grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string; retryable?: boolean } }>().error.code)
      .toBe('challenge_provider_unavailable');
  });

  it('rejects challenge create without principal session → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'csrf=anything',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_session_required');
  });

  it('rejects challenge create with mismatched CSRF → 403', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: 'csrf=wrong',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('csrf_invalid');
  });

  it('rejects challenge create when principal hint does not match → 403', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent({ user_principal_hint: 'user_OTHER' })]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_hint_mismatch');
  });
});

// ---------------------------------------------------------------------
// Challenge verify endpoint
// ---------------------------------------------------------------------
describe('POST /v1/commerce/consent/{reqId}/challenge/verify', () => {
  it('correct code marks the challenge verified + audit', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    const code = '123456';
    const goodHash = challengeInternal.hashChallengeCode(code, REQ, PRINCIPAL);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                          // findConsentByRequestId
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);                   // tenant binding
    // verifyChallenge inside sql.begin:
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_X', tenant_id: TENANT,
      consent_request_id: REQ, principal_id: PRINCIPAL,
      challenge_hash: goodHash,
      status: 'requested', attempts_count: 0, max_attempts: 5,
      expires_at: new Date(Date.now() + 60_000),
    }]);                                                                      // SELECT FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                                        // UPDATE → verified
    sqlMock.mockResolvedValueOnce([{ id: 'caud_V', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=${code}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string; challenge_id: string } }>();
    expect(body.data.status).toBe('verified');
    expect(body.data.challenge_id).toBe('ccch_X');
  });

  it('wrong code increments attempts → 403 challenge_invalid with remaining_attempts', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    const goodHash = challengeInternal.hashChallengeCode('999999', REQ, PRINCIPAL);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_X', tenant_id: TENANT, consent_request_id: REQ, principal_id: PRINCIPAL,
      challenge_hash: goodHash,
      status: 'requested', attempts_count: 0, max_attempts: 5,
      expires_at: new Date(Date.now() + 60_000),
    }]);
    sqlMock.mockResolvedValueOnce([]);  // UPDATE attempts_count

    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=000000`,
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; details?: { remaining_attempts: number } } }>();
    expect(body.error.code).toBe('challenge_invalid');
    expect(body.error.details?.remaining_attempts).toBe(4);
  });

  it('exceeded max_attempts → 410 challenge_expired (challenge marked expired)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    const goodHash = challengeInternal.hashChallengeCode('999999', REQ, PRINCIPAL);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    // attempts_count: 4 of 5 (next attempt is the 5th and final).
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_X', tenant_id: TENANT, consent_request_id: REQ, principal_id: PRINCIPAL,
      challenge_hash: goodHash, status: 'requested',
      attempts_count: 4, max_attempts: 5,
      expires_at: new Date(Date.now() + 60_000),
    }]);
    sqlMock.mockResolvedValueOnce([]);   // UPDATE → expired

    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=000000`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('challenge_expired');
  });

  it('expired challenge (past expires_at) → 410 challenge_expired', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_X', tenant_id: TENANT, consent_request_id: REQ, principal_id: PRINCIPAL,
      challenge_hash: 'h', status: 'requested',
      attempts_count: 0, max_attempts: 5,
      expires_at: new Date(Date.now() - 1000),     // already expired
    }]);
    sqlMock.mockResolvedValueOnce([]);   // UPDATE → expired
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=123456`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('challenge_expired');
  });

  it('no active challenge for (reqId, principalId) → 404 challenge_not_found', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([]);  // verifyChallenge SELECT FOR UPDATE → none
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=123456`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('challenge_not_found');
  });

  it('rejects non-numeric code → 422 validation_failed', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge/verify`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}&code=abc`,
    });
    expect(res.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------
// End-to-end: verify challenge then approve / re-approve fails
// ---------------------------------------------------------------------
describe('Approve/deny consume the verified challenge atomically', () => {
  it('successful approve consumes the challenge; second approve fails (no more verified challenges)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    // First approve — supplies all mocks for: findConsent, tenant,
    // consent FOR UPDATE, challenge FOR UPDATE (verified), challenge UPDATE used,
    // consent UPDATE granted, audit consent.granted, audit consent.challenge.used.
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_V', expires_at: new Date(Date.now() + 60_000),
    }]);
    sqlMock.mockResolvedValueOnce([]);                               // challenge → 'used'
    sqlMock.mockResolvedValueOnce([fakeConsent({
      status: 'granted', approved_scopes: ['commerce:catalog.read'],
      approved_at: new Date(), user_principal_id: PRINCIPAL,
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_G', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C', occurred_at: new Date().toISOString() }]);

    const ok = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/approve`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(ok.statusCode).toBe(200);

    // Second approve — consent now status='granted'; SELECT FOR UPDATE
    // returns granted row → already_decided. (Even before that, the
    // challenge was consumed so this would also fail challenge_required.)
    sqlMock.mockResolvedValueOnce([fakeConsent({ status: 'granted' })]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([fakeConsent({ status: 'granted' })]);

    const second = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/approve`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code)
      .toBe('consent_already_decided');
  });
});

// ---------------------------------------------------------------------
// Round-5 P1 fixes — fail-closed on email_otp / non-test environments
// ---------------------------------------------------------------------
describe('Delivery channel selection — fail-closed everywhere except NODE_ENV=test', () => {
  // Defensive lib-level reads. The route paths are covered separately
  // in the integration tests below.
  it('NODE_ENV=test (default vitest env) → test_sink', () => {
    expect(challengeInternal.selectDeliveryChannel()).toBe('test_sink');
  });

  it('NODE_ENV=development without provider → null (fail closed)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });

  it('NODE_ENV=staging without provider → null', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });

  it('NODE_ENV=production without provider → null', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });

  it('NODE_ENV=production with COMMERCE_CONSENT_CHALLENGE_PROVIDER=email_otp → STILL null (M2 fail-closed)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_CONSENT_CHALLENGE_PROVIDER', 'email_otp');
    // M2 deferral: setting the env var must NOT enable delivery,
    // because no real delivery is implemented yet. Route returns 503.
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });

  it('NODE_ENV=development with email_otp → STILL null (M2 fail-closed)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('COMMERCE_CONSENT_CHALLENGE_PROVIDER', 'email_otp');
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });

  it('NODE_ENV=test with email_otp → null (lets tests cover the email_otp deferred path)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_CONSENT_CHALLENGE_PROVIDER', 'email_otp');
    expect(challengeInternal.selectDeliveryChannel()).toBeNull();
  });
});

describe('Route — challenge create reflects the strict fail-closed posture', () => {
  it('POST /challenge in NODE_ENV=development → 503 challenge_provider_unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code)
      .toBe('challenge_provider_unavailable');
  });

  it('POST /challenge in NODE_ENV=production with email_otp → STILL 503 (M2 deferred)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_CONSENT_CHALLENGE_PROVIDER', 'email_otp');
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        // production cookie name in this NODE_ENV
        host: 'consent.grantex.dev',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `__Host-grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code)
      .toBe('challenge_provider_unavailable');
  });

  it('test_only_code is returned ONLY in NODE_ENV=test', async () => {
    // Default vitest env IS NODE_ENV=test (per vitest.config.ts).
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_R', occurred_at: new Date().toISOString() }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/challenge`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { test_only_code?: string } }>();
    expect(typeof body.data.test_only_code).toBe('string');
  });
});

describe('GET /page renders challenge_unavailable in any non-test env without a real provider', () => {
  it('NODE_ENV=development → 503 challenge_unavailable (no green button to a 503 POST)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsent()]);                  // present FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                               // present UPDATE
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);           // tenant binding
    sqlMock.mockResolvedValueOnce([]);                               // findActiveChallenge → none
    const res = await app.inject({
      method: 'GET', url: `/v1/commerce/consent/page?req=${REQ}`,
      headers: { host: HOST, cookie: `grantex_principal_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(503);
    // Page surface must NOT show approve/deny OR a request-code button.
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
    expect(res.body).not.toMatch(/<form[^>]*\/challenge"/);
  });
});

// ---------------------------------------------------------------------
// Round-5 P2 fix — expired challenges don't render decision forms
// ---------------------------------------------------------------------
describe('findActiveChallenge filters by expires_at (P2)', () => {
  it('expired requested challenge → page renders challenge_request, NOT challenge_verify', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    // findActiveChallenge SELECT ... AND expires_at > NOW() → empty
    // (the expired row is not returned). Even though there IS a stale
    // row in the DB, the filter hides it. Page renders challenge_request.
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET', url: `/v1/commerce/consent/page?req=${REQ}`,
      headers: { host: HOST, cookie: `grantex_principal_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    // Decision forms NOT rendered.
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
    // Code-entry form NOT rendered (we don't have an active requested challenge).
    expect(res.body).not.toMatch(/<form[^>]*\/challenge\/verify"/);
    // Send-code form IS rendered.
    expect(res.body).toMatch(/<form[^>]*\/challenge"/);
  });

  it('expired VERIFIED challenge → page does NOT render approve/deny forms', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    // The DB has a verified row but it's past expires_at; the WHERE
    // expires_at > NOW() filter excludes it. Page renders the request
    // form instead of the now-broken approve/deny.
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET', url: `/v1/commerce/consent/page?req=${REQ}`,
      headers: { host: HOST, cookie: `grantex_principal_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
    expect(res.body).toMatch(/<form[^>]*\/challenge"/);
  });

  it('NOT-yet-expired verified challenge still renders approve/deny (regression check)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsent()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_X', status: 'verified', expires_at: new Date(Date.now() + 60_000),
    }]);
    const res = await app.inject({
      method: 'GET', url: `/v1/commerce/consent/page?req=${REQ}`,
      headers: { host: HOST, cookie: `grantex_principal_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<form[^>]*\/approve"/);
    expect(res.body).toMatch(/<form[^>]*\/deny"/);
  });
});

// ---------------------------------------------------------------------
// P2 — deny enforces principal_hint_mismatch
// ---------------------------------------------------------------------
describe('P2 — deny enforces user_principal_hint', () => {
  it('deny with mismatched hint → 403 principal_hint_mismatch', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent({ user_principal_hint: 'user_OTHER' })]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([fakeConsent({ user_principal_hint: 'user_OTHER' })]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/deny`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code)
      .toBe('principal_hint_mismatch');
  });

  it('deny with matching hint + verified challenge → 200', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: PRINCIPAL, developerId: DEVELOPER }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, REQ);
    sqlMock.mockResolvedValueOnce([fakeConsent({ user_principal_hint: PRINCIPAL })]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([fakeConsent({ user_principal_hint: PRINCIPAL })]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_V', expires_at: new Date(Date.now() + 60_000),
    }]);
    sqlMock.mockResolvedValueOnce([]);                                 // UPDATE challenge used
    sqlMock.mockResolvedValueOnce([fakeConsent({
      status: 'denied', user_principal_id: PRINCIPAL, user_principal_hint: PRINCIPAL,
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_D', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C', occurred_at: new Date().toISOString() }]);
    const res = await app.inject({
      method: 'POST', url: `/v1/commerce/consent/${REQ}/deny`,
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Denied/);
  });
});
