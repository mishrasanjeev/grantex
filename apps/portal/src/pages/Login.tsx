import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useToast } from '../store/toast';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { API_BASE_URL } from '../lib/constants';

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [org, setOrg] = useState(() => new URLSearchParams(window.location.search).get('org') ?? '');
  const [workEmail, setWorkEmail] = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const { login } = useAuth();
  const { show } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    fetch(`${API_BASE_URL}/sso/capabilities`)
      .then((res) => res.ok ? res.json() : null)
      .then((body) => setSsoEnabled(body?.humanSessionsEnabled === true))
      .catch(() => setSsoEnabled(false));
  }, []);

  async function handleSso() {
    if (!org.trim()) return;
    setLoading(true);
    try {
      const callback = `${window.location.origin}/dashboard/sso/callback`;
      const url = new URL(`${API_BASE_URL}/sso/login`);
      url.searchParams.set('org', org.trim());
      url.searchParams.set('redirect_uri', callback);
      const domain = workEmail.trim().split('@')[1];
      if (domain) url.searchParams.set('domain', domain.toLowerCase());
      const response = await fetch(url);
      if (!response.ok) throw new Error('SSO login could not start');
      const result = await response.json() as { protocol: string; authorizeUrl?: string };
      if (result.protocol !== 'oidc' || !result.authorizeUrl) {
        throw new Error('Dashboard SSO currently requires an OIDC connection');
      }
      const state = new URL(result.authorizeUrl).searchParams.get('state');
      if (!state) throw new Error('SSO state is missing');
      sessionStorage.setItem('grantex_sso_login_state', state);
      sessionStorage.setItem('grantex_sso_return', new URLSearchParams(location.search).get('return') ?? '/dashboard');
      window.location.assign(result.authorizeUrl);
    } catch (error) {
      show(error instanceof Error ? error.message : 'SSO login could not start', 'error');
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;

    setLoading(true);
    try {
      await login(apiKey.trim());
      navigate('/dashboard');
    } catch {
      show('Invalid API key or SSO is required for this organization', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gx-bg flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-mono text-xl font-bold text-gx-accent mb-1">
            grant<span className="text-gx-text">ex</span>
          </h1>
          <p className="text-sm text-gx-muted">Sign in to your developer dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="apiKey" className="block text-sm font-medium text-gx-text mb-1.5">
              API Key
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="current-password"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="gx_live_..."
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none focus:border-gx-accent transition-colors font-mono"
              autoFocus
            />
          </div>

          <Button type="submit" disabled={loading || !apiKey.trim()} className="w-full">
            {loading ? <Spinner className="h-4 w-4" /> : 'Sign in'}
          </Button>
        </form>

        {ssoEnabled && (
          <div className="mt-6 border-t border-gx-border pt-5 space-y-3">
            <label htmlFor="sso-org" className="block text-sm font-medium text-gx-text">Organization ID</label>
            <input id="sso-org" value={org} onChange={(e) => setOrg(e.target.value)}
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text" />
            <label htmlFor="sso-email" className="block text-sm font-medium text-gx-text">Work email</label>
            <input id="sso-email" type="email" autoComplete="email" value={workEmail} onChange={(e) => setWorkEmail(e.target.value)}
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text" />
            <Button type="button" variant="secondary" onClick={handleSso} disabled={loading || !org.trim()} className="w-full">
              Continue with SSO
            </Button>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-gx-muted">
          Don&apos;t have an account?{' '}
          <Link to="/dashboard/signup" className="text-gx-accent2 hover:underline">
            Create one
          </Link>
        </p>
      </Card>
    </main>
  );
}
