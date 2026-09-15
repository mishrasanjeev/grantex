/**
 * The approval page for decision grants (PRD G-3): the only place a decision
 * can be approved.
 *
 * - An approver opens `/decisions/{id}` (for example from a link in the
 *   platform's console). Without a session the page offers the developer's
 *   allow-listed identity providers.
 * - Sign-in is an OpenID Connect authorization code flow with PKCE, state and
 *   nonce, run by this service in the approver's browser
 *   (`/decisions/login`, `/decisions/callback`). Step-up is required. The
 *   session secret is set only as a `__Host-` HttpOnly Secure SameSite=Lax
 *   cookie on this origin; no API returns it.
 * - The page shows the memo and policy score the platform supplied (stored
 *   with their hashes), and the exact action and its hash, all HTML-escaped,
 *   with no script (CSP) and no framing.
 * - Approval is a form post that must carry the session cookie, a CSRF token
 *   bound to the session, the request and this rendering, and an `Origin` of
 *   this service (`Sec-Fetch-Site`, when sent, must be `same-origin`). Dwell
 *   time is measured by the service from rendering to submission.
 *
 * The decision grant the service signs is the attestation: it binds the
 * approver, their authentication, the action hash, the memo and policy score
 * hashes and the measured dwell time. A per-decision signature by a key held
 * in the browser was considered and not used: such a key is usable by any
 * script running on this origin, exactly as the HttpOnly session is, so it
 * would add a round trip and script to the page without separating anyone
 * the session does not already separate.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { decisionDwellSeconds, decisionGrantsMintedTotal, decisionGrantsRejectedTotal } from '../lib/metrics.js';
import { completeAuthorization, startAuthorization } from '../lib/decisions/approver-oidc.js';
import { decryptApproverName } from '../lib/decisions/personal-data.js';
import { DecisionError, DecisionSubReason, approverClaimsFromIdToken } from '../lib/decisions/policy.js';
import { DecisionSettingsError, decisionGrantsEnabled, decisionSettings, type DecisionSettings } from '../lib/decisions/settings.js';
import {
  approveDecisionRequest,
  consumeLoginState,
  createApproverSession,
  createLoginState,
  createPageView,
  getDecisionRequest,
  listApproverIdps,
  requestDeveloper,
  revokeApproverSession,
  sessionBySecret,
  toApproverIdp,
  type ApproverSessionRow,
  type DecisionRequestRow,
} from '../lib/decisions/store.js';
import { canonicalize } from '../lib/decisions/canonical.js';

export const DECISION_SESSION_COOKIE = '__Host-grantex_decision_session';
export const DECISION_LOGIN_COOKIE = '__Host-grantex_decision_login';

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const REQUEST_ID_RE = /^dreq_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDP_ID_RE = /^dapi_[0-9A-HJKMNP-TV-Z]{26}$/;
const VIEW_ID_RE = /^dview_[0-9A-HJKMNP-TV-Z]{26}$/;

let ephemeralPageSecret: Buffer | null = null;

/** HMAC key for CSRF tokens: DECISION_PAGE_SECRET, else derived from the vault key, else per process. */
function pageSecret(): Buffer {
  const configured = process.env['DECISION_PAGE_SECRET'] ?? config.vaultEncryptionKey;
  if (configured) return createHash('sha256').update(`grantex:decision-page:${configured}`).digest();
  ephemeralPageSecret ??= randomBytes(32);
  return ephemeralPageSecret;
}

export function csrfToken(sessionId: string, requestId: string, viewId: string): string {
  return createHmac('sha256', pageSecret()).update(`${sessionId}\n${requestId}\n${viewId}`).digest('base64url');
}

