/**
 * Minimal server-rendered approval page for decision grants (PRD G-3). The
 * approvals console of the platform is the main surface; this page exists so
 * a decision can be approved without one.
 *
 * - Opened with a one-time ticket (POST /v1/decisions/requests/:id/page-tickets),
 *   which sets an HttpOnly SameSite=Strict cookie holding the approver session
 *   and redirects to a URL without the ticket.
 * - Shows the memo reference, the policy score reference and the exact
 *   semantic action and its hash, all HTML-escaped. No script runs (CSP).
 * - Dwell time is measured by the server from rendering to submission.
 * - The form carries a CSRF token bound to the session, the request and the
 *   rendering; cross-site submissions are refused.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { getKeyPair } from '../lib/crypto.js';
import { decisionDwellSeconds, decisionGrantsMintedTotal, decisionGrantsRejectedTotal } from '../lib/metrics.js';
import { DecisionError, DecisionSubReason, approverSubject } from '../lib/decisions/policy.js';
import { DecisionSettingsError, decisionGrantsEnabled, decisionSettings } from '../lib/decisions/settings.js';
import {
  approveDecisionRequest,
  createPageView,
  getApproverSession,
  getDecisionRequest,
  redeemPageTicket,
  type ApproverSessionRow,
  type DecisionRequestRow,
} from '../lib/decisions/store.js';
import { DecisionTokenError, signApproverSession, verifyApproverSession } from '../lib/decisions/token.js';

export const DECISION_SESSION_COOKIE = 'grantex_decision_session';

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const REQUEST_ID_RE = /^dreq_[0-9A-HJKMNP-TV-Z]{26}$/;

let ephemeralPageSecret: Buffer | null = null;

/** HMAC key for CSRF tokens: DECISION_PAGE_SECRET, else derived from the RSA key, else per process. */
function pageSecret(): Buffer {
  const configured = process.env['DECISION_PAGE_SECRET'];
  if (configured) return createHash('sha256').update(`grantex:decision-page:${configured}`).digest();
  if (config.rsaPrivateKey) return createHash('sha256').update(`grantex:decision-page:${config.rsaPrivateKey}`).digest();
  getKeyPair();
  ephemeralPageSecret ??= randomBytes(32);
  return ephemeralPageSecret;
}

export function csrfToken(sessionId: string, requestId: string, viewId: string): string {
  return createHmac('sha256', pageSecret()).update(`${sessionId}\n${requestId}\n${viewId}`).digest('base64url');
}

function csrfMatches(expected: string, actual: unknown): boolean {
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
  main { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 16px; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-size: 0.85rem; }
  .note { color: #3f3f46; font-size: 0.9rem; }
  .error { color: #991b1b; }
  button { font: inherit; padding: 10px 16px; border-radius: 6px; border: 0; background: #18181b; color: #fff; cursor: pointer; }
  button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  return reply
    .status(status)
    .header('Content-Security-Policy', PAGE_CSP)
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

async function sessionFromCookie(request: FastifyRequest): Promise<{ session: ApproverSessionRow; token: string } | null> {
  const token = readCookie(request, DECISION_SESSION_COOKIE);
  if (!token) return null;
  try {
    const verified = await verifyApproverSession(token);
    const session = await getApproverSession(getSql(), verified.developerId, verified.sessionId);
    return { session, token };
  } catch (err) {
    if (err instanceof DecisionTokenError || err instanceof DecisionError) return null;
    throw err;
  }
}

function sameOriginSubmission(request: FastifyRequest): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      return new URL(origin).origin === new URL(config.publicBaseUrl).origin;
    } catch {
      return false;
    }
  }
  return origin !== 'null';
}

function actionRows(request: DecisionRequestRow): string {
  const a = request.action;
  const rows: [string, string][] = [
    ['Case', a.case_id],
    ['Action', `${request.connector}.${a.action}`],
    ['Decision', a.decision],
    ['Subject', a.subject],
  ];
  if (a.amount !== undefined) rows.push(['Amount', String(a.amount)]);
  rows.push(['Memo', request.memo_ref ?? 'not provided']);
  rows.push(['Policy score', request.policy_score_ref ?? 'not provided']);
  rows.push(['Action hash', request.action_hash]);
  return `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === 'Action hash' ? `<code>${escapeHtml(v)}</code>` : escapeHtml(v)}</dd>`).join('')}</dl>`;
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

  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>(
    '/decisions/:id',
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!decisionGrantsEnabled()) return messagePage(reply, 404, 'Not available', 'Decision grants are not enabled on this service.');
      const requestId = request.params.id;
      if (!REQUEST_ID_RE.test(requestId)) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      const sql = getSql();

      const ticket = request.query.ticket;
      if (typeof ticket === 'string') {
        const redeemed = await redeemPageTicket(sql, ticket);
        if (!redeemed || redeemed.requestId !== requestId) {
          return messagePage(reply, 403, 'Link expired', 'This approval link has expired or was already used. Open the decision again from your approvals console.');
        }
        let session: ApproverSessionRow;
        try {
          session = await getApproverSession(sql, redeemed.developerId, redeemed.sessionId);
        } catch {
          return messagePage(reply, 403, 'Sign in again', 'Your approver session has ended. Authenticate again from your approvals console.');
        }
        const expiresAt = Math.floor(session.expires_at.getTime() / 1000);
        const token = await signApproverSession(session.id, session.developer_id, expiresAt);
        const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
        const secure = config.publicBaseUrl.startsWith('https:') ? '; Secure' : '';
        return reply
          .status(303)
          .header('Set-Cookie', `${DECISION_SESSION_COOKIE}=${token}; Path=/decisions; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`)
          .header('Referrer-Policy', 'no-referrer')
          .header('Location', `/decisions/${encodeURIComponent(requestId)}`)
          .send();
      }

      const current = await sessionFromCookie(request);
      if (!current) {
        return messagePage(reply, 401, 'Sign in required', 'Open this decision from your approvals console to authenticate.');
      }
      const { session } = current;
      const found = await getDecisionRequest(sql, session.developer_id, requestId);
      if (!found) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      const { request: decision, grants } = found;
      const sub = approverSubject(session.subject);
      const heading = '<h1>Approve this decision</h1>';
      const details = actionRows(decision);
      if (decision.status !== 'pending' || decision.expires_at.getTime() <= Date.now()) {
        const state = decision.expires_at.getTime() <= Date.now() && decision.status === 'pending' ? 'expired' : decision.status;
        return sendPage(reply, 409, 'Decision closed', `${heading}${details}<p class="note">This decision is ${escapeHtml(state)} and cannot be approved.</p>`);
      }
      if (grants.some((g) => g.approver_sub === sub)) {
        return sendPage(reply, 409, 'Already approved', `${heading}${details}<p class="note">You have already approved this decision. It needs a different second approver.</p>`);
      }
      const fourEyes = decision.approvals_required === 2
        ? `<p class="note">Four eyes: this decision needs two approvers. Approvals so far: ${grants.length} of 2.</p>`
        : '';
      const viewId = await createPageView(sql, decision.id, session.id);
      const csrf = csrfToken(session.id, decision.id, viewId);
      const form = `<form method="post" action="/decisions/${escapeHtml(encodeURIComponent(decision.id))}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<input type="hidden" name="view_id" value="${escapeHtml(viewId)}">
