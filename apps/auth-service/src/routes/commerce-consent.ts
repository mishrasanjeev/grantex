import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/client.js';
import { verifyPrincipalSessionToken } from '../lib/crypto.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import {
  findConsentByRequestId,
  presentConsentForUser,
  approveConsent,
  denyConsent,
  canonicalPresentedPayload,
  sha256hex,
  deriveConsentCsrfToken,
  type ConsentRecord,
} from '../lib/commerce/consent.js';
import {
  createChallenge,
  verifyChallenge,
  findActiveChallenge,
  isChallengeProviderAvailable,
} from '../lib/commerce/consent-challenge.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';

const SESSION_COOKIE_PROD = '__Host-grantex_principal_session';
const SESSION_COOKIE_DEV = 'grantex_principal_session';

function sessionCookieName(): string {
  return process.env['NODE_ENV'] === 'production' ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

function isAcceptableConsentHost(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.split(':')[0];
  if (process.env['NODE_ENV'] === 'production') {
    const required = process.env['COMMERCE_CONSENT_HOST'] ?? 'consent.grantex.dev';
    return bare === required;
  }
  if (bare === 'localhost' || bare === '127.0.0.1') return true;
  if (bare === 'consent.grantex.dev') return true;
  const dev = process.env['COMMERCE_CONSENT_HOST'];
  if (dev && bare === dev) return true;
  return false;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applySecurityHeaders(reply: FastifyReply, nonce: string): void {
  // Spec §14 strict CSP. Inline scripts use a per-request nonce.
  const csp = [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https:",
    "connect-src 'self'",
  ].join('; ');
  void reply.header('Content-Security-Policy', csp);
  void reply.header('X-Frame-Options', 'DENY');
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('Cache-Control', 'no-store');
  void reply.header('Pragma', 'no-cache');
  void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // Finding 2: consent URLs may transiently carry a principal session
  // token in the query string (which we strip via 303 immediately, but
  // belt-and-braces). no-referrer keeps the token from leaking via the
  // browser Referer header to any subresource, even within the same
  // origin. Server-level onSend respects this when set per-route.
  void reply.header('Referrer-Policy', 'no-referrer');
}

function setSessionCookie(reply: FastifyReply, sessionToken: string): void {
  const isProd = process.env['NODE_ENV'] === 'production';
  const parts = [
    `${sessionCookieName()}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isProd) parts.push('Secure');
  void reply.header('Set-Cookie', parts.join('; '));
}

function getSessionFromCookie(request: FastifyRequest): string | null {
  const raw = request.headers['cookie'];
  if (typeof raw !== 'string') return null;
  const name = sessionCookieName();
  const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`);
  const match = re.exec(raw);
  return match?.[1] ?? null;
}

interface AuthenticatedPrincipal {
  principalId: string;
  developerId: string;
  rawToken: string;
}

/**
 * Resolve the authenticated principal for the consent flow. Reads the
 * session token from the cookie; on first GET the route promotes a
 * `?session=<token>` query param to the cookie before this is called.
 *
 * Returns null when no session is present or it fails verification.
 * Callers that REQUIRE a principal must respond accordingly (the GET
 * handler renders a sign-in screen; POST approve/deny return 401).
 */
async function resolvePrincipalSession(request: FastifyRequest): Promise<AuthenticatedPrincipal | null> {
  const token = getSessionFromCookie(request);
  if (!token) return null;
  try {
    const claims = await verifyPrincipalSessionToken(token);
    return { principalId: claims.principalId, developerId: claims.developerId, rawToken: token };
  } catch {
    return null;
  }
}

type PrincipalTenantBinding =
  | { bound: false }
  | { bound: true; tenantStatus: 'active' | 'disabled' };

/**
 * Verify the authenticated principal's developer is bound to the
 * consent record's tenant AND that the tenant is active (Finding 3).
 * Returns the tenant status alongside the binding so the caller can
 * surface a precise tenant_disabled response without a second query.
 */
async function ensurePrincipalCanActOnTenant(
  developerId: string,
  tenantId: string,
): Promise<PrincipalTenantBinding> {
  const sql = getSql();
  const rows = await sql<{ status: string }[]>`
    SELECT t.status
      FROM commerce_developer_tenants dt
      JOIN commerce_tenants t ON t.id = dt.tenant_id
     WHERE dt.developer_id = ${developerId}
       AND dt.tenant_id = ${tenantId}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { bound: false };
  return {
    bound: true,
    tenantStatus: row.status === 'disabled' ? 'disabled' : 'active',
  };
}

function parseFormBody(body: unknown): URLSearchParams {
  // Return URLSearchParams rather than a plain object so user-supplied
  // form keys cannot pollute Object.prototype via bracket-assignment.
  // Callers read fixed known fields with `.get('csrf')` etc.
  if (typeof body === 'string') {
    return new URLSearchParams(body);
  }
  if (body && typeof body === 'object') {
    const init: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') init.push([k, v]);
    }
    return new URLSearchParams(init);
  }
  return new URLSearchParams();
}

type RenderState =
  | 'present'                    // verified challenge → approve/deny forms
  | 'challenge_request'          // session ok, no challenge yet → "send code" form
  | 'challenge_verify'           // challenge requested → "enter code" form
  | 'challenge_unavailable'      // production with no provider → fail closed
  | 'expired'
  | 'already_decided'
  | 'not_found'
  | 'sign_in_required';

function renderConsentPage(
  record: ConsentRecord | null,
  csrfToken: string | null,
  nonce: string,
  state: RenderState,
): string {
  const title =
    state === 'present' ? 'Authorize agent action'
    : state === 'challenge_request' ? 'Verify it’s you'
    : state === 'challenge_verify' ? 'Enter your verification code'
    : state === 'challenge_unavailable' ? 'Verification temporarily unavailable'
    : state === 'expired' ? 'Consent expired'
    : state === 'not_found' ? 'Consent not found'
    : state === 'sign_in_required' ? 'Sign in to authorize'
    : `Consent ${record?.status ?? 'closed'}`;
  const reqIdAttr = escapeHtml(record?.consentRequestId ?? '');
  const csrfField = csrfToken
    ? `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`
    : '';
  const scopesHtml = record
    ? record.requestedScopes.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    : '';
  const decisionForms = (state === 'present' && csrfToken && record)
    ? `
      <form method="POST" action="/v1/commerce/consent/${reqIdAttr}/approve" class="row">
        ${csrfField}
        <button class="btn btn-primary" type="submit">Approve</button>
      </form>
      <form method="POST" action="/v1/commerce/consent/${reqIdAttr}/deny" class="row">
        ${csrfField}
        <button class="btn btn-secondary" type="submit">Deny</button>
      </form>`
    : '';
  const challengeRequestForm = (state === 'challenge_request' && csrfToken && record)
    ? `
      <p class="msg">For your security, Grantex will send you a one-time verification code before your decision is recorded.</p>
      <form method="POST" action="/v1/commerce/consent/${reqIdAttr}/challenge" class="row">
        ${csrfField}
        <button class="btn btn-primary" type="submit">Send verification code</button>
      </form>`
    : '';
  const challengeVerifyForm = (state === 'challenge_verify' && csrfToken && record)
    ? `
      <p class="msg">Enter the 6-digit verification code sent to you. The code expires in a few minutes.</p>
      <form method="POST" action="/v1/commerce/consent/${reqIdAttr}/challenge/verify" class="row">
        ${csrfField}
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="code-input" placeholder="123456">
        <button class="btn btn-primary" type="submit">Verify</button>
      </form>`
    : '';
  const challengeUnavailableBlock = state === 'challenge_unavailable'
    ? `<p class="msg">User verification is required before this decision can be recorded, but the verification provider is not configured in this environment. Please contact your platform operator.</p>`
    : '';
  const signInBlock = state === 'sign_in_required'
    ? `<p class="msg">You must sign in with the application that requested this authorization. The agent must include your principal session in the consent link (<code>?session=&lt;token&gt;</code>) for you to authorize.</p>`
    : '';
  const closedBlock = (state === 'expired' || state === 'already_decided' || state === 'not_found')
    ? `<p class="msg">${escapeHtml(title)}. You may close this window.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;max-width:460px;width:100%;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:28px}
  h1{font-size:20px;margin:0 0 12px}
  .meta{color:#444;font-size:14px;line-height:1.6;margin-bottom:18px}
  .meta .k{color:#888;display:inline-block;min-width:96px}
  ul.scopes{list-style:none;padding-left:0;margin:8px 0 18px}
  ul.scopes li{padding:6px 10px;background:#f8f8f8;border-radius:6px;font-size:13px;margin-bottom:6px}
  .row{margin:0}
  .btn{display:inline-block;width:100%;padding:12px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
  .btn-primary{background:#111;color:#fff}
  .btn-secondary{background:#f3f4f6;color:#374151}
  .msg{color:#555;line-height:1.6;margin-bottom:12px}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px}
  .code-input{width:100%;font-size:22px;letter-spacing:.4em;text-align:center;padding:12px;border:1px solid #d1d5db;border-radius:8px;font-family:'SF Mono','Fira Code',monospace}
</style>
</head><body>
<main class="card">
  <h1>${escapeHtml(title)}</h1>
  ${(state === 'present' || state === 'challenge_request' || state === 'challenge_verify') && record ? `
    <div class="meta">
      <div><span class="k">Merchant</span> <strong>${escapeHtml(record.merchantId)}</strong></div>
      <div><span class="k">Agent</span> <strong>${escapeHtml(record.agentId)}</strong></div>
      <div><span class="k">Type</span> ${escapeHtml(record.passportType)}</div>
      ${record.maxAmount != null ? `<div><span class="k">Max amount</span> ${escapeHtml(String(record.maxAmount))} (${escapeHtml(record.currency ?? '')}, minor units, tax-inclusive)</div>` : ''}
      <div><span class="k">Expires</span> ${escapeHtml(record.expiresAt)}</div>
      <div><span class="k">Confirmation</span> Final payment requires a separate user confirmation step.</div>
    </div>
    <div><strong>Scopes requested:</strong></div>
    <ul class="scopes">${scopesHtml}</ul>
    ${decisionForms}${challengeRequestForm}${challengeVerifyForm}` : signInBlock + closedBlock + challengeUnavailableBlock}
</main>
</body></html>`;
}

function renderDecisionPage(
  title: 'Approved' | 'Denied',
  message: string,
  nonce: string,
): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px}
  main{max-width:560px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#555;line-height:1.6}
</style>
</head><body><main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main></body></html>`;
}

export async function commerceConsentRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  // GET /v1/commerce/consent/page?req=<id>[&session=<token>]
  app.get<{ Querystring: { req?: string; session?: string } }>(
    '/consent/page',
    { config: { publicConsent: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        return reply.status(404).type('text/html').send('<!doctype html><title>Not Found</title>');
      }
      const nonce = randomBytes(16).toString('base64url');
      applySecurityHeaders(reply, nonce);

      // Finding 2: when ?session=<token> is supplied, verify, set the
      // session cookie, and 303 to the same URL with session stripped.
      // The token must NOT linger in browser history, server logs,
      // screenshots, or referrers. Render is deferred to the follow-up
      // request that the browser will make against the clean URL.
      //
      // The sensitive action (cookie set + redirect) is gated solely on
      // verifiedSession, which is bound only after server-side
      // cryptographic verification of the JWT succeeds. The user-controlled
      // presence/length test is only used to decide whether to attempt
      // verification, never as the security gate itself.
      const querySession = request.query.session;
      let verifiedSession: string | null = null;
      if (typeof querySession === 'string' && querySession.length > 0) {
        try {
          await verifyPrincipalSessionToken(querySession);
          verifiedSession = querySession;
        } catch {
          // Invalid session in the URL — do NOT set a cookie, do NOT
          // redirect. Fall through and render sign_in_required so the
          // user sees a useful error rather than a redirect loop.
        }
      }
      if (verifiedSession !== null) {
        setSessionCookie(reply, verifiedSession);
        // Build a clean URL that preserves the req param and any other
        // future query params except session. encodeURIComponent here
        // because reqId is reflected from user input.
        const reqIdParam = typeof request.query.req === 'string' && request.query.req
          ? `?req=${encodeURIComponent(request.query.req)}`
          : '';
        // 303 See Other forces the browser to GET the new location
        // without resending any body, and explicitly without keeping
        // the query string. Cache-Control: no-store + Pragma:
        // no-cache prevent intermediaries from caching the redirect
        // (the cookie set in this response is the side-effect we
        // need preserved). The browser drops the old URL from the
        // address bar and history navigation.
        return reply
          .status(303)
          .header('Location', `/v1/commerce/consent/page${reqIdParam}`)
          .header('Cache-Control', 'no-store')
          .header('Pragma', 'no-cache')
          .send('');
      }

      const reqId = request.query.req;
      if (typeof reqId !== 'string' || !reqId) {
        return reply.status(400).type('text/html')
          .send(renderConsentPage(null, null, nonce, 'not_found'));
      }

      const sql = getSql();
      const record = await presentConsentForUser(sql, reqId);
      if (!record) {
        return reply.status(404).type('text/html')
          .send(renderConsentPage(null, null, nonce, 'not_found'));
      }

      // Determine render state.
      if (record.status === 'expired') {
        return reply.status(410).type('text/html')
          .send(renderConsentPage(record, null, nonce, 'expired'));
      }
      if (record.status !== 'requested') {
        return reply.status(200).type('text/html')
          .send(renderConsentPage(record, null, nonce, 'already_decided'));
      }

      // Status === 'requested' — render only when there's a valid
      // session in the COOKIE (the query-param path was redirected).
      const principal = await resolvePrincipalSession(request);

      if (!principal) {
        return reply.status(200).type('text/html; charset=utf-8')
          .send(renderConsentPage(record, null, nonce, 'sign_in_required'));
      }

      // Tenant binding + tenant-active check (Finding 3).
      const tenantOk = await ensurePrincipalCanActOnTenant(principal.developerId, record.tenantId);
      if (!tenantOk.bound) {
        return reply.status(403).type('text/html')
          .send(renderConsentPage(record, null, nonce, 'sign_in_required'));
      }
      if (tenantOk.bound && tenantOk.tenantStatus === 'disabled') {
        // Tenant disabled — surface the explicit code via the JSON
        // route; for the SSR page we render a closed screen.
        return reply.status(403).type('text/html')
          .send(renderConsentPage(record, null, nonce, 'already_decided'));
      }

      // Hint pre-check.
      if (record.userPrincipalHint && record.userPrincipalHint !== principal.principalId) {
        return reply.status(200).type('text/html; charset=utf-8')
          .send(renderConsentPage(record, null, nonce, 'sign_in_required'));
      }

      // P0 fix: gate the approve/deny forms behind a verified
      // user-presence challenge. Only after a server-issued, single-use
      // challenge has been verified for THIS (consent_request_id,
      // principal_id) pair do we render the approve/deny forms. Without
      // that gate, a developer-minted principal session would still be
      // sufficient to self-approve.
      const csrfToken = deriveConsentCsrfToken(principal.rawToken, record.consentRequestId);
      const active = await findActiveChallenge(sql, {
        consentRequestId: record.consentRequestId,
        principalId: principal.principalId,
      });
      if (active?.status === 'verified') {
        return reply.status(200).type('text/html; charset=utf-8')
          .send(renderConsentPage(record, csrfToken, nonce, 'present'));
      }
      if (active?.status === 'requested') {
        return reply.status(200).type('text/html; charset=utf-8')
          .send(renderConsentPage(record, csrfToken, nonce, 'challenge_verify'));
      }
      // No active challenge: render `challenge_request` only if the
      // environment can actually deliver a challenge. Anywhere a real
      // delivery provider isn't wired (M2: everything except
      // NODE_ENV=test), surface the unavailable screen instead of a
      // button that would only 503 on POST.
      if (!isChallengeProviderAvailable()) {
        return reply.status(503).type('text/html; charset=utf-8')
          .send(renderConsentPage(record, null, nonce, 'challenge_unavailable'));
      }
      return reply.status(200).type('text/html; charset=utf-8')
        .send(renderConsentPage(record, csrfToken, nonce, 'challenge_request'));
    },
  );

  // GET /v1/commerce/consent/:reqId — JSON metadata (publicConsent)
  app.get<{ Params: { reqId: string } }>(
    '/consent/:reqId',
    { config: { publicConsent: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        throw new CommerceHttpError(404, 'not_found', 'Resource not found');
      }
      applySecurityHeaders(reply, randomBytes(8).toString('base64url'));
      const sql = getSql();
      const r = await findConsentByRequestId(sql, request.params.reqId);
      if (!r) {
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      const canonical = canonicalPresentedPayload(r);
      return reply.status(200).send({
        consent_request_id: r.consentRequestId,
        merchant_id: r.merchantId,
        agent_id: r.agentId,
        passport_type: r.passportType,
        requested_scopes: r.requestedScopes,
        max_amount: r.maxAmount,
        currency: r.currency,
        consent_text_version: r.consentTextVersion,
        expires_at: r.expiresAt,
        status: r.status,
        presented_payload_hash: r.presentedPayloadHash ?? sha256hex(canonical),
        // Hint surfaces so an SPA can confirm with the user before POST.
        // Not the verified identity — that comes only from the principal session.
        user_principal_hint: r.userPrincipalHint,
      });
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/commerce/consent/:reqId/challenge — request a one-time
  // verification code that the agent/developer cannot read or compute.
  // -----------------------------------------------------------------
  app.post<{ Params: { reqId: string }; Body: string | Record<string, string> }>(
    '/consent/:reqId/challenge',
    { config: { publicConsent: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        throw new CommerceHttpError(404, 'not_found', 'Resource not found');
      }
      const principal = await resolvePrincipalSession(request);
      if (!principal) {
        throw new CommerceHttpError(401, 'principal_session_required',
          'Requesting a verification code requires an authenticated principal session');
      }
      const form = parseFormBody(request.body);
      const formCsrf = form.get('csrf') ?? '';
      const expected = deriveConsentCsrfToken(principal.rawToken, request.params.reqId);
      const a = Buffer.from(formCsrf);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new CommerceHttpError(403, 'csrf_invalid', 'CSRF token mismatch');
      }

      const sql = getSql();
      const consent = await findConsentByRequestId(sql, request.params.reqId);
      if (!consent) {
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      const tenantOk = await ensurePrincipalCanActOnTenant(principal.developerId, consent.tenantId);
      if (!tenantOk.bound) {
        throw new CommerceHttpError(403, 'principal_not_authorized_for_tenant',
          'Authenticated principal is not bound to this commerce tenant');
      }
      if (tenantOk.tenantStatus === 'disabled') {
        throw new CommerceHttpError(403, 'tenant_disabled',
          'Commerce tenant is disabled', { retryable: false });
      }
      if (consent.userPrincipalHint && consent.userPrincipalHint !== principal.principalId) {
        throw new CommerceHttpError(403, 'principal_hint_mismatch',
          'Authenticated principal does not match the user this consent was created for');
      }

      const result = await createChallenge(sql, {
        tenantId: consent.tenantId,
        consentRecordId: consent.id,
        consentRequestId: consent.consentRequestId,
        principalId: principal.principalId,
        developerId: principal.developerId,
      });
      if (!result.ok) {
        if (result.reason === 'no_delivery_provider_configured') {
          throw new CommerceHttpError(503, 'challenge_provider_unavailable',
            'Consent challenge delivery provider is not configured in this environment',
            { retryable: false });
        }
        // active_challenge_exists — a parallel request created one; let
        // the user proceed with the existing challenge by reloading the
        // page (which will render challenge_verify state).
        throw new CommerceHttpError(409, 'challenge_already_active',
          'A verification code has already been sent for this consent and principal',
          { retryable: false });
      }

      await appendCommerceAudit(sql, {
        tenantId: consent.tenantId, merchantId: consent.merchantId, agentId: consent.agentId,
        userPrincipalId: principal.principalId,
        eventType: 'consent.challenge.requested',
        resourceType: 'commerce_consent_challenge', resourceId: result.challengeId,
        requestId: request.id,
        metadata: {
          delivery_channel: result.deliveryChannel,
          consent_request_id: consent.consentRequestId,
        },
      });

      // Raw code is included ONLY when NODE_ENV === 'test' AND the
      // selected delivery channel is `test_sink`. Both gates required;
      // the lib also re-checks before populating `result.testOnlyCode`
      // so any single regression cannot leak the secret. Staging,
      // preview, QA, development, and production never reach this
      // branch (channel is null upstream → 503 challenge_provider_unavailable).
      const body: Record<string, unknown> = {
        data: {
          challenge_id: result.challengeId,
          delivery_channel: result.deliveryChannel,
          expires_at: result.expiresAt,
        },
      };
      if (result.testOnlyCode !== undefined) {
        (body['data'] as Record<string, unknown>)['test_only_code'] = result.testOnlyCode;
      }
      return reply.status(201).send(body);
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/commerce/consent/:reqId/challenge/verify — submit the code
  // -----------------------------------------------------------------
  app.post<{ Params: { reqId: string }; Body: string | Record<string, string> }>(
    '/consent/:reqId/challenge/verify',
    { config: { publicConsent: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        throw new CommerceHttpError(404, 'not_found', 'Resource not found');
      }
      const principal = await resolvePrincipalSession(request);
      if (!principal) {
        throw new CommerceHttpError(401, 'principal_session_required',
          'Verifying a challenge requires an authenticated principal session');
      }
      const form = parseFormBody(request.body);
      const formCsrf = form.get('csrf') ?? '';
      const expected = deriveConsentCsrfToken(principal.rawToken, request.params.reqId);
      const a = Buffer.from(formCsrf);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new CommerceHttpError(403, 'csrf_invalid', 'CSRF token mismatch');
      }
      const code = (form.get('code') ?? '').trim();
      if (!/^\d{4,10}$/.test(code)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Code must be a 4-10 digit numeric string',
          { details: { fields: { code: 'numeric, 4-10 digits' } }, retryable: false });
      }

      const sql = getSql();
      const consent = await findConsentByRequestId(sql, request.params.reqId);
      if (!consent) {
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      const tenantOk = await ensurePrincipalCanActOnTenant(principal.developerId, consent.tenantId);
      if (!tenantOk.bound) {
        throw new CommerceHttpError(403, 'principal_not_authorized_for_tenant',
          'Authenticated principal is not bound to this commerce tenant');
      }
      if (tenantOk.tenantStatus === 'disabled') {
        throw new CommerceHttpError(403, 'tenant_disabled',
          'Commerce tenant is disabled', { retryable: false });
      }
      if (consent.userPrincipalHint && consent.userPrincipalHint !== principal.principalId) {
        throw new CommerceHttpError(403, 'principal_hint_mismatch',
          'Authenticated principal does not match the user this consent was created for');
      }

      const r = await verifyChallenge(sql, {
        consentRequestId: consent.consentRequestId,
        principalId: principal.principalId,
        code,
      });
      if (!r.ok) {
        const failureKindMap: Record<string, { status: number; code: string }> = {
          not_found:    { status: 404, code: 'challenge_not_found' },
          expired:      { status: 410, code: 'challenge_expired' },
          invalid_code: { status: 403, code: 'challenge_invalid' },
        };
        const mapped = failureKindMap[r.reason];
        await appendCommerceAudit(sql, {
          tenantId: consent.tenantId, merchantId: consent.merchantId, agentId: consent.agentId,
          userPrincipalId: principal.principalId,
          eventType: r.reason === 'expired' ? 'consent.challenge.expired' : 'consent.challenge.failed',
          resourceType: 'commerce_consent_challenge',
          resourceId: '(verification rejected)',
          requestId: request.id,
          metadata: {
            reason: r.reason,
            consent_request_id: consent.consentRequestId,
            ...(r.remainingAttempts !== undefined ? { remaining_attempts: r.remainingAttempts } : {}),
          },
        }).catch(() => undefined);
        throw new CommerceHttpError(mapped!.status, mapped!.code,
          'Challenge verification failed',
          {
            retryable: r.reason === 'invalid_code',
            ...(r.remainingAttempts !== undefined
              ? { details: { remaining_attempts: r.remainingAttempts } } : {}),
          });
      }
      await appendCommerceAudit(sql, {
        tenantId: consent.tenantId, merchantId: consent.merchantId, agentId: consent.agentId,
        userPrincipalId: principal.principalId,
        eventType: 'consent.challenge.verified',
        resourceType: 'commerce_consent_challenge', resourceId: r.challengeId,
        requestId: request.id,
        metadata: { consent_request_id: consent.consentRequestId },
      });
      return reply.status(200).send({
        data: { challenge_id: r.challengeId, status: 'verified' },
      });
    },
  );

  // POST /v1/commerce/consent/:reqId/approve
  app.post<{ Params: { reqId: string }; Body: string | Record<string, string> }>(
    '/consent/:reqId/approve',
    { config: { publicConsent: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        throw new CommerceHttpError(404, 'not_found', 'Resource not found');
      }
      // 1. Authenticated principal session is REQUIRED.
      const principal = await resolvePrincipalSession(request);
      if (!principal) {
        throw new CommerceHttpError(401, 'principal_session_required',
          'Approving consent requires an authenticated principal session');
      }
      // 2. CSRF token bound to (session_token, consent_request_id).
      const form = parseFormBody(request.body);
      const formCsrf = form.get('csrf') ?? '';
      const expected = deriveConsentCsrfToken(principal.rawToken, request.params.reqId);
      const a = Buffer.from(formCsrf);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new CommerceHttpError(403, 'csrf_invalid',
          'CSRF token missing or does not match the session');
      }

      const sql = getSql();
      // 3. Tenant binding — principal's developer must own the consent's tenant.
      const existing = await findConsentByRequestId(sql, request.params.reqId);
      if (!existing) {
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      const tenantOk = await ensurePrincipalCanActOnTenant(principal.developerId, existing.tenantId);
      if (!tenantOk.bound) {
        throw new CommerceHttpError(403, 'principal_not_authorized_for_tenant',
          'Authenticated principal\'s developer is not bound to this commerce tenant');
      }
      // Finding 3 (P1): tenant must be active even if developer is bound.
      if (tenantOk.tenantStatus === 'disabled') {
        throw new CommerceHttpError(403, 'tenant_disabled',
          'Commerce tenant is disabled', { retryable: false });
      }

      // 4. Decide. user_principal_id is set from the verified session,
      //    NEVER from the agent. The lib also enforces hint match
      //    (defense in depth) — when present, hint must == principalId.
      const r = await approveConsent(sql, request.params.reqId, principal.principalId);
      if (!r.ok) {
        if (r.reason === 'expired') throw new CommerceHttpError(410, 'consent_expired', 'Consent request has expired');
        if (r.reason === 'already_decided') throw new CommerceHttpError(409, 'consent_already_decided', 'Consent request was already approved or denied');
        if (r.reason === 'principal_hint_mismatch') {
          throw new CommerceHttpError(403, 'principal_hint_mismatch',
            'Authenticated principal does not match the user this consent was created for');
        }
        if (r.reason === 'challenge_required') {
          throw new CommerceHttpError(403, 'challenge_required',
            'A verified consent challenge is required before this decision can be recorded',
            { retryable: false });
        }
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      await appendCommerceAudit(sql, {
        tenantId: r.record.tenantId,
        merchantId: r.record.merchantId,
        agentId: r.record.agentId,
        userPrincipalId: r.record.userPrincipalId,
        eventType: 'consent.granted',
        resourceType: 'commerce_consent_record',
        resourceId: r.record.id,
        requestId: request.id,
        metadata: {
          passport_type: r.record.passportType,
          principal_developer_id: principal.developerId,
          consumed_challenge_id: r.consumedChallengeId,
        },
      });
      // Mark the challenge as used in the audit trail explicitly (the
      // DB transition to 'used' already happened atomically inside
      // approveConsent; this is the forensic record).
      await appendCommerceAudit(sql, {
        tenantId: r.record.tenantId, merchantId: r.record.merchantId, agentId: r.record.agentId,
        userPrincipalId: r.record.userPrincipalId,
        eventType: 'consent.challenge.used',
        resourceType: 'commerce_consent_challenge', resourceId: r.consumedChallengeId,
        requestId: request.id,
        metadata: { decision: 'granted', consent_request_id: r.record.consentRequestId },
      }).catch(() => undefined);
      const nonce = randomBytes(8).toString('base64url');
      applySecurityHeaders(reply, nonce);
      return reply.status(200).type('text/html; charset=utf-8').send(
        renderDecisionPage('Approved', 'You may now return to your agent. You can close this tab.', nonce),
      );
    },
  );

  // POST /v1/commerce/consent/:reqId/deny
  app.post<{ Params: { reqId: string }; Body: string | Record<string, string> }>(
    '/consent/:reqId/deny',
    { config: { publicConsent: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAcceptableConsentHost(request.headers['host'])) {
        throw new CommerceHttpError(404, 'not_found', 'Resource not found');
      }
      const principal = await resolvePrincipalSession(request);
      if (!principal) {
        throw new CommerceHttpError(401, 'principal_session_required',
          'Denying consent requires an authenticated principal session');
      }
      const form = parseFormBody(request.body);
      const formCsrf = form.get('csrf') ?? '';
      const expected = deriveConsentCsrfToken(principal.rawToken, request.params.reqId);
      const a = Buffer.from(formCsrf);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new CommerceHttpError(403, 'csrf_invalid', 'CSRF token mismatch');
      }
      const sql = getSql();
      const existing = await findConsentByRequestId(sql, request.params.reqId);
      if (!existing) {
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      const tenantOk = await ensurePrincipalCanActOnTenant(principal.developerId, existing.tenantId);
      if (!tenantOk.bound) {
        throw new CommerceHttpError(403, 'principal_not_authorized_for_tenant',
          'Authenticated principal\'s developer is not bound to this commerce tenant');
      }
      if (tenantOk.tenantStatus === 'disabled') {
        throw new CommerceHttpError(403, 'tenant_disabled',
          'Commerce tenant is disabled', { retryable: false });
      }
      const r = await denyConsent(sql, request.params.reqId, principal.principalId);
      if (!r.ok) {
        if (r.reason === 'expired') throw new CommerceHttpError(410, 'consent_expired', 'Consent request has expired');
        if (r.reason === 'already_decided') throw new CommerceHttpError(409, 'consent_already_decided', 'Consent request was already approved or denied');
        if (r.reason === 'principal_hint_mismatch') {
          // P2 fix: deny now enforces hint match too.
          throw new CommerceHttpError(403, 'principal_hint_mismatch',
            'Authenticated principal does not match the user this consent was created for');
        }
        if (r.reason === 'challenge_required') {
          throw new CommerceHttpError(403, 'challenge_required',
            'A verified consent challenge is required before this decision can be recorded',
            { retryable: false });
        }
        throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
      }
      await appendCommerceAudit(sql, {
        tenantId: r.record.tenantId,
        merchantId: r.record.merchantId,
        agentId: r.record.agentId,
        userPrincipalId: principal.principalId,
        eventType: 'consent.denied',
        resourceType: 'commerce_consent_record',
        resourceId: r.record.id,
        requestId: request.id,
        metadata: {
          passport_type: r.record.passportType,
          principal_developer_id: principal.developerId,
          consumed_challenge_id: r.consumedChallengeId,
        },
      });
      await appendCommerceAudit(sql, {
        tenantId: r.record.tenantId, merchantId: r.record.merchantId, agentId: r.record.agentId,
        userPrincipalId: principal.principalId,
        eventType: 'consent.challenge.used',
        resourceType: 'commerce_consent_challenge', resourceId: r.consumedChallengeId,
        requestId: request.id,
        metadata: { decision: 'denied', consent_request_id: r.record.consentRequestId },
      }).catch(() => undefined);
      const nonce = randomBytes(8).toString('base64url');
      applySecurityHeaders(reply, nonce);
      return reply.status(200).type('text/html; charset=utf-8').send(
        renderDecisionPage('Denied', 'The agent has been notified. You may close this tab.', nonce),
      );
    },
  );
}
