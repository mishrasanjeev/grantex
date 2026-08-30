import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import {
  signPrincipalSessionToken,
  parseExpiresIn,
} from '../lib/crypto.js';
import { revokeGrantCascade } from '../lib/revoke.js';
import { requirePrincipalSession } from '../lib/principal-auth.js';

const PERMISSIONS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_SESSION_SECONDS = 86400; // 24h

export async function principalRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/principal-sessions — developer creates a session for an end-user
  app.post<{ Body: { principalId?: string; expiresIn?: string } }>(
    '/v1/principal-sessions',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { principalId, expiresIn } = request.body ?? {};

      if (!principalId) {
        return reply.status(400).send({
          message: 'principalId is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      // Parse and validate expiresIn
      let seconds = 3600; // default 1h
      if (expiresIn) {
        try {
          seconds = parseExpiresIn(expiresIn);
        } catch {
          return reply.status(400).send({
            message: 'Invalid expiresIn format. Use e.g. "1h", "30m", "24h".',
            code: 'BAD_REQUEST',
            requestId: request.id,
          });
        }
        if (seconds > MAX_SESSION_SECONDS) {
          seconds = MAX_SESSION_SECONDS;
        }
      }

      // Verify at least one active grant exists for this principal+developer
      const sql = getSql();
      const grantRows = await sql`
        SELECT id FROM grants
        WHERE developer_id = ${request.developer.id}
          AND principal_id = ${principalId}
          AND status = 'active'
          AND expires_at > NOW()
        LIMIT 1
      `;

      if (grantRows.length === 0) {
        return reply.status(404).send({
          message: 'No active grants found for this principal',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const sessionToken = await signPrincipalSessionToken(
        { principalId, developerId: request.developer.id },
        seconds,
      );

      const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();

      return reply.status(201).send({
        sessionToken,
        dashboardUrl: `${request.protocol}://${request.hostname}/permissions#session=${encodeURIComponent(sessionToken)}`,
        expiresAt,
      });
    },
  );

  // GET /v1/principal/grants — end-user views their grants (session JWT auth)
  app.get(
    '/v1/principal/grants',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const session = await requirePrincipalSession(request, reply);
      if (!session) return;

      const sql = getSql();
      const rows = await sql`
        SELECT g.id, g.agent_id, g.scopes, g.status, g.issued_at, g.expires_at,
               g.delegation_depth,
               a.name AS agent_name, a.description AS agent_description, a.did AS agent_did
        FROM grants g
        LEFT JOIN agents a ON a.id = g.agent_id AND a.developer_id = g.developer_id
        WHERE g.developer_id = ${session.developerId}
          AND g.principal_id = ${session.principalId}
          AND g.status = 'active'
        ORDER BY g.issued_at DESC
      `;

      const grants = rows.map((row) => ({
        grantId: row['id'],
        agentId: row['agent_id'],
        agentName: row['agent_name'] ?? null,
        agentDescription: row['agent_description'] ?? null,
        agentDid: row['agent_did'] ?? null,
        scopes: row['scopes'],
        status: row['status'],
        issuedAt: row['issued_at'],
        expiresAt: row['expires_at'],
        delegationDepth: (row['delegation_depth'] as number | undefined) ?? 0,
      }));

      return reply.send({ grants, principalId: session.principalId });
    },
  );

  // GET /v1/principal/audit — end-user views their audit log (session JWT auth)
  app.get(
    '/v1/principal/audit',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const session = await requirePrincipalSession(request, reply);
      if (!session) return;

      const sql = getSql();
      const rows = await sql`
        SELECT id, agent_id, agent_did, grant_id, principal_id, action, metadata, status, timestamp
        FROM audit_entries
        WHERE developer_id = ${session.developerId}
          AND principal_id = ${session.principalId}
        ORDER BY timestamp DESC
        LIMIT 100
      `;

      const entries = rows.map((row) => ({
        entryId: row['id'],
        agentId: row['agent_id'],
        agentDid: row['agent_did'],
        grantId: row['grant_id'],
        principalId: row['principal_id'],
        action: row['action'],
        metadata: row['metadata'],
        status: row['status'],
        timestamp: row['timestamp'],
      }));

      return reply.send({ entries });
    },
  );

  // DELETE /v1/principal/grants/:id — end-user revokes a grant (session JWT auth)
  app.delete<{ Params: { id: string } }>(
    '/v1/principal/grants/:id',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const session = await requirePrincipalSession(request, reply);
      if (!session) return;

      // Verify the grant belongs to this principal+developer
      const sql = getSql();
      const grantRows = await sql`
        SELECT id FROM grants
        WHERE id = ${request.params.id}
          AND developer_id = ${session.developerId}
          AND principal_id = ${session.principalId}
          AND status = 'active'
      `;

      if (grantRows.length === 0) {
        return reply.status(404).send({
          message: 'Grant not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      await revokeGrantCascade(request.params.id, session.developerId);

      return reply.status(204).send();
    },
  );

  // GET /permissions — public HTML page for end-users to manage their permissions
  app.get(
    '/permissions',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      await reply
        .header('Content-Security-Policy', PERMISSIONS_CSP)
        .type('text/html')
        .send(permissionsPageHtml());
    },
  );
}

function permissionsPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Manage Permissions — Grantex</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f8f9fa; color: #111827; min-height: 100vh; }

    .header { background: #1a1a2e; color: white; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
    .header .pill { background: rgba(255,255,255,0.15); font-size: 11px; padding: 2px 9px; border-radius: 12px; font-weight: 500; }

    .page { max-width: 900px; margin: 0 auto; padding: 32px 24px; }

    .section-title { font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 4px; }
    .section-sub { font-size: 14px; color: #6b7280; margin-bottom: 20px; }

    .grant-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 40px; }
    .grant-card { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; display: flex; align-items: flex-start; gap: 16px; }
    .agent-icon { width: 40px; height: 40px; border-radius: 10px; background: #ede9fe; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
    .grant-body { flex: 1; min-width: 0; }
    .grant-name { font-size: 15px; font-weight: 600; color: #111827; }
    .grant-desc { font-size: 12px; color: #9ca3af; margin-top: 1px; }
    .grant-did { font-family: monospace; font-size: 11px; color: #9ca3af; margin-top: 1px; }
    .grant-scopes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .scope { background: #ede9fe; color: #5b21b6; font-size: 11px; padding: 2px 7px; border-radius: 4px; font-family: monospace; }
    .grant-meta { margin-top: 8px; font-size: 12px; color: #9ca3af; display: flex; gap: 16px; flex-wrap: wrap; }
    .grant-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; }

    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 10px; }
    .b-active  { background: #d1fae5; color: #065f46; }
    .b-revoked { background: #fee2e2; color: #991b1b; }
    .b-expired { background: #fef3c7; color: #92400e; }
    .depth-badge { background: #e0e7ff; color: #3730a3; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }

    .btn-revoke { padding: 6px 14px; background: #fff; border: 1px solid #fca5a5; color: #dc2626; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .btn-revoke:hover { background: #fee2e2; }
    .wallet-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 40px; }
    .wallet-card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; min-width: 0; }
    .wallet-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .wallet-name { font-weight: 650; color: #111827; overflow-wrap: anywhere; }
    .wallet-balance { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 22px; color: #111827; margin: 14px 0 2px; }
    .wallet-unit { font-size: 11px; color: #9ca3af; }
    .wallet-policy { border-top: 1px solid #f3f4f6; margin-top: 14px; padding-top: 12px; font-size: 12px; color: #6b7280; }
    .wallet-policy-row { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; }
    .wallet-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .btn-control { border: 1px solid #d1d5db; background: white; color: #374151; border-radius: 6px; padding: 6px 9px; font-size: 11px; cursor: pointer; }
    .btn-control:hover { background: #f9fafb; }
    .btn-stop { border-color: #fca5a5; color: #b91c1c; }
    .btn-approve { border-color: #86efac; color: #047857; }
    .reload-row { background: #f9fafb; border-radius: 6px; padding: 9px; margin-top: 10px; font-size: 11px; color: #4b5563; }

    .audit-wrap { background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th { background: #f9fafb; padding: 9px 14px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
    tbody td { padding: 11px 14px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #fafafa; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }

    .b-success { background: #d1fae5; color: #065f46; }
    .b-failure { background: #fee2e2; color: #991b1b; }
    .b-blocked { background: #fef3c7; color: #92400e; }

    .empty { padding: 44px; text-align: center; color: #9ca3af; font-size: 14px; }
    #err { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 16px; border-radius: 6px; font-size: 13px; margin-bottom: 20px; display: none; }
    #loading { padding: 72px 24px; text-align: center; color: #9ca3af; font-size: 14px; }
    .expired-msg { padding: 72px 24px; text-align: center; }
    .expired-msg h2 { font-size: 20px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    .expired-msg p { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>

<div class="header">
  <h1>Grantex</h1>
  <span class="pill">Manage Permissions</span>
</div>

<div id="loading">Loading your permissions...</div>
<div id="expired" style="display:none">
  <div class="expired-msg">
    <h2>Session Expired</h2>
    <p>Your session link has expired or is invalid. Please request a new link from the application.</p>
  </div>
</div>

<div id="main" style="display:none">
  <div class="page">
    <div id="err"></div>

    <div class="section-title">Apps with access</div>
    <div class="section-sub">These agents are authorized to act on your behalf. You can revoke access at any time.</div>
    <div id="grant-list" class="grant-list"></div>

    <div class="section-title">Agent prepaid wallets</div>
    <div class="section-sub">Review atomic-unit balances, reload requests, and the policy assigned to each agent. Stop controls release outstanding reservations in the affected boundary.</div>
    <div id="wallet-list" class="wallet-list"></div>

    <div class="section-title">Recent activity</div>
    <div class="section-sub" style="margin-bottom:12px">Actions taken by agents on your behalf.</div>
    <div class="audit-wrap">
      <table>
        <thead><tr><th>Action</th><th>Result</th><th>Agent</th><th>Metadata</th><th>When</th></tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
  function getSessionToken() {
    var hash = window.location.hash || '';
    if (hash.startsWith('#')) {
      var hashParams = new URLSearchParams(hash.slice(1));
      var hashToken = hashParams.get('session');
      if (hashToken) return hashToken;
    }
    return new URLSearchParams(window.location.search).get('session');
  }

  var sessionToken = getSessionToken();

  if (!sessionToken) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('expired').style.display = '';
  } else {
    loadData();
  }

  function apiFetch(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + sessionToken } }).then(function(res) {
      if (res.status === 401) throw new Error('SESSION_EXPIRED');
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    });
  }

  function loadData() {
    Promise.all([
      apiFetch('/v1/principal/grants'),
      apiFetch('/v1/principal/audit'),
      apiFetch('/v1/principal/prepaid-wallets'),
    ]).then(function(results) {
      var wallets = results[2].wallets || [];
      return Promise.all(wallets.map(function(wallet) {
        return apiFetch('/v1/principal/prepaid-wallets/' + encodeURIComponent(wallet.walletId) + '/activity');
      })).then(function(activity) { return { results: results, wallets: wallets, activity: activity }; });
    }).then(function(data) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('main').style.display = '';
      renderGrants(data.results[0].grants || []);
      renderWallets(data.wallets, data.activity);
      renderAudit(data.results[1].entries || []);
    }).catch(function(e) {
      document.getElementById('loading').style.display = 'none';
      if (e.message === 'SESSION_EXPIRED') {
        document.getElementById('expired').style.display = '';
      } else {
        document.getElementById('main').style.display = '';
        var err = document.getElementById('err');
        err.textContent = 'Error: ' + e.message;
        err.style.display = 'block';
      }
    });
  }

  function renderWallets(wallets, activity) {
    var el = document.getElementById('wallet-list');
    if (!wallets.length) {
      el.innerHTML = '<div class="empty">No prepaid wallets are assigned to this principal.</div>';
      return;
    }
    el.innerHTML = wallets.map(function(wallet, index) {
      var details = activity[index] || {};
      var assignments = details.assignments || [];
      var reloads = (details.reloadRequests || []).filter(function(item) {
        return item.status === 'pending' || item.status === 'approved';
      });
      var assignmentHtml = assignments.map(function(item) {
        var next = item.status === 'active' ? 'blocked' : 'active';
        var action = item.status === 'active' ? 'Block assignment' : 'Unblock assignment';
        var assignmentControl = item.status === 'revoked'
          ? '<span class="badge b-blocked">revoked</span>'
          : '<button class="btn-control ' + (item.status === 'active' ? 'btn-stop' : '') + '" onclick="setAssignment(' + jsString(item.assignmentId) + ',' + jsString(next) + ')">' + action + '</button>';
        return '<div class="wallet-policy">'
          + '<div class="wallet-policy-row"><span>Agent</span><span class="mono">' + esc(item.agentId) + '</span></div>'
          + '<div class="wallet-policy-row"><span>Transaction cap</span><span class="mono">' + esc(item.perTransactionLimit) + '</span></div>'
          + '<div class="wallet-policy-row"><span>Rolling cap</span><span class="mono">' + esc(item.cumulativeLimit) + ' / ' + esc(item.cumulativePeriodSeconds) + 's</span></div>'
          + '<div class="wallet-actions">'
          + assignmentControl
          + '<button class="btn-control btn-stop" onclick="setAgentBlock(' + jsString(item.agentId) + ',true)">Stop all agent wallets</button>'
          + '<button class="btn-control" onclick="setAgentBlock(' + jsString(item.agentId) + ',false)">Allow agent wallets</button>'
          + '</div></div>';
      }).join('');
      var reloadHtml = reloads.map(function(item) {
        var actions = item.status === 'pending'
          ? '<button class="btn-control btn-approve" onclick="decideReload(' + jsString(item.reloadRequestId) + ',\'approved\')">Approve</button>'
            + '<button class="btn-control btn-stop" onclick="decideReload(' + jsString(item.reloadRequestId) + ',\'rejected\')">Reject</button>'
          : '<button class="btn-control btn-approve" onclick="fundReload(' + jsString(item.reloadRequestId) + ')">Fund approved reload</button>';
        return '<div class="reload-row"><strong>Reload ' + esc(item.amount) + '</strong> &middot; ' + esc(item.status)
          + '<div class="wallet-actions">' + actions + '</div></div>';
      }).join('');
      var nextWalletStatus = wallet.status === 'active' ? 'blocked' : 'active';
      var walletControl = wallet.status === 'closed'
        ? '<span class="badge b-blocked">closed</span>'
        : '<button class="btn-control ' + (wallet.status === 'active' ? 'btn-stop' : '') + '" onclick="setWallet(' + jsString(wallet.walletId) + ',' + jsString(nextWalletStatus) + ')">'
          + (wallet.status === 'active' ? 'Block wallet' : 'Unblock wallet') + '</button>';
      return '<div class="wallet-card"><div class="wallet-head">'
        + '<div><div class="wallet-name">' + esc(wallet.name) + '</div><div class="wallet-unit">' + esc(wallet.asset) + ' on ' + esc(wallet.network) + '</div></div>'
        + '<span class="badge b-' + (wallet.status === 'active' ? 'active' : 'blocked') + '">' + esc(wallet.status) + '</span></div>'
        + '<div class="wallet-balance">' + esc(wallet.availableAmount) + '</div>'
        + '<div class="wallet-unit">atomic units available &middot; ' + esc(wallet.reservedAmount) + ' reserved</div>'
        + '<div class="wallet-actions">' + walletControl + '</div>'
        + assignmentHtml + reloadHtml + '</div>';
    }).join('');
  }

  function renderGrants(grants) {
    var el = document.getElementById('grant-list');
    if (!grants.length) {
      el.innerHTML = '<div class="empty">No active permissions found.</div>';
      return;
    }
    el.innerHTML = grants.map(function(g) {
      var name = g.agentName || g.agentId;
      var desc = g.agentDescription ? '<div class="grant-desc">' + esc(g.agentDescription) + '</div>' : '';
      var did = g.agentDid ? '<div class="grant-did">' + esc(g.agentDid) + '</div>' : '';
      var depthBadge = g.delegationDepth > 0
        ? '<span class="depth-badge">sub-agent depth ' + g.delegationDepth + '</span>'
        : '';
      var scopes = (g.scopes || []).map(function(s) {
        return '<span class="scope">' + esc(s) + '</span>';
      }).join('');
      return '<div class="grant-card">'
        + '<div class="agent-icon">&#129302;</div>'
        + '<div class="grant-body">'
        + '<div class="grant-name">' + esc(name) + '</div>'
        + desc + did
        + '<div class="grant-scopes">' + scopes + '</div>'
        + '<div class="grant-meta">'
        + '<span>Granted ' + fmtTime(g.issuedAt) + '</span>'
        + '<span>Expires ' + fmtTime(g.expiresAt) + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="grant-actions">'
        + '<span class="badge b-active">active</span>'
        + depthBadge
        + '<button class="btn-revoke" onclick="revokeGrant(' + jsString(g.grantId) + ')">Revoke access</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderAudit(entries) {
    var tbody = document.getElementById('audit-body');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(function(e) {
      var s = e.status === 'failure' || e.status === 'blocked' ? e.status : 'success';
      var meta = e.metadata && Object.keys(e.metadata).length
        ? JSON.stringify(e.metadata).slice(0, 80)
        : '\\u2014';
      return '<tr>'
        + '<td class="mono">' + esc(e.action || '\\u2014') + '</td>'
        + '<td><span class="badge b-' + s + '">' + esc(s) + '</span></td>'
        + '<td style="font-size:12px;color:#6b7280">' + esc((e.agentId || '').slice(0, 22)) + '</td>'
        + '<td><span class="mono" style="font-size:11px;color:#6b7280">' + esc(meta) + '</span></td>'
        + '<td style="font-size:12px;color:#9ca3af;white-space:nowrap">' + fmtTime(e.timestamp) + '</td>'
        + '</tr>';
    }).join('');
  }

  function revokeGrant(grantId) {
    if (!confirm('Revoke this access?\\n\\nThe agent will no longer be able to act on your behalf. This cannot be undone.')) return;
    fetch('/v1/principal/grants/' + encodeURIComponent(grantId), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + sessionToken },
    }).then(function(res) {
      if (res.status === 401) { document.getElementById('main').style.display = 'none'; document.getElementById('expired').style.display = ''; return; }
      if (!res.ok && res.status !== 204) throw new Error(res.statusText);
      loadData();
    }).catch(function(e) { alert('Failed to revoke: ' + e.message); });
  }

  function walletMutation(path, method, body) {
    return fetch(path, {
      method: method,
      headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function(res) {
      if (res.status === 401) throw new Error('SESSION_EXPIRED');
      return res.json().catch(function() { return {}; }).then(function(value) {
        if (!res.ok) throw new Error(value.message || (res.status + ' ' + res.statusText));
        return value;
      });
    }).then(loadData).catch(function(error) {
      if (error.message === 'SESSION_EXPIRED') {
        document.getElementById('main').style.display = 'none';
        document.getElementById('expired').style.display = '';
        return;
      }
      alert('Wallet action failed: ' + error.message);
    });
  }

  function setWallet(walletId, status) {
    return walletMutation('/v1/principal/prepaid-wallets/' + encodeURIComponent(walletId) + '/status', 'PATCH', {
      status: status,
      reason: status === 'blocked' ? 'Principal dashboard action' : undefined,
    });
  }

  function setAssignment(assignmentId, status) {
    return walletMutation('/v1/principal/prepaid-wallet-assignments/' + encodeURIComponent(assignmentId), 'PATCH', {
      status: status,
      reason: status === 'blocked' ? 'Principal dashboard action' : undefined,
    });
  }

  function setAgentBlock(agentId, blocked) {
    return walletMutation('/v1/principal/prepaid-wallet-agents/' + encodeURIComponent(agentId) + '/block', 'PUT', {
      blocked: blocked,
      reason: blocked ? 'Principal dashboard emergency stop' : undefined,
    });
  }

  function decideReload(requestId, decision) {
    return walletMutation('/v1/principal/prepaid-wallet-reload-requests/' + encodeURIComponent(requestId) + '/decision', 'POST', {
      decision: decision,
    });
  }

  function fundReload(requestId) {
    return walletMutation('/v1/principal/prepaid-wallet-reload-requests/' + encodeURIComponent(requestId) + '/fund', 'POST', {});
  }

  function fmtTime(ts) {
    if (!ts) return '\\u2014';
    var d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function jsString(str) {
    return JSON.stringify(String(str || '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  }
</script>
</body>
</html>`;
}
