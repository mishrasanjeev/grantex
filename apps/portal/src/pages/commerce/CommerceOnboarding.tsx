import { useMemo, useState } from 'react';
import {
  createCommerceMerchantReadOnlyDiscoveryRolloutProposal,
  dryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal,
  evaluateCommercePolicy,
  getCommerceMerchantAgenticOrgBuyerDiscoveryPreview,
  getCommerceMerchantReadOnlyDiscoveryReview,
  getCommerceMerchantReadOnlyDiscoveryRolloutProposal,
  getCommerceMerchantSandboxOnboarding,
  getCommerceMerchantSchemaOrgJsonLdPreview,
  getCommerceWellKnownProfile,
  listCommerceAgents,
  listCommercePolicies,
  listCommerceProducts,
  listCommerceProviderCredentials,
  listCommerceWebhookSources,
  recordCommerceReadOnlyDiscoveryReviewDecision,
  requestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff,
  requestCommerceMerchantReadOnlyDiscoveryReview,
  updateCommerceMerchantSandboxOnboarding,
  withdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff,
  withdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal,
  type CommerceAgent,
  type CommerceAgenticOrgBuyerDiscoveryPreview,
  type CommerceReadOnlyDiscoveryOperatorDecision,
  type CommerceReadOnlyDiscoveryOperatorReview,
  type CommerceReadOnlyDiscoveryRolloutProposal,
  type CommerceSchemaOrgJsonLdPreview,
  type CommerceSandboxOnboarding,
  type CommercePolicyDecision,
  type CommerceWellKnownProfile,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { BlockerBanner, DateText, IdText, PageHeader, statusVariant } from './CommerceShared';

interface MerchantPatchForm {
  display_name: string;
  category_preset: string;
  default_currency: string;
  country_code: string;
  support_email: string;
  support_url: string;
  public_discovery_description_draft: string;
  agentic_commerce_requested: boolean;
}

const defaultPatch: MerchantPatchForm = {
  display_name: '',
  category_preset: 'electronics_appliances',
  default_currency: 'INR',
  country_code: 'IN',
  support_email: '',
  support_url: '',
  public_discovery_description_draft: '',
  agentic_commerce_requested: false,
};

const actionScopes = [
  'commerce:catalog.read',
  'commerce:inventory.read',
  'commerce:checkout.create',
  'commerce:payment.initiate',
  'commerce:payment.status.read',
];

function readinessVariant(status: string): 'default' | 'success' | 'warning' | 'danger' {
  if (status === 'pass') return 'success';
  if (status === 'fail' || status === 'not_applicable' || status === 'recommended') return 'warning';
  if (status === 'blocked') return 'danger';
  return 'default';
}

function severityVariant(severity: string): 'default' | 'success' | 'warning' | 'danger' {
  if (severity === 'blocked') return 'danger';
  if (severity === 'required') return 'warning';
  return 'default';
}

function countLabel(count?: number, total?: number): string | null {
  if (count === undefined && total === undefined) return null;
  if (count !== undefined && total !== undefined) return `${count}/${total}`;
  if (count !== undefined) return String(count);
  return `0/${total}`;
}

function capabilityLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

export function CommerceOnboarding() {
  const [merchantId, setMerchantId] = useState('');
  const [merchant, setMerchant] = useState<CommerceSandboxOnboarding | null>(null);
  const [operatorReview, setOperatorReview] = useState<CommerceReadOnlyDiscoveryOperatorReview | null>(null);
  const [rolloutProposal, setRolloutProposal] = useState<CommerceReadOnlyDiscoveryRolloutProposal | null>(null);
  const [agenticOrgPreview, setAgenticOrgPreview] = useState<CommerceAgenticOrgBuyerDiscoveryPreview | null>(null);
  const [schemaOrgPreview, setSchemaOrgPreview] = useState<CommerceSchemaOrgJsonLdPreview | null>(null);
  const [merchantForm, setMerchantForm] = useState<MerchantPatchForm>(defaultPatch);
  const [agents, setAgents] = useState<CommerceAgent[]>([]);
  const [activePolicyCount, setActivePolicyCount] = useState(0);
  const [productCount, setProductCount] = useState(0);
  const [mockCredentialCount, setMockCredentialCount] = useState(0);
  const [webhookSourceCount, setWebhookSourceCount] = useState(0);
  const [profile, setProfile] = useState<CommerceWellKnownProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [proposalSubmitting, setProposalSubmitting] = useState(false);
  const [proposalNote, setProposalNote] = useState('');
  const [agenticOrgSubmitting, setAgenticOrgSubmitting] = useState(false);
  const [agenticOrgNote, setAgenticOrgNote] = useState('');
  const [decisionForm, setDecisionForm] = useState<{
    decision: CommerceReadOnlyDiscoveryOperatorDecision;
    reason: string;
    remediation_items: string;
  }>({
    decision: 'changes_requested',
    reason: '',
    remediation_items: '',
  });
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
      const [merchantRes, reviewRes, proposalRes, agenticOrgRes, schemaOrgRes, agentRes, policyRes, productRes, credentialRes, sourceRes, profileRes] = await Promise.all([
        getCommerceMerchantSandboxOnboarding(id),
        getCommerceMerchantReadOnlyDiscoveryReview(id).catch(() => null),
        getCommerceMerchantReadOnlyDiscoveryRolloutProposal(id).catch(() => null),
        getCommerceMerchantAgenticOrgBuyerDiscoveryPreview(id).catch(() => null),
        getCommerceMerchantSchemaOrgJsonLdPreview(id).catch(() => null),
        listCommerceAgents({ merchantId: id, limit: 25 }),
        listCommercePolicies({ merchantId: id, status: 'active', limit: 10 }),
        listCommerceProducts({ merchantId: id, status: 'active', limit: 10 }),
        listCommerceProviderCredentials({ merchantId: id, providerKey: 'mock', environment: 'sandbox' }),
        listCommerceWebhookSources({ merchantId: id }),
        getCommerceWellKnownProfile(id),
      ]);
      setMerchant(merchantRes.data);
      setOperatorReview(reviewRes?.data ?? null);
      setRolloutProposal(proposalRes?.data ?? null);
      setAgenticOrgPreview(agenticOrgRes?.data ?? null);
      setSchemaOrgPreview(schemaOrgRes?.data ?? null);
      setProposalNote(proposalRes?.data.proposal_note ?? '');
      setAgenticOrgNote('');
      setMerchantForm({
        display_name: merchantRes.data.display_name ?? '',
        category_preset: merchantRes.data.category_preset ?? 'electronics_appliances',
        default_currency: merchantRes.data.default_currency ?? 'INR',
        country_code: merchantRes.data.country_code ?? 'IN',
        support_email: merchantRes.data.support_email ?? '',
        support_url: merchantRes.data.support_url ?? '',
        public_discovery_description_draft: merchantRes.data.public_discovery_description_draft ?? '',
        agentic_commerce_requested: merchantRes.data.agentic_commerce_requested,
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
      const res = await updateCommerceMerchantSandboxOnboarding(merchant.merchant_id, {
        ...merchantForm,
        support_email: merchantForm.support_email || null,
        support_url: merchantForm.support_url || null,
        public_discovery_description_draft: merchantForm.public_discovery_description_draft || null,
      });
      setMerchant(res.data);
      show('Sandbox onboarding profile updated', 'success');
    } catch {
      show('Failed to update merchant profile', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function requestReadOnlyDiscoveryReview() {
    if (!merchant) return;
    setSubmitting(true);
    try {
      const res = await requestCommerceMerchantReadOnlyDiscoveryReview(merchant.merchant_id);
      setMerchant(res.data);
      const reviewRes = await getCommerceMerchantReadOnlyDiscoveryReview(merchant.merchant_id).catch(() => null);
      setOperatorReview(reviewRes?.data ?? null);
      show('Read-only discovery review requested', 'success');
    } catch {
      show('Read-only discovery review request is blocked', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function recordOperatorDecision() {
    if (!merchant || !operatorReview) return;
    setDecisionSubmitting(true);
    try {
      const remediationItems = decisionForm.remediation_items
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
      const res = await recordCommerceReadOnlyDiscoveryReviewDecision(merchant.merchant_id, {
        decision: decisionForm.decision,
        reason: decisionForm.reason,
        remediationItems,
      });
      setOperatorReview(res.data);
      const proposalRes = await getCommerceMerchantReadOnlyDiscoveryRolloutProposal(merchant.merchant_id).catch(() => null);
      setRolloutProposal(proposalRes?.data ?? null);
      setProposalNote(proposalRes?.data.proposal_note ?? '');
      setMerchant((prev) => prev
        ? {
          ...prev,
          sandbox_onboarding_state: res.data.sandbox_onboarding_state,
          sandbox_onboarding_blocker: res.data.decision_reason,
          read_only_discovery_review: {
            ...prev.read_only_discovery_review,
            status: res.data.review_request_status === 'changes_requested'
              ? 'blocked'
              : res.data.review_request_status === 'rollout_proposal_ready'
                ? 'requested'
                : res.data.review_request_status === 'rejected'
                  ? 'rejected'
                  : prev.read_only_discovery_review.status,
            blockers: res.data.blockers,
            remediation: res.data.remediation_items,
          },
        }
        : prev);
      show('Operator review decision recorded', 'success');
    } catch {
      show('Operator review decision is blocked', 'error');
    } finally {
      setDecisionSubmitting(false);
    }
  }

  async function createRolloutProposal() {
    if (!merchant) return;
    setProposalSubmitting(true);
    try {
      const res = await createCommerceMerchantReadOnlyDiscoveryRolloutProposal(merchant.merchant_id, {
        proposalNote: proposalNote.trim() || undefined,
      });
      setRolloutProposal(res.data);
      setProposalNote(res.data.proposal_note ?? '');
      const agenticOrgRes = await getCommerceMerchantAgenticOrgBuyerDiscoveryPreview(merchant.merchant_id).catch(() => null);
      setAgenticOrgPreview(agenticOrgRes?.data ?? null);
      show('Rollout proposal evidence saved', 'success');
    } catch {
      show('Rollout proposal is blocked', 'error');
    } finally {
      setProposalSubmitting(false);
    }
  }

  async function runRolloutProposalDryRun() {
    if (!merchant) return;
    setProposalSubmitting(true);
    try {
      const res = await dryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal(merchant.merchant_id, {
        proposalNote: proposalNote.trim() || undefined,
      });
      setRolloutProposal(res.data);
      setProposalNote(res.data.proposal_note ?? '');
      const agenticOrgRes = await getCommerceMerchantAgenticOrgBuyerDiscoveryPreview(merchant.merchant_id).catch(() => null);
      setAgenticOrgPreview(agenticOrgRes?.data ?? null);
      show(res.data.dry_run_result === 'passed' ? 'Rollout proposal dry run passed' : 'Rollout proposal dry run blocked', 'success');
    } catch {
      show('Rollout proposal dry run is blocked', 'error');
    } finally {
      setProposalSubmitting(false);
    }
  }

  async function withdrawRolloutProposal() {
    if (!merchant) return;
    setProposalSubmitting(true);
    try {
      const res = await withdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal(merchant.merchant_id, {
        reason: proposalNote.trim() || undefined,
      });
      setRolloutProposal(res.data);
      setProposalNote(res.data.proposal_note ?? '');
      const agenticOrgRes = await getCommerceMerchantAgenticOrgBuyerDiscoveryPreview(merchant.merchant_id).catch(() => null);
      setAgenticOrgPreview(agenticOrgRes?.data ?? null);
      show('Rollout proposal withdrawn', 'success');
    } catch {
      show('Rollout proposal withdrawal is blocked', 'error');
    } finally {
      setProposalSubmitting(false);
    }
  }

  async function requestAgenticOrgHandoff() {
    if (!merchant) return;
    setAgenticOrgSubmitting(true);
    try {
      const res = await requestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff(merchant.merchant_id, {
        handoffNote: agenticOrgNote.trim() || undefined,
      });
      setAgenticOrgPreview(res.data);
      show('AgenticOrg sandbox handoff requested', 'success');
    } catch {
      show('AgenticOrg sandbox handoff is blocked', 'error');
    } finally {
      setAgenticOrgSubmitting(false);
    }
  }

  async function withdrawAgenticOrgHandoff() {
    if (!merchant) return;
    setAgenticOrgSubmitting(true);
    try {
      const res = await withdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff(merchant.merchant_id, {
        reason: agenticOrgNote.trim() || undefined,
      });
      setAgenticOrgPreview(res.data);
      show('AgenticOrg sandbox handoff withdrawn', 'success');
    } catch {
      show('AgenticOrg sandbox handoff withdrawal is blocked', 'error');
    } finally {
      setAgenticOrgSubmitting(false);
    }
  }

  async function simulatePolicy() {
    if (!merchant) return;
    setSimulating(true);
    setPolicyDecision(null);
    try {
      const res = await evaluateCommercePolicy({
        merchantId: merchant.merchant_id,
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

  const integrationChecklist = useMemo(() => ([
    { label: 'Trusted agent', done: agents.some((agent) => agent.trust_status === 'trusted' && agent.status === 'active') },
    { label: 'Active policy', done: activePolicyCount > 0 },
    { label: 'Catalog products', done: productCount > 0 },
    { label: 'Mock provider credential metadata', done: mockCredentialCount > 0 },
    { label: 'Webhook source', done: webhookSourceCount > 0 },
    { label: 'Playground/MCP profile', done: Boolean(profile?.supported_tools?.length) },
  ]), [activePolicyCount, agents, mockCredentialCount, productCount, profile, webhookSourceCount]);
  const agentPreviewJson = merchant ? JSON.stringify(merchant.agent_facing_preview, null, 2) : '';
  const readOnlyReview = merchant?.read_only_discovery_review ?? {
    status: 'blocked' as const,
    eligible: false,
    sandbox_only: true as const,
    request_is_approval: false as const,
    live_mode_status: 'not_live' as const,
    production_approval_status: 'not_approved' as const,
    rollout_status: 'rollout_not_requested' as const,
    public_discovery_enabled: false as const,
    checkout_payment_enabled: false as const,
    live_provider_enabled: false as const,
    live_plural_enabled: false as const,
    production_allowlist_written: false as const,
    requested_at: null,
    status_updated_at: null,
    blockers: [],
    remediation: [],
  };
  const reviewRequestDisabled = !readOnlyReview.eligible || readOnlyReview.status === 'requested' || submitting;
  const reviewRequestTitle = readOnlyReview.blockers.length
    ? readOnlyReview.blockers.map(capabilityLabel).join(', ')
    : readOnlyReview.status === 'requested'
      ? 'Read-only discovery review request is pending.'
      : 'Request read-only discovery review.';
  const operatorDecisionDisabled = !operatorReview
    || operatorReview.review_request_status !== 'requested'
    || decisionSubmitting
    || !decisionForm.reason.trim()
    || (decisionForm.decision === 'changes_requested' && !decisionForm.remediation_items.trim())
    || (decisionForm.decision === 'rollout_proposal_ready' && operatorReview.blockers.length > 0);
  const operatorDecisionTitle = operatorReview?.blockers.length
    ? operatorReview.blockers.map(capabilityLabel).join(', ')
    : operatorReview?.review_request_status === 'requested'
      ? 'Record a non-production operator review decision.'
      : 'A pending read-only discovery review request is required.';
  const proposalStatus = rolloutProposal?.proposal_status ?? 'not_created';
  const proposalBlocked = Boolean(rolloutProposal?.blockers.length);
  const proposalCreateDisabled = proposalSubmitting
    || operatorReview?.operator_decision !== 'rollout_proposal_ready'
    || proposalBlocked;
  const proposalDryRunDisabled = proposalSubmitting
    || !rolloutProposal
    || proposalStatus === 'not_created'
    || proposalStatus === 'withdrawn';
  const proposalWithdrawDisabled = proposalSubmitting
    || !rolloutProposal
    || proposalStatus === 'not_created'
    || proposalStatus === 'withdrawn';
  const agenticOrgStatus = agenticOrgPreview?.integration_status ?? 'not_ready';
  const agenticOrgHardBlockers = agenticOrgPreview?.blockers.filter((blocker) => blocker !== 'agenticorg_handoff_withdrawn') ?? [];
  const agenticOrgRequestDisabled = agenticOrgSubmitting
    || !agenticOrgPreview
    || !['sandbox_handoff_ready', 'sandbox_handoff_withdrawn'].includes(agenticOrgStatus)
    || agenticOrgHardBlockers.length > 0;
  const agenticOrgWithdrawDisabled = agenticOrgSubmitting
    || agenticOrgStatus !== 'sandbox_handoff_requested';
  const agenticOrgJson = agenticOrgPreview ? JSON.stringify(agenticOrgPreview, null, 2) : '';
  const schemaOrgJson = schemaOrgPreview ? JSON.stringify(schemaOrgPreview.jsonld, null, 2) : '';

  return (
    <div>
      <PageHeader
        title="Commerce Onboarding"
        description="Merchant control-plane entry point for sandbox profile, readiness checklist, trusted agents, policy simulation, and blocked discovery status."
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
                <div className="mt-1 text-xs text-gx-muted">{merchant.merchant_id}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={merchant.environment === 'sandbox' ? 'warning' : 'danger'}>{merchant.environment}</Badge>
                <Badge variant="danger">{merchant.readiness.live_mode_status}</Badge>
                <Badge variant="danger">{merchant.readiness.production_approval_status}</Badge>
                <Badge variant={statusVariant(merchant.sandbox_onboarding_state)}>{merchant.sandbox_onboarding_state}</Badge>
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
              <Input
                id="onboarding-support-url"
                label="Support URL"
                value={merchantForm.support_url ?? ''}
                onChange={(e) => setMerchantForm({ ...merchantForm, support_url: e.target.value })}
              />
            </div>
            <div className="mt-3">
              <label htmlFor="onboarding-description" className="mb-1.5 block text-sm font-medium text-gx-text">
                Discovery description draft
              </label>
              <textarea
                id="onboarding-description"
                value={merchantForm.public_discovery_description_draft ?? ''}
                onChange={(e) => setMerchantForm({ ...merchantForm, public_discovery_description_draft: e.target.value })}
                rows={4}
                className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
              />
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-gx-text">
              <input
                type="checkbox"
                checked={merchantForm.agentic_commerce_requested}
                onChange={(e) => setMerchantForm({ ...merchantForm, agentic_commerce_requested: e.target.checked })}
              />
              Agentic commerce requested
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={saveMerchant} disabled={saving}>{saving ? 'Saving' : 'Save sandbox profile'}</Button>
              <Button
                variant="secondary"
                onClick={requestReadOnlyDiscoveryReview}
                disabled={reviewRequestDisabled}
                title={reviewRequestTitle}
              >
                {submitting ? 'Requesting' : 'Request read-only review'}
              </Button>
              <Button variant="secondary" disabled title="Publish/unpublish requires a reviewed backend API.">
                Publish unavailable
              </Button>
            </div>
            <p className="mt-3 text-xs text-gx-muted">
              Publish/unpublish controls require a separate reviewed backend API and remain blocked.
            </p>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">Read-only discovery review</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Sandbox-only request status for human review; it is not approval, launch, public discovery, checkout, live provider, or live Plural.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={readOnlyReview.status === 'requested' ? 'warning' : readOnlyReview.eligible ? 'success' : 'danger'}>
                  {readOnlyReview.status}
                </Badge>
                <Badge variant="warning">sandbox_only</Badge>
                <Badge variant="danger">{readOnlyReview.live_mode_status}</Badge>
                <Badge variant="danger">{readOnlyReview.production_approval_status}</Badge>
                <Badge variant="danger">{readOnlyReview.rollout_status}</Badge>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {[
                { label: 'request_is_approval', value: readOnlyReview.request_is_approval },
                { label: 'public_discovery_enabled', value: readOnlyReview.public_discovery_enabled },
                { label: 'checkout_payment_enabled', value: readOnlyReview.checkout_payment_enabled },
                { label: 'live_provider_enabled', value: readOnlyReview.live_provider_enabled },
                { label: 'live_plural_enabled', value: readOnlyReview.live_plural_enabled },
                { label: 'production_allowlist_written', value: readOnlyReview.production_allowlist_written },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
              <div>
                <div className="text-xs text-gx-muted">Eligibility</div>
                <Badge variant={readOnlyReview.eligible ? 'success' : 'danger'}>
                  {readOnlyReview.eligible ? 'eligible' : 'blocked'}
                </Badge>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Requested</div>
                <DateText value={readOnlyReview.requested_at} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Status updated</div>
                <DateText value={readOnlyReview.status_updated_at} />
              </div>
            </div>
            {readOnlyReview.blockers.length > 0 ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">Review blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {readOnlyReview.blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
                <div className="mt-3 grid gap-2 text-xs text-gx-warning">
                  {readOnlyReview.remediation.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4">
              <Button
                variant="secondary"
                onClick={requestReadOnlyDiscoveryReview}
                disabled={reviewRequestDisabled}
                title={reviewRequestTitle}
              >
                {submitting ? 'Requesting' : readOnlyReview.status === 'requested' ? 'Review requested' : 'Request read-only discovery review'}
              </Button>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">Operator read-only discovery review</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Operator decisions are audit evidence only; rollout_proposal_ready is a later planning gate, not launch, not production approval, and not public discovery.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={operatorReview?.review_request_status === 'requested' ? 'warning' : operatorReview?.operator_decision ? 'success' : 'danger'}>
                  {operatorReview?.review_request_status ?? 'not_requested'}
                </Badge>
                <Badge variant="warning">sandbox_only</Badge>
                <Badge variant="danger">{operatorReview?.production_approval_status ?? 'not_approved'}</Badge>
                <Badge variant="danger">{operatorReview?.live_mode_status ?? 'not_live'}</Badge>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {[
                { label: 'operator_decision_is_approval', value: operatorReview?.operator_decision_is_approval ?? false },
                { label: 'rollout_proposal_ready_is_launch', value: operatorReview?.rollout_proposal_ready_is_launch ?? false },
                { label: 'public_discovery_enabled', value: operatorReview?.public_discovery_enabled ?? false },
                { label: 'checkout_payment_enabled', value: operatorReview?.checkout_payment_enabled ?? false },
                { label: 'live_provider_enabled', value: operatorReview?.live_provider_enabled ?? false },
                { label: 'live_plural_enabled', value: operatorReview?.live_plural_enabled ?? false },
                { label: 'production_allowlist_written', value: operatorReview?.production_allowlist_written ?? false },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-gx-muted">Requested</div>
                <DateText value={operatorReview?.requested_at ?? null} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Request actor</div>
                <div className="text-gx-text">{operatorReview?.request_actor ?? 'unavailable'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Decision</div>
                <div className="text-gx-text">{operatorReview?.operator_decision ?? 'none'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Decision recorded</div>
                <DateText value={operatorReview?.decision_recorded_at ?? null} />
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Readiness evidence</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant={readinessVariant(operatorReview?.readiness_summary.overall_status ?? merchant.readiness.status)}>
                    {operatorReview?.readiness_summary.overall_score_percent ?? merchant.readiness.score_percent}%
                  </Badge>
                  <Badge variant={readinessVariant(operatorReview?.readiness_summary.category_status ?? merchant.readiness.category_readiness.status)}>
                    category {operatorReview?.readiness_summary.category_score_percent ?? merchant.readiness.category_readiness.score_percent}%
                  </Badge>
                  <Badge variant={readinessVariant(operatorReview?.readiness_summary.catalog_status ?? merchant.readiness.catalog_readiness.status)}>
                    catalog {operatorReview?.readiness_summary.catalog_score_percent ?? merchant.readiness.catalog_readiness.score_percent}%
                  </Badge>
                </div>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Agent-facing preview status</div>
                <Badge variant={readinessVariant(operatorReview?.agent_facing_preview_status ?? merchant.agent_facing_preview.preview_status)}>
                  {operatorReview?.agent_facing_preview_status ?? merchant.agent_facing_preview.preview_status}
                </Badge>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Audit event</div>
                <div className="text-gx-text">{operatorReview?.audit_event_id ?? 'pending'}</div>
              </div>
            </div>
            {operatorReview?.blockers.length ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">Operator review blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {operatorReview.blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {operatorReview?.remediation_items.length ? (
              <div className="mt-4 rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Remediation</div>
                <div className="mt-2 grid gap-2 text-xs text-gx-warning">
                  {operatorReview.remediation_items.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
              <label className="text-sm font-medium text-gx-text">
                Decision
                <select
                  className="mt-1.5 w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
                  value={decisionForm.decision}
                  onChange={(e) => setDecisionForm({ ...decisionForm, decision: e.target.value as CommerceReadOnlyDiscoveryOperatorDecision })}
                >
                  <option value="changes_requested">changes_requested</option>
                  <option value="rejected">rejected</option>
                  <option value="rollout_proposal_ready">rollout_proposal_ready</option>
                </select>
              </label>
              <Input
                id="operator-review-reason"
                label="Reason"
                value={decisionForm.reason}
                onChange={(e) => setDecisionForm({ ...decisionForm, reason: e.target.value })}
              />
            </div>
            <div className="mt-3">
              <label htmlFor="operator-review-remediation" className="mb-1.5 block text-sm font-medium text-gx-text">
                Remediation items
              </label>
              <textarea
                id="operator-review-remediation"
                value={decisionForm.remediation_items}
                onChange={(e) => setDecisionForm({ ...decisionForm, remediation_items: e.target.value })}
                rows={3}
                className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
              />
            </div>
            <div className="mt-4">
              <Button
                variant="secondary"
                onClick={recordOperatorDecision}
                disabled={operatorDecisionDisabled}
                title={operatorDecisionTitle}
              >
                {decisionSubmitting ? 'Recording' : 'Record operator decision'}
              </Button>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">Rollout proposal</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Proposal evidence is non-enabling; dry_run_passed is not launch, production approval, public discovery, checkout, live provider, or live Plural.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={proposalStatus === 'dry_run_passed' ? 'success' : proposalStatus === 'dry_run_blocked' ? 'danger' : 'warning'}>
                  {proposalStatus}
                </Badge>
                <Badge variant={rolloutProposal?.dry_run_result === 'passed' ? 'success' : rolloutProposal?.dry_run_result === 'blocked' ? 'danger' : 'warning'}>
                  {rolloutProposal?.dry_run_result ?? 'not_run'}
                </Badge>
                <Badge variant="danger">{rolloutProposal?.production_approval_status ?? 'not_approved'}</Badge>
                <Badge variant="danger">{rolloutProposal?.live_mode_status ?? 'not_live'}</Badge>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {[
                { label: 'proposal_is_approval', value: rolloutProposal?.proposal_is_approval ?? false },
                { label: 'dry_run_is_launch', value: rolloutProposal?.dry_run_is_launch ?? false },
                { label: 'public_discovery_enabled', value: rolloutProposal?.public_discovery_enabled ?? false },
                { label: 'checkout_payment_enabled', value: rolloutProposal?.checkout_payment_enabled ?? false },
                { label: 'live_provider_enabled', value: rolloutProposal?.live_provider_enabled ?? false },
                { label: 'live_plural_enabled', value: rolloutProposal?.live_plural_enabled ?? false },
                { label: 'production_allowlist_written', value: rolloutProposal?.production_allowlist_written ?? false },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-gx-muted">Created</div>
                <DateText value={rolloutProposal?.created_at ?? null} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Dry run checked</div>
                <DateText value={rolloutProposal?.dry_run_checked_at ?? null} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Operator decision</div>
                <div className="text-gx-text">{rolloutProposal?.operator_review.operator_decision ?? operatorReview?.operator_decision ?? 'none'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Audit event</div>
                <div className="text-gx-text">{rolloutProposal?.audit_event_id ?? 'pending'}</div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Category readiness</div>
                <Badge variant={readinessVariant(rolloutProposal?.evidence.category_readiness_summary.status ?? merchant.readiness.category_readiness.status)}>
                  {rolloutProposal?.evidence.category_readiness_summary.score_percent ?? merchant.readiness.category_readiness.score_percent}%
                </Badge>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Catalog readiness</div>
                <Badge variant={readinessVariant(rolloutProposal?.evidence.catalog_readiness_summary.status ?? merchant.readiness.catalog_readiness.status)}>
                  {rolloutProposal?.evidence.catalog_readiness_summary.score_percent ?? merchant.readiness.catalog_readiness.score_percent}%
                </Badge>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Agent-facing preview</div>
                <Badge variant={readinessVariant(rolloutProposal?.evidence.agent_facing_preview_summary.preview_status ?? merchant.agent_facing_preview.preview_status)}>
                  {rolloutProposal?.evidence.agent_facing_preview_summary.preview_status ?? merchant.agent_facing_preview.preview_status}
                </Badge>
              </div>
            </div>
            <div className="mt-4 rounded-md border border-gx-border p-3">
              <div className="text-sm font-medium text-gx-text">Evidence checklist</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {(rolloutProposal?.evidence_checklist ?? [
                  { key: 'operator_review_rollout_proposal_ready', label: 'Operator review marked rollout_proposal_ready', status: operatorReview?.operator_decision === 'rollout_proposal_ready' ? 'pass' as const : 'blocked' as const },
                  { key: 'non_enabling_controls_locked', label: 'Non-enabling controls locked', status: 'pass' as const },
                ]).map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gx-muted">{item.label}</span>
                    <Badge variant={item.status === 'pass' ? 'success' : 'danger'}>{item.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
            {rolloutProposal?.blockers.length ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">Proposal blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {rolloutProposal.blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {rolloutProposal?.remediation_items.length ? (
              <div className="mt-4 rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Proposal remediation</div>
                <div className="mt-2 grid gap-2 text-xs text-gx-warning">
                  {rolloutProposal.remediation_items.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4">
              <label htmlFor="rollout-proposal-note" className="mb-1.5 block text-sm font-medium text-gx-text">
                Proposal note
              </label>
              <textarea
                id="rollout-proposal-note"
                value={proposalNote}
                onChange={(e) => setProposalNote(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={createRolloutProposal}
                disabled={proposalCreateDisabled}
                title={proposalBlocked ? rolloutProposal?.blockers.map(capabilityLabel).join(', ') : 'Create or update non-enabling proposal evidence.'}
              >
                {proposalSubmitting ? 'Saving' : proposalStatus === 'not_created' ? 'Create proposal' : 'Update proposal'}
              </Button>
              <Button
                variant="secondary"
                onClick={runRolloutProposalDryRun}
                disabled={proposalDryRunDisabled}
              >
                {proposalSubmitting ? 'Running' : 'Run dry run'}
              </Button>
              <Button
                variant="ghost"
                onClick={withdrawRolloutProposal}
                disabled={proposalWithdrawDisabled}
              >
                Withdraw proposal
              </Button>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">AgenticOrg buyer-agent discovery</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Sandbox handoff evidence only; this is not public discovery, not launch, not production approval, and not checkout or payment enablement.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={agenticOrgStatus === 'sandbox_handoff_requested' ? 'success' : agenticOrgStatus === 'blocked' ? 'danger' : 'warning'}>
                  {agenticOrgStatus}
                </Badge>
                <Badge variant="danger">{agenticOrgPreview?.production_approval_status ?? 'not_approved'}</Badge>
                <Badge variant="danger">{agenticOrgPreview?.live_mode_status ?? 'not_live'}</Badge>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-4">
              {[
                { label: 'handoff_request_is_approval', value: agenticOrgPreview?.handoff_request_is_approval ?? false },
                { label: 'buyer_agent_discovery_is_public', value: agenticOrgPreview?.buyer_agent_discovery_is_public ?? false },
                { label: 'agenticorg_public_discovery_enabled', value: agenticOrgPreview?.agenticorg_public_discovery_enabled ?? false },
                { label: 'public_discovery_enabled', value: agenticOrgPreview?.public_discovery_enabled ?? false },
                { label: 'checkout_payment_enabled', value: agenticOrgPreview?.checkout_payment_enabled ?? false },
                { label: 'live_provider_enabled', value: agenticOrgPreview?.live_provider_enabled ?? false },
                { label: 'live_plural_enabled', value: agenticOrgPreview?.live_plural_enabled ?? false },
                { label: 'production_allowlist_written', value: agenticOrgPreview?.production_allowlist_written ?? false },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-gx-muted">Handoff requested</div>
                <DateText value={agenticOrgPreview?.handoff_requested_at ?? null} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Handoff withdrawn</div>
                <DateText value={agenticOrgPreview?.handoff_withdrawn_at ?? null} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">C6F dry run</div>
                <div className="text-gx-text">{agenticOrgPreview?.rollout_proposal_summary.dry_run_result ?? 'not_run'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Audit event</div>
                <div className="text-gx-text">{agenticOrgPreview?.audit_event_id ?? 'pending'}</div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Readiness</div>
                <Badge variant={readinessVariant(agenticOrgPreview?.readiness_summary.overall_status ?? merchant.readiness.status)}>
                  {agenticOrgPreview?.readiness_summary.overall_score_percent ?? merchant.readiness.score_percent}%
                </Badge>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Agent-facing preview</div>
                <Badge variant={readinessVariant(agenticOrgPreview?.agent_facing_preview_summary.preview_status ?? merchant.agent_facing_preview.preview_status)}>
                  {agenticOrgPreview?.agent_facing_preview_summary.preview_status ?? merchant.agent_facing_preview.preview_status}
                </Badge>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Sample products</div>
                <Badge variant={(agenticOrgPreview?.sample_products.length ?? 0) > 0 ? 'success' : 'warning'}>
                  {agenticOrgPreview?.sample_products.length ?? 0}
                </Badge>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-gx-border p-3">
              <div className="text-sm font-medium text-gx-text">Evidence checklist</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {(agenticOrgPreview?.evidence_checklist ?? [
                  { key: 'rollout_proposal_dry_run_passed', label: 'Rollout proposal dry-run passed', status: rolloutProposal?.proposal_status === 'dry_run_passed' ? 'pass' as const : 'blocked' as const },
                  { key: 'buyer_agent_handoff_is_sandbox_only', label: 'Buyer-agent handoff is sandbox-only', status: 'pass' as const },
                ]).map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gx-muted">{item.label}</span>
                    <Badge variant={item.status === 'pass' ? 'success' : 'danger'}>{item.status}</Badge>
                  </div>
                ))}
              </div>
            </div>

            {agenticOrgPreview?.blockers.length ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">AgenticOrg handoff blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agenticOrgPreview.blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {agenticOrgPreview?.remediation_items.length ? (
              <div className="mt-4 rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">AgenticOrg remediation</div>
                <div className="mt-2 grid gap-2 text-xs text-gx-warning">
                  {agenticOrgPreview.remediation_items.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Allowed buyer-agent labels</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(agenticOrgPreview?.allowed_buyer_agent_capabilities ?? []).map((capability) => (
                    <Badge key={capability} variant="success">{capabilityLabel(capability)}</Badge>
                  ))}
                </div>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Blocked buyer-agent labels</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(agenticOrgPreview?.blocked_buyer_agent_capabilities ?? []).map((capability) => (
                    <Badge key={capability} variant="danger">{capabilityLabel(capability)}</Badge>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="agenticorg-handoff-note" className="mb-1.5 block text-sm font-medium text-gx-text">
                Handoff note
              </label>
              <textarea
                id="agenticorg-handoff-note"
                value={agenticOrgNote}
                onChange={(e) => setAgenticOrgNote(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={requestAgenticOrgHandoff}
                disabled={agenticOrgRequestDisabled}
                title={agenticOrgHardBlockers.length ? agenticOrgHardBlockers.map(capabilityLabel).join(', ') : 'Request sandbox-only AgenticOrg handoff.'}
              >
                {agenticOrgSubmitting ? 'Requesting' : 'Request AgenticOrg handoff'}
              </Button>
              <Button
                variant="ghost"
                onClick={withdrawAgenticOrgHandoff}
                disabled={agenticOrgWithdrawDisabled}
              >
                Withdraw handoff
              </Button>
              {agenticOrgJson ? (
                <div className="flex items-center gap-2 text-xs text-gx-muted">
                  <span>Handoff JSON</span>
                  <CopyButton text={agenticOrgJson} />
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">Schema.org JSON-LD preview</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Preview-only schema.org shape from Grantex evidence; not publication, certification, launch, checkout, payment, live provider, or allowlist enablement.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={schemaOrgPreview?.status === 'preview_only' ? 'success' : 'warning'}>
                  {schemaOrgPreview?.status ?? 'unavailable'}
                </Badge>
                <Badge variant="danger">{schemaOrgPreview?.production_approval_status ?? 'not_approved'}</Badge>
                <Badge variant="danger">{schemaOrgPreview?.live_mode_status ?? 'not_live'}</Badge>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-4">
              {[
                { label: 'schemaorg_publication_enabled', value: schemaOrgPreview?.schemaorg_publication_enabled ?? false },
                { label: 'public_discovery_enabled', value: schemaOrgPreview?.public_discovery_enabled ?? false },
                { label: 'checkout_payment_enabled', value: schemaOrgPreview?.checkout_payment_enabled ?? false },
                { label: 'live_provider_enabled', value: schemaOrgPreview?.live_provider_enabled ?? false },
                { label: 'live_plural_enabled', value: schemaOrgPreview?.live_plural_enabled ?? false },
                { label: 'production_allowlist_written', value: schemaOrgPreview?.production_allowlist_written ?? false },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {[
                { label: 'Products', value: schemaOrgPreview?.evidence_summary.product_count ?? 0 },
                { label: 'Offers', value: schemaOrgPreview?.evidence_summary.offer_count ?? 0 },
                { label: 'Return policies', value: schemaOrgPreview?.evidence_summary.return_policy_count ?? 0 },
                { label: 'Shipping details', value: schemaOrgPreview?.evidence_summary.shipping_details_count ?? 0 },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{item.label}</div>
                  <div className="text-sm font-medium text-gx-text">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Included schema.org types</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(schemaOrgPreview?.included_types ?? []).map((type) => (
                    <Badge key={type} variant="success">{type}</Badge>
                  ))}
                </div>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Omitted schema.org types</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(schemaOrgPreview?.omitted_types ?? []).map((type) => (
                    <Badge key={type} variant="warning">{type}</Badge>
                  ))}
                </div>
              </div>
            </div>

            {schemaOrgPreview?.blockers.length ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">Schema.org blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {schemaOrgPreview.blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {schemaOrgPreview?.remediation_items.length ? (
              <div className="mt-4 rounded-md border border-gx-border p-3">
                <div className="text-sm font-medium text-gx-text">Schema.org remediation</div>
                <div className="mt-2 grid gap-2 text-xs text-gx-warning">
                  {schemaOrgPreview.remediation_items.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>
            ) : null}

            <details className="mt-4 rounded-md border border-gx-border p-3">
              <summary className="cursor-pointer text-sm font-semibold text-gx-text">JSON-LD preview</summary>
              <div className="mt-3 flex justify-end">
                <CopyButton text={schemaOrgJson} />
              </div>
              <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-gx-bg p-3 text-xs text-gx-text">
                {schemaOrgJson}
              </pre>
            </details>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold text-gx-text">Readiness checklist</h2>
            <div className="mb-4 rounded-md border border-gx-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-gx-muted">Category preset</div>
                  <div className="mt-1 text-sm font-medium text-gx-text">{merchant.readiness.category_readiness.label}</div>
                  <div className="mt-1 text-xs text-gx-muted">{merchant.readiness.category_readiness.summary}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={readinessVariant(merchant.readiness.category_readiness.status)}>
                    {merchant.readiness.category_readiness.status}
                  </Badge>
                  <Badge variant="default">{merchant.readiness.category_readiness.score_percent}%</Badge>
                </div>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gx-border">
                <div
                  className="h-full rounded-full bg-gx-accent"
                  style={{ width: `${Math.max(0, Math.min(100, merchant.readiness.category_readiness.score_percent))}%` }}
                />
              </div>
              <div className="mt-3 grid gap-2">
                {merchant.readiness.category_readiness.items.map((item) => (
                  <div key={item.key} className="rounded-md border border-gx-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gx-text">{item.label}</span>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
                        <Badge variant={readinessVariant(item.status)}>{item.status}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gx-muted">{item.description}</div>
                    {item.status !== 'pass' && item.status !== 'not_applicable' ? (
                      <div className="mt-2 text-xs text-gx-warning">{item.remediation}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="mb-4 rounded-md border border-gx-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-gx-muted">Catalog readiness</div>
                  <div className="mt-1 text-sm font-medium text-gx-text">
                    {merchant.readiness.catalog_readiness.product_count} products / {merchant.readiness.catalog_readiness.variant_count} variants
                  </div>
                  <div className="mt-1 text-xs text-gx-muted">{merchant.readiness.catalog_readiness.summary}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={readinessVariant(merchant.readiness.catalog_readiness.status)}>
                    {merchant.readiness.catalog_readiness.status}
                  </Badge>
                  <Badge variant="default">{merchant.readiness.catalog_readiness.score_percent}%</Badge>
                  <Badge variant="default">
                    recommended {merchant.readiness.catalog_readiness.recommended_completion_percent}%
                  </Badge>
                </div>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gx-border">
                <div
                  className="h-full rounded-full bg-gx-accent"
                  style={{ width: `${Math.max(0, Math.min(100, merchant.readiness.catalog_readiness.score_percent))}%` }}
                />
              </div>
              <div className="mt-3 grid gap-2">
                {merchant.readiness.catalog_readiness.items.map((item) => (
                  <div key={item.key} className="rounded-md border border-gx-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gx-text">{item.label}</span>
                      <div className="flex flex-wrap gap-2">
                        {countLabel(item.count, item.total) ? (
                          <Badge variant="default">{countLabel(item.count, item.total)}</Badge>
                        ) : null}
                        <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
                        <Badge variant={readinessVariant(item.status)}>{item.status}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gx-muted">{item.description}</div>
                    {item.status !== 'pass' && item.status !== 'not_applicable' ? (
                      <div className="mt-2 text-xs text-gx-warning">{item.remediation}</div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 text-xs text-gx-muted md:grid-cols-3">
                <div>Manual entry: {merchant.readiness.catalog_readiness.intake.manual_entry_supported ? 'available' : 'unavailable'}</div>
                <div>CSV dry-run: {merchant.readiness.catalog_readiness.intake.csv_dry_run_supported ? 'available' : 'unavailable'}</div>
                <div>Bulk API dry-run: {merchant.readiness.catalog_readiness.intake.bulk_api_dry_run_supported ? 'available' : 'unavailable'}</div>
                <div>Async import job: {merchant.readiness.catalog_readiness.intake.async_import_job_supported ? 'available' : 'deferred'}</div>
                <div>Connector import: {merchant.readiness.catalog_readiness.intake.external_connector_supported ? 'available' : 'deferred'}</div>
              </div>
            </div>
            <h3 className="mb-3 text-sm font-semibold text-gx-text">Production gates</h3>
            <div className="grid gap-2 md:grid-cols-2">
              {merchant.readiness.checks.map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-3 rounded-md border border-gx-border p-3">
                  <span className="text-sm text-gx-text">{item.label}</span>
                  <Badge variant={item.status === 'pass' ? 'success' : 'warning'}>
                    {item.status === 'pass' ? 'pass' : 'blocked'}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <div className="text-xs text-gx-muted">Merchant</div>
                <IdText value={merchant.merchant_id} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Rollout status</div>
                <div className="text-gx-text">{merchant.readiness.rollout_status}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Updated</div>
                <DateText value={merchant.sandbox_onboarding_updated_at} />
              </div>
              <div>
                <div className="text-xs text-gx-muted">Agentic request</div>
                <div className="text-gx-text">{merchant.agentic_commerce_requested ? 'requested' : 'not requested'}</div>
              </div>
            </div>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-gx-text">V1 control signals</h3>
            <div className="grid gap-2 md:grid-cols-2">
              {integrationChecklist.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border border-gx-border p-3">
                  <span className="text-sm text-gx-text">{item.label}</span>
                  <Badge variant={item.done ? 'success' : 'warning'}>{item.done ? 'present' : 'missing'}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <div className="text-xs text-gx-muted">Well-known environment</div>
                <div className="text-gx-text">{profile?.environment ?? 'not loaded'}</div>
              </div>
              <div>
                <div className="text-xs text-gx-muted">Discovery tools</div>
                <div className="truncate text-xs text-gx-muted">{profile?.supported_tools?.join(', ') || 'none'}</div>
              </div>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">Agent-facing preview</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Sandbox-only read-only view of public-safe profile and catalog fields for later readiness review.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={merchant.agent_facing_preview.preview_status === 'ready' ? 'success' : 'danger'}>
                  {merchant.agent_facing_preview.preview_status}
                </Badge>
                <Badge variant="warning">sandbox_only</Badge>
                <Badge variant="danger">{merchant.agent_facing_preview.live_mode_status}</Badge>
                <Badge variant="danger">{merchant.agent_facing_preview.production_approval_status}</Badge>
                <Badge variant="danger">{merchant.agent_facing_preview.rollout_status}</Badge>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-4">
              {[
                { label: 'public_discovery_enabled', value: merchant.agent_facing_preview.public_discovery_enabled },
                { label: 'checkout_payment_enabled', value: merchant.agent_facing_preview.checkout_payment_enabled },
                { label: 'live_provider_enabled', value: merchant.agent_facing_preview.live_provider_enabled },
                { label: 'live_plural_enabled', value: merchant.agent_facing_preview.live_plural_enabled },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-md border border-gx-border p-3">
                  <div className="text-xs text-gx-muted">{label}</div>
                  <Badge variant={value ? 'danger' : 'success'}>{value ? 'true' : 'false'}</Badge>
                </div>
              ))}
            </div>
            {merchant.agent_facing_preview.preview_blockers.length > 0 ? (
              <div className="mt-4 rounded-md border border-gx-danger/40 bg-gx-danger/5 p-3">
                <div className="text-sm font-medium text-gx-text">Preview blockers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {merchant.agent_facing_preview.preview_blockers.map((blocker) => (
                    <Badge key={blocker} variant="danger">{capabilityLabel(blocker)}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Merchant preview</div>
                <div className="mt-2 grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-gx-muted">Reference</span>
                    <IdText value={merchant.agent_facing_preview.merchant.merchant_reference} />
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gx-muted">Display name</span>
                    <span className="text-right text-gx-text">{merchant.agent_facing_preview.merchant.display_name ?? 'blocked'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gx-muted">Category</span>
                    <span className="text-right text-gx-text">{merchant.agent_facing_preview.merchant.category_preset ?? 'blocked'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gx-muted">Country/currency</span>
                    <span className="text-right text-gx-text">
                      {merchant.agent_facing_preview.merchant.country_code ?? 'blocked'} / {merchant.agent_facing_preview.merchant.default_currency ?? 'blocked'}
                    </span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-gx-muted">Description draft</div>
                <div className="mt-1 text-sm text-gx-text">
                  {merchant.agent_facing_preview.merchant.public_discovery_description_draft ?? 'blocked'}
                </div>
              </div>
              <div className="rounded-md border border-gx-border p-3">
                <div className="text-xs text-gx-muted">Readiness summary</div>
                <div className="mt-2 grid gap-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gx-muted">Overall</span>
                    <Badge variant={readinessVariant(merchant.agent_facing_preview.readiness_summary.overall_status)}>
                      {merchant.agent_facing_preview.readiness_summary.overall_score_percent}%
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gx-muted">Category</span>
                    <Badge variant={readinessVariant(merchant.agent_facing_preview.readiness_summary.category_status)}>
                      {merchant.agent_facing_preview.readiness_summary.category_score_percent}%
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gx-muted">Catalog</span>
                    <Badge variant={readinessVariant(merchant.agent_facing_preview.readiness_summary.catalog_status)}>
                      {merchant.agent_facing_preview.readiness_summary.catalog_score_percent}%
                    </Badge>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-gx-muted">
                  <div>{merchant.agent_facing_preview.readiness_summary.category_summary}</div>
                  <div>{merchant.agent_facing_preview.readiness_summary.catalog_summary}</div>
                </div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-sm font-semibold text-gx-text">Allowed preview capabilities</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {merchant.agent_facing_preview.allowed_preview_capabilities.map((capability) => (
                    <Badge key={capability} variant="success">{capabilityLabel(capability)}</Badge>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold text-gx-text">Blocked capabilities</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {merchant.agent_facing_preview.blocked_capabilities.map((capability) => (
                    <Badge key={capability} variant="danger">{capabilityLabel(capability)}</Badge>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-gx-text">Sample products</div>
              {merchant.agent_facing_preview.sample_products.length === 0 ? (
                <div className="rounded-md border border-gx-border p-3 text-sm text-gx-muted">
                  No public-safe sample products are available for preview.
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-3">
                  {merchant.agent_facing_preview.sample_products.map((product) => (
                    <div key={product.sample_reference} className="rounded-md border border-gx-border p-3">
                      <div className="text-sm font-medium text-gx-text">{product.title}</div>
                      <div className="mt-1 line-clamp-3 text-xs text-gx-muted">{product.description}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant="default">{product.category_preset}</Badge>
                        <Badge variant="default">{product.variants.length} variants</Badge>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-gx-muted">
                        {product.variants.map((variant) => (
                          <div key={variant.sku} className="flex justify-between gap-2">
                            <span>{variant.sku}</span>
                            <span>{variant.price_amount} {variant.currency}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <details className="mt-4 rounded-md border border-gx-border p-3">
              <summary className="cursor-pointer text-sm font-semibold text-gx-text">Preview JSON</summary>
              <div className="mt-3 flex justify-end">
                <CopyButton text={agentPreviewJson} />
              </div>
              <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-gx-bg p-3 text-xs text-gx-text">
                {agentPreviewJson}
              </pre>
            </details>
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
