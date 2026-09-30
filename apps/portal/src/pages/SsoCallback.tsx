import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { API_BASE_URL } from '../lib/constants';

export function SsoCallback() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const expected = sessionStorage.getItem('grantex_sso_login_state');
    const returnTo = sessionStorage.getItem('grantex_sso_return') ?? '/dashboard';
    sessionStorage.removeItem('grantex_sso_login_state');
    sessionStorage.removeItem('grantex_sso_return');
    window.history.replaceState(null, '', '/dashboard/sso/callback');

    if (!code || !state || !expected || state !== expected) {
      setError('SSO sign-in could not be verified. Please start again.');
      return;
    }

    async function complete() {
      try {
        const response = await fetch(`${API_BASE_URL}/sso/callback/oidc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, state, redirect_uri: `${window.location.origin}/dashboard/sso/callback` }),
        });
        if (!response.ok) throw new Error('Identity provider sign-in failed');
        const result = await response.json() as { sessionToken?: string };
        if (!result.sessionToken?.startsWith('gx_sso_')) throw new Error('SSO session was not issued');
        if (returnTo.startsWith('/consent?')) {
          sessionStorage.setItem('grantex_principal_sso_token', result.sessionToken);
          window.location.replace(returnTo);
          return;
        }
        await login(result.sessionToken);
        navigate('/dashboard', { replace: true });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'SSO sign-in failed');
      }
    }
    void complete();
  }, [login, navigate]);

  return (
    <main className="min-h-screen bg-gx-bg flex flex-col items-center justify-center gap-4 px-4 text-gx-text">
      {error ? <><p role="alert">{error}</p><Link to="/dashboard/login" className="text-gx-accent">Try again</Link></>
        : <p>Completing organization sign-in...</p>}
    </main>
  );
}
