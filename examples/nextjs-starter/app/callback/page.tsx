'use client';

import { useEffect, useState } from 'react';

interface GrantResult {
  grantToken: string;
  grantId: string;
  scopes: string[];
  expiresAt: string;
  auditEntryId: string;
}

interface AuditEntry {
  entryId: string;
  action: string;
  status: string;
  timestamp: string;
}

export default function CallbackPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    async function exchange() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const denied = params.get('error');

      if (denied === 'access_denied') {
        setError('Authorization was denied by the user.');
        setLoading(false);
        return;
      }

      if (!code) {
        setError('No authorization code received.');
        setLoading(false);
        return;
      }

      // Read agentId and expected state from cookies
      const cookies = Object.fromEntries(
        document.cookie.split('; ').filter(Boolean).map((c) => c.split('=').map(decodeURIComponent))
      );
      const agentId = cookies['grantex_agent_id'];
      const expectedState = cookies['grantex_state'];

      if (!agentId) {
        setError('Missing agent ID cookie — did you start from the home page?');
        setLoading(false);
        return;
      }

      if (state !== expectedState) {
        setError('State mismatch — possible CSRF. Please restart the demo.');
        setLoading(false);
        return;
      }

      try {
        // Exchange code for grant token
        const exchangeRes = await fetch('/api/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, agentId }),
        });
        const exchangeData = await exchangeRes.json();

        if (!exchangeRes.ok) {
          setError(exchangeData.error ?? 'Token exchange failed');
          setLoading(false);
          return;
        }

        setGrant(exchangeData);

        // Fetch audit entries
        const auditRes = await fetch(`/api/audit?grantId=${exchangeData.grantId}`);
        if (auditRes.ok) {
          const auditData = await auditRes.json();
          setAudit(auditData.entries ?? []);
        }
      } catch {
        setError('Network error during token exchange.');
      } finally {
        setLoading(false);
      }
    }

    exchange();
  }, []);

  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center' }}>
        <span className="spinner" style={{ width: 32, height: 32 }} />
        <p style={{ marginTop: 16 }}>Exchanging authorization code…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <h1>Authorization Failed</h1>
        <div className="error" style={{ marginTop: 12 }}>{error}</div>
        <a href="/" style={{ display: 'inline-block', marginTop: 16 }}>← Try again</a>
      </div>
    );
  }

  if (!grant) return null;

  const truncatedToken = grant.grantToken.length > 60
    ? grant.grantToken.slice(0, 30) + '…' + grant.grantToken.slice(-20)
    : grant.grantToken;

  return (
    <div className="card">
      <h1>Authorization Complete</h1>
      <p>The consent flow completed successfully. Here are the grant details.</p>

      <div className="section" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
        <div className="label">Grant ID</div>
        <div className="mono">{grant.grantId}</div>
      </div>

      <div className="section">
        <div className="label">Scopes</div>
        <div className="scopes">
          {grant.scopes.map((s) => (
            <span key={s} className="badge">{s}</span>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="label">Grant Token (JWT)</div>
        <div className="mono">{truncatedToken}</div>
      </div>

      <div className="section">
        <div className="label">Expires At</div>
        <div className="mono">{new Date(grant.expiresAt).toLocaleString()}</div>
      </div>

      {audit.length > 0 && (
        <div className="section">
          <h2>Audit Trail</h2>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.entryId}>
                  <td style={{ fontFamily: 'var(--mono)' }}>{entry.action}</td>
                  <td>
                    <span className="badge">{entry.status}</span>
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section">
        <a href="/">← Start a new demo</a>
      </div>
    </div>
  );
}
