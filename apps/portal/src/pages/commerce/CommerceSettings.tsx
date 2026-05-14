import { useState } from 'react';
import {
  disableMerchantAgenticCommerce,
  enableMerchantAgenticCommerce,
  getCommerceMerchant,
  getCommerceOpsHealth,
  listCommerceProviderCredentials,
  validateCommerceProviderCredential,
  type CommerceMerchant,
  type CommerceOpsHealth,
  type CommerceProviderCredential,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import {
  BlockerBanner,
  DateText,
  IdText,
  PageHeader,
  statusVariant,
} from './CommerceShared';

export function CommerceSettings() {
  const [merchantId, setMerchantId] = useState('');
  const [merchant, setMerchant] = useState<CommerceMerchant | null>(null);
  const [credentials, setCredentials] = useState<CommerceProviderCredential[]>([]);
  const [health, setHealth] = useState<CommerceOpsHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [reenableReason, setReenableReason] = useState('');
  const [reviewedPolicyId, setReviewedPolicyId] = useState('');
  const [incidentReference, setIncidentReference] = useState('');
  const [confirmReenable, setConfirmReenable] = useState(false);
  const [reenabling, setReenabling] = useState(false);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const { show } = useToast();
  const mockProviderHealth = health?.checks.provider_adapters.mock;
  const pluralProviderHealth = health?.checks.provider_adapters.plural;

  async function load() {
    if (!merchantId.trim()) {
      show('Enter a merchant ID before loading commerce settings', 'error');
      return;
    }
    setLoading(true);
    try {
      const [merchantRes, credentialRes, healthRes] = await Promise.all([
        getCommerceMerchant(merchantId.trim()),
        listCommerceProviderCredentials({ merchantId: merchantId.trim() }),
        getCommerceOpsHealth({ merchantId: merchantId.trim(), environment: 'sandbox' }),
      ]);
      setMerchant(merchantRes.data);
      setCredentials(credentialRes.items);
      setHealth(healthRes);
    } catch {
      show('Failed to load commerce settings', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function disableAgenticCommerce() {
    if (!merchant) return;
    setDisabling(true);
    try {
      await disableMerchantAgenticCommerce(merchant.id, 'dashboard_emergency_disable');
      setMerchant({ ...merchant, agentic_commerce_enabled: false });
      setConfirmReenable(false);
      show('Agentic commerce disabled', 'success');
    } catch {
      show('Failed to disable agentic commerce', 'error');
    } finally {
      setDisabling(false);
      setDisableOpen(false);
    }
  }

  async function reenableAgenticCommerce() {
    if (!merchant) return;
    if (!reenableReason.trim() || !reviewedPolicyId.trim() || !confirmReenable) {
      show('Reason, reviewed policy, and confirmation are required', 'error');
      return;
    }
    setReenabling(true);
    try {
      await enableMerchantAgenticCommerce(merchant.id, {
        reason: reenableReason.trim(),
        reviewedPolicyId: reviewedPolicyId.trim(),
        incidentReference: incidentReference.trim() || undefined,
        confirmReenable,
      });
      setMerchant({ ...merchant, agentic_commerce_enabled: true });
      setReenableReason('');
      setReviewedPolicyId('');
      setIncidentReference('');
      setConfirmReenable(false);
      show('Agentic commerce re-enabled', 'success');
    } catch {
      show('Failed to re-enable agentic commerce', 'error');
    } finally {
      setReenabling(false);
    }
  }

  async function validateCredential(credential: CommerceProviderCredential) {
    setValidatingId(credential.id);
    try {
      const res = await validateCommerceProviderCredential(credential.id);
      setCredentials((prev) => prev.map((c) => (c.id === credential.id ? res.data : c)));
      show('Provider credential validation completed', 'success');
    } catch {
      show('Provider credential validation failed', 'error');
    } finally {
      setValidatingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Commerce Settings"
        description="Merchant-level operational controls and safe provider credential status. Secret values are never displayed."
        action={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Input
            id="commerce-settings-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
          />
          <Button onClick={load} disabled={loading || !merchantId.trim()}>
            {loading ? 'Loading' : 'Load settings'}
          </Button>
        </div>
      </Card>

      {!merchant ? (
        <Card>
          <EmptyState
            title="Select a merchant"
            description="Enter a merchant ID to load API-backed commerce settings and operational readiness."
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Card>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">{merchant.display_name}</h2>
                <div className="mt-1 text-xs text-gx-muted">{merchant.legal_name}</div>
              </div>
              <Badge variant={merchant.agentic_commerce_enabled ? 'success' : 'danger'}>
                {merchant.agentic_commerce_enabled ? 'agentic enabled' : 'agentic disabled'}
              </Badge>
            </div>
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs text-gx-muted">Merchant</dt>
                <dd><IdText value={merchant.id} /></dd>
              </div>
              <div>
                <dt className="text-xs text-gx-muted">Environment</dt>
                <dd className="text-gx-text">{merchant.environment}</dd>
              </div>
              <div>
                <dt className="text-xs text-gx-muted">Verification</dt>
                <dd><Badge variant={merchant.verification_status === 'verified' ? 'success' : 'warning'}>{merchant.verification_status}</Badge></dd>
              </div>
              <div>
                <dt className="text-xs text-gx-muted">Currency</dt>
                <dd className="text-gx-text">{merchant.default_currency}</dd>
              </div>
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                variant="danger"
                disabled={!merchant.agentic_commerce_enabled}
                onClick={() => setDisableOpen(true)}
              >
                Emergency disable
              </Button>
            </div>
            {!merchant.agentic_commerce_enabled ? (
              <div className="mt-5 space-y-3 rounded-md border border-gx-border p-3">
                <div>
                  <h3 className="text-sm font-semibold text-gx-text">Emergency re-enable</h3>
                  <p className="mt-1 text-xs text-gx-muted">
                    Operator-only recovery requires a reason, reviewed active policy, and explicit confirmation. Live payments and Plural remain disabled.
                  </p>
                </div>
                <Input
                  id="reenable-reason"
                  label="Reason"
                  placeholder="incident review summary"
                  value={reenableReason}
                  onChange={(e) => setReenableReason(e.target.value)}
                />
                <Input
                  id="reviewed-policy"
                  label="Reviewed policy ID"
                  placeholder="cpol_..."
                  value={reviewedPolicyId}
                  onChange={(e) => setReviewedPolicyId(e.target.value)}
                />
                <Input
                  id="incident-reference"
                  label="Incident reference"
                  placeholder="optional"
                  value={incidentReference}
                  onChange={(e) => setIncidentReference(e.target.value)}
                />
                <label className="flex items-start gap-2 text-sm text-gx-text">
                  <input
                    type="checkbox"
                    checked={confirmReenable}
                    onChange={(e) => setConfirmReenable(e.target.checked)}
                  />
                  <span>I confirm the active policy was reviewed and no live payment or Plural setting will be enabled.</span>
                </label>
                <Button
                  variant="secondary"
                  disabled={reenabling || !reenableReason.trim() || !reviewedPolicyId.trim() || !confirmReenable}
                  onClick={() => void reenableAgenticCommerce()}
                >
                  {reenabling ? 'Re-enabling' : 'Re-enable agentic commerce'}
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-gx-muted">
                Re-enable controls appear only after emergency disable and require reviewed policy evidence.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold text-gx-text">Operational readiness</h2>
            {health ? (
              <div className="space-y-3">
                <Badge variant={statusVariant(health.status)}>{health.status}</Badge>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <div>
                    <div className="text-xs text-gx-muted">Mock provider</div>
                    <Badge variant={Boolean(mockProviderHealth?.ok) ? 'success' : 'danger'}>
                      {String(mockProviderHealth?.status ?? 'unknown')}
                    </Badge>
                  </div>
                  <div>
                    <div className="text-xs text-gx-muted">Plural provider</div>
                    <Badge variant="danger">{String(pluralProviderHealth?.status ?? 'blocked')}</Badge>
                  </div>
                  <div>
                    <div className="text-xs text-gx-muted">Webhook backlog</div>
                    <div className="text-gx-text">{health.checks.webhook_backlog.backlog_count ?? 'unknown'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gx-muted">Recent webhook failures</div>
                    <div className="text-gx-text">{health.checks.webhook_backlog.recent_failure_count ?? 'unknown'}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-gx-muted">Blockers</div>
                  <div className="flex flex-wrap gap-2">
                    {health.blockers.map((blocker) => <Badge key={blocker} variant="warning">{blocker}</Badge>)}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gx-muted">Load a merchant to inspect operational readiness.</p>
            )}
          </Card>

          <Card className="xl:col-span-2 p-0">
            {credentials.length === 0 ? (
              <EmptyState
                title="No provider credentials"
                description="Provider credential metadata will appear here after credentials are configured through the API."
              />
            ) : (
              <div className="p-4">
                <Table
                  data={credentials}
                  rowKey={(credential) => credential.id}
                  columns={[
                    { key: 'id', header: 'Credential', render: (credential) => <IdText value={credential.id} /> },
                    {
                      key: 'provider',
                      header: 'Provider',
                      render: (credential) => (
                        <div className="space-y-1">
                          <Badge variant={credential.provider_key === 'plural' ? 'danger' : 'default'}>{credential.provider_key}</Badge>
                          <div className="text-xs text-gx-muted">{credential.environment}</div>
                        </div>
                      ),
                    },
                    { key: 'status', header: 'Status', render: (credential) => <Badge variant={statusVariant(credential.status)}>{credential.status}</Badge> },
                    { key: 'ref', header: 'Reference', render: (credential) => <IdText value={credential.credential_ref} /> },
                    { key: 'validated', header: 'Validated', render: (credential) => <DateText value={credential.last_validated_at} /> },
                    {
                      key: 'actions',
                      header: '',
                      className: 'text-right',
                      render: (credential) => (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={validatingId === credential.id || credential.status === 'disabled'}
                          onClick={(e) => {
                            e.stopPropagation();
                            void validateCredential(credential);
                          }}
                        >
                          {validatingId === credential.id ? 'Validating' : 'Validate'}
                        </Button>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={disableAgenticCommerce}
        title="Emergency Disable"
        message={`Disable agentic commerce for ${merchant?.display_name ?? 'this merchant'}? Protected checkout and payment actions will be blocked immediately.`}
        confirmLabel="Disable"
        loading={disabling}
      />
    </div>
  );
}
