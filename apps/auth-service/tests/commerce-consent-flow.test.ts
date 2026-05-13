import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sqlMock, buildTestApp } from './helpers.js';
import { signPrincipalSessionToken } from '../src/lib/crypto.js';
import { deriveConsentCsrfToken, sha256hex, canonicalPresentedPayload } from '../src/lib/commerce/consent.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => { vi.unstubAllEnvs(); });

const CONSENT_HOST = 'consent.grantex.dev';
const TEST_DEVELOPER_ID = 'dev_TEST';
const TEST_PRINCIPAL_ID = 'user_X';

function fakeConsentRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'crec_TEST', tenant_id: 'cten_T', merchant_id: 'mch_M', agent_id: 'cag_A',
    consent_request_id: 'req_TEST', passport_type: 'browse',
    requested_scopes: ['commerce:catalog.read'],
    approved_scopes: null, max_amount: null, currency: null,
    consent_text_version: '2026-05-01',
    presented_payload_hash: null, status: 'requested',
    agent_auth_method: 'jwt',
    expires_at: new Date(Date.now() + 600_000), approved_at: null, denied_at: null,
    user_principal_id: null,
    user_principal_hint: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('GET /v1/commerce/consent/page — host isolation + sign-in gating', () => {
  it('host isolation — returns 404 when Host is the API origin (production)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/consent/page?req=req_TEST',
      headers: { host: 'api.grantex.dev' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('renders sign_in_required when no principal session is present', async () => {
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);  // FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                  // UPDATE presented_payload_hash
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/consent/page?req=req_TEST',
      headers: { host: CONSENT_HOST },
    });
    expect(res.statusCode).toBe(200);
    // Strict CSP enforced regardless of state.
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).not.toMatch(/'unsafe-inline'/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    // No CSRF/principal cookie set when sign-in required.
    expect(res.headers['set-cookie']).toBeUndefined();
    // No approve/deny forms rendered.
    expect(res.body).toMatch(/Sign in to authorize/);
    expect(res.body).not.toMatch(/<form[^>]*action="\/v1\/commerce\/consent\//);
  });

  it('first GET with ?session= returns 303 redirect (Finding 2 — token must not linger in URL)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST&session=${encodeURIComponent(sessionToken)}`,
      headers: { host: CONSENT_HOST },
    });
    expect(res.statusCode).toBe(303);
    // Location preserves req but excludes session.
    expect(res.headers['location']).toBe('/v1/commerce/consent/page?req=req_TEST');
    expect(res.headers['location']).not.toMatch(/session=/);
    // Cookie set on the redirect itself so the follow-up GET carries it.
    expect(res.headers['set-cookie']).toMatch(/grantex_principal_session=/);
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/);
    expect(res.headers['set-cookie']).toMatch(/SameSite=Strict/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    // Referrer-Policy must be no-referrer so the redirect itself doesn't
    // leak the source URL (which still contains the session) to any
    // intermediary that follows the Referer chain.
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('follow-up GET (with cookie, no ?session=) — no challenge yet → renders challenge_request', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);          // present FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                          // present UPDATE
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);      // tenant binding
    sqlMock.mockResolvedValueOnce([]);                          // findActiveChallenge → none

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // Per P0 fix: approve/deny are NOT rendered until a verified challenge
    // exists. The page shows the "send verification code" form instead.
    expect(res.body).toMatch(/Verify it/);
    expect(res.body).toMatch(/<form[^>]*\/challenge"/);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
    expect(res.body).not.toMatch(/<form[^>]*\/deny"/);
  });

  it('follow-up GET with verified challenge → renders approve/deny forms', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);          // present FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);                          // present UPDATE
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);      // tenant binding
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_TEST', status: 'verified',
      expires_at: new Date(Date.now() + 60_000),
    }]);                                                         // findActiveChallenge → verified

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toMatch(/<form[^>]+action="\/v1\/commerce\/consent\/req_TEST\/approve"/);
    expect(res.body).toMatch(/<form[^>]+action="\/v1\/commerce\/consent\/req_TEST\/deny"/);
    const expectedCsrf = deriveConsentCsrfToken(sessionToken, 'req_TEST');
    expect(res.body).toContain(expectedCsrf);
  });

  it('invalid ?session= does NOT set cookie and does NOT redirect — renders sign_in_required', async () => {
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/consent/page?req=req_TEST&session=garbage',
      headers: { host: CONSENT_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toMatch(/Sign in to authorize/);
  });

  it('follow-up GET with cookie but developer NOT bound to tenant returns 403', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: 'dev_OTHER' }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);
    sqlMock.mockResolvedValueOnce([]);                  // UPDATE presented hash
    sqlMock.mockResolvedValueOnce([]);                  // tenant binding lookup empty (no row)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/<form/);
  });

  it('follow-up GET with cookie but disabled tenant renders closed screen (Finding 3)', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status: 'disabled' }]);  // tenant disabled

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
  });

  it('follow-up GET with cookie + hint mismatch renders sign_in_required', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    sqlMock.mockResolvedValueOnce([fakeConsentRow({ user_principal_hint: 'user_DIFFERENT' })]);
    sqlMock.mockResolvedValueOnce([]);                  // UPDATE presented hash
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);  // tenant binding ok + active

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Sign in to authorize/);
    expect(res.body).not.toMatch(/<form[^>]*\/approve"/);
  });
});

