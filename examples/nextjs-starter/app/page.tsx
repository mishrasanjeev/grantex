'use client';

import { useState } from 'react';

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startDemo() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/authorize', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Failed to start authorization');
        setLoading(false);
        return;
      }

      // Redirect to Grantex consent UI
      window.location.href = data.consentUrl;
    } catch {
      setError('Network error — is the server running?');
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h1>Grantex Next.js Demo</h1>
      <p>
        Interactive demo of the Grantex authorization consent flow.
        Click the button below to register a temporary agent, start an
        authorization request, and walk through the consent UI.
      </p>

      <p style={{ fontSize: 14 }}>
        <strong style={{ color: 'var(--text)' }}>What happens:</strong>{' '}
        A fresh agent is registered → you're redirected to the Grantex consent
        page → after approval the code is exchanged for a grant token →
        results are displayed on the callback page.
      </p>

      {error && <div className="error">{error}</div>}

      <button className="btn" onClick={startDemo} disabled={loading} style={{ marginTop: 16 }}>
        {loading ? <><span className="spinner" /> Starting…</> : 'Start Demo →'}
      </button>
    </div>
  );
}