<input type="hidden" name="action_hash" value="${escapeHtml(decision.action_hash)}">
<p class="note">Signed in as ${escapeHtml(session.name ?? session.email ?? sub)} (${escapeHtml(session.approver_auth)}). By approving you attest that you reviewed the memo, the policy score and the exact action above.</p>
<button type="submit">Approve ${escapeHtml(decision.action.decision)}</button>
</form>`;
      return sendPage(reply, 200, 'Approve decision', `${heading}${details}${fourEyes}${form}`);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, string> }>(
    '/decisions/:id',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!decisionGrantsEnabled()) return messagePage(reply, 404, 'Not available', 'Decision grants are not enabled on this service.');
      let settings;
      try {
        settings = decisionSettings();
      } catch (err) {
        if (err instanceof DecisionSettingsError) return messagePage(reply, 503, 'Unavailable', 'Decision grants are misconfigured on this service.');
        throw err;
      }
      const requestId = request.params.id;
      if (!REQUEST_ID_RE.test(requestId)) return messagePage(reply, 404, 'Decision not found', 'This decision does not exist.');
      if (!sameOriginSubmission(request)) {
        decisionGrantsRejectedTotal.labels('approve', 'cross_site').inc();
        return messagePage(reply, 403, 'Refused', 'This approval was not submitted from the approval page.');
      }
      const current = await sessionFromCookie(request);
      if (!current) return messagePage(reply, 401, 'Sign in required', 'Your approver session has ended. Authenticate again from your approvals console.');
      const body = (request.body ?? {}) as Record<string, unknown>;
      const viewId = body['view_id'];
      if (typeof viewId !== 'string' || !/^dview_[0-9A-HJKMNP-TV-Z]{26}$/.test(viewId)
          || !csrfMatches(csrfToken(current.session.id, requestId, viewId), body['csrf_token'])) {
        decisionGrantsRejectedTotal.labels('approve', 'csrf').inc();
        return messagePage(reply, 403, 'Refused', 'The approval form is invalid. Reload the decision and try again.');
      }
      try {
        const result = await approveDecisionRequest(getSql(), {
          developerId: current.session.developer_id,
          requestId,
          sessionId: current.session.id,
          actionHash: body['action_hash'],
          dwell: { kind: 'page_view', viewId },
          stepUp: settings.stepUp,
          dwellPolicy: settings.dwell,
        });
        decisionGrantsMintedTotal.labels(String(result.request.approvals_required), String(result.approvalsReceived)).inc();
        decisionDwellSeconds.observe(result.claims.dwell_ms / 1000);
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
