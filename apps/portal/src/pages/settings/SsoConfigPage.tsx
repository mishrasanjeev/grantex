import { useState, useEffect } from 'react';
import { getSsoConfig, saveSsoConfig, deleteSsoConfig, type SsoConfig } from '../../api/sso';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Spinner } from '../../components/ui/Spinner';
import { Badge } from '../../components/ui/Badge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ApiError } from '../../api/client';

export function SsoConfigPage() {
  const [config, setConfig] = useState<SsoConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);

  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');

  const { show } = useToast();

  useEffect(() => {
    getSsoConfig()
      .then((c) => {
        setConfig(c);
        setIssuerUrl(c.issuerUrl);
        setClientId(c.clientId);
        setRedirectUri(c.redirectUri);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          // No SSO configured — that's fine
        } else {
          show('Failed to load SSO configuration', 'error');
        }
      })
      .finally(() => setLoading(false));
  }, [show]);

  async function handleSave() {
    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return;
    setSaving(true);
    try {
      const result = await saveSsoConfig({ issuerUrl, clientId, clientSecret, redirectUri });
      setConfig(result);
      setClientSecret('');
      setEditing(false);
      show('SSO configuration saved', 'success');
    } catch {
      show('Failed to save SSO configuration', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await deleteSsoConfig();
      setConfig(null);
      setIssuerUrl('');
      setClientId('');
      setClientSecret('');
      setRedirectUri('');
      setEditing(false);
      show('SSO configuration removed', 'success');
    } catch {
      show('Failed to remove SSO configuration', 'error');
    } finally {
      setRemoving(false);
      setShowRemove(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gx-text">SSO Configuration</h1>
          <Badge>{config ? 'Configured' : 'Not configured'}</Badge>
        </div>
      </div>

      {config && !editing ? (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">OIDC Provider</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gx-muted">Issuer URL</span>
              <span className="text-sm font-mono text-gx-text">{config.issuerUrl}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gx-muted">Client ID</span>
              <span className="text-sm font-mono text-gx-text">{config.clientId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gx-muted">Redirect URI</span>
              <span className="text-sm font-mono text-gx-text break-all">{config.redirectUri}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gx-muted">Updated</span>
              <span className="text-sm text-gx-text">{new Date(config.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-6 pt-4 border-t border-gx-border">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowRemove(true)}>
              Remove SSO
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">
            {config ? 'Update OIDC Provider' : 'Configure OIDC Provider'}
          </h2>
          <div className="space-y-4">
            <Input
              label="Issuer URL"
              placeholder="https://accounts.google.com"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
            />
            <Input
              label="Client ID"
              placeholder="your-client-id.apps.googleusercontent.com"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <Input
              label="Client Secret"
              placeholder="your-client-secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <Input
              label="Redirect URI"
              placeholder="https://your-app.com/sso/callback"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
            />
            <div className="flex justify-end gap-3 pt-2">
              {config && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!issuerUrl || !clientId || !clientSecret || !redirectUri || saving}
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-2">About SSO</h2>
        <p className="text-xs text-gx-muted leading-relaxed">
          Single Sign-On allows members of your organization to log in using your existing identity
          provider (Google Workspace, Okta, Azure AD, etc.) via OpenID Connect. SSO is available
          on the Enterprise plan.
        </p>
      </Card>

      <ConfirmDialog
        open={showRemove}
        onClose={() => setShowRemove(false)}
        onConfirm={handleRemove}
        title="Remove SSO Configuration"
        message="This will remove your SSO configuration. Team members will need to use API key authentication instead."
        confirmLabel="Remove"
        loading={removing}
      />
    </div>
  );
}
