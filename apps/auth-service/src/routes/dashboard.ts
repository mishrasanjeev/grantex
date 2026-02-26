import type { FastifyInstance } from 'fastify';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', { config: { skipAuth: true } }, async (_request, reply) => {
    await reply.type('text/html').send(dashboardHtml());
  });
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grantex Developer Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f8f9fa; color: #111827; min-height: 100vh; }

    .header { background: #1a1a2e; color: white; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
    .header .pill { background: rgba(255,255,255,0.15); font-size: 11px; padding: 2px 9px; border-radius: 12px; font-weight: 500; }

    .key-bar { background: white; border-bottom: 1px solid #e5e7eb; padding: 10px 24px; display: flex; align-items: center; gap: 10px; }
    .key-bar label { font-size: 13px; font-weight: 500; color: #4b5563; white-space: nowrap; }
    .key-bar input { flex: 1; max-width: 380px; padding: 6px 11px; border: 1px solid #d1d5db; border-radius: 6px; font-family: monospace; font-size: 13px; outline: none; }
    .key-bar input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
    .key-bar button { padding: 6px 16px; background: #6366f1; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .key-bar button:hover { background: #4f46e5; }
    #conn-status { font-size: 13px; color: #6b7280; }

    .stats { display: flex; gap: 14px; padding: 20px 24px 0; }
    .stat { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 20px; flex: 1; min-width: 0; }
    .stat .label { font-size: 11px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: .06em; }
    .stat .value { font-size: 30px; font-weight: 700; color: #111827; margin-top: 4px; line-height: 1; }

    .tabs { display: flex; padding: 16px 24px 0; border-bottom: 1px solid #e5e7eb; background: transparent; margin-top: 16px; }
    .tab { padding: 10px 18px; font-size: 14px; font-weight: 500; color: #6b7280; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tab.active { color: #6366f1; border-bottom-color: #6366f1; }
    .tab:hover:not(.active) { color: #374151; }

    .content { padding: 20px 24px; }
    .panel { display: none; }
    .panel.active { display: block; }

    .table-wrap { background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th { background: #f9fafb; padding: 9px 14px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
    tbody td { padding: 11px 14px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #fafafa; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #374151; }

    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
    .b-active  { background: #d1fae5; color: #065f46; }
    .b-revoked { background: #fee2e2; color: #991b1b; }
    .b-expired { background: #fef3c7; color: #92400e; }
    .b-success { background: #d1fae5; color: #065f46; }
    .b-failure { background: #fee2e2; color: #991b1b; }
    .b-blocked { background: #fef3c7; color: #92400e; }

    .scope-list { display: flex; flex-wrap: wrap; gap: 3px; }
    .scope { background: #ede9fe; color: #5b21b6; font-size: 11px; padding: 1px 6px; border-radius: 4px; font-family: monospace; }

    .btn-revoke { padding: 3px 10px; background: #fff; border: 1px solid #fca5a5; color: #dc2626; border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .btn-revoke:hover { background: #fee2e2; }

    .empty { padding: 44px; text-align: center; color: #9ca3af; font-size: 14px; }
    #err { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 16px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; display: none; }
    #hint { padding: 72px 24px; text-align: center; color: #9ca3af; font-size: 14px; line-height: 2; }
    #hint code { font-family: monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; color: #374151; }
  </style>
</head>
<body>

<div class="header">
  <h1>Grantex</h1>
  <span class="pill">Developer Dashboard</span>
</div>

<div class="key-bar">
  <label for="api-key">API Key</label>
  <input id="api-key" type="password" placeholder="dev-api-key-local" autocomplete="off">
  <button onclick="connectKey()">Connect</button>
  <span id="conn-status"></span>
</div>

<div id="main" style="display:none">
  <div class="stats">
    <div class="stat"><div class="label">Agents</div><div class="value" id="stat-agents">—</div></div>
    <div class="stat"><div class="label">Active Grants</div><div class="value" id="stat-grants">—</div></div>
    <div class="stat"><div class="label">Audit Entries</div><div class="value" id="stat-audit">—</div></div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('agents')">Agents</div>
    <div class="tab" onclick="switchTab('grants')">Grants</div>
    <div class="tab" onclick="switchTab('audit')">Audit Log</div>
  </div>

  <div class="content">
    <div id="err"></div>

    <div id="panel-agents" class="panel active">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>DID</th><th>Scopes</th><th>Status</th><th>Created</th></tr></thead>
          <tbody id="agents-body"></tbody>
        </table>
      </div>
    </div>

    <div id="panel-grants" class="panel">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Grant ID</th><th>Principal</th><th>Agent</th><th>Scopes</th><th>Depth</th><th>Status</th><th>Expires</th><th></th></tr></thead>
          <tbody id="grants-body"></tbody>
        </table>
      </div>
    </div>

    <div id="panel-audit" class="panel">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Action</th><th>Status</th><th>Principal</th><th>Agent</th><th>Metadata</th><th>Timestamp</th></tr></thead>
          <tbody id="audit-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<div id="hint">
  Enter your API key above to connect.<br>
  Running locally? Try <code>dev-api-key-local</code> (live) or <code>sandbox-api-key-local</code> (sandbox).
</div>

<script>
  var apiKey = sessionStorage.getItem('grantex_key') || '';
  var currentTab = 'agents';

  if (apiKey) {
    document.getElementById('api-key').value = apiKey;
    loadData();
  }

  document.getElementById('api-key').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') connectKey();
  });

  function connectKey() {
    apiKey = document.getElementById('api-key').value.trim();
    if (!apiKey) return;
    sessionStorage.setItem('grantex_key', apiKey);
    document.getElementById('conn-status').textContent = '';
    loadData();
  }

  function switchTab(name) {
    currentTab = name;
    var tabs = ['agents', 'grants', 'audit'];
    document.querySelectorAll('.tab').forEach(function(t, i) {
      t.classList.toggle('active', tabs[i] === name);
    });
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    document.getElementById('panel-' + name).classList.add('active');
  }

  function apiFetch(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + apiKey } }).then(function(res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    });
  }

  function loadData() {
    var err = document.getElementById('err');
    err.style.display = 'none';
    Promise.all([
      apiFetch('/v1/agents'),
      apiFetch('/v1/grants'),
      apiFetch('/v1/audit/entries'),
    ]).then(function(results) {
      var agentsData = results[0], grantsData = results[1], auditData = results[2];
      document.getElementById('main').style.display = '';
      document.getElementById('hint').style.display = 'none';
      document.getElementById('conn-status').textContent = '✓ Connected';

      var agents = agentsData.agents || [];
      var grants = grantsData.grants || [];
      var entries = auditData.entries || [];
      var activeGrants = grants.filter(function(g) { return g.status === 'active'; }).length;

      document.getElementById('stat-agents').textContent = agents.length;
      document.getElementById('stat-grants').textContent = activeGrants;
      document.getElementById('stat-audit').textContent = entries.length;

      renderAgents(agents);
      renderGrants(grants);
      renderAudit(entries);
    }).catch(function(e) {
      err.textContent = 'Error: ' + e.message + ' — check your API key and try again.';
      err.style.display = 'block';
      document.getElementById('conn-status').textContent = '';
    });
  }

  function statusBadge(status) {
    var cls = status === 'active' ? 'b-active' : status === 'revoked' ? 'b-revoked' : 'b-expired';
    return '<span class="badge ' + cls + '">' + (status || '—') + '</span>';
  }

  function auditBadge(status) {
    var s = status || 'success';
    return '<span class="badge b-' + s + '">' + s + '</span>';
  }

  function scopesHtml(arr) {
    if (!arr || !arr.length) return '—';
    return '<div class="scope-list">' + arr.map(function(s) {
      return '<span class="scope">' + s + '</span>';
    }).join('') + '</div>';
  }

  function shortId(id) {
    if (!id) return '—';
    return '<span class="mono" title="' + id + '">' + id.slice(0, 20) + (id.length > 20 ? '…' : '') + '</span>';
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderAgents(agents) {
    var tbody = document.getElementById('agents-body');
    if (!agents.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No agents registered yet.</td></tr>';
      return;
    }
    tbody.innerHTML = agents.map(function(a) {
      return '<tr>'
        + '<td><strong>' + esc(a.name) + '</strong>'
        + (a.description ? '<div style="font-size:11px;color:#9ca3af;margin-top:2px">' + esc(a.description) + '</div>' : '')
        + '</td>'
        + '<td>' + shortId(a.did) + '</td>'
        + '<td>' + scopesHtml(a.scopes) + '</td>'
        + '<td>' + statusBadge(a.status) + '</td>'
        + '<td style="font-size:12px;color:#9ca3af;white-space:nowrap">' + fmtTime(a.createdAt) + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderGrants(grants) {
    var tbody = document.getElementById('grants-body');
    if (!grants.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No grants yet.</td></tr>';
      return;
    }
    tbody.innerHTML = grants.map(function(g) {
      var depth = g.delegationDepth || 0;
      var depthCell = depth > 0
        ? '<span class="badge" style="background:#e0e7ff;color:#3730a3">depth ' + depth + '</span>'
        : '<span style="color:#9ca3af;font-size:12px">root</span>';
      var revokeBtn = g.status === 'active'
        ? '<button class="btn-revoke" onclick="revokeGrant(\'' + g.grantId + '\')">Revoke</button>'
        : '';
      return '<tr>'
        + '<td>' + shortId(g.grantId) + '</td>'
        + '<td class="mono">' + esc(g.principalId || '—') + '</td>'
        + '<td>' + shortId(g.agentId) + '</td>'
        + '<td>' + scopesHtml(g.scopes) + '</td>'
        + '<td>' + depthCell + '</td>'
        + '<td>' + statusBadge(g.status) + '</td>'
        + '<td style="font-size:12px;color:#9ca3af;white-space:nowrap">' + fmtTime(g.expiresAt) + '</td>'
        + '<td>' + revokeBtn + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderAudit(entries) {
    var tbody = document.getElementById('audit-body');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No audit entries yet.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(function(e) {
      var meta = e.metadata && Object.keys(e.metadata).length
        ? JSON.stringify(e.metadata).slice(0, 80) + (JSON.stringify(e.metadata).length > 80 ? '…' : '')
        : '—';
      return '<tr>'
        + '<td class="mono">' + esc(e.action || '—') + '</td>'
        + '<td>' + auditBadge(e.status) + '</td>'
        + '<td>' + shortId(e.principalId) + '</td>'
        + '<td>' + shortId(e.agentId) + '</td>'
        + '<td><span class="mono" style="font-size:11px;color:#6b7280">' + esc(meta) + '</span></td>'
        + '<td style="font-size:12px;color:#9ca3af;white-space:nowrap">' + fmtTime(e.timestamp) + '</td>'
        + '</tr>';
    }).join('');
  }

  function revokeGrant(grantId) {
    if (!confirm('Revoke grant ' + grantId + '?\\n\\nThis will also cascade-revoke all delegated sub-grants.')) return;
    fetch('/v1/grants/' + grantId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + apiKey },
    }).then(function(res) {
      if (!res.ok && res.status !== 204) throw new Error(res.statusText);
      loadData();
    }).catch(function(e) {
      alert('Failed to revoke: ' + e.message);
    });
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}
