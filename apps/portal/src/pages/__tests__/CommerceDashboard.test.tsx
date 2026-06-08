import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CommerceAudit } from '../commerce/CommerceAudit';
import { CommerceCatalog } from '../commerce/CommerceCatalog';
import { CommerceOnboarding } from '../commerce/CommerceOnboarding';
import { CommercePassports } from '../commerce/CommercePassports';
import { CommercePayments } from '../commerce/CommercePayments';
import { CommerceOps } from '../commerce/CommerceOps';
import { CommercePlayground } from '../commerce/CommercePlayground';
import { CommerceSettings } from '../commerce/CommerceSettings';
import { CommerceWebhooks } from '../commerce/CommerceWebhooks';

const mockListCommercePaymentIntents = vi.fn();
const mockReconcileCommercePaymentIntent = vi.fn();
const mockListCommerceAuditEvents = vi.fn();
const mockListCommercePassports = vi.fn();
const mockRevokeCommercePassport = vi.fn();
const mockGetCommerceMerchant = vi.fn();
const mockUpdateCommerceMerchant = vi.fn();
const mockGetCommerceMerchantSandboxOnboarding = vi.fn();
const mockUpdateCommerceMerchantSandboxOnboarding = vi.fn();
const mockTransitionCommerceMerchantSandboxOnboarding = vi.fn();
const mockRequestCommerceMerchantReadOnlyDiscoveryReview = vi.fn();
const mockGetCommerceMerchantReadOnlyDiscoveryReview = vi.fn();
const mockRecordCommerceReadOnlyDiscoveryReviewDecision = vi.fn();
const mockGetCommerceMerchantReadOnlyDiscoveryRolloutProposal = vi.fn();
const mockCreateCommerceMerchantReadOnlyDiscoveryRolloutProposal = vi.fn();
const mockDryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal = vi.fn();
const mockWithdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal = vi.fn();
const mockGetCommerceMerchantAgenticOrgBuyerDiscoveryPreview = vi.fn();
const mockGetCommerceMerchantSchemaOrgJsonLdPreview = vi.fn();
const mockRequestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff = vi.fn();
const mockWithdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff = vi.fn();
const mockRunCommerceConnectorDryRun = vi.fn();
const mockRequestCommerceConnectorDryRunReview = vi.fn();
const mockRecordCommerceConnectorDryRunReviewDecision = vi.fn();
const mockDisableMerchantAgenticCommerce = vi.fn();
const mockEnableMerchantAgenticCommerce = vi.fn();
const mockListCommerceAgents = vi.fn();
const mockUpdateCommerceAgent = vi.fn();
const mockListCommerceProducts = vi.fn();
const mockUpdateCommerceProduct = vi.fn();
const mockBulkIngestCommerceProducts = vi.fn();
const mockListCommercePolicies = vi.fn();
const mockEvaluateCommercePolicy = vi.fn();
const mockListCommerceWebhookSources = vi.fn();
const mockCreateCommerceWebhookSource = vi.fn();
const mockUpdateCommerceWebhookSource = vi.fn();
const mockRotateCommerceWebhookSourceSecret = vi.fn();
const mockListCommerceProviderCredentials = vi.fn();
const mockValidateCommerceProviderCredential = vi.fn();
const mockGetCommerceOpsHealth = vi.fn();
const mockListCommerceProviderWebhookEvents = vi.fn();
const mockReplayCommerceProviderWebhookEvent = vi.fn();
const mockGetCommerceWellKnownProfile = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/commerce', () => ({
  listCommercePaymentIntents: (...a: unknown[]) => mockListCommercePaymentIntents(...a),
  reconcileCommercePaymentIntent: (...a: unknown[]) => mockReconcileCommercePaymentIntent(...a),
  listCommerceAuditEvents: (...a: unknown[]) => mockListCommerceAuditEvents(...a),
  listCommercePassports: (...a: unknown[]) => mockListCommercePassports(...a),
  revokeCommercePassport: (...a: unknown[]) => mockRevokeCommercePassport(...a),
  getCommerceMerchant: (...a: unknown[]) => mockGetCommerceMerchant(...a),
  updateCommerceMerchant: (...a: unknown[]) => mockUpdateCommerceMerchant(...a),
  getCommerceMerchantSandboxOnboarding: (...a: unknown[]) => mockGetCommerceMerchantSandboxOnboarding(...a),
  updateCommerceMerchantSandboxOnboarding: (...a: unknown[]) => mockUpdateCommerceMerchantSandboxOnboarding(...a),
  transitionCommerceMerchantSandboxOnboarding: (...a: unknown[]) => mockTransitionCommerceMerchantSandboxOnboarding(...a),
  requestCommerceMerchantReadOnlyDiscoveryReview: (...a: unknown[]) => mockRequestCommerceMerchantReadOnlyDiscoveryReview(...a),
  getCommerceMerchantReadOnlyDiscoveryReview: (...a: unknown[]) => mockGetCommerceMerchantReadOnlyDiscoveryReview(...a),
  recordCommerceReadOnlyDiscoveryReviewDecision: (...a: unknown[]) => mockRecordCommerceReadOnlyDiscoveryReviewDecision(...a),
  getCommerceMerchantReadOnlyDiscoveryRolloutProposal: (...a: unknown[]) => mockGetCommerceMerchantReadOnlyDiscoveryRolloutProposal(...a),
  createCommerceMerchantReadOnlyDiscoveryRolloutProposal: (...a: unknown[]) => mockCreateCommerceMerchantReadOnlyDiscoveryRolloutProposal(...a),
  dryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal: (...a: unknown[]) => mockDryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal(...a),
  withdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal: (...a: unknown[]) => mockWithdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal(...a),
  getCommerceMerchantAgenticOrgBuyerDiscoveryPreview: (...a: unknown[]) => mockGetCommerceMerchantAgenticOrgBuyerDiscoveryPreview(...a),
  getCommerceMerchantSchemaOrgJsonLdPreview: (...a: unknown[]) => mockGetCommerceMerchantSchemaOrgJsonLdPreview(...a),
  requestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff: (...a: unknown[]) => mockRequestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff(...a),
  withdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff: (...a: unknown[]) => mockWithdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff(...a),
  runCommerceConnectorDryRun: (...a: unknown[]) => mockRunCommerceConnectorDryRun(...a),
  requestCommerceConnectorDryRunReview: (...a: unknown[]) => mockRequestCommerceConnectorDryRunReview(...a),
  recordCommerceConnectorDryRunReviewDecision: (...a: unknown[]) => mockRecordCommerceConnectorDryRunReviewDecision(...a),
  disableMerchantAgenticCommerce: (...a: unknown[]) => mockDisableMerchantAgenticCommerce(...a),
  enableMerchantAgenticCommerce: (...a: unknown[]) => mockEnableMerchantAgenticCommerce(...a),
  listCommerceAgents: (...a: unknown[]) => mockListCommerceAgents(...a),
  updateCommerceAgent: (...a: unknown[]) => mockUpdateCommerceAgent(...a),
  listCommerceProducts: (...a: unknown[]) => mockListCommerceProducts(...a),
  updateCommerceProduct: (...a: unknown[]) => mockUpdateCommerceProduct(...a),
  bulkIngestCommerceProducts: (...a: unknown[]) => mockBulkIngestCommerceProducts(...a),
  listCommercePolicies: (...a: unknown[]) => mockListCommercePolicies(...a),
  evaluateCommercePolicy: (...a: unknown[]) => mockEvaluateCommercePolicy(...a),
  listCommerceWebhookSources: (...a: unknown[]) => mockListCommerceWebhookSources(...a),
  createCommerceWebhookSource: (...a: unknown[]) => mockCreateCommerceWebhookSource(...a),
  updateCommerceWebhookSource: (...a: unknown[]) => mockUpdateCommerceWebhookSource(...a),
  rotateCommerceWebhookSourceSecret: (...a: unknown[]) => mockRotateCommerceWebhookSourceSecret(...a),
  listCommerceProviderCredentials: (...a: unknown[]) => mockListCommerceProviderCredentials(...a),
  validateCommerceProviderCredential: (...a: unknown[]) => mockValidateCommerceProviderCredential(...a),
  getCommerceOpsHealth: (...a: unknown[]) => mockGetCommerceOpsHealth(...a),
  listCommerceProviderWebhookEvents: (...a: unknown[]) => mockListCommerceProviderWebhookEvents(...a),
  replayCommerceProviderWebhookEvent: (...a: unknown[]) => mockReplayCommerceProviderWebhookEvent(...a),
  getCommerceWellKnownProfile: (...a: unknown[]) => mockGetCommerceWellKnownProfile(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

function r(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const payment = {
  id: 'cpi_pending',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  cart_id: 'cart_1',
  passport_jti: 'cpsp_1',
  amount: 1299,
  amount_minor_units: 1299,
  currency: 'INR',
  provider: 'mock' as const,
  provider_environment: 'sandbox' as const,
  provider_payment_id: 'mock_pay_1',
  provider_order_id: null,
  checkout_url: null,
  checkout_expires_at: null,
  status: 'payment_pending' as const,
  policy_version: 'v1',
  decision_id: 'cpdec_1',
  provider_raw_status: 'pending',
  idempotency_key_hash: 'idem_hash_1',
  reconciled_at: null,
  last_reconciliation_attempt_at: null,
  last_reconciliation_error: null,
  last_reconciliation_retryable: null,
  expires_at: '2026-01-01T00:15:00Z',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:01:00Z',
};

const auditEvent = {
  id: 'caud_1',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  user_principal_id: null,
  event_type: 'payment_intent.created',
  resource_type: 'commerce_payment_intent',
  resource_id: 'cpi_pending',
  passport_jti: 'cpsp_1',
  policy_version: 'v1',
  decision_id: 'cpdec_1',
  idempotency_key_hash: 'idem_hash_1',
  request_id: 'req_1',
  occurred_at: '2026-01-01T00:00:00Z',
  metadata: { payment_intent_id: 'cpi_pending' },
};

const checkoutPassport = {
  jti: 'cpsp_checkout',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  passport_type: 'checkout' as const,
  subject: 'agent:cag_1',
  scopes: ['commerce:payment.initiate'],
  max_amount: 5000,
  currency: 'INR',
  environment: 'sandbox' as const,
  issued_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
  revoked: false,
  revocation_reason: null,
  passport_jwt: 'raw-passport-token-must-not-render',
};

const browsePassport = {
  ...checkoutPassport,
  jti: 'cpsp_browse',
  passport_type: 'browse' as const,
  scopes: ['commerce:catalog.search'],
  revoked: true,
  revocation_reason: 'operator',
};

const merchant = {
  id: 'mch_1',
  tenant_id: 'cten_1',
  legal_name: 'Grantex Commerce Pvt Ltd',
  display_name: 'Grantex Store',
  category_preset: 'software',
  verification_status: 'verified',
  environment: 'sandbox' as const,
  agentic_commerce_enabled: true,
  default_currency: 'INR',
  country_code: 'IN',
  support_email: 'ops@example.test',
  disabled_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const sandboxOnboarding = {
  merchant_id: 'mch_1',
  tenant_id: 'cten_1',
  display_name: 'Grantex Store',
  category_preset: 'electronics_appliances',
  country_code: 'IN',
  default_currency: 'INR',
  support_email: 'ops@example.test',
  support_url: 'https://support.example.test/help',
  public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
  environment: 'sandbox' as const,
  agentic_commerce_requested: true,
  agentic_commerce_enabled: false,
  sandbox_onboarding_state: 'sandbox_ready' as const,
  sandbox_onboarding_blocker: null,
  sandbox_onboarding_updated_at: '2026-01-01T00:00:00Z',
  readiness: {
    ready: true,
    status: 'pass' as const,
    score_percent: 100,
    live_mode_status: 'not_live' as const,
    production_approval_status: 'not_approved' as const,
    rollout_status: 'rollout_not_requested' as const,
    category_readiness: {
      preset_key: 'electronics_appliances',
      label: 'Electronics and appliances',
      status: 'pass' as const,
      required_passed: true,
      score_percent: 100,
      score: {
        passed: 14,
        total: 14,
        percentage: 100,
        required_passed: 5,
        required_total: 5,
        blocked: 0,
      },
      summary: 'Required sandbox category fields pass.',
      items: [
        {
          key: 'category_preset_recognized' as const,
          label: 'Category preset recognized',
          description: 'The sandbox profile must select the V1 launch preset for category-specific scoring.',
          severity: 'required' as const,
          status: 'pass' as const,
          remediation: 'Select the electronics_appliances category preset.',
        },
        {
          key: 'warranty_summary' as const,
          label: 'Warranty summary',
          description: 'Electronics/appliances variants should expose warranty summary text before agent-facing preview.',
          severity: 'recommended' as const,
          status: 'pass' as const,
          remediation: 'Add warranty_summary on every active sandbox variant.',
        },
        {
          key: 'no_checkout_payment_enablement' as const,
          label: 'No checkout/payment enablement',
          description: 'C6A only scores read-only sandbox preview readiness; checkout/payment execution remains disabled.',
          severity: 'blocked' as const,
          status: 'pass' as const,
          remediation: 'Disable agentic commerce execution before marking sandbox onboarding ready.',
        },
      ],
    },
    catalog_readiness: {
      status: 'pass' as const,
      required_passed: true,
      score_percent: 100,
      recommended_completion_percent: 100,
      blocker_count: 0,
      product_count: 1,
      variant_count: 2,
      score: {
        passed: 13,
        total: 13,
        percentage: 100,
        required_passed: true,
        required_passed_count: 7,
        required_total: 7,
        recommended_passed: 5,
        recommended_total: 5,
        recommended_completion_percentage: 100,
        blocker_count: 0,
      },
      summary: 'Required catalog fields pass for sandbox read-only discovery review.',
      intake: {
        manual_entry_supported: true as const,
        csv_dry_run_supported: true as const,
        bulk_api_dry_run_supported: true as const,
        async_import_job_supported: false as const,
        external_connector_supported: false as const,
      },
      items: [
        {
          key: 'catalog_products_present' as const,
          label: 'Catalog products present',
          description: 'Read-only discovery review needs at least one active sandbox product.',
          severity: 'required' as const,
          status: 'pass' as const,
          count: 1,
          total: 1,
          remediation: 'Add at least one active sandbox product through manual entry, CSV dry-run plus bulk upsert, or the existing catalog API.',
        },
        {
          key: 'variants_price_currency_present' as const,
          label: 'Variant price and currency present',
          description: 'Read-only discovery preview needs price and ISO currency for every active variant.',
          severity: 'required' as const,
          status: 'pass' as const,
          count: 2,
          total: 2,
          remediation: 'Add non-negative price_amount and uppercase ISO currency to every active variant.',
        },
        {
          key: 'products_image_media' as const,
          label: 'Product image/media present',
          description: 'Images help operators check what agents will show.',
          severity: 'recommended' as const,
          status: 'pass' as const,
          count: 1,
          total: 1,
          remediation: 'Add a public-safe image_url for every active product when available.',
        },
        {
          key: 'no_unsafe_catalog_text' as const,
          label: 'No unsafe catalog text',
          description: 'Catalog public/runtime fields must not include private artifacts, production claims, provider/payment claims, secrets, or approval claims.',
          severity: 'blocked' as const,
          status: 'pass' as const,
          count: 0,
          total: 3,
          remediation: 'Remove private, secret, provider, payment, live, production, approval, readiness, or certification claims from product and variant text.',
        },
      ],
    },
    checks: [
      {
        key: 'merchant_profile_present' as const,
        label: 'Merchant profile present',
        status: 'pass' as const,
        detail: 'present',
      },
      {
        key: 'no_checkout_payment_enablement' as const,
        label: 'No checkout/payment enablement',
        status: 'pass' as const,
        detail: 'blocked',
      },
    ],
  },
  agent_facing_preview: {
    preview_status: 'ready' as const,
    preview_blockers: [],
    sandbox_only: true as const,
    live_mode_status: 'not_live' as const,
    production_approval_status: 'not_approved' as const,
    rollout_status: 'rollout_not_requested' as const,
    public_discovery_enabled: false as const,
    checkout_payment_enabled: false as const,
    live_provider_enabled: false as const,
    live_plural_enabled: false as const,
    merchant: {
      merchant_reference: 'mch_1',
      display_name: 'Grantex Store',
      category_preset: 'electronics_appliances' as const,
      country_code: 'IN',
      default_currency: 'INR',
      public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
      support_email: 'ops@example.test',
      support_url: 'https://support.example.test/help',
    },
    readiness_summary: {
      overall_status: 'pass' as const,
      overall_score_percent: 100,
      category_status: 'pass' as const,
      category_score_percent: 100,
      category_summary: 'Required sandbox category fields pass.',
      catalog_status: 'pass' as const,
      catalog_score_percent: 100,
      catalog_summary: 'Required catalog fields pass for sandbox read-only discovery review.',
    },
    sample_products: [
      {
        sample_reference: 'catalog_sample_1',
        title: 'Sandbox induction cooktop',
        description: 'Public-safe appliance preview item.',
        image_url: 'https://images.example.test/cooktop.jpg',
        category_preset: 'electronics_appliances' as const,
        variants: [
          {
            sku: 'SKU-COOKTOP-1',
            variant_title: 'Black finish',
            price_amount: 129900,
            currency: 'INR',
            availability_status: 'in_stock' as const,
            warranty_summary: 'One year limited warranty.',
            return_policy_summary: 'Returns accepted within seven days.',
          },
        ],
      },
    ],
    allowed_preview_capabilities: [
      'read_only_profile_preview',
      'read_only_catalog_preview',
      'readiness_review_preview',
    ] as const,
    blocked_capabilities: [
      'public_discovery',
      'checkout_payment_creation',
      'live_payment',
      'live_plural',
      'provider_credentials',
      'order_fulfillment',
      'refunds_returns_execution',
      'production_allowlist',
    ] as const,
    generated_at: '2026-01-01T00:00:00Z',
  },
  read_only_discovery_review: {
    status: 'eligible' as const,
    eligible: true,
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
    status_updated_at: '2026-01-01T00:00:00Z',
    blockers: [],
    remediation: [],
  },
};

const operatorReview = {
  merchant_id: 'mch_1',
  tenant_id: 'cten_1',
  merchant_reference: 'mch_1',
  display_name: 'Grantex Store',
  sandbox_onboarding_state: 'submitted_for_review' as const,
  review_request_status: 'requested' as const,
  operator_decision: null,
  decision_reason: null,
  remediation_items: [],
  requested_at: '2026-01-01T00:05:00Z',
  request_actor: 'dev_TEST',
  decision_recorded_at: null,
  decision_actor: null,
  updated_at: '2026-01-01T00:05:00Z',
  readiness_summary: sandboxOnboarding.agent_facing_preview.readiness_summary,
  agent_facing_preview_status: 'ready' as const,
  blockers: [],
  sandbox_only: true as const,
  request_is_approval: false as const,
  operator_decision_is_approval: false as const,
  rollout_proposal_ready_is_launch: false as const,
  live_mode_status: 'not_live' as const,
  production_approval_status: 'not_approved' as const,
  rollout_status: 'rollout_not_requested' as const,
  public_discovery_enabled: false as const,
  checkout_payment_enabled: false as const,
  live_provider_enabled: false as const,
  live_plural_enabled: false as const,
  production_allowlist_written: false as const,
  audit_event_id: null,
};

const rolloutReadyOperatorReview = {
  ...operatorReview,
  review_request_status: 'rollout_proposal_ready' as const,
  operator_decision: 'rollout_proposal_ready' as const,
  decision_reason: 'Evidence supports later planning gate.',
  decision_recorded_at: '2026-01-01T00:10:00Z',
  decision_actor: 'dev_OPERATOR',
  audit_event_id: 'aud_rollout_ready',
};

const rolloutProposal = {
  merchant_id: 'mch_1',
  tenant_id: 'cten_1',
  merchant_reference: 'mch_1',
  display_name: 'Grantex Store',
  proposal_status: 'not_created' as const,
  proposal_note: null,
  dry_run_result: 'not_run' as const,
  created_at: null,
  updated_at: null,
  dry_run_checked_at: null,
  withdrawn_at: null,
  operator_review: {
    operator_decision: null,
    decision_reason: null,
    decision_recorded_at: null,
    decision_actor: null,
  },
  evidence: {
    merchant_sandbox_profile_summary: sandboxOnboarding.agent_facing_preview.merchant,
    category_readiness_summary: {
      status: 'pass' as const,
      score_percent: 100,
      summary: 'Required sandbox category fields pass.',
    },
    catalog_readiness_summary: {
      status: 'pass' as const,
      score_percent: 100,
      product_count: 1,
      variant_count: 2,
      summary: 'Required catalog fields pass for sandbox read-only discovery review.',
    },
    agent_facing_preview_summary: {
      preview_status: 'ready' as const,
      preview_blockers: [],
      sample_product_count: 1,
      allowed_preview_capabilities: sandboxOnboarding.agent_facing_preview.allowed_preview_capabilities,
      blocked_capabilities: sandboxOnboarding.agent_facing_preview.blocked_capabilities,
    },
    blocker_remediation_status: {
      blockers: ['operator_review_rollout_proposal_ready_missing'],
      remediation_items: ['Record rollout_proposal_ready before creating a proposal.'],
    },
    non_enabling_controls: {
      sandbox_only: true as const,
      production_approval_status: 'not_approved' as const,
      rollout_status: 'rollout_not_requested' as const,
      public_discovery_enabled: false as const,
      checkout_payment_enabled: false as const,
      live_provider_enabled: false as const,
      live_plural_enabled: false as const,
      production_allowlist_written: false as const,
    },
  },
  evidence_checklist: [
    { key: 'operator_review_rollout_proposal_ready', label: 'Operator review marked rollout_proposal_ready', status: 'blocked' as const },
    { key: 'non_enabling_controls_locked', label: 'Non-enabling controls locked', status: 'pass' as const },
  ],
  blockers: ['operator_review_rollout_proposal_ready_missing'],
  remediation_items: ['Record rollout_proposal_ready before creating a proposal.'],
  sandbox_only: true as const,
  proposal_is_approval: false as const,
  dry_run_is_launch: false as const,
  public_discovery_enabled: false as const,
  checkout_payment_enabled: false as const,
  live_provider_enabled: false as const,
  live_plural_enabled: false as const,
  production_allowlist_written: false as const,
  live_mode_status: 'not_live' as const,
  production_approval_status: 'not_approved' as const,
  rollout_status: 'rollout_not_requested' as const,
  audit_event_id: null,
};

const rolloutProposalReady = {
  ...rolloutProposal,
  operator_review: {
    operator_decision: 'rollout_proposal_ready' as const,
    decision_reason: 'Evidence supports later planning gate.',
    decision_recorded_at: '2026-01-01T00:10:00Z',
    decision_actor: 'dev_OPERATOR',
  },
  evidence: {
    ...rolloutProposal.evidence,
    blocker_remediation_status: { blockers: [], remediation_items: [] },
  },
  evidence_checklist: [
    { key: 'sandbox_profile_ready', label: 'Sandbox profile readiness', status: 'pass' as const },
    { key: 'category_readiness_passed', label: 'Category readiness passed', status: 'pass' as const },
    { key: 'catalog_readiness_passed', label: 'Catalog readiness passed', status: 'pass' as const },
    { key: 'agent_facing_preview_ready', label: 'Agent-facing preview ready', status: 'pass' as const },
    { key: 'operator_review_rollout_proposal_ready', label: 'Operator review marked rollout_proposal_ready', status: 'pass' as const },
    { key: 'non_enabling_controls_locked', label: 'Non-enabling controls locked', status: 'pass' as const },
  ],
  blockers: [],
  remediation_items: [],
};

const rolloutProposalDraft = {
  ...rolloutProposalReady,
  proposal_status: 'draft_created' as const,
  proposal_note: 'Sandbox evidence package.',
  created_at: '2026-01-01T00:15:00Z',
  updated_at: '2026-01-01T00:15:00Z',
  audit_event_id: 'aud_proposal',
};

const rolloutProposalPassed = {
  ...rolloutProposalDraft,
  proposal_status: 'dry_run_passed' as const,
  dry_run_result: 'passed' as const,
  dry_run_checked_at: '2026-01-01T00:20:00Z',
  updated_at: '2026-01-01T00:20:00Z',
  audit_event_id: 'aud_dry_run',
};

const agenticOrgPreview = {
  merchant_id: 'mch_1',
  tenant_id: 'cten_1',
  merchant_reference: 'mch_1',
  display_name: 'Grantex Store',
  integration_status: 'sandbox_handoff_ready' as const,
  handoff_requested_at: null,
  handoff_request_actor: null,
  handoff_withdrawn_at: null,
  handoff_withdraw_actor: null,
  audit_event_id: null,
  generated_at: '2026-01-01T00:21:00Z',
  merchant: sandboxOnboarding.agent_facing_preview.merchant,
  readiness_summary: sandboxOnboarding.agent_facing_preview.readiness_summary,
  agent_facing_preview_summary: {
    preview_status: 'ready' as const,
    preview_blockers: [],
    sample_product_count: 1,
    allowed_preview_capabilities: sandboxOnboarding.agent_facing_preview.allowed_preview_capabilities,
    blocked_capabilities: sandboxOnboarding.agent_facing_preview.blocked_capabilities,
  },
  rollout_proposal_summary: {
    proposal_status: 'dry_run_passed' as const,
    dry_run_result: 'passed' as const,
    dry_run_checked_at: '2026-01-01T00:20:00Z',
    operator_decision: 'rollout_proposal_ready' as const,
    proposal_audit_event_id: 'aud_dry_run',
  },
  evidence_checklist: [
    { key: 'rollout_proposal_dry_run_passed', label: 'Rollout proposal dry-run passed', status: 'pass' as const },
    { key: 'agenticorg_public_discovery_disabled', label: 'AgenticOrg public discovery disabled', status: 'pass' as const },
    { key: 'buyer_agent_handoff_is_sandbox_only', label: 'Buyer-agent handoff is sandbox-only', status: 'pass' as const },
  ],
  sample_products: sandboxOnboarding.agent_facing_preview.sample_products,
  allowed_buyer_agent_capabilities: [
    'read_only_profile_discovery_preview',
    'read_only_catalog_discovery_preview',
    'buyer_agent_readiness_context',
  ] as const,
  blocked_buyer_agent_capabilities: [
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    'live_plural',
    'provider_credentials',
    'order_fulfillment',
    'refunds_returns_execution',
    'production_allowlist',
    'direct_merchant_system_access',
  ] as const,
  blockers: [],
  remediation_items: [],
  sandbox_only: true as const,
  handoff_request_is_approval: false as const,
  buyer_agent_discovery_is_public: false as const,
  agenticorg_public_discovery_enabled: false as const,
  public_discovery_enabled: false as const,
  checkout_payment_enabled: false as const,
  live_provider_enabled: false as const,
  live_plural_enabled: false as const,
  production_allowlist_written: false as const,
  live_mode_status: 'not_live' as const,
  production_approval_status: 'not_approved' as const,
  rollout_status: 'rollout_not_requested' as const,
};

const schemaOrgPreview = {
  status: 'preview_only' as const,
  message: 'Schema.org JSON-LD preview was generated from public-safe Grantex catalog evidence.',
  preview_only: true as const,
  publication_status: 'not_published' as const,
  schemaorg_publication_enabled: false as const,
  public_discovery_enabled: false as const,
  checkout_payment_enabled: false as const,
  live_provider_enabled: false as const,
  live_plural_enabled: false as const,
  production_allowlist_written: false as const,
  live_mode_status: 'not_live' as const,
  production_approval_status: 'not_approved' as const,
  certification_claims: [] as const,
  generated_at: '2026-01-01T00:22:00Z',
  jsonld: {
    '@context': 'https://schema.org' as const,
    '@graph': [{
      '@type': 'Product' as const,
      name: 'Sandbox induction cooktop',
      description: 'Sandbox appliance catalog item.',
      category: 'electronics_appliances',
      brand: { '@type': 'Brand' as const, name: 'Acme Home' },
      offers: [{
        '@type': 'Offer' as const,
        price: '1299.00',
        priceCurrency: 'INR',
        availability: 'https://schema.org/InStock',
        hasMerchantReturnPolicy: {
          '@type': 'MerchantReturnPolicy' as const,
          description: 'Returns accepted within seven days.',
          applicableCountry: 'IN',
        },
      }],
    }],
  },
  included_types: ['Product', 'Offer', 'MerchantReturnPolicy'] as const,
  omitted_types: ['OfferShippingDetails'] as const,
  allowed_capabilities: ['schemaorg_jsonld_preview_read'] as const,
  blocked_capabilities: [
    'schemaorg_publication',
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    'live_plural',
    'provider_credentials',
    'production_allowlist',
  ] as const,
  blockers: ['schemaorg_shipping_details_evidence_missing'],
  remediation_items: ['Add public-safe shipping evidence before including OfferShippingDetails objects.'],
  source_reference: {
    system: 'grantex' as const,
    canonical_state: 'merchant_catalog_readiness' as const,
    endpoint_template: '/v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview' as const,
    tenant_scoped: true as const,
  },
  evidence_summary: {
    product_count: 1,
    offer_count: 1,
    return_policy_count: 1,
    shipping_details_count: 0,
    omitted_unsafe_field_count: 0,
    readiness_state: 'submitted_for_review',
    read_only: true as const,
    public_safe: true as const,
  },
};

const connectorDryRun = {
  dry_run_id: 'cdry_C6SB',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  connector_type: 'csv' as const,
  source_label: 'portal_manual_catalog_snapshot',
  status: 'passed' as const,
  sandbox_only: true as const,
  not_live: true as const,
  not_approved: true as const,
  public_discovery_enabled: false as const,
  checkout_payment_enabled: false as const,
  live_provider_enabled: false as const,
  live_plural_enabled: false as const,
  rows_received: 1,
  products_detected: 1,
  variants_detected: 1,
  would_create_count: 1,
  would_update_count: 0,
  would_archive_count: 0,
  blocked_count: 0,
  warning_count: 0,
  normalized_preview: [{
    source_product_ref: 'portal_fixture_001',
    title: 'Portal Sandbox Fixture Product',
    brand: 'Synthetic Fixture',
    description: 'Public-safe local fixture row for connector dry-run rehearsal.',
    image_url: null,
    category_preset: 'electronics_appliances',
    variants: [{
      sku: 'PORTAL-FIXTURE-001',
      variant_title: null,
      price_amount: 1299,
      currency: 'INR',
      availability_status: 'in_stock' as const,
      warranty_summary: 'Sandbox fixture warranty summary.',
      return_policy_summary: 'Sandbox fixture return summary.',
    }],
  }],
  blockers: [],
  warnings: [],
  requested_audit_event_id: 'caud_C6SB_REQUESTED',
  audit_event_id: 'caud_C6SB_COMPLETED',
  generated_at: '2026-01-01T00:40:00Z',
  created_at: '2026-01-01T00:40:00Z',
};

const connectorReview = {
  review_id: 'cdrev_C6SB',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  dry_run_id: 'cdry_C6SB',
  status: 'pending_operator_review' as const,
  decision: null,
  decision_note: null,
  requested_by: { kind: 'operator' as const, id: 'dev_TEST' },
  decided_by_operator_id: null,
  dry_run_status: 'passed' as const,
  dry_run_generated_at: '2026-01-01T00:40:00Z',
  evidence_summary: { rows_received: 1, blocked_count: 0, warning_count: 0 },
  requested_audit_event_id: 'caud_C6SB_REVIEW_REQUESTED',
  audit_event_id: null,
  controls: {
    sandbox_only: true as const,
    not_live: true as const,
    not_approved: true as const,
    public_discovery_enabled: false as const,
    checkout_payment_enabled: false as const,
    live_provider_enabled: false as const,
    live_plural_enabled: false as const,
    production_allowlist_written: false as const,
    review_is_production_approval: false as const,
    review_enables_connector_execution: false as const,
  },
  created_at: '2026-01-01T00:41:00Z',
  updated_at: '2026-01-01T00:41:00Z',
  decided_at: null,
};

const connectorReviewAccepted = {
  ...connectorReview,
  status: 'accepted_for_sandbox_followup' as const,
  decision: 'accepted_for_sandbox_followup' as const,
  decision_note: 'Sandbox follow-up only.',
  decided_by_operator_id: 'dev_TEST',
  audit_event_id: 'caud_C6SB_DECISION',
  decided_at: '2026-01-01T00:42:00Z',
};

const credential = {
  id: 'cpcred_1',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  provider_key: 'mock' as const,
  environment: 'sandbox' as const,
  credential_ref: 'mock_ref_1',
  secret_version: 1,
  status: 'valid' as const,
  last_validated_at: '2026-01-01T00:00:00Z',
  last_validation_error: null,
  capabilities: ['payment_intents'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  rotated_at: null,
  encrypted_secret_blob: 'encrypted-secret-must-not-render',
};

const agent = {
  id: 'cag_1',
  tenant_id: 'cten_1',
  display_name: 'AgenticOrg Sales',
  agent_type: 'sales',
  public_key_jwk: null,
  trust_status: 'trusted' as const,
  status: 'active' as const,
  disabled_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const product = {
  id: 'cprd_1',
  product_id: 'TOASTER-V1',
  merchant_id: 'mch_1',
  title: 'Acme Toaster',
  brand: 'Acme',
  image_url: null,
  category_preset: 'electronics_appliances',
  updated_at: '2026-01-01T00:00:00Z',
  variants_summary: [{
    variant_id: 'cvar_1',
    sku: 'TOASTER-V1-WHITE',
    variant_title: 'White',
    model: 'T100',
    price_amount: 250000,
    currency: 'INR',
    availability_status: 'in_stock' as const,
    last_synced_at: '2026-01-01T00:00:00Z',
    stale: false,
    freshness: 'fresh' as const,
  }],
};

const webhookSource = {
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  source_key: 'erp_sync',
  display_name: 'ERP Sync',
  status: 'active' as const,
  secret_last_rotated_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  secret_hash: 'redacted-hash-must-not-render',
};

const health = {
  status: 'degraded' as const,
  checked_at: '2026-01-01T00:00:00Z',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  environment: 'sandbox' as const,
  checks: {
    api: { ok: true },
    database: { ok: true },
    provider_adapters: {
      mock: { ok: true, status: 'healthy' },
      plural: { ok: false, status: 'blocked' },
    },
    reconciliation_worker: { ok: true },
    webhook_backlog: { backlog_count: 1, recent_failure_count: 0 },
  },
  blockers: ['plural_signature_scheme_unconfirmed', 'live_payments_disabled'],
};

const failedWebhookEvent = {
  id: 'cwh_failed',
  tenant_id: 'cten_1',
  provider_key: 'mock' as const,
  merchant_id: 'mch_1',
  payment_intent_id: 'cpi_pending',
  provider_payment_id: 'mock_pay_1',
  provider_event_id: 'evt_failed',
  provider_event_type: 'payment.updated',
  signature_validation_status: 'valid' as const,
  replay_status: 'fresh' as const,
  processing_status: 'failed' as const,
  payload_hash: 'hash_safe',
  error_code: 'invalid_payment_status_transition',
  error_message: 'safe error',
  attempt_count: 1,
  received_at: '2026-01-01T00:02:00Z',
  processed_at: null,
  updated_at: '2026-01-01T00:03:00Z',
  replay_available: false,
  replay_blocker: 'encrypted_payload_not_available',
  replay_count: 0,
  last_replayed_at: null,
  raw_payload_ref: 'raw-payload-ref-must-not-render',
  raw_signature: 'signature-must-not-render',
};

const replayableWebhookEvent = {
  ...failedWebhookEvent,
  id: 'cwh_replayable',
  provider_event_id: 'evt_replayable',
  replay_available: true,
  replay_blocker: null,
  replay_count: 1,
  last_replayed_at: '2026-01-01T00:04:00Z',
};

describe('CommercePayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommercePaymentIntents.mockResolvedValue({ items: [payment], next_cursor: null });
    mockReconcileCommercePaymentIntent.mockResolvedValue({ data: { ...payment, status: 'paid' }, reconciliation: {} });
    mockReplayCommerceProviderWebhookEvent.mockResolvedValue({
      data: { status: 'processed', event_id: 'cwh_replayable', provider_event_id: 'evt_replayable', payment_intent_id: 'cpi_pending', payment_status: 'paid' },
      audit_event_id: 'aud_replay',
    });
  });

  it('lists payment intents and exposes manual reconcile for pending payments', async () => {
    const user = userEvent.setup();
    r(<CommercePayments />);
    await waitFor(() => expect(screen.getByText('cpi_pending')).toBeInTheDocument());
    expect(screen.getByText('Live payments and Plural remain blocked')).toBeInTheDocument();
    expect(screen.getAllByText('payment_pending').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(mockReconcileCommercePaymentIntent).toHaveBeenCalledWith('cpi_pending'));
    expect(mockShow).toHaveBeenCalledWith('Payment reconciliation completed', 'success');
  });

  it('shows empty and error states', async () => {
    mockListCommercePaymentIntents.mockResolvedValueOnce({ items: [], next_cursor: null });
    r(<CommercePayments />);
    await waitFor(() => expect(screen.getByText('No payment intents')).toBeInTheDocument());

    mockListCommercePaymentIntents.mockRejectedValueOnce(new Error('fail'));
    r(<CommercePayments />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce payments', 'error'));
  });
});

describe('CommerceOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceOpsHealth.mockResolvedValue(health);
    mockListCommercePaymentIntents.mockResolvedValue({ items: [payment], next_cursor: null });
    mockListCommerceProviderWebhookEvents.mockResolvedValue({
      items: [failedWebhookEvent],
      next_cursor: null,
      replay_available: false,
      replay_blocker: 'encrypted_payload_not_available',
    });
    mockReconcileCommercePaymentIntent.mockResolvedValue({ data: { ...payment, status: 'paid' }, reconciliation: {} });
  });

  it('shows SLA readiness, stuck payments, and failed webhook metadata without raw payloads', async () => {
    const user = userEvent.setup();
    r(<CommerceOps />);
    await waitFor(() => expect(screen.getByText('Payment intent create')).toBeInTheDocument());
    expect(screen.getByText('10 RPS, p95 < 500 ms')).toBeInTheDocument();
    expect(screen.getByText('measured')).toBeInTheDocument();
    expect(screen.getByText('passing')).toBeInTheDocument();
    expect(screen.getAllByText('not-yet-measured').length).toBeGreaterThan(0);
    expect(screen.getByText('Plural live readiness')).toBeInTheDocument();
    expect(screen.getAllByText('cpi_pending').length).toBeGreaterThan(0);
    expect(screen.getByText('evt_failed')).toBeInTheDocument();
    expect(screen.getByText('Replay blocked')).toBeInTheDocument();
    expect(screen.queryByText('raw-payload-ref-must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('signature-must-not-render')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(mockReconcileCommercePaymentIntent).toHaveBeenCalledWith('cpi_pending'));
  });

  it('requires reason and calls provider webhook replay without rendering raw material', async () => {
    mockListCommerceProviderWebhookEvents.mockResolvedValueOnce({
      items: [replayableWebhookEvent],
      next_cursor: null,
      replay_available: true,
      replay_blocker: null,
    });
    const user = userEvent.setup();
    r(<CommerceOps />);
    await waitFor(() => expect(screen.getByText('evt_replayable')).toBeInTheDocument());
    expect(screen.getByText('Replay available')).toBeInTheDocument();
    expect(screen.queryByText('raw-payload-ref-must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('signature-must-not-render')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByRole('button', { name: 'Replay webhook' })).toBeDisabled();
    await user.type(screen.getByLabelText('Replay reason'), 'ops review');
    await user.click(screen.getByRole('button', { name: 'Dry-run replay' }));
    await waitFor(() => expect(mockReplayCommerceProviderWebhookEvent).toHaveBeenCalledWith('cwh_replayable', {
      reason: 'ops review',
      dryRun: true,
    }));
  });

  it('supports empty and error states', async () => {
    mockListCommercePaymentIntents.mockResolvedValueOnce({ items: [], next_cursor: null });
    mockListCommerceProviderWebhookEvents.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      replay_available: false,
      replay_blocker: 'blocked',
    });
    r(<CommerceOps />);
    await waitFor(() => expect(screen.getByText('No stuck pending payments')).toBeInTheDocument());
    expect(screen.getByText('No failed webhook events')).toBeInTheDocument();

    mockGetCommerceOpsHealth.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceOps />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce operations readiness', 'error'));
  });
});

describe('CommerceAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommerceAuditEvents.mockResolvedValue({ items: [auditEvent], next_cursor: null });
  });

  it('shows read-only commerce audit events and filters by payment intent evidence', async () => {
    const user = userEvent.setup();
    r(<CommerceAudit />);
    await waitFor(() => expect(screen.getByText('payment_intent.created')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /revoke|disable|delete/i })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Payment intent search'), 'missing');
    expect(screen.getByText('No commerce audit events')).toBeInTheDocument();
  });

  it('shows an error toast when audit loading fails', async () => {
    mockListCommerceAuditEvents.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceAudit />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce audit events', 'error'));
  });
});

