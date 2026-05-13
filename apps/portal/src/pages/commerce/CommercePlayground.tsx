import { useState } from 'react';
import { getCommerceWellKnownProfile, type CommerceWellKnownProfile } from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { BlockerBanner, ErrorPanel, PageHeader } from './CommerceShared';

export function CommercePlayground() {
  const [merchantId, setMerchantId] = useState('');
  const [profile, setProfile] = useState<CommerceWellKnownProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { show } = useToast();

  async function loadProfile() {
    setLoading(true);
    setError(null);
    try {
      setProfile(await getCommerceWellKnownProfile(merchantId || undefined));
    } catch {
      setError('Failed to load well-known commerce profile.');
      show('Failed to load commerce profile', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Commerce Playground"
        description="Operator entry point for the static Commerce MCP playground and public publishing profile checks."
        action={<Button variant="secondary" size="sm" onClick={loadProfile} disabled={loading}>{loading ? 'Loading' : 'Load profile'}</Button>}
      />
      <BlockerBanner />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <h2 className="mb-3 text-base font-semibold text-gx-text">Well-known profile</h2>
          <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Input
              id="commerce-playground-merchant"
              label="Merchant selector"
              placeholder="mch_..."
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            />
            <Button onClick={loadProfile} disabled={loading}>{loading ? 'Loading' : 'Fetch'}</Button>
          </div>
          {error && <ErrorPanel message={error} />}
          {profile && (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-gx-muted">Merchant</div>
                <div className="text-gx-text">{profile.merchant.display_name}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Environment</div>
                <div className="text-gx-text">{profile.environment}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Tools</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {profile.supported_tools.map((tool) => (
                    <span key={tool} className="rounded border border-gx-border px-2 py-1 font-mono text-xs text-gx-muted">
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-gx-text">Static playground</h2>
          <p className="mb-4 text-sm text-gx-muted">
            Open the existing static MCP playground. It keeps bearer tokens, Commerce Passports,
            provider credentials, and idempotency keys out of browser storage.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href="/commerce-playground.html"
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded-md bg-gx-accent px-4 py-2 text-sm font-semibold text-gx-bg hover:opacity-90"
            >
              Open static playground
            </a>
            <a
              href="/.well-known/grantex-commerce"
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded-md border border-gx-border px-4 py-2 text-sm font-semibold text-gx-text hover:border-gx-muted"
            >
              Open well-known profile
            </a>
          </div>
          <div className="mt-4 rounded-md border border-gx-border bg-gx-bg p-3 text-xs text-gx-muted">
            Full MCP session streaming and failed webhook replay views remain M7 operational blockers.
          </div>
        </Card>
      </div>
    </div>
  );
}
