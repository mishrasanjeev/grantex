import { useState } from 'react';
import { useAuth } from '../../store/auth';
import { rotateKey } from '../../api/auth';
import { setApiKey } from '../../api/client';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';

export function SettingsPage() {
  const { developer, apiKey, login } = useAuth();
  const { show } = useToast();
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function handleRotateKey() {
    setRotating(true);
    try {
      const { apiKey: rotatedKey } = await rotateKey();
      setNewKey(rotatedKey);
      // Update client and auth state with new key
      setApiKey(rotatedKey);
      sessionStorage.setItem('grantex_api_key', rotatedKey);
      await login(rotatedKey);
      show('API key rotated successfully', 'success');
    } catch {
      show('Failed to rotate API key', 'error');
    } finally {
      setRotating(false);
    }
  }

  if (!developer) return null;

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-gx-text mb-6">Settings</h1>

      {/* Profile */}
      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-gx-text mb-4">Profile</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gx-muted">Developer ID</span>
            <span className="text-sm font-mono text-gx-text">{developer.developerId}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gx-muted">Name</span>
            <span className="text-sm text-gx-text">{developer.name}</span>
          </div>
          {developer.email && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gx-muted">Email</span>
              <span className="text-sm text-gx-text">{developer.email}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-gx-muted">Mode</span>
            <Badge>{developer.mode}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gx-muted">Plan</span>
            <Badge>{developer.plan}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gx-muted">Created</span>
            <span className="text-sm text-gx-text">{new Date(developer.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </Card>

      {/* API Key */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">API Key</h2>

        <div className="p-3 bg-gx-bg rounded-md border border-gx-border mb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gx-muted mb-1">Current Key</p>
              <p className="text-sm font-mono text-gx-text">
                {apiKey ? `${apiKey.slice(0, 8)}${'•'.repeat(24)}` : '••••••••••••••••'}
              </p>
            </div>
            {apiKey && <CopyButton text={apiKey} />}
          </div>
        </div>

        {newKey && (
          <div className="p-3 bg-gx-accent/10 rounded-md border border-gx-accent/30 mb-4">
            <p className="text-xs text-gx-accent font-semibold mb-1">New API Key (save it now!)</p>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-mono text-gx-text break-all">{newKey}</p>
              <CopyButton text={newKey} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-xs text-gx-muted">
            Rotating your key will invalidate the current one immediately.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRotateKey}
            disabled={rotating}
          >
            {rotating ? <Spinner className="h-3 w-3" /> : 'Rotate Key'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