function constantTimeEquals(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f4f4f5; color: #18181b; }
  main { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 16px; }
  h2 { font-size: 1rem; margin: 20px 0 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 16px; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f4f5; padding: 12px; border-radius: 6px; font-size: 0.875rem; max-height: 480px; overflow: auto; }
  code { font-size: 0.85rem; overflow-wrap: anywhere; }
  .note { color: #3f3f46; font-size: 0.9rem; }
  .error { color: #991b1b; }
  button, .button { font: inherit; padding: 10px 16px; border-radius: 6px; border: 0; background: #18181b; color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
  button:focus-visible, .button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
  .secondary { background: #e4e4e7; color: #18181b; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  return reply
    .status(status)
    .header('Content-Security-Policy', PAGE_CSP)
    .header('X-Frame-Options', 'DENY')
    .header('Referrer-Policy', 'no-referrer')
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(layout(title, body));
}

function messagePage(reply: FastifyReply, status: number, title: string, message: string): FastifyReply {
  return sendPage(reply, status, title, `<h1>${escapeHtml(title)}</h1><p class="${status >= 400 ? 'error' : 'note'}">${escapeHtml(message)}</p>`);
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

function settingsOrPage(reply: FastifyReply): DecisionSettings | null {
  if (!decisionGrantsEnabled()) {
    messagePage(reply, 404, 'Not available', 'Decision grants are not enabled on this service.');
    return null;
  }
  try {
    return decisionSettings();
  } catch (err) {
    if (err instanceof DecisionSettingsError) {
      messagePage(reply, 503, 'Unavailable', 'Decision grants are misconfigured on this service.');
      return null;
    }
    throw err;
  }
}

/**
 * A form post from this service's own page. Both headers are required: Origin
 * equal to the service origin and Sec-Fetch-Site `same-origin`. A request
 * without either is refused (every current browser sends both on a form post;
 * a client that omits them is not the approval page).
 */
function sameOriginSubmission(request: FastifyRequest, publicOrigin: string): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin !== publicOrigin) return false;
  return request.headers['sec-fetch-site'] === 'same-origin';
}

function reviewSection(request: DecisionRequestRow): string {
  const a = request.action;
  const rows: [string, string, boolean][] = [
    ['Case', a.case_id, false],
    ['Action', `${request.connector}.${a.action}`, false],
    ['Decision', a.decision, false],
    ['Subject', a.subject, false],
  ];
  if (a.amount !== undefined) rows.push(['Amount', String(a.amount), false]);
  for (const [name, value] of Object.entries(a.extra ?? {})) rows.push([name, String(value), false]);
  rows.push(['Action hash', request.action_hash, true]);
  const actionList = `<dl>${rows.map(([k, v, code]) => `<dt>${escapeHtml(k)}</dt><dd>${code ? `<code>${escapeHtml(v)}</code>` : escapeHtml(v)}</dd>`).join('')}</dl>`;
  const policy = JSON.stringify(JSON.parse(canonicalize(request.policy_score)), null, 2);
  return `<h2>Exact action</h2>${actionList}`
    + `<h2>Memo</h2><p class="note">${escapeHtml(request.memo_ref ?? '')} <code>${escapeHtml(request.memo_hash)}</code></p><pre>${escapeHtml(request.memo_content)}</pre>`
    + `<h2>Policy score</h2><p class="note">${escapeHtml(request.policy_score_ref ?? '')} <code>${escapeHtml(request.policy_score_hash)}</code></p><pre>${escapeHtml(policy)}</pre>`;
}

async function sessionFromCookie(request: FastifyRequest): Promise<ApproverSessionRow | null> {
  return sessionBySecret(getSql(), readCookie(request, DECISION_SESSION_COOKIE));
}

function redirectUri(): string {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/decisions/callback`;
}

export async function decisionPageRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8_192 }, (_request, body, done) => {
    try {
      const parsed: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          done(new Error('Repeated form field'));
          return;
        }
        parsed[key] = value;
      }
      done(null, parsed);
    } catch (error) {
      done(error instanceof Error ? error : new Error('Invalid form body'));
    }
  });

  // Sign-in: start the authorization code flow in this browser.
  app.get<{ Querystring: { request?: string; idp?: string } }>(
    '/decisions/login',
    { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = settingsOrPage(reply);
      if (!settings) return reply;
      const { request: requestId, idp: idpId } = request.query;
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId) || typeof idpId !== 'string' || !IDP_ID_RE.test(idpId)) {
        return messagePage(reply, 400, 'Invalid link', 'This sign-in link is invalid.');
      }
      const sql = getSql();
      const developerId = await requestDeveloper(sql, requestId);
      if (!developerId) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      const idpRow = (await listApproverIdps(sql, developerId)).find((i) => i.id === idpId && i.status === 'active');
      if (!idpRow) return messagePage(reply, 404, 'Not available', 'This identity provider cannot be used to approve this decision.');
      let start;
      try {
        start = await startAuthorization(toApproverIdp(idpRow), redirectUri(), settings.stepUp.maxAgeSeconds);
      } catch (err) {
        if (err instanceof DecisionError) return messagePage(reply, 502, 'Sign-in unavailable', err.message);
        throw err;
      }
      const binding = randomBytes(32).toString('base64url');
      await createLoginState(sql, {
        developerId,
        idpId: idpRow.id,
        requestId,
        state: start.state,
        nonce: start.nonce,
        codeVerifier: start.codeVerifier,
        browserBinding: binding,
        ttlSeconds: settings.loginStateSeconds,
      });
      return reply
        .status(302)
        .header('Set-Cookie', cookie(DECISION_LOGIN_COOKIE, binding, settings.loginStateSeconds))
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store')
        .header('Location', start.url)
        .send();
    },
  );

  // Sign-in: the identity provider returns here.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/decisions/callback',
    { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = settingsOrPage(reply);
      if (!settings) return reply;
      const sql = getSql();
      const clearLogin = cookie(DECISION_LOGIN_COOKIE, '', 0);
      const { code, state, error } = request.query;
      const login = await consumeLoginState(sql, state ?? '', readCookie(request, DECISION_LOGIN_COOKIE));
      if (!login) {
        decisionGrantsRejectedTotal.labels('sign_in', 'invalid_state').inc();
        reply.header('Set-Cookie', clearLogin);
        return messagePage(reply, 400, 'Sign-in failed', 'This sign-in has expired, was already used, or was started in another browser. Open the decision again.');
      }
      if (typeof error === 'string' || typeof code !== 'string' || code.length === 0 || code.length > 4_096) {
        decisionGrantsRejectedTotal.labels('sign_in', 'idp_error').inc();
        reply.header('Set-Cookie', clearLogin);
        return messagePage(reply, 401, 'Sign-in failed', 'The identity provider did not complete the sign-in.');
      }
      const idpRow = (await listApproverIdps(sql, login.developerId)).find((i) => i.id === login.idpId && i.status === 'active');
      if (!idpRow) {
        reply.header('Set-Cookie', clearLogin);
        return messagePage(reply, 403, 'Sign-in failed', 'This identity provider can no longer be used to approve decisions.');
      }
      try {
        const payload = await completeAuthorization(toApproverIdp(idpRow), {
          code,
          redirectUri: redirectUri(),
          codeVerifier: login.codeVerifier,
          nonce: login.nonce,
        });
        const nowSeconds = Math.floor(Date.now() / 1000);
        const claims = approverClaimsFromIdToken(payload as Record<string, unknown>, nowSeconds, settings.stepUp);
        const { session, secret } = await createApproverSession(sql, {
          developerId: login.developerId,
          idp: idpRow,
          claims,
          nonce: login.nonce,
          stepUp: settings.stepUp,
          nowSeconds,
        });
        const maxAge = (session.expires_at.getTime() - Date.now()) / 1000;
        return reply
          .status(303)
          .header('Set-Cookie', [clearLogin, cookie(DECISION_SESSION_COOKIE, secret, maxAge)])
          .header('Referrer-Policy', 'no-referrer')
          .header('Cache-Control', 'no-store')
          .header('Location', `/decisions/${encodeURIComponent(login.requestId)}`)
          .send();
      } catch (err) {
        if (!(err instanceof DecisionError)) throw err;
        decisionGrantsRejectedTotal.labels('sign_in', err.subReason).inc();
        reply.header('Set-Cookie', clearLogin);
        return messagePage(reply, err.status, err.subReason === DecisionSubReason.STEP_UP_REQUIRED ? 'Stronger sign-in required' : 'Sign-in failed', err.message);
      }
    },
  );

  // End the approver session in this browser.
  app.post<{ Body: Record<string, string> }>(
    '/decisions/logout',
    { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = settingsOrPage(reply);
      if (!settings) return reply;
      if (!sameOriginSubmission(request, settings.publicOrigin)) return messagePage(reply, 403, 'Refused', 'This request did not come from the approval page.');
      const session = await sessionFromCookie(request);
      if (session) await revokeApproverSession(getSql(), session.id);
      reply.header('Set-Cookie', cookie(DECISION_SESSION_COOKIE, '', 0));
      return messagePage(reply, 200, 'Signed out', 'You are signed out of approvals in this browser.');
    },
  );

  app.get<{ Params: { id: string } }>(
    '/decisions/:id',
    { config: { skipAuth: true, rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = settingsOrPage(reply);
      if (!settings) return reply;
      const requestId = request.params.id;
      if (!REQUEST_ID_RE.test(requestId)) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      const sql = getSql();
      const developerId = await requestDeveloper(sql, requestId);
      if (!developerId) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');

      const session = await sessionFromCookie(request);
      if (!session || session.developer_id !== developerId) {
        const idps = (await listApproverIdps(sql, developerId)).filter((i) => i.status === 'active');
        if (idps.length === 0) {
          return messagePage(reply, 403, 'Approvals not configured', 'No identity provider is configured for approvers. Contact your administrator.');
        }
        const links = idps
          .map((i) => `<p><a class="button" href="/decisions/login?request=${encodeURIComponent(requestId)}&amp;idp=${encodeURIComponent(i.id)}">Sign in with ${escapeHtml(i.display_name)}</a></p>`)
          .join('');
        return sendPage(reply, 401, 'Sign in to review', `<h1>Sign in to review this decision</h1><p class="note">Approving requires a strong sign-in with your organisation's identity provider.</p>${links}`);
      }

      const found = await getDecisionRequest(sql, developerId, requestId);
      if (!found) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      const { request: decision, grants } = found;
      const heading = '<h1>Review and approve this decision</h1>';
      const review = reviewSection(decision);
      if (decision.status !== 'pending' || decision.expires_at.getTime() <= Date.now()) {
        const state = decision.expires_at.getTime() <= Date.now() && decision.status === 'pending' ? 'expired' : decision.status;
        return sendPage(reply, 409, 'Decision closed', `${heading}<p class="note">This decision is ${escapeHtml(state)} and cannot be approved.</p>${review}`);
      }
      if (grants.some((g) => g.approver_sub === session.subject || (session.email_hash !== null && g.approver_email_hash === session.email_hash))) {
        return sendPage(reply, 409, 'Already approved', `${heading}<p class="note">You have already approved this decision. It needs a different second approver.</p>${review}`);
      }
      const fourEyes = decision.approvals_required === 2
        ? `<p class="note">Four eyes: this decision needs two different approvers. Approvals so far: ${grants.length} of 2.</p>`
        : '';
      const viewId = await createPageView(sql, decision.id, session.id);
      const csrf = csrfToken(session.id, decision.id, viewId);
      const who = decryptApproverName(session.name_encrypted) ?? session.subject;
      const form = `<form method="post" action="/decisions/${escapeHtml(encodeURIComponent(decision.id))}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<input type="hidden" name="view_id" value="${escapeHtml(viewId)}">
<input type="hidden" name="action_hash" value="${escapeHtml(decision.action_hash)}">
<p class="note">Signed in as ${escapeHtml(who)} (${escapeHtml(session.approver_auth)}). By approving you attest that you reviewed the memo, the policy score and the exact action on this page.</p>
<button type="submit">Approve: ${escapeHtml(decision.action.decision)}</button>
</form>
<form method="post" action="/decisions/logout"><p><button class="secondary" type="submit">Sign out</button></p></form>`;
      return sendPage(reply, 200, 'Approve decision', `${heading}${fourEyes}${review}${form}`);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, string> }>(
    '/decisions/:id',
    { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = settingsOrPage(reply);
      if (!settings) return reply;
      const requestId = request.params.id;
      if (!REQUEST_ID_RE.test(requestId)) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      if (!sameOriginSubmission(request, settings.publicOrigin)) {
        decisionGrantsRejectedTotal.labels('approve', 'cross_site').inc();
        return messagePage(reply, 403, 'Refused', 'This approval was not submitted from the approval page.');
      }
      const session = await sessionFromCookie(request);
      if (!session) return messagePage(reply, 401, 'Sign in required', 'Your approver session has ended. Open the decision again to sign in.');
      const body = (request.body ?? {}) as Record<string, unknown>;
      const viewId = body['view_id'];
      if (typeof viewId !== 'string' || !VIEW_ID_RE.test(viewId)
          || !constantTimeEquals(csrfToken(session.id, requestId, viewId), body['csrf_token'])) {
        decisionGrantsRejectedTotal.labels('approve', 'csrf').inc();
        return messagePage(reply, 403, 'Refused', 'The approval form is invalid. Reload the decision and try again.');
      }
      try {
        const result = await approveDecisionRequest(getSql(), {
          session,
          requestId,
          actionHash: body['action_hash'],
          viewId,
          stepUp: settings.stepUp,
          dwellPolicy: settings.dwell,
        });
        decisionGrantsMintedTotal.labels(String(result.request.approvals_required), String(result.approvalsReceived), 'server').inc();
        decisionDwellSeconds.labels('server').observe(result.claims.dwell_ms / 1000);
        const remaining = result.request.approvals_required - result.approvalsReceived;
        return messagePage(
          reply,
          200,
          'Approved',
          remaining > 0
            ? 'Your approval is recorded. This decision needs one more approval from a different person.'
            : 'Your approval is recorded. You can close this page.',
        );
      } catch (err) {
        if (!(err instanceof DecisionError)) throw err;
        decisionGrantsRejectedTotal.labels('approve', err.subReason).inc();
        const message = err.subReason === DecisionSubReason.SAME_APPROVER
          ? 'You have already approved this decision. It needs a different second approver.'
          : err.message;
        return messagePage(reply, err.status, 'Not approved', message);
      }
    },
  );
}
