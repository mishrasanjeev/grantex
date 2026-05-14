import { useMemo, useState } from 'react';
import {
  evaluateCommercePolicy,
  getCommerceMerchant,
  getCommerceWellKnownProfile,
  listCommerceAgents,
  listCommercePolicies,
  listCommerceProducts,
  listCommerceProviderCredentials,
  listCommerceWebhookSources,
  updateCommerceMerchant,
  type CommerceAgent,
  type CommerceMerchant,
  type CommercePolicyDecision,
  type CommerceWellKnownProfile,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { BlockerBanner, DateText, IdText, PageHeader, statusVariant } from './CommerceShared';

type MerchantPatchForm = Pick<CommerceMerchant,
  'display_name' | 'legal_name' | 'category_preset' | 'default_currency' | 'country_code' | 'support_email' | 'agentic_commerce_enabled'>;

const defaultPatch: MerchantPatchForm = {
  display_name: '',
  legal_name: '',
  category_preset: 'electronics_appliances',
  default_currency: 'INR',
  country_code: 'IN',
  support_email: '',
  agentic_commerce_enabled: false,
};

const actionScopes = [
  'commerce:catalog.read',
  'commerce:inventory.read',
  'commerce:checkout.create',
  'commerce:payment.initiate',
  'commerce:payment.status.read',
];

export function CommerceOnboarding() {
  const [merchantId, setMerchantId] = useState('');
  const [merchant, setMerchant] = useState<CommerceMerchant | null>(null);
  const [merchantForm, setMerchantForm] = useState<MerchantPatchForm>(defaultPatch);
  const [agents, setAgents] = useState<CommerceAgent[]>([]);
  const [activePolicyCount, setActivePolicyCount] = useState(0);
  const [productCount, setProductCount] = useState(0);
  const [mockCredentialCount, setMockCredentialCount] = useState(0);
  const [webhookSourceCount, setWebhookSourceCount] = useState(0);
  const [profile, setProfile] = useState<CommerceWellKnownProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policyDecision, setPolicyDecision] = useState<CommercePolicyDecision | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [policyForm, setPolicyForm] = useState({
    agent_id: '',
    action_scope: 'commerce:payment.initiate',
    amount_minor_units: '1000',
    currency: 'INR',
    passport_type: 'checkout',
    passport_jti: 'cpsp_preview',
  });
  const { show } = useToast();

  async function load() {
    const id = merchantId.trim();
    if (!id) {
      show('Enter a merchant ID before loading onboarding controls', 'error');
      return;
    }
    setLoading(true);
    try {
      const [merchantRes, agentRes, policyRes, productRes, credentialRes, sourceRes, profileRes] = await Promise.all([
        getCommerceMerchant(id),
        listCommerceAgents({ merchantId: id, limit: 25 }),
        listCommercePolicies({ merchantId: id, status: 'active', limit: 10 }),
        listCommerceProducts({ merchantId: id, status: 'active', limit: 10 }),
        listCommerceProviderCredentials({ merchantId: id, providerKey: 'mock', environment: 'sandbox' }),
        listCommerceWebhookSources({ merchantId: id }),
        getCommerceWellKnownProfile(id),
      ]);
      setMerchant(merchantRes.data);
      setMerchantForm({
        display_name: merchantRes.data.display_name,
        legal_name: merchantRes.data.legal_name,
        category_preset: merchantRes.data.category_preset,
        default_currency: merchantRes.data.default_currency,
        country_code: merchantRes.data.country_code,
        support_email: merchantRes.data.support_email ?? '',
        agentic_commerce_enabled: merchantRes.data.agentic_commerce_enabled,
      });
      setAgents(agentRes.items);
      setActivePolicyCount(policyRes.items.length);
      setProductCount(productRes.items.length);
      setMockCredentialCount(credentialRes.items.length);
      setWebhookSourceCount(sourceRes.items.length);
      setProfile(profileRes);
      setPolicyForm((prev) => ({ ...prev, agent_id: agentRes.items[0]?.id ?? prev.agent_id }));
    } catch {
      show('Failed to load commerce onboarding controls', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function saveMerchant() {
    if (!merchant) return;
    setSaving(true);
    try {
      const res = await updateCommerceMerchant(merchant.id, {
        ...merchantForm,
        support_email: merchantForm.support_email || null,
      });
      setMerchant(res.data);
      show('Merchant profile updated', 'success');
    } catch {
      show('Failed to update merchant profile', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function simulatePolicy() {
    if (!merchant) return;
    setSimulating(true);
    setPolicyDecision(null);
    try {
      const res = await evaluateCommercePolicy({
        merchantId: merchant.id,
        agentId: policyForm.agent_id,
        actionScope: policyForm.action_scope,
        amountMinorUnits: Number.parseInt(policyForm.amount_minor_units, 10),
        currency: policyForm.currency,
        environment: 'sandbox',
        passportJwt: `portal-simulator:${policyForm.passport_type}:${policyForm.passport_jti || 'redacted'}`,
        resourceType: 'commerce_portal_policy_simulator',
        resourceId: policyForm.passport_jti,
      });
      setPolicyDecision(res.data);
    } catch {
      show('Policy simulator request failed', 'error');
    } finally {
      setSimulating(false);
    }
  }

  const checklist = useMemo(() => ([
    { label: 'Merchant profile', done: Boolean(merchant) },
    { label: 'Trusted agent', done: agents.some((agent) => agent.trust_status === 'trusted' && agent.status === 'active') },
    { label: 'Active policy', done: activePolicyCount > 0 },
    { label: 'Catalog products', done: productCount > 0 },
    { label: 'Mock provider credential metadata', done: mockCredentialCount > 0 },
    { label: 'Webhook source', done: webhookSourceCount > 0 },
    { label: 'Playground/MCP profile', done: Boolean(profile?.supported_tools?.length) },
  ]), [activePolicyCount, agents, merchant, mockCredentialCount, productCount, profile, webhookSourceCount]);

  return (
    <div>
      <PageHeader
        title="Commerce Onboarding"
        description="Merchant control-plane entry point for profile, readiness checklist, trusted agents, policy simulation, and public discovery status."
        action={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Input
            id="commerce-onboarding-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
          />
          <Button onClick={load} disabled={loading || !merchantId.trim()}>{loading ? 'Loading' : 'Load onboarding'}</Button>
        </div>
      </Card>

      {!merchant ? (
        <Card>
          <EmptyState
            title="Select a merchant"
            description="Load a merchant to inspect profile, checklist, agent, policy, and discovery status."
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">{merchant.display_name}</h2>
                <div className="mt-1 text-xs text-gx-muted">{merchant.legal_name}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={merchant.environment === 'sandbox' ? 'warning' : 'danger'}>{merchant.environment}</Badge>
                <Badge variant={merchant.agentic_commerce_enabled ? 'success' : 'danger'}>
                  {merchant.agentic_commerce_enabled ? 'agentic enabled' : 'agentic disabled'}
                </Badge>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input
                id="onboarding-display-name"
                label="Display name"
                value={merchantForm.display_name}
                onChange={(e) => setMerchantForm({ ...merchantForm, display_name: e.target.value })}
              />
              <Input
                id="onboarding-legal-name"
                label="Legal name"
                value={merchantForm.legal_name}
                onChange={(e) => setMerchantForm({ ...merchantForm, legal_name: e.target.value })}
              />
              <Input
                id="onboarding-category"
                label="Category preset"
                value={merchantForm.category_preset}
                onChange={(e) => setMerchantForm({ ...merchantForm, category_preset: e.target.value })}
              />
              <Input
                id="onboarding-currency"
                label="Default currency"
                value={merchantForm.default_currency}
                onChange={(e) => setMerchantForm({ ...merchantForm, default_currency: e.target.value.toUpperCase() })}
              />
              <Input
                id="onboarding-country"
                label="Country code"
                value={merchantForm.country_code}
                onChange={(e) => setMerchantForm({ ...merchantForm, country_code: e.target.value.toUpperCase() })}
              />
              <Input
                id="onboarding-support-email"
                label="Support email"
                value={merchantForm.support_email ?? ''}
                onChange={(e) => setMerchantForm({ ...merchantForm, support_email: e.target.value })}
              />
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-gx-text">
              <input
                type="checkbox"
                checked={merchantForm.agentic_commerce_enabled}
                onChange={(e) => setMerchantForm({ ...merchantForm, agentic_commerce_enabled: e.target.checked })}
              />
              Agentic commerce enabled
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={saveMerchant} disabled={saving}>{saving ? 'Saving' : 'Save merchant'}</Button>
              <Button variant="secondary" disabled title="Publish/unpublish requires a reviewed backend API.">
                Publish unavailable
              </Button>
            </div>
            <p className="mt-3 text-xs text-gx-muted">
              Publish/unpublish controls require a reviewed backend API and remain blocked.
            </p>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold text-gx-text">Readiness checklist</h2>
            <div className="grid gap-2 md:grid-cols-2">
              {checklist.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border border-gx-border p-3">
                  <span className="text-sm text-gx-text">{item.label}</span>
                  <Badge variant={item.done ? 'success' : 'warning'}>{item.done ? 'ready' : 'missing'}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <div className="text-xs text-gx-muted">Merchant</div>
                <IdText value={merchant.id} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Well-known environment</div>
                <div className="text-gx-text">{profile?.environment ?? 'not loaded'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Updated</div>
                <DateText value={merchant.updated_at} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Discovery tools</div>
                <div className="truncate text-xs text-gx-muted">{profile?.supported_tools?.join(', ') || 'none'}</div>
              </div>
            </div>
          </Card>

          <Card className="xl:col-span-2 p-0">
            {agents.length === 0 ? (
              <EmptyState title="No CommerceAgents" description="Trusted CommerceAgent status will appear here after agents are registered." />
            ) : (
              <div className="p-4">
                <div className="mb-3 text-sm font-semibold text-gx-text">CommerceAgents</div>
                <Table
                  data={agents}
                  rowKey={(agent) => agent.id}
                  columns={[
                    { key: 'agent', header: 'Agent', render: (agent) => <IdText value={agent.id} /> },
                    { key: 'name', header: 'Name', render: (agent) => <span className="text-gx-text">{agent.display_name}</span> },
                    { key: 'trust', header: 'Trust', render: (agent) => <Badge variant={statusVariant(agent.trust_status)}>{agent.trust_status}</Badge> },
                    { key: 'status', header: 'Status', render: (agent) => <Badge variant={statusVariant(agent.status)}>{agent.status}</Badge> },
                  ]}
                />
              </div>
            )}
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-3">
              <h2 className="text-base font-semibold text-gx-text">Policy simulator</h2>
              <p className="mt-1 text-xs text-gx-muted">
                The portal does not collect or display raw passport JWTs. Allow-path proof remains in the staging E2E harness.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Input
                id="policy-agent-id"
                label="Agent ID"
                value={policyForm.agent_id}
                onChange={(e) => setPolicyForm({ ...policyForm, agent_id: e.target.value })}
              />
              <div>
                <label htmlFor="policy-action" className="mb-1.5 block text-sm font-medium text-gx-text">Action</label>
                <select
                  id="policy-action"
                  value={policyForm.action_scope}
                  onChange={(e) => setPolicyForm({ ...policyForm, action_scope: e.target.value })}
                  className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
                >
                  {actionScopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
                </select>
              </div>
              <Input
                id="policy-amount"
                label="Amount minor units"
                value={policyForm.amount_minor_units}
                onChange={(e) => setPolicyForm({ ...policyForm, amount_minor_units: e.target.value })}
              />
              <Input
                id="policy-currency"
                label="Currency"
                value={policyForm.currency}
                onChange={(e) => setPolicyForm({ ...policyForm, currency: e.target.value.toUpperCase() })}
              />
              <Input
                id="policy-passport-type"
                label="Passport type"
                value={policyForm.passport_type}
                onChange={(e) => setPolicyForm({ ...policyForm, passport_type: e.target.value })}
              />
              <Input
                id="policy-passport-jti"
                label="Passport JTI"
                value={policyForm.passport_jti}
                onChange={(e) => setPolicyForm({ ...policyForm, passport_jti: e.target.value })}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={simulatePolicy} disabled={simulating || !policyForm.agent_id}>
                {simulating ? 'Evaluating' : 'Evaluate policy'}
              </Button>
              {policyDecision && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={policyDecision.decision === 'allow' ? 'success' : 'warning'}>{policyDecision.decision}</Badge>
                  <span className="text-gx-muted">{policyDecision.reason}</span>
                  <IdText value={policyDecision.policy_version} />
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-gx-muted">
              Emergency disable status is visible above. Re-enable remains intentionally unavailable in the portal.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