describe('GET /v1/commerce/consent/page — multi-tab re-render (bonus bug fix)', () => {
  it('returns the same presented_payload_hash on second present (no regeneration)', async () => {
    const fixedHash = 'a'.repeat(64);
    sqlMock.mockResolvedValueOnce([fakeConsentRow({ presented_payload_hash: fixedHash })]);
    // No UPDATE on subsequent present (hash already set; lib short-circuits).
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);  // tenant binding lookup → bound + active
    // With a verified challenge, the page renders the approve/deny forms.
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_TEST', status: 'verified',
      expires_at: new Date(Date.now() + 60_000),
    }]);

    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/consent/page?req=req_TEST`,
      headers: {
        host: CONSENT_HOST,
        cookie: `grantex_principal_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Authorize agent action/);
    expect(res.body).toMatch(/<form[^>]*\/approve"/);
  });
});

describe('POST /v1/commerce/consent/:reqId/approve — Finding 1 enforcement', () => {
  it('rejects approve without principal session cookie → 401 principal_session_required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'csrf=anything',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_session_required');
  });

  it('rejects approve when principal session JWT is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'grantex_principal_session=garbage',
      },
      payload: 'csrf=anything',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_session_required');
  });

  it('rejects approve with valid session but mismatched CSRF → 403 csrf_invalid', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: 'csrf=wrong-token',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('csrf_invalid');
  });

  it('rejects approve when principal\'s developer is not bound to consent tenant → 403', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: 'dev_NOT_BOUND' }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, 'req_TEST');
    // findConsentByRequestId
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);
    // ensurePrincipalCanActOnTenant — empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_not_authorized_for_tenant');
  });

  it('happy path: valid session + verified challenge + matching CSRF + tenant binding → 200 + audit', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, 'req_TEST');
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);                       // findConsentByRequestId
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);                   // tenant binding
    // approveConsent inside sql.begin:
    sqlMock.mockResolvedValueOnce([fakeConsentRow()]);                       // SELECT FOR UPDATE consent
    // consumeVerifiedChallengeTx — SELECT FOR UPDATE then UPDATE used.
    sqlMock.mockResolvedValueOnce([{
      id: 'ccch_VERIFIED', expires_at: new Date(Date.now() + 60_000),
    }]);
    sqlMock.mockResolvedValueOnce([]);                                        // UPDATE challenge → 'used'
    sqlMock.mockResolvedValueOnce([fakeConsentRow({
      status: 'granted', approved_scopes: ['commerce:catalog.read'],
      approved_at: new Date(), user_principal_id: TEST_PRINCIPAL_ID,
    })]);                                                                     // UPDATE...RETURNING
    sqlMock.mockResolvedValueOnce([{ id: 'caud_G', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Approved/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['content-security-policy']).not.toMatch(/'unsafe-inline'/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(/\sstyle=/);
    expect(res.body).not.toContain(sessionToken);
    expect(res.body).not.toContain(csrf);

    // Confirm both audit events fired: consent.granted AND consent.challenge.used.
    const auditEventTypes = sqlMock.mock.calls
      .filter((c) => {
        const tpl = c[0] as unknown;
        return Array.isArray(tpl)
          && tpl.some((s) => typeof s === 'string' && /INSERT INTO commerce_audit_events/i.test(s));
      })
      .flatMap((c) => c.slice(1));
    expect(auditEventTypes).toContain('consent.granted');
    expect(auditEventTypes).toContain('consent.challenge.used');
    expect(auditEventTypes).toContain(TEST_PRINCIPAL_ID);
  });

  it('rejects approve when consent has hint that does NOT match authenticated principal → 403', async () => {
    const sessionToken = await signPrincipalSessionToken(
      { principalId: TEST_PRINCIPAL_ID, developerId: TEST_DEVELOPER_ID }, 600,
    );
    const csrf = deriveConsentCsrfToken(sessionToken, 'req_TEST');
    sqlMock.mockResolvedValueOnce([fakeConsentRow({ user_principal_hint: 'user_OTHER' })]);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    // approveConsent: SELECT FOR UPDATE returns the same row with hint.
    // Hint check fires BEFORE challenge consumption, so no challenge mocks needed.
    sqlMock.mockResolvedValueOnce([fakeConsentRow({ user_principal_hint: 'user_OTHER' })]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/consent/req_TEST/approve',
      headers: {
        host: CONSENT_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `grantex_principal_session=${sessionToken}`,
      },
      payload: `csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('principal_hint_mismatch');
  });
});

// Use the canonical hash function so the unused-import lint doesn't fire.
void canonicalPresentedPayload;
void sha256hex;
