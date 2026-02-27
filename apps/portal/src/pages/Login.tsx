import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useToast } from '../store/toast';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const { show } = useToast();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;

    setLoading(true);
    try {
      await login(apiKey.trim());
      navigate('/dashboard');
    } catch {
      show('Invalid API key', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gx-bg flex items-center justify-center px-4">
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
              type="password"
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

        <p className="mt-6 text-center text-xs text-gx-muted">
          Don&apos;t have an account?{' '}
          <Link to="/dashboard/signup" className="text-gx-accent2 hover:underline">
            Create one
          </Link>
        </p>
      </Card>
    </div>
  );
}
