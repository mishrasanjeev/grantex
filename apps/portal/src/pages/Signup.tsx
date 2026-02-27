import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useToast } from '../store/toast';
import { signup } from '../api/auth';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { CopyButton } from '../components/ui/CopyButton';
import { Spinner } from '../components/ui/Spinner';

export function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const { login } = useAuth();
  const { show } = useToast();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    try {
      const result = await signup({
        name: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setNewKey(result.apiKey);
      show('Account created!', 'success');
    } catch {
      show('Failed to create account', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleContinue() {
    if (!newKey) return;
    try {
      await login(newKey);
      navigate('/dashboard');
    } catch {
      show('Failed to authenticate', 'error');
    }
  }

  if (newKey) {
    return (
      <div className="min-h-screen bg-gx-bg flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full bg-gx-accent/15 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-gx-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gx-text">Account created</h2>
            <p className="text-sm text-gx-muted mt-1">
              Save your API key — you won&apos;t see it again.
            </p>
          </div>

          <div className="bg-gx-bg border border-gx-border rounded-md p-3 flex items-center justify-between gap-2 mb-6">
            <code className="text-sm font-mono text-gx-accent2 break-all">{newKey}</code>
            <CopyButton text={newKey} />
          </div>

          <Button onClick={handleContinue} className="w-full">
            Continue to Dashboard
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gx-bg flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-mono text-xl font-bold text-gx-accent mb-1">
            grant<span className="text-gx-text">ex</span>
          </h1>
          <p className="text-sm text-gx-muted">Create your developer account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gx-text mb-1.5">
              Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none focus:border-gx-accent transition-colors"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gx-text mb-1.5">
              Email <span className="text-gx-muted">(optional)</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="dev@acme.com"
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none focus:border-gx-accent transition-colors"
            />
          </div>

          <Button type="submit" disabled={loading || !name.trim()} className="w-full">
            {loading ? <Spinner className="h-4 w-4" /> : 'Create Account'}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-gx-muted">
          Already have an account?{' '}
          <Link to="/dashboard/login" className="text-gx-accent2 hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
