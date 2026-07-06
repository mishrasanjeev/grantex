import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { ulid } from 'ulid';
import { describeScope } from '../lib/scopes.js';

const CONSENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CONSENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorization Request</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 440px; width: 100%; padding: 32px; }
  .header { text-align: center; margin-bottom: 24px; }
  .header .icon { font-size: 32px; margin-bottom: 8px; }
  .header h1 { font-size: 20px; font-weight: 600; color: #111; }
  .agent-box { background: #f8f8f8; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .agent-name { font-size: 16px; font-weight: 600; color: #111; }
  .agent-desc { font-size: 14px; color: #666; margin-top: 4px; }
  .agent-did { font-size: 11px; color: #999; margin-top: 6px; word-break: break-all; font-family: monospace; }
  .scopes-label { font-size: 13px; font-weight: 600; color: #444; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
  .scope-list { list-style: none; margin-bottom: 20px; }
  .scope-list li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #333; }
  .scope-list li:last-child { border-bottom: none; }
  .scope-list li::before { content: "✓"; color: #22c55e; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .expiry { font-size: 13px; color: #888; margin-bottom: 24px; text-align: center; }
  .expiry.expired { color: #ef4444; }
  .actions { display: flex; gap: 12px; }
  .btn { flex: 1; padding: 12px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; border: none; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-deny { background: #f3f4f6; color: #374151; }
  .btn-approve { background: #111; color: #fff; }
  .status-screen { text-align: center; padding: 20px 0; }
  .status-screen .status-icon { font-size: 48px; margin-bottom: 16px; }
  .status-screen h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .status-screen p { font-size: 14px; color: #666; }
  .spinner { border: 3px solid #f0f0f0; border-top-color: #111; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.7s linear infinite; margin: 40px auto; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-msg { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px; color: #991b1b; font-size: 14px; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div id="content"><div class="spinner"></div></div>
</div>
<script>
(async () => {
  const params = new URLSearchParams(location.search);
  const reqId = params.get('req');
  const el = document.getElementById('content');

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showError(msg) {
    el.innerHTML = '<div class="error-msg">' + esc(msg) + '</div>';
  }

  function showStatus(title, msg) {
    el.innerHTML =
      '<div class="status-screen">' +
        '<div class="status-icon">&#128274;</div>' +
        '<h2>' + esc(title) + '</h2>' +
        '<p>' + esc(msg) + '</p>' +
      '</div>';
  }

  function formatExpiry(isoStr) {
    const diff = Math.floor((new Date(isoStr) - Date.now()) / 1000);
    if (diff <= 0) return { text: 'Expired', expired: true };
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (h > 0) return { text: 'Expires in ' + h + 'h ' + m + 'm', expired: false };
    return { text: 'Expires in ' + m + 'm', expired: false };
  }

  async function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async function responseMessage(res, fallback) {
    try {
      const body = await res.json();
      return body && body.message ? body.message : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function base64urlToBuffer(value) {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }

  function browserPublicKeyOptions(publicKey) {
    const options = Object.assign({}, publicKey);
    options.challenge = base64urlToBuffer(publicKey.challenge);
    if (Array.isArray(publicKey.allowCredentials)) {
      options.allowCredentials = publicKey.allowCredentials.map(function(credential) {
        return Object.assign({}, credential, { id: base64urlToBuffer(credential.id) });
      });
    }
    return options;
  }

  function assertionToJson(assertion) {
    const response = {
      clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
      authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
      signature: bufferToBase64url(assertion.response.signature),
    };
    if (assertion.response.userHandle) {
      response.userHandle = bufferToBase64url(assertion.response.userHandle);
    }
    return {
      id: assertion.id,
      rawId: bufferToBase64url(assertion.rawId),
      type: assertion.type,
      response: response,
      authenticatorAttachment: assertion.authenticatorAttachment || undefined,
    };
  }

  async function verifyPrincipalPresence() {
    if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.get) {
      throw new Error('This approval requires a passkey, but this browser does not support passkeys.');
    }

    showStatus('Passkey required', 'Follow your browser prompt to verify this approval.');

    const optionsRes = await postJson('/v1/webauthn/assert/options', { authRequestId: reqId });
    if (!optionsRes.ok) {
      throw new Error(await responseMessage(optionsRes, 'Could not start passkey verification.'));
    }
    const optionsBody = await optionsRes.json();
    const assertion = await navigator.credentials.get({
      publicKey: browserPublicKeyOptions(optionsBody.publicKey),
    });
    if (!assertion) {
      throw new Error('Passkey verification was cancelled.');
    }

    const verifyRes = await postJson('/v1/webauthn/assert/verify', {
      challengeId: optionsBody.challengeId,
      response: assertionToJson(assertion),
    });
    if (!verifyRes.ok) {
      throw new Error(await responseMessage(verifyRes, 'Passkey verification failed.'));
    }
  }

  async function approveRequest(allowVerificationRetry) {
    const res = await fetch('/v1/consent/' + encodeURIComponent(reqId) + '/approve', { method: 'POST' });
    if (res.status === 410) { showError('This request has expired or was already processed.'); return; }
    if (res.status === 404) { showError('Authorization request not found.'); return; }
    if (res.status === 403) {
      let body = {};
      try { body = await res.json(); } catch (e) {}
      if (allowVerificationRetry && (body.code === 'FIDO_REQUIRED' || body.code === 'PRINCIPAL_VERIFICATION_REQUIRED')) {
        await verifyPrincipalPresence();
        return approveRequest(false);
      }
      showError(body.message || 'Approval requires additional verification.');
      return;
    }
    if (!res.ok) { showError(await responseMessage(res, 'Failed to approve. Please try again.')); return; }

    const body = await res.json();
    if (body.redirectUri) {
      const url = new URL(body.redirectUri);
      url.searchParams.set('code', body.code);
      if (body.state) url.searchParams.set('state', body.state);
      location.href = url.toString();
    } else {
      el.innerHTML =
        '<div class="status-screen">' +
          '<div class="status-icon">&#10003;</div>' +
          '<h2>Approved</h2>' +
          '<p>You have granted access. You may close this window.</p>' +
        '</div>';
    }
  }

  if (!reqId) { showError('Missing request ID'); return; }

  let data;
  try {
    const res = await fetch('/v1/consent/' + encodeURIComponent(reqId));
    if (res.status === 404) { showError('Authorization request not found.'); return; }
    if (res.status === 410) { showError('This authorization request has expired or has already been processed.'); return; }
    if (!res.ok) { showError('Failed to load authorization request.'); return; }
    data = await res.json();
  } catch (e) {
    showError('Network error. Please try again.');
    return;
  }

  const expiry = formatExpiry(data.expiresAt);
  const scopeItems = (data.scopeDescriptions || []).map(function(d) {
    return '<li>' + esc(d) + '</li>';
  }).join('');

  el.innerHTML =
    '<div class="header"><div class="icon">&#128274;</div><h1>Authorization Request</h1></div>' +
    '<div class="agent-box">' +
      '<div class="agent-name">' + esc(data.agentName) + ' wants permission:</div>' +
      (data.agentDescription ? '<div class="agent-desc">' + esc(data.agentDescription) + '</div>' : '') +
      '<div class="agent-did">' + esc(data.agentDid) + '</div>' +
    '</div>' +
    '<div class="scopes-label">Requested permissions</div>' +
    '<ul class="scope-list">' + scopeItems + '</ul>' +
    '<div class="expiry' + (expiry.expired ? ' expired' : '') + '">' + expiry.text + '</div>' +
    '<div class="actions">' +
      '<button class="btn btn-deny" id="btn-deny">Deny</button>' +
      '<button class="btn btn-approve" id="btn-approve">Approve</button>' +
    '</div>';

  document.getElementById('btn-approve').addEventListener('click', async function() {
    this.disabled = true;
    document.getElementById('btn-deny').disabled = true;
    try {
      await approveRequest(true);
    } catch (e) {
      showError(e && e.message ? e.message : 'Network error. Please try again.');
    }
  });

  document.getElementById('btn-deny').addEventListener('click', async function() {
    this.disabled = true;
    document.getElementById('btn-approve').disabled = true;
    try {
      const res = await fetch('/v1/consent/' + encodeURIComponent(reqId) + '/deny', { method: 'POST' });
      if (!res.ok && res.status !== 404) { showError('Failed to deny. Please try again.'); return; }
      const body = await res.json();
      if (body.redirectUri) {
        const url = new URL(body.redirectUri);
        url.searchParams.set('error', 'access_denied');
        if (body.state) url.searchParams.set('state', body.state);
        location.href = url.toString();
      } else {
        el.innerHTML =
          '<div class="status-screen">' +
            '<div class="status-icon">&#10007;</div>' +
            '<h2>Denied</h2>' +
            '<p>You have denied access. You may close this window.</p>' +
          '</div>';
      }
    } catch (e) {
      showError('Network error. Please try again.');
    }
  });
})();
</script>
</body>
</html>`;

export async function consentRoutes(app: FastifyInstance): Promise<void> {
  // GET /consent — serve the HTML consent page (public)
  app.get<{ Querystring: { req?: string } }>(
    '/consent',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      return reply
        .header('Content-Security-Policy', CONSENT_CSP)
        .type('text/html')
        .send(CONSENT_HTML);
    },
  );

  // GET /v1/consent/:id — return auth request details (public)
  app.get<{ Params: { id: string } }>(
    '/v1/consent/:id',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql<{
        id: string;
        scopes: string[];
        expires_at: string;
        status: string;
        redirect_uri: string | null;
        state: string | null;
        agent_name: string;
        agent_description: string | null;
        agent_did: string;
        fido_required: boolean;
      }[]>`
        SELECT ar.id, ar.scopes, ar.expires_at, ar.status, ar.redirect_uri, ar.state,
               a.name AS agent_name, a.description AS agent_description, a.did AS agent_did,
               d.fido_required
        FROM auth_requests ar
        JOIN agents a ON a.id = ar.agent_id
        JOIN developers d ON d.id = ar.developer_id
        WHERE ar.id = ${request.params.id}
      `;

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ message: 'Auth request not found', code: 'NOT_FOUND', requestId: request.id });
      }

      const expired = new Date(row.expires_at) <= new Date();
      if (expired || row.status !== 'pending') {
        return reply.status(410).send({ message: 'Auth request expired or already processed', code: 'GONE', requestId: request.id });
      }

      return reply.send({
        id: row.id,
        agentName: row.agent_name,
        agentDid: row.agent_did,
        agentDescription: row.agent_description ?? null,
        scopes: row.scopes,
        scopeDescriptions: row.scopes.map(describeScope),
        expiresAt: row.expires_at,
        status: row.status,
        fidoRequired: Boolean(row.fido_required),
      });
    },
  );

  // POST /v1/consent/:id/approve — principal approves (public)
  app.post<{ Params: { id: string } }>(
    '/v1/consent/:id/approve',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sql = getSql();
      const code = ulid();

      const rows = await sql<{ id: string; code: string; redirect_uri: string | null; state: string | null }[]>`
        UPDATE auth_requests
        SET status = 'approved', code = ${code}
        WHERE id = ${request.params.id}
          AND status = 'pending'
          AND expires_at > NOW()
          AND EXISTS (
            SELECT 1 FROM developers d
            WHERE d.id = auth_requests.developer_id
              AND (d.mode = 'sandbox' OR auth_requests.fido_verified = TRUE)
          )
        RETURNING id, code, redirect_uri, state
      `;

      const row = rows[0];
      if (!row) {
        // Distinguish FIDO_REQUIRED from expired/processed
        const fidoCheck = await sql`
          SELECT d.fido_required, d.mode, ar.fido_verified, ar.status, ar.expires_at
          FROM auth_requests ar
          JOIN developers d ON d.id = ar.developer_id
          WHERE ar.id = ${request.params.id}
        `;
        const fc = fidoCheck[0];
        if (fc && fc['status'] === 'pending' && new Date(fc['expires_at'] as string) > new Date()) {
          if (fc['fido_required'] && !fc['fido_verified']) {
            return reply.status(403).send({
              message: 'FIDO verification required before approval',
              code: 'FIDO_REQUIRED',
              requestId: request.id,
            });
          }
          if (fc['mode'] !== 'sandbox' && !fc['fido_verified']) {
            return reply.status(403).send({
              message: 'Principal verification required before approval',
              code: 'PRINCIPAL_VERIFICATION_REQUIRED',
              requestId: request.id,
            });
          }
        }
        return reply.status(410).send({ message: 'Auth request expired or already processed', code: 'GONE', requestId: request.id });
      }

      const result: { code: string; redirectUri?: string; state?: string } = { code: row.code };
      if (row.redirect_uri) result.redirectUri = row.redirect_uri;
      if (row.state) result.state = row.state;
      return reply.send(result);
    },
  );

  // POST /v1/consent/:id/deny — principal denies (public)
  app.post<{ Params: { id: string } }>(
    '/v1/consent/:id/deny',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sql = getSql();

      const rows = await sql<{ id: string; redirect_uri: string | null; state: string | null }[]>`
        UPDATE auth_requests
        SET status = 'denied'
        WHERE id = ${request.params.id}
          AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM developers d
            WHERE d.id = auth_requests.developer_id
              AND (d.mode = 'sandbox' OR auth_requests.fido_verified = TRUE)
          )
        RETURNING id, redirect_uri, state
      `;

      const row = rows[0];
      if (!row) {
        const proofCheck = await sql`
          SELECT d.mode, ar.fido_verified, ar.status, ar.expires_at
          FROM auth_requests ar
          JOIN developers d ON d.id = ar.developer_id
          WHERE ar.id = ${request.params.id}
        `;
        const pc = proofCheck[0];
        if (pc && pc['status'] === 'pending' && new Date(pc['expires_at'] as string) > new Date()
            && pc['mode'] !== 'sandbox' && !pc['fido_verified']) {
          return reply.status(403).send({
            message: 'Principal verification required before denial',
            code: 'PRINCIPAL_VERIFICATION_REQUIRED',
            requestId: request.id,
          });
        }
        return reply.status(404).send({ message: 'Auth request not found or already processed', code: 'NOT_FOUND', requestId: request.id });
      }

      const result: { redirectUri?: string; state?: string } = {};
      if (row.redirect_uri) result.redirectUri = row.redirect_uri;
      if (row.state) result.state = row.state;
      return reply.send(result);
    },
  );
}