describe('CommercePassports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommercePassports.mockResolvedValue({ items: [checkoutPassport, browsePassport], next_cursor: null });
    mockRevokeCommercePassport.mockResolvedValue({
      data: { jti: 'cpsp_checkout', revoked: true, reason: 'dashboard_emergency_review' },
      audit_event_id: 'aud_1',
    });
  });

  it('distinguishes browse and checkout passports without rendering raw tokens', async () => {
    r(<CommercePassports />);
    await waitFor(() => expect(screen.getByText('cpsp_checkout')).toBeInTheDocument());
    expect(screen.getByText('checkout')).toBeInTheDocument();
    expect(screen.getByText('browse')).toBeInTheDocument();
    expect(screen.queryByText('raw-passport-token-must-not-render')).not.toBeInTheDocument();
  });

  it('confirms and revokes an active passport through the API', async () => {
    const user = userEvent.setup();
    r(<CommercePassports />);
    await waitFor(() => expect(screen.getByText('cpsp_checkout')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    await user.click(revokeButtons[revokeButtons.length - 1]!);
    await waitFor(() => expect(mockRevokeCommercePassport).toHaveBeenCalledWith({
      jti: 'cpsp_checkout',
      reason: 'dashboard_emergency_review',
    }));
  });
});

describe('CommerceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceMerchant.mockResolvedValue({ data: merchant });
    mockListCommerceProviderCredentials.mockResolvedValue({ items: [credential], next_cursor: null });
    mockGetCommerceOpsHealth.mockResolvedValue(health);
    mockDisableMerchantAgenticCommerce.mockResolvedValue({
      data: { merchant_id: 'mch_1', agentic_commerce_enabled: false, disabled: true },
      audit_event_id: 'aud_1',
    });
    mockEnableMerchantAgenticCommerce.mockResolvedValue({
      data: { merchant_id: 'mch_1', agentic_commerce_enabled: true, disabled: false, reviewed_policy_id: 'cpol_1' },
      audit_event_id: 'aud_reenabled',
    });
    mockValidateCommerceProviderCredential.mockResolvedValue({ data: credential, audit_event_id: 'aud_2' });
  });

  it('loads merchant settings, provider status, and redacted credential metadata', async () => {
    const user = userEvent.setup();
    r(<CommerceSettings />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load settings' }));
    await waitFor(() => expect(screen.getByText('Grantex Store')).toBeInTheDocument());
    expect(screen.getByText('cpcred_1')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('live_payments_disabled')).toBeInTheDocument();
    expect(screen.queryByText('encrypted-secret-must-not-render')).not.toBeInTheDocument();
  });

  it('validates credentials and confirms emergency disable', async () => {
    const user = userEvent.setup();
    r(<CommerceSettings />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load settings' }));
    await waitFor(() => expect(screen.getByText('cpcred_1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(mockValidateCommerceProviderCredential).toHaveBeenCalledWith('cpcred_1'));
    await user.click(screen.getByRole('button', { name: 'Emergency disable' }));
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(mockDisableMerchantAgenticCommerce).toHaveBeenCalledWith('mch_1', 'dashboard_emergency_disable'));
  });

  it('requires reviewed policy evidence before emergency re-enable', async () => {
    mockGetCommerceMerchant.mockResolvedValueOnce({ data: { ...merchant, agentic_commerce_enabled: false } });
    const user = userEvent.setup();
    r(<CommerceSettings />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load settings' }));
    await waitFor(() => expect(screen.getByText('Emergency re-enable')).toBeInTheDocument());
    expect(screen.getByText(/Live payments and Plural remain disabled/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Re-enable agentic commerce' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'ops review');
    await user.type(screen.getByLabelText('Reviewed policy ID'), 'cpol_1');
    await user.click(screen.getByLabelText(/I confirm the active policy/i));
    await user.click(screen.getByRole('button', { name: 'Re-enable agentic commerce' }));
    await waitFor(() => expect(mockEnableMerchantAgenticCommerce).toHaveBeenCalledWith('mch_1', expect.objectContaining({
      reason: 'ops review',
      reviewedPolicyId: 'cpol_1',
      confirmReenable: true,
    })));
    expect(screen.queryByText(/enable live plural/i)).not.toBeInTheDocument();
  });
});

describe('CommerceOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceMerchantSandboxOnboarding.mockResolvedValue({ data: sandboxOnboarding });
    mockUpdateCommerceMerchantSandboxOnboarding.mockResolvedValue({
      data: { ...sandboxOnboarding, display_name: 'Grantex Store Updated' },
      audit_event_id: 'aud_merchant',
    });
    mockGetCommerceMerchantReadOnlyDiscoveryReview.mockResolvedValue({ data: operatorReview });
    mockGetCommerceMerchantReadOnlyDiscoveryRolloutProposal.mockResolvedValue({ data: rolloutProposal });
    mockRequestCommerceMerchantReadOnlyDiscoveryReview.mockResolvedValue({
      data: {
        ...sandboxOnboarding,
        sandbox_onboarding_state: 'submitted_for_review',
        read_only_discovery_review: {
          ...sandboxOnboarding.read_only_discovery_review,
          status: 'requested' as const,
          requested_at: '2026-01-01T00:05:00Z',
        },
      },
      audit_event_id: 'aud_review',
    });
    mockRecordCommerceReadOnlyDiscoveryReviewDecision.mockResolvedValue({
      data: {
        ...operatorReview,
        review_request_status: 'changes_requested' as const,
        operator_decision: 'changes_requested' as const,
        decision_reason: 'Improve catalog summaries.',
        remediation_items: ['Add more product grounding.'],
        decision_recorded_at: '2026-01-01T00:10:00Z',
        audit_event_id: 'aud_decision',
      },
      audit_event_id: 'aud_decision',
    });
    mockCreateCommerceMerchantReadOnlyDiscoveryRolloutProposal.mockResolvedValue({
      data: rolloutProposalDraft,
      audit_event_id: 'aud_proposal',
    });
    mockDryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal.mockResolvedValue({
      data: rolloutProposalPassed,
      audit_event_id: 'aud_dry_run',
    });
    mockWithdrawCommerceMerchantReadOnlyDiscoveryRolloutProposal.mockResolvedValue({
      data: { ...rolloutProposalDraft, proposal_status: 'withdrawn' as const, withdrawn_at: '2026-01-01T00:25:00Z' },
      audit_event_id: 'aud_withdraw',
    });
    mockGetCommerceMerchantAgenticOrgBuyerDiscoveryPreview.mockResolvedValue({ data: agenticOrgPreview });
    mockGetCommerceMerchantSchemaOrgJsonLdPreview.mockResolvedValue({ data: schemaOrgPreview });
    mockRequestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff.mockResolvedValue({
      data: {
        ...agenticOrgPreview,
        integration_status: 'sandbox_handoff_requested' as const,
        handoff_requested_at: '2026-01-01T00:25:00Z',
        audit_event_id: 'aud_agenticorg_handoff',
      },
      audit_event_id: 'aud_agenticorg_handoff',
    });
    mockWithdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff.mockResolvedValue({
      data: {
        ...agenticOrgPreview,
        integration_status: 'sandbox_handoff_withdrawn' as const,
        handoff_withdrawn_at: '2026-01-01T00:30:00Z',
        audit_event_id: 'aud_agenticorg_withdraw',
      },
      audit_event_id: 'aud_agenticorg_withdraw',
    });
    mockRunCommerceConnectorDryRun.mockResolvedValue({
      data: connectorDryRun,
      audit_events: [
        { event_type: 'connector_dry_run_requested', audit_event_id: 'caud_C6SB_REQUESTED' },
        { event_type: 'connector_dry_run_completed', audit_event_id: 'caud_C6SB_COMPLETED' },
      ],
    });
    mockRequestCommerceConnectorDryRunReview.mockResolvedValue({
      data: connectorReview,
      dry_run: connectorDryRun,
      audit_event_id: 'caud_C6SB_REVIEW_REQUESTED',
    });
    mockRecordCommerceConnectorDryRunReviewDecision.mockResolvedValue({
      data: connectorReviewAccepted,
      dry_run: connectorDryRun,
      audit_event_id: 'caud_C6SB_DECISION',
    });
    mockListCommerceAgents.mockResolvedValue({ items: [agent], next_cursor: null });
    mockListCommercePolicies.mockResolvedValue({ items: [{ id: 'cpol_1', status: 'active' }], next_cursor: null });
    mockListCommerceProducts.mockResolvedValue({ items: [product], next_cursor: null });
    mockListCommerceProviderCredentials.mockResolvedValue({ items: [credential], next_cursor: null });
    mockListCommerceWebhookSources.mockResolvedValue({ items: [webhookSource] });
    mockGetCommerceWellKnownProfile.mockResolvedValue({
      version: '1.0.0',
      merchant: { merchant_id: 'mch_1', display_name: 'Grantex Store', legal_name: 'Grantex Commerce Pvt Ltd', environment: 'sandbox', capabilities: ['catalog.search'] },
      environment: 'sandbox',
      supported_tools: ['merchant.get_profile', 'catalog.search'],
      capabilities: ['mcp_json_rpc_http'],
    });
    mockEvaluateCommercePolicy.mockResolvedValue({
      data: { decision: 'allow', reason: 'policy_allow', policy_id: 'cpol_1', policy_version: 'v1', decision_id: 'cpdec_1' },
    });
  });

  it('loads merchant onboarding checklist, saves safe profile fields, and evaluates policy without raw passport display', async () => {
    const user = userEvent.setup();
    r(<CommerceOnboarding />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load onboarding' }));
    await waitFor(() => expect(screen.getByText('Readiness checklist')).toBeInTheDocument());
    expect(mockGetCommerceMerchantSchemaOrgJsonLdPreview).toHaveBeenCalledWith('mch_1');
    expect(screen.getByText('Category preset recognized')).toBeInTheDocument();
    expect(screen.getByText('Electronics and appliances')).toBeInTheDocument();
    expect(screen.getByText('Warranty summary')).toBeInTheDocument();
    expect(screen.getAllByText('Catalog readiness').length).toBeGreaterThan(0);
    expect(screen.getByText('1 products / 2 variants')).toBeInTheDocument();
    expect(screen.getByText('Catalog products present')).toBeInTheDocument();
    expect(screen.getByText('Variant price and currency present')).toBeInTheDocument();
    expect(screen.getByText('CSV dry-run: available')).toBeInTheDocument();
    expect(screen.getByText('Bulk API dry-run: available')).toBeInTheDocument();
    expect(screen.getByText('Async import job: deferred')).toBeInTheDocument();
    expect(screen.getByText('Connector import: deferred')).toBeInTheDocument();
    expect(screen.getAllByText('Agent-facing preview').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sandbox-only read-only view/)).toBeInTheDocument();
    expect(screen.getAllByText('public_discovery_enabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('checkout_payment_enabled').length).toBeGreaterThan(0);
    expect(screen.getByText('read only profile preview')).toBeInTheDocument();
    expect(screen.getAllByText('public discovery').length).toBeGreaterThan(0);
    expect(screen.getByText('Sandbox induction cooktop')).toBeInTheDocument();
    expect(screen.getByText('Preview JSON')).toBeInTheDocument();
    expect(screen.getByText('Read-only discovery review')).toBeInTheDocument();
    expect(screen.getByText(/it is not approval, launch, public discovery, checkout/i)).toBeInTheDocument();
    expect(screen.getByText('request_is_approval')).toBeInTheDocument();
    expect(screen.getAllByText('production_allowlist_written').length).toBeGreaterThan(0);
    expect(screen.getByText('Eligibility')).toBeInTheDocument();
    expect(screen.getByText('Operator read-only discovery review')).toBeInTheDocument();
    expect(screen.getByText(/rollout_proposal_ready is a later planning gate/i)).toBeInTheDocument();
    expect(screen.getByText('operator_decision_is_approval')).toBeInTheDocument();
    expect(screen.getByText('rollout_proposal_ready_is_launch')).toBeInTheDocument();
    expect(screen.getByText('Readiness evidence')).toBeInTheDocument();
    expect(screen.getByText('Agent-facing preview status')).toBeInTheDocument();
    expect(screen.getByText('Rollout proposal')).toBeInTheDocument();
    expect(screen.getByText(/Proposal evidence is non-enabling/i)).toBeInTheDocument();
    expect(screen.getByText('proposal_is_approval')).toBeInTheDocument();
    expect(screen.getByText('dry_run_is_launch')).toBeInTheDocument();
    expect(screen.getAllByText('Evidence checklist').length).toBeGreaterThan(0);
    expect(screen.getByText('AgenticOrg buyer-agent discovery')).toBeInTheDocument();
    expect(screen.getByText(/Sandbox handoff evidence only/i)).toBeInTheDocument();
    expect(screen.getByText('agenticorg_public_discovery_enabled')).toBeInTheDocument();
    expect(screen.getByText('buyer_agent_discovery_is_public')).toBeInTheDocument();
    expect(screen.getByText('read only profile discovery preview')).toBeInTheDocument();
    expect(screen.getByText('direct merchant system access')).toBeInTheDocument();
    expect(screen.getByText('Handoff JSON')).toBeInTheDocument();
    expect(screen.getByText('Schema.org JSON-LD preview')).toBeInTheDocument();
    expect(screen.getByText(/Preview-only schema.org shape/i)).toBeInTheDocument();
    expect(screen.getByText('schemaorg_publication_enabled')).toBeInTheDocument();
    expect(screen.getByText('Schema.org blockers')).toBeInTheDocument();
    expect(screen.getByText('schemaorg shipping details evidence missing')).toBeInTheDocument();
    expect(screen.getByText('Omitted schema.org types')).toBeInTheDocument();
    expect(screen.getByText('OfferShippingDetails')).toBeInTheDocument();
    expect(screen.getByText('JSON-LD preview')).toBeInTheDocument();
    expect(screen.getByText((_content, node) => (
      node?.tagName === 'PRE'
      && node.textContent?.includes('"@context": "https://schema.org"')
    ) ?? false)).toBeInTheDocument();
    expect(screen.getByText('Merchant profile present')).toBeInTheDocument();
    expect(screen.getAllByText('No checkout/payment enablement').length).toBeGreaterThan(0);
    expect(screen.getByText('Trusted agent')).toBeInTheDocument();
    expect(screen.getByText('Mock provider credential metadata')).toBeInTheDocument();
    expect(screen.getByText('Publish/unpublish controls require a separate reviewed backend API and remain blocked.')).toBeInTheDocument();
    expect(screen.queryByText(/enable live plural/i)).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Grantex Store Updated');
    await user.click(screen.getByRole('button', { name: 'Save sandbox profile' }));
    await waitFor(() => expect(mockUpdateCommerceMerchantSandboxOnboarding).toHaveBeenCalledWith('mch_1', expect.objectContaining({
      display_name: 'Grantex Store Updated',
      agentic_commerce_requested: true,
    })));

    await user.click(screen.getByRole('button', { name: 'Request read-only discovery review' }));
    await waitFor(() => expect(mockRequestCommerceMerchantReadOnlyDiscoveryReview).toHaveBeenCalledWith('mch_1'));

    await user.type(screen.getByLabelText('Reason'), 'Improve catalog summaries.');
    await user.type(screen.getByLabelText('Remediation items'), 'Add more product grounding.');
    await user.click(screen.getByRole('button', { name: 'Record operator decision' }));
    await waitFor(() => expect(mockRecordCommerceReadOnlyDiscoveryReviewDecision).toHaveBeenCalledWith('mch_1', {
      decision: 'changes_requested',
      reason: 'Improve catalog summaries.',
      remediationItems: ['Add more product grounding.'],
    }));

    await user.click(screen.getByRole('button', { name: 'Evaluate policy' }));
    await waitFor(() => expect(mockEvaluateCommercePolicy).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: 'mch_1',
      agentId: 'cag_1',
      passportJwt: 'portal-simulator:checkout:cpsp_preview',
    })));
    expect(screen.getByText('policy_allow')).toBeInTheDocument();
    expect(screen.queryByText(/passport_jwt/i)).not.toBeInTheDocument();
  });

  it('runs connector dry-run review evidence without credential entry or live execution controls', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:c6sc-evidence');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    r(<CommerceOnboarding />);

    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load onboarding' }));
    await waitFor(() => expect(screen.getByText('Connector dry-run review')).toBeInTheDocument());

    expect(screen.getAllByText((_content, node) => (
      node?.textContent?.includes('Credential-free sandbox evidence') ?? false
    )).length).toBeGreaterThan(0);
    expect(screen.getByText('No credential entry')).toBeInTheDocument();
    expect(screen.getByText('Outbound sync off')).toBeInTheDocument();
    expect(screen.getByText('credential_entry_enabled')).toBeInTheDocument();
    expect(screen.getByText('outbound_sync_enabled')).toBeInTheDocument();
    expect(screen.getByText('production_connector_setup')).toBeInTheDocument();
    expect(screen.getByText('merchant_private_api_calls')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Credential' })).not.toBeInTheDocument();
    expect(screen.getByText('Rows parsed: 1')).toBeInTheDocument();
    expect(screen.getByText('Products estimated: 1')).toBeInTheDocument();
    expect(screen.getByText('Variants estimated: 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Validate rows' }));
    expect(mockShow).toHaveBeenCalledWith('Connector rows parsed for local sandbox dry-run', 'success');

    await user.click(screen.getByRole('button', { name: 'Run connector dry-run' }));
    await waitFor(() => expect(mockRunCommerceConnectorDryRun).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: 'mch_1',
      connectorType: 'csv',
      sourceLabel: 'portal_manual_catalog_snapshot',
      previewLimit: 5,
    })));
    const dryRunArgument = mockRunCommerceConnectorDryRun.mock.calls[0]![0];
    const serializedDryRunArgument = JSON.stringify(dryRunArgument).toLowerCase();
    for (const forbidden of [
      'credential',
      'secret',
      'provider_metadata',
      'public_discovery_enabled',
      'checkout_payment_enabled',
      'live_provider_enabled',
      'live_plural_enabled',
      'merchant_private_api',
    ]) {
      expect(serializedDryRunArgument).not.toContain(forbidden);
    }
    expect(screen.getByText('Portal Sandbox Fixture Product')).toBeInTheDocument();
    expect(screen.getByText('would create')).toBeInTheDocument();
    expect(screen.getByText('Redacted evidence handoff')).toBeInTheDocument();
    expect(screen.getByText('internal sandbox only')).toBeInTheDocument();
    expect(screen.getByText('redacted summary')).toBeInTheDocument();
    expect(screen.getByText('Sandbox follow-up readiness')).toBeInTheDocument();
    expect(screen.getByText('Evidence packet review checklist')).toBeInTheDocument();
    expect(screen.getAllByText('needs_operator_review').length).toBeGreaterThan(0);
    expect(screen.getByText('Operator review requested')).toBeInTheDocument();
    expect(screen.getByText('Schema: grantex.commerce.connector_dry_run.evidence_packet.v1')).toBeInTheDocument();
    expect(screen.getByText('Evidence JSON preview')).toBeInTheDocument();
    const evidenceJsonPreview = screen.getByText((_content, node) => (
      node?.tagName === 'PRE'
      && node.textContent?.includes('"evidence_type": "connector_dry_run_review_handoff"')
    ) ?? false);
    expect(evidenceJsonPreview).toBeInTheDocument();
    expect(evidenceJsonPreview.textContent).toContain('"schema_version": "grantex.commerce.connector_dry_run.evidence_packet.v1"');
    expect(evidenceJsonPreview.textContent).toContain('"packet_status": "needs_operator_review"');
    expect(evidenceJsonPreview.textContent).toContain('"normalized_product_titles_included": false');
    expect(evidenceJsonPreview.textContent).not.toContain('rows_json');
    expect(evidenceJsonPreview.textContent).not.toContain('Portal Sandbox Fixture Product');
    expect(evidenceJsonPreview.textContent).toContain('"public_discovery_enabled": false');
    expect(evidenceJsonPreview.textContent).toContain('"checkout_payment_enabled": false');
    expect(evidenceJsonPreview.textContent).toContain('"merchant_private_api_calls": false');

    await user.click(screen.getByRole('button', { name: 'Download JSON' }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();

    await user.type(screen.getByLabelText('Review request note'), 'Public-safe sandbox evidence.');
    await user.click(screen.getByRole('button', { name: 'Request dry-run review' }));
    await waitFor(() => expect(mockRequestCommerceConnectorDryRunReview).toHaveBeenCalledWith('mch_1', 'cdry_C6SB', {
      requestNote: 'Public-safe sandbox evidence.',
    }));
    expect(screen.getAllByText('cdrev_C6SB').length).toBeGreaterThan(0);
    expect(screen.getByText('review_is_production_approval')).toBeInTheDocument();
    expect(screen.getByText('review_enables_connector_execution')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Decision note'), 'Sandbox follow-up only.');
    await user.click(screen.getByRole('button', { name: 'Record dry-run review decision' }));
    await waitFor(() => expect(mockRecordCommerceConnectorDryRunReviewDecision).toHaveBeenCalledWith('mch_1', 'cdry_C6SB', {
      decision: 'accepted_for_sandbox_followup',
      decisionNote: 'Sandbox follow-up only.',
    }));
    expect(screen.getAllByText('caud_C6SB_DECISION').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('ready_for_sandbox_followup').length).toBeGreaterThan(0));
    const acceptedEvidenceJsonPreview = screen.getByText((_content, node) => (
      node?.tagName === 'PRE'
      && node.textContent?.includes('"packet_status": "ready_for_sandbox_followup"')
    ) ?? false);
    expect(acceptedEvidenceJsonPreview.textContent).toContain('"review_decision_audit_event_id": "caud_C6SB_DECISION"');
    expect(acceptedEvidenceJsonPreview.textContent).not.toContain('Portal Sandbox Fixture Product');
    expect(screen.queryByText('production connector setup enabled')).not.toBeInTheDocument();
    anchorClick.mockRestore();
  });

  it('validates, clears, and resets connector rows before dry-run submission', async () => {
    const user = userEvent.setup();
    r(<CommerceOnboarding />);

    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load onboarding' }));
    await waitFor(() => expect(screen.getByText('Connector dry-run review')).toBeInTheDocument());

    const rowsInput = screen.getByLabelText('Sandbox catalog rows JSON');
    fireEvent.change(rowsInput, { target: { value: '{' } });
    expect(screen.getByText('Rows parsed: 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run connector dry-run' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Validate rows' }));
    expect(mockShow).toHaveBeenCalledWith(expect.stringContaining('Rows JSON is invalid'), 'error');
    expect(mockRunCommerceConnectorDryRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear rows' }));
    expect(screen.getAllByText(/Paste at least one local sandbox row/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Run connector dry-run' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Reset sample' }));
    expect(screen.getByText('Rows parsed: 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run connector dry-run' })).not.toBeDisabled();
  });

  it('creates and dry-runs rollout proposal evidence from the operator flow', async () => {
    mockGetCommerceMerchantReadOnlyDiscoveryReview.mockResolvedValueOnce({ data: rolloutReadyOperatorReview });
    mockGetCommerceMerchantReadOnlyDiscoveryRolloutProposal.mockResolvedValueOnce({ data: rolloutProposalReady });
    const user = userEvent.setup();
    r(<CommerceOnboarding />);

    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load onboarding' }));
    await waitFor(() => expect(screen.getByText('Rollout proposal')).toBeInTheDocument());
    expect(screen.getByText('not_created')).toBeInTheDocument();
    expect(screen.getAllByText('public_discovery_enabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('checkout_payment_enabled').length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText('Proposal note'), 'Sandbox evidence package.');
    await user.click(screen.getByRole('button', { name: 'Create proposal' }));
    await waitFor(() => expect(mockCreateCommerceMerchantReadOnlyDiscoveryRolloutProposal).toHaveBeenCalledWith('mch_1', {
      proposalNote: 'Sandbox evidence package.',
    }));
    expect(screen.getByText('draft_created')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run dry run' }));
    await waitFor(() => expect(mockDryRunCommerceMerchantReadOnlyDiscoveryRolloutProposal).toHaveBeenCalledWith('mch_1', {
      proposalNote: 'Sandbox evidence package.',
    }));
    expect(screen.getByText('dry_run_passed')).toBeInTheDocument();
    expect(screen.getByText('aud_dry_run')).toBeInTheDocument();
    expect(screen.queryByText(/public discovery enabled/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Handoff note'), 'Sandbox buyer-agent handoff evidence.');
    await user.click(screen.getByRole('button', { name: 'Request AgenticOrg handoff' }));
    await waitFor(() => expect(mockRequestCommerceMerchantAgenticOrgBuyerDiscoveryHandoff).toHaveBeenCalledWith('mch_1', {
      handoffNote: 'Sandbox buyer-agent handoff evidence.',
    }));
    expect(screen.getByText('sandbox_handoff_requested')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Withdraw handoff' }));
    await waitFor(() => expect(mockWithdrawCommerceMerchantAgenticOrgBuyerDiscoveryHandoff).toHaveBeenCalledWith('mch_1', {
      reason: 'Sandbox buyer-agent handoff evidence.',
    }));
    expect(screen.getByText('sandbox_handoff_withdrawn')).toBeInTheDocument();
  });
});

describe('CommerceCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommerceProducts.mockResolvedValue({ items: [product], next_cursor: null });
    mockUpdateCommerceProduct.mockResolvedValue({ data: { ...product, variants: [] }, audit_event_id: 'aud_product' });
    mockBulkIngestCommerceProducts.mockResolvedValue({
      dry_run: true,
      summary: { total: 1, valid: 1, invalid: 0 },
      rows: [{ index: 0, product_id: 'TOASTER-CSV', status: 'valid', field_errors: {} }],
    });
  });

  it('lists products and patches selected product/variant fields', async () => {
    const user = userEvent.setup();
    r(<CommerceCatalog />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load catalog' }));
    await waitFor(() => expect(screen.getByText('Acme Toaster')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Acme Toaster Pro');
    await user.click(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(mockUpdateCommerceProduct).toHaveBeenCalledWith('TOASTER-V1', expect.objectContaining({
      title: 'Acme Toaster Pro',
      variants: [expect.objectContaining({ variant_id: 'cvar_1', price_amount: 250000 })],
    }), 'mch_1'));
  });

  it('runs local CSV validation and API bulk dry-run without production upload claims', async () => {
    const user = userEvent.setup();
    r(<CommerceCatalog />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    const csv = [
      'product_id,title,brand,category_preset,sku,price_amount,currency,availability_status,warranty_summary,return_policy_summary',
      'TOASTER-CSV,CSV Toaster,Acme,electronics_appliances,TOASTER-CSV-WHITE,-1,INR,in_stock,1 year,7 days',
    ].join('\n');
    fireEvent.change(screen.getByLabelText('CSV rows'), { target: { value: csv } });
    await user.click(screen.getByRole('button', { name: 'Local CSV dry-run' }));
    expect(screen.getByText('price_amount')).toBeInTheDocument();
    expect(mockBulkIngestCommerceProducts).not.toHaveBeenCalled();

    const validCsv = csv.replace('-1', '1000');
    fireEvent.change(screen.getByLabelText('CSV rows'), { target: { value: validCsv } });
    await user.click(screen.getByRole('button', { name: 'Local CSV dry-run' }));
    await user.click(screen.getByRole('button', { name: 'API bulk dry-run' }));
    await waitFor(() => expect(mockBulkIngestCommerceProducts).toHaveBeenCalledWith(expect.objectContaining({
      merchantId: 'mch_1',
      dryRun: true,
    })));
    expect(screen.getByText('dry-run')).toBeInTheDocument();
    expect(screen.queryByText(/production upload/i)).not.toBeInTheDocument();
  });

  it('shows empty and error states for product list', async () => {
    mockListCommerceProducts.mockResolvedValueOnce({ items: [], next_cursor: null });
    const user = userEvent.setup();
    const first = r(<CommerceCatalog />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load catalog' }));
    await waitFor(() => expect(screen.getByText('No catalog products')).toBeInTheDocument());
    first.unmount();

    mockListCommerceProducts.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceCatalog />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load catalog' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce catalog', 'error'));
  });
});

describe('CommerceWebhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommerceWebhookSources.mockResolvedValue({ items: [webhookSource] });
    mockCreateCommerceWebhookSource.mockResolvedValue({
      data: { ...webhookSource, source_key: 'shopify_sync', display_name: 'Shopify Sync', webhook_secret: 'one-time-created-value' },
      audit_event_id: 'aud_created',
    });
    mockUpdateCommerceWebhookSource.mockResolvedValue({
      data: { ...webhookSource, source_key: 'shopify_sync', display_name: 'ERP Sync v2', status: 'disabled' },
      audit_event_id: 'aud_updated',
    });
    mockRotateCommerceWebhookSourceSecret.mockResolvedValue({
      data: { ...webhookSource, webhook_secret: 'one-time-rotated-value' },
      audit_event_id: 'aud_rotated',
    });
  });

  it('lists, creates, updates, and rotates webhook sources without rendering list secret material', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    r(<CommerceWebhooks />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load webhooks' }));
    await waitFor(() => expect(screen.getByText('ERP Sync')).toBeInTheDocument());
    expect(screen.queryByText('redacted-hash-must-not-render')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Source key'), 'shopify_sync');
    await user.type(screen.getByLabelText('New display name'), 'Shopify Sync');
    await user.click(screen.getByRole('button', { name: 'Create source' }));
    await waitFor(() => expect(screen.getByText('one-time-created-value')).toBeInTheDocument());
    expect(storageSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Clear secret' }));
    expect(screen.queryByText('one-time-created-value')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'ERP Sync v2');
    await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await waitFor(() => expect(mockUpdateCommerceWebhookSource).toHaveBeenCalledWith('shopify_sync', expect.objectContaining({
      merchantId: 'mch_1',
      displayName: 'ERP Sync v2',
      status: 'disabled',
    })));

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    const rotateButtons = screen.getAllByRole('button', { name: 'Rotate' });
    await user.click(rotateButtons[rotateButtons.length - 1]!);
    await waitFor(() => expect(screen.getByText('one-time-rotated-value')).toBeInTheDocument());
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it('shows webhook empty and error states', async () => {
    mockListCommerceWebhookSources.mockResolvedValueOnce({ items: [] });
    const user = userEvent.setup();
    const first = r(<CommerceWebhooks />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load webhooks' }));
    await waitFor(() => expect(screen.getByText('No webhook sources')).toBeInTheDocument());
    first.unmount();

    mockListCommerceWebhookSources.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceWebhooks />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load webhooks' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load webhook sources', 'error'));
  });
});

describe('CommercePlayground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceWellKnownProfile.mockResolvedValue({
      version: '1.0.0',
      merchant: {
        merchant_id: 'mch_1',
        display_name: 'Grantex Store',
        legal_name: 'Grantex Commerce Pvt Ltd',
        environment: 'sandbox',
        capabilities: ['catalog.search'],
      },
      environment: 'sandbox',
      supported_tools: ['merchant.get_profile', 'catalog.search', 'payment.get_status'],
      capabilities: ['mcp_json_rpc_http'],
    });
  });

  it('loads the well-known profile and links to the static playground without certification claims', async () => {
    const user = userEvent.setup();
    r(<CommercePlayground />);
    await user.type(screen.getByLabelText('Merchant selector'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(mockGetCommerceWellKnownProfile).toHaveBeenCalledWith('mch_1'));
    expect(screen.getByText('catalog.search')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open static playground' })).toHaveAttribute('href', '/commerce-playground.html');
    expect(screen.getByText(/out of browser storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/certified|certification/i)).not.toBeInTheDocument();
  });
});
