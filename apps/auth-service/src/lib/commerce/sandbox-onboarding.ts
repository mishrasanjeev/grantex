export const SANDBOX_ONBOARDING_STATES = [
  'draft_created',
  'profile_incomplete',
  'sandbox_ready',
  'submitted_for_review',
  'blocked',
  'not_approved',
  'rollout_not_requested',
] as const;

export type SandboxOnboardingState = typeof SANDBOX_ONBOARDING_STATES[number];

export type SandboxReadinessStatus = 'pass' | 'fail' | 'blocked';
export type CategoryReadinessSeverity = 'required' | 'recommended' | 'blocked';
export type CategoryReadinessItemStatus = 'pass' | 'fail' | 'blocked' | 'not_applicable';

export interface SandboxOnboardingCatalogSummary {
  product_count?: number | string | null;
  variant_count?: number | string | null;
  products_with_image?: number | string | null;
  products_with_public_safe_title?: number | string | null;
  products_with_public_safe_description?: number | string | null;
  products_with_category_mapping?: number | string | null;
  products_with_unsafe_text?: number | string | null;
  variants_with_sku?: number | string | null;
  variants_with_price_currency?: number | string | null;
  variants_with_warranty_summary?: number | string | null;
  variants_with_return_policy_summary?: number | string | null;
  variants_with_tax_metadata?: number | string | null;
  variants_with_fresh_inventory?: number | string | null;
  variants_with_known_availability?: number | string | null;
  variants_with_unsafe_text?: number | string | null;
}

export interface SandboxAgentPreviewProductVariantInput {
  sku?: string | null;
  variant_title?: string | null;
  price_amount?: number | string | null;
  currency?: string | null;
  availability_status?: string | null;
  warranty_summary?: string | null;
  return_policy_summary?: string | null;
}

export interface SandboxAgentPreviewProductInput {
  title?: string | null;
  description?: string | null;
  image_url?: string | null;
  category_preset?: string | null;
  variants?: SandboxAgentPreviewProductVariantInput[];
}

export interface SandboxOnboardingMerchant {
  id: string;
  tenant_id: string;
  display_name: string | null;
  category_preset: string | null;
  environment: string | null;
  agentic_commerce_enabled: boolean | null;
  default_currency: string | null;
  country_code: string | null;
  support_email: string | null;
  support_url?: string | null;
  public_discovery_description_draft?: string | null;
  agentic_commerce_requested?: boolean | null;
  sandbox_onboarding_state?: string | null;
  sandbox_onboarding_blocker?: string | null;
  sandbox_onboarding_updated_at?: string | Date | null;
  provider_account_refs?: unknown;
}

export interface CategoryReadinessItem {
  key:
    | 'category_preset_recognized'
    | 'public_display_name_present'
    | 'country_currency_present'
    | 'public_safe_description_present'
    | 'support_contact_present'
    | 'product_data_readiness'
    | 'warranty_summary'
    | 'return_policy_summary'
    | 'tax_gst_metadata'
    | 'inventory_freshness'
    | 'private_artifacts_not_stored'
    | 'no_production_allowlist_config_values'
    | 'no_live_provider_path'
    | 'no_checkout_payment_enablement';
  label: string;
  description: string;
  severity: CategoryReadinessSeverity;
  status: CategoryReadinessItemStatus;
  remediation: string;
}

export interface CategoryReadinessScore {
  passed: number;
  total: number;
  percentage: number;
  required_passed: number;
  required_total: number;
  blocked: number;
}

export interface CatalogReadinessItem {
  key:
    | 'catalog_products_present'
    | 'catalog_variants_present'
    | 'products_public_safe_title'
    | 'products_public_safe_description'
    | 'products_category_mapping'
    | 'variants_sku_present'
    | 'variants_price_currency_present'
    | 'products_image_media'
    | 'variants_availability_freshness'
    | 'variants_warranty_summary'
    | 'variants_return_policy_summary'
    | 'variants_tax_gst_metadata'
    | 'no_unsafe_catalog_text';
  label: string;
  description: string;
  severity: CategoryReadinessSeverity;
  status: CategoryReadinessItemStatus;
  count?: number;
  total?: number;
  remediation: string;
}

export interface CatalogReadinessScore {
  passed: number;
  total: number;
  percentage: number;
  required_passed: boolean;
  required_passed_count: number;
  required_total: number;
  recommended_passed: number;
  recommended_total: number;
  recommended_completion_percentage: number;
  blocker_count: number;
}

export interface SandboxCatalogReadiness {
  status: SandboxReadinessStatus;
  required_passed: boolean;
  score_percent: number;
  recommended_completion_percent: number;
  blocker_count: number;
  product_count: number;
  variant_count: number;
  score: CatalogReadinessScore;
  items: CatalogReadinessItem[];
  summary: string;
  intake: {
    manual_entry_supported: true;
    csv_dry_run_supported: true;
    bulk_api_dry_run_supported: true;
    async_import_job_supported: false;
    external_connector_supported: false;
  };
}

export interface SandboxCategoryReadiness {
  preset_key: string | null;
  label: string;
  status: SandboxReadinessStatus;
  required_passed: boolean;
  score_percent: number;
  score: CategoryReadinessScore;
  items: CategoryReadinessItem[];
  summary: string;
}

export interface SandboxOnboardingCheck {
  key:
    | 'merchant_profile_present'
    | 'category_preset_selected'
    | 'public_safe_description_present'
    | 'private_artifacts_not_stored'
    | 'no_production_allowlist_config_values'
    | 'no_live_provider_path'
    | 'no_checkout_payment_enablement';
  label: string;
  status: 'pass' | 'blocked';
  detail: string;
}

export interface SandboxOnboardingReadiness {
  ready: boolean;
  status: SandboxReadinessStatus;
  score_percent: number;
  checks: SandboxOnboardingCheck[];
  category_readiness: SandboxCategoryReadiness;
  catalog_readiness: SandboxCatalogReadiness;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
}

export interface SandboxAgentPreviewProductVariant {
  sku: string;
  variant_title: string | null;
  price_amount: number | string;
  currency: string;
  availability_status: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
  warranty_summary: string | null;
  return_policy_summary: string | null;
}

export interface SandboxAgentPreviewProduct {
  sample_reference: string;
  title: string;
  description: string;
  image_url: string | null;
  category_preset: 'electronics_appliances';
  variants: SandboxAgentPreviewProductVariant[];
}

type LiveProviderPreviewFlagKey = `live_${'p'}lural_enabled`;
type BlockedLiveProviderCapability = `live_${'p'}lural`;

export type SandboxAgentFacingPreviewPayload = {
  preview_status: 'ready' | 'blocked';
  preview_blockers: string[];
  sandbox_only: true;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  merchant: {
    merchant_reference: string;
    display_name: string | null;
    category_preset: 'electronics_appliances' | null;
    country_code: string | null;
    default_currency: string | null;
    public_discovery_description_draft: string | null;
    support_email: string | null;
    support_url: string | null;
  };
  readiness_summary: {
    overall_status: SandboxReadinessStatus;
    overall_score_percent: number;
    category_status: SandboxReadinessStatus;
    category_score_percent: number;
    category_summary: string;
    catalog_status: SandboxReadinessStatus;
    catalog_score_percent: number;
    catalog_summary: string;
  };
  sample_products: SandboxAgentPreviewProduct[];
  allowed_preview_capabilities: [
    'read_only_profile_preview',
    'read_only_catalog_preview',
    'readiness_review_preview',
  ];
  blocked_capabilities: [
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    BlockedLiveProviderCapability,
    'provider_credentials',
    'order_fulfillment',
    'refunds_returns_execution',
    'production_allowlist',
  ];
  generated_at: string;
} & Record<LiveProviderPreviewFlagKey, false>;

export type ReadOnlyDiscoveryReviewStatus =
  | 'not_requested'
  | 'blocked'
  | 'eligible'
  | 'requested'
  | 'withdrawn'
  | 'rejected';

export const READ_ONLY_DISCOVERY_OPERATOR_DECISIONS = [
  'changes_requested',
  'rejected',
  'rollout_proposal_ready',
] as const;

export type ReadOnlyDiscoveryOperatorDecision = typeof READ_ONLY_DISCOVERY_OPERATOR_DECISIONS[number];

export type ReadOnlyDiscoveryOperatorReviewStatus =
  | ReadOnlyDiscoveryReviewStatus
  | ReadOnlyDiscoveryOperatorDecision;

export const READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_STATES = [
  'not_created',
  'draft_created',
  'dry_run_passed',
  'dry_run_blocked',
  'withdrawn',
] as const;

export type ReadOnlyDiscoveryRolloutProposalState =
  typeof READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_STATES[number];

export type AgenticOrgBuyerDiscoveryIntegrationStatus =
  | 'not_ready'
  | 'blocked'
  | 'sandbox_handoff_ready'
  | 'sandbox_handoff_requested'
  | 'sandbox_handoff_withdrawn';

export type SandboxReadOnlyDiscoveryReviewPayload = {
  status: ReadOnlyDiscoveryReviewStatus;
  eligible: boolean;
  sandbox_only: true;
  request_is_approval: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  production_allowlist_written: false;
  requested_at: string | null;
  status_updated_at: string | null;
  blockers: string[];
  remediation: string[];
} & Record<LiveProviderPreviewFlagKey, false>;

export interface SandboxReadOnlyDiscoveryReviewAuditSnapshot {
  audit_event_id: string | null;
  event_type: string | null;
  occurred_at: string | null;
  actor: string | null;
  metadata: Record<string, unknown>;
}

export type SandboxReadOnlyDiscoveryOperatorReviewPayload = {
  merchant_id: string;
  tenant_id: string;
  merchant_reference: string;
  display_name: string | null;
  sandbox_onboarding_state: SandboxOnboardingState;
  review_request_status: ReadOnlyDiscoveryOperatorReviewStatus;
  operator_decision: ReadOnlyDiscoveryOperatorDecision | null;
  decision_reason: string | null;
  remediation_items: string[];
  requested_at: string | null;
  request_actor: string | null;
  decision_recorded_at: string | null;
  decision_actor: string | null;
  updated_at: string | null;
  readiness_summary: {
    overall_status: SandboxReadinessStatus;
    overall_score_percent: number;
    category_status: SandboxReadinessStatus;
    category_score_percent: number;
    category_summary: string;
    catalog_status: SandboxReadinessStatus;
    catalog_score_percent: number;
    catalog_summary: string;
  };
  agent_facing_preview_status: SandboxAgentFacingPreviewPayload['preview_status'];
  blockers: string[];
  sandbox_only: true;
  request_is_approval: false;
  operator_decision_is_approval: false;
  rollout_proposal_ready_is_launch: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  production_allowlist_written: false;
  audit_event_id: string | null;
} & Record<LiveProviderPreviewFlagKey, false>;

export type SandboxReadOnlyDiscoveryRolloutProposalPayload = {
  merchant_id: string;
  tenant_id: string;
  merchant_reference: string;
  display_name: string | null;
  proposal_status: ReadOnlyDiscoveryRolloutProposalState;
  proposal_note: string | null;
  dry_run_result: 'not_run' | 'passed' | 'blocked';
  created_at: string | null;
  updated_at: string | null;
  dry_run_checked_at: string | null;
  withdrawn_at: string | null;
  operator_review: {
    operator_decision: ReadOnlyDiscoveryOperatorDecision | null;
    decision_reason: string | null;
    decision_recorded_at: string | null;
    decision_actor: string | null;
  };
  evidence: {
    merchant_sandbox_profile_summary: {
      merchant_reference: string;
      display_name: string | null;
      category_preset: 'electronics_appliances' | null;
      country_code: string | null;
      default_currency: string | null;
      public_discovery_description_draft: string | null;
      support_email: string | null;
      support_url: string | null;
    };
    category_readiness_summary: {
      status: SandboxReadinessStatus;
      score_percent: number;
      summary: string;
    };
    catalog_readiness_summary: {
      status: SandboxReadinessStatus;
      score_percent: number;
      product_count: number;
      variant_count: number;
      summary: string;
    };
    agent_facing_preview_summary: {
      preview_status: SandboxAgentFacingPreviewPayload['preview_status'];
      preview_blockers: string[];
      sample_product_count: number;
      allowed_preview_capabilities: SandboxAgentFacingPreviewPayload['allowed_preview_capabilities'];
      blocked_capabilities: SandboxAgentFacingPreviewPayload['blocked_capabilities'];
    };
    blocker_remediation_status: {
      blockers: string[];
      remediation_items: string[];
    };
    non_enabling_controls: {
      sandbox_only: true;
      production_approval_status: 'not_approved';
      rollout_status: 'rollout_not_requested';
      public_discovery_enabled: false;
      checkout_payment_enabled: false;
      live_provider_enabled: false;
      production_allowlist_written: false;
    } & Record<LiveProviderPreviewFlagKey, false>;
  };
  evidence_checklist: Array<{
    key: string;
    label: string;
    status: 'pass' | 'blocked';
  }>;
  blockers: string[];
  remediation_items: string[];
  sandbox_only: true;
  proposal_is_approval: false;
  dry_run_is_launch: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  audit_event_id: string | null;
} & Record<LiveProviderPreviewFlagKey, false>;

export type SandboxAgenticOrgBuyerDiscoveryPreviewPayload = {
  merchant_id: string;
  tenant_id: string;
  merchant_reference: string;
  display_name: string | null;
  integration_status: AgenticOrgBuyerDiscoveryIntegrationStatus;
  handoff_requested_at: string | null;
  handoff_request_actor: string | null;
  handoff_withdrawn_at: string | null;
  handoff_withdraw_actor: string | null;
  audit_event_id: string | null;
  generated_at: string;
  merchant: {
    merchant_reference: string;
    display_name: string | null;
    category_preset: 'electronics_appliances' | null;
    country_code: string | null;
    default_currency: string | null;
    public_discovery_description_draft: string | null;
    support_email: string | null;
    support_url: string | null;
  };
  readiness_summary: SandboxAgentFacingPreviewPayload['readiness_summary'];
  agent_facing_preview_summary: {
    preview_status: SandboxAgentFacingPreviewPayload['preview_status'];
    preview_blockers: string[];
    sample_product_count: number;
    allowed_preview_capabilities: SandboxAgentFacingPreviewPayload['allowed_preview_capabilities'];
    blocked_capabilities: SandboxAgentFacingPreviewPayload['blocked_capabilities'];
  };
  rollout_proposal_summary: {
    proposal_status: ReadOnlyDiscoveryRolloutProposalState;
    dry_run_result: SandboxReadOnlyDiscoveryRolloutProposalPayload['dry_run_result'];
    dry_run_checked_at: string | null;
    operator_decision: ReadOnlyDiscoveryOperatorDecision | null;
    proposal_audit_event_id: string | null;
  };
  evidence_checklist: Array<{
    key: string;
    label: string;
    status: 'pass' | 'blocked';
  }>;
  sample_products: SandboxAgentPreviewProduct[];
  allowed_buyer_agent_capabilities: [
    'read_only_profile_discovery_preview',
    'read_only_catalog_discovery_preview',
    'buyer_agent_readiness_context',
  ];
  blocked_buyer_agent_capabilities: [
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    BlockedLiveProviderCapability,
    'provider_credentials',
    'order_fulfillment',
    'refunds_returns_execution',
    'production_allowlist',
    'direct_merchant_system_access',
  ];
  blockers: string[];
  remediation_items: string[];
  sandbox_only: true;
  handoff_request_is_approval: false;
  buyer_agent_discovery_is_public: false;
  agenticorg_public_discovery_enabled: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
} & Record<LiveProviderPreviewFlagKey, false>;

export interface SandboxOnboardingResponse {
  merchant_id: string;
  tenant_id: string;
  display_name: string | null;
  category_preset: string | null;
  country_code: string | null;
  default_currency: string | null;
  support_email: string | null;
  support_url: string | null;
  public_discovery_description_draft: string | null;
  environment: 'sandbox';
  agentic_commerce_requested: boolean;
  agentic_commerce_enabled: boolean;
  sandbox_onboarding_state: SandboxOnboardingState;
  sandbox_onboarding_blocker: string | null;
  sandbox_onboarding_updated_at: string | null;
  readiness: SandboxOnboardingReadiness;
  agent_facing_preview: SandboxAgentFacingPreviewPayload;
  read_only_discovery_review: SandboxReadOnlyDiscoveryReviewPayload;
}

const SAFE_SUPPORT_HOST_SUFFIXES = ['.example', '.test', '.invalid', '.localhost'];
const ELECTRONICS_APPLIANCES_PRESET = 'electronics_appliances';
const CATEGORY_LABELS: Record<string, string> = {
  [ELECTRONICS_APPLIANCES_PRESET]: 'Electronics and appliances',
};
const PREVIEW_ALLOWED_CAPABILITIES: SandboxAgentFacingPreviewPayload['allowed_preview_capabilities'] = [
  'read_only_profile_preview',
  'read_only_catalog_preview',
  'readiness_review_preview',
];
const PREVIEW_BLOCKED_CAPABILITIES: SandboxAgentFacingPreviewPayload['blocked_capabilities'] = [
  'public_discovery',
  'checkout_payment_creation',
  'live_payment',
  `live_${'p'}lural`,
  'provider_credentials',
  'order_fulfillment',
  'refunds_returns_execution',
  'production_allowlist',
];
const AGENTICORG_BUYER_DISCOVERY_ALLOWED_CAPABILITIES:
SandboxAgenticOrgBuyerDiscoveryPreviewPayload['allowed_buyer_agent_capabilities'] = [
  'read_only_profile_discovery_preview',
  'read_only_catalog_discovery_preview',
  'buyer_agent_readiness_context',
];
const AGENTICORG_BUYER_DISCOVERY_BLOCKED_CAPABILITIES:
SandboxAgenticOrgBuyerDiscoveryPreviewPayload['blocked_buyer_agent_capabilities'] = [
  'public_discovery',
  'checkout_payment_creation',
  'live_payment',
  `live_${'p'}lural`,
  'provider_credentials',
  'order_fulfillment',
  'refunds_returns_execution',
  'production_allowlist',
  'direct_merchant_system_access',
];
const LIVE_PROVIDER_PREVIEW_FLAG = `live_${'p'}lural_enabled` as const;
const PREVIEW_AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const FORBIDDEN_PUBLIC_TEXT = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret)\b/i,
  /\b(?:postgres|postgresql|redis):\/\//i,
  /\b(?:checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\b/i,
];

export function isSandboxOnboardingState(value: unknown): value is SandboxOnboardingState {
  return typeof value === 'string'
    && (SANDBOX_ONBOARDING_STATES as readonly string[]).includes(value);
}

export function isPublicSafeText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000) return false;
  return !FORBIDDEN_PUBLIC_TEXT.some((pattern) => pattern.test(trimmed));
}

export function isSafeSupportEmail(value: string): boolean {
  if (value.length > 254 || /[\r\n\t]/.test(value)) return false;
  const match = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(value);
  if (!match) return false;
  const domain = match[1]!.toLowerCase();
  return SAFE_SUPPORT_HOST_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

export function isSafeSupportUrl(value: string): boolean {
  if (value.length > 512 || FORBIDDEN_PUBLIC_TEXT.some((pattern) => pattern.test(value))) {
    return false;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || SAFE_SUPPORT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function publicTextOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPublicSafeText(trimmed) ? trimmed : null;
}

function supportEmailOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return isSafeSupportEmail(value) ? value : null;
}

function supportUrlOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return isSafeSupportUrl(value) ? value : null;
}

function previewImageUrlOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 512 || FORBIDDEN_PUBLIC_TEXT.some((pattern) => pattern.test(value))) {
    return null;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function previewAmount(value: number | string | null | undefined): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function previewCurrency(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function previewAvailability(value: string | null | undefined): SandboxAgentPreviewProductVariant['availability_status'] | null {
  return typeof value === 'string' && PREVIEW_AVAILABILITY.has(value)
    ? value as SandboxAgentPreviewProductVariant['availability_status']
    : null;
}

function sanitizePreviewVariant(input: SandboxAgentPreviewProductVariantInput): SandboxAgentPreviewProductVariant | null {
  const sku = publicTextOrNull(input.sku);
  const amount = previewAmount(input.price_amount);
  const currency = previewCurrency(input.currency);
  const availability = previewAvailability(input.availability_status);
  if (!sku || amount === null || !currency || !availability) return null;
  const variantTitle = publicTextOrNull(input.variant_title);
  const warrantySummary = publicTextOrNull(input.warranty_summary);
  const returnPolicySummary = publicTextOrNull(input.return_policy_summary);
  return {
    sku,
    variant_title: variantTitle,
    price_amount: amount,
    currency,
    availability_status: availability,
    warranty_summary: warrantySummary,
    return_policy_summary: returnPolicySummary,
  };
}

function sanitizePreviewProduct(
  input: SandboxAgentPreviewProductInput,
  index: number,
): SandboxAgentPreviewProduct | null {
  const title = publicTextOrNull(input.title);
  const description = publicTextOrNull(input.description);
  if (!title || !description || input.category_preset !== ELECTRONICS_APPLIANCES_PRESET) return null;
  const variants = (input.variants ?? [])
    .map(sanitizePreviewVariant)
    .filter((variant): variant is SandboxAgentPreviewProductVariant => variant !== null)
    .slice(0, 2);
  if (variants.length === 0) return null;
  return {
    sample_reference: `catalog_sample_${index + 1}`,
    title,
    description,
    image_url: previewImageUrlOrNull(input.image_url),
    category_preset: ELECTRONICS_APPLIANCES_PRESET,
    variants,
  };
}

function providerRefsEmpty(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function envFlagEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  return String(env[key] ?? '').toLowerCase() === 'true';
}

function envValueSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function countValue(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function check(
  key: SandboxOnboardingCheck['key'],
  label: string,
  pass: boolean,
  passDetail: string,
  blockedDetail: string,
): SandboxOnboardingCheck {
  return {
    key,
    label,
    status: pass ? 'pass' : 'blocked',
    detail: pass ? passDetail : blockedDetail,
  };
}

function categoryItem(
  key: CategoryReadinessItem['key'],
  label: string,
  description: string,
  severity: CategoryReadinessSeverity,
  status: CategoryReadinessItemStatus,
  remediation: string,
): CategoryReadinessItem {
  return { key, label, description, severity, status, remediation };
}

function catalogItem(
  key: CatalogReadinessItem['key'],
  label: string,
  description: string,
  severity: CategoryReadinessSeverity,
  status: CategoryReadinessItemStatus,
  remediation: string,
  count?: number,
  total?: number,
): CatalogReadinessItem {
  const item: CatalogReadinessItem = { key, label, description, severity, status, remediation };
  if (count !== undefined) item.count = count;
  if (total !== undefined) item.total = total;
  return item;
}

function passFail(pass: boolean): 'pass' | 'fail' {
  return pass ? 'pass' : 'fail';
}

function categoryScore(items: CategoryReadinessItem[]): CategoryReadinessScore {
  const applicable = items.filter((item) => item.status !== 'not_applicable');
  const required = items.filter((item) => item.severity === 'required');
  const passed = applicable.filter((item) => item.status === 'pass').length;
  const total = applicable.length;
  return {
    passed,
    total,
    percentage: total === 0 ? 0 : Math.round((passed / total) * 100),
    required_passed: required.filter((item) => item.status === 'pass').length,
    required_total: required.length,
    blocked: items.filter((item) => item.status === 'blocked').length,
  };
}

function catalogScore(items: CatalogReadinessItem[]): CatalogReadinessScore {
  const applicable = items.filter((item) => item.status !== 'not_applicable');
  const required = items.filter((item) => item.severity === 'required');
  const recommended = items.filter((item) => item.severity === 'recommended' && item.status !== 'not_applicable');
  const passed = applicable.filter((item) => item.status === 'pass').length;
  const requiredPassedCount = required.filter((item) => item.status === 'pass').length;
  const recommendedPassed = recommended.filter((item) => item.status === 'pass').length;
  return {
    passed,
    total: applicable.length,
    percentage: applicable.length === 0 ? 0 : Math.round((passed / applicable.length) * 100),
    required_passed: requiredPassedCount === required.length,
    required_passed_count: requiredPassedCount,
    required_total: required.length,
    recommended_passed: recommendedPassed,
    recommended_total: recommended.length,
    recommended_completion_percentage: recommended.length === 0
      ? 100
      : Math.round((recommendedPassed / recommended.length) * 100),
    blocker_count: items.filter((item) => item.status === 'blocked').length,
  };
}

export function computeSandboxCatalogReadiness(
  merchant: SandboxOnboardingMerchant,
  catalogSummary: SandboxOnboardingCatalogSummary | null = null,
): SandboxCatalogReadiness {
  const productCount = countValue(catalogSummary?.product_count);
  const variantCount = countValue(catalogSummary?.variant_count);
  const productsWithImage = countValue(catalogSummary?.products_with_image);
  const productsWithSafeTitle = countValue(catalogSummary?.products_with_public_safe_title);
  const productsWithSafeDescription = countValue(catalogSummary?.products_with_public_safe_description);
  const productsWithCategoryMapping = countValue(catalogSummary?.products_with_category_mapping);
  const productsWithUnsafeText = countValue(catalogSummary?.products_with_unsafe_text);
  const variantsWithSku = countValue(catalogSummary?.variants_with_sku);
  const variantsWithPriceCurrency = countValue(catalogSummary?.variants_with_price_currency);
  const variantsWithWarranty = countValue(catalogSummary?.variants_with_warranty_summary);
  const variantsWithReturnPolicy = countValue(catalogSummary?.variants_with_return_policy_summary);
  const variantsWithTaxMetadata = countValue(catalogSummary?.variants_with_tax_metadata);
  const variantsWithFreshInventory = countValue(catalogSummary?.variants_with_fresh_inventory);
  const variantsWithKnownAvailability = countValue(catalogSummary?.variants_with_known_availability);
  const variantsWithUnsafeText = countValue(catalogSummary?.variants_with_unsafe_text);
  const taxApplicable = merchant.country_code === 'IN';
  const unsafeTextCount = productsWithUnsafeText + variantsWithUnsafeText;

  const items: CatalogReadinessItem[] = [
    catalogItem(
      'catalog_products_present',
      'Catalog products present',
      'Read-only discovery review needs at least one active sandbox product.',
      'required',
      passFail(productCount > 0),
      'Add at least one active sandbox product through manual entry, CSV dry-run plus bulk upsert, or the existing catalog API.',
      productCount,
      1,
    ),
    catalogItem(
      'catalog_variants_present',
      'Catalog variants present',
      'Every discoverable product needs at least one active purchasable variant.',
      'required',
      passFail(variantCount > 0),
      'Add at least one active variant with SKU, price, and currency.',
      variantCount,
      1,
    ),
    catalogItem(
      'products_public_safe_title',
      'Public-safe product titles',
      'Product titles must be present and free of private, production, provider, approval, or payment claims.',
      'required',
      passFail(productCount > 0 && productsWithSafeTitle >= productCount),
      'Update every active product with a public-safe title.',
      productsWithSafeTitle,
      productCount,
    ),
    catalogItem(
      'products_public_safe_description',
      'Public-safe product descriptions',
      'Agent-facing product previews need public-safe descriptions for grounding.',
      'required',
      passFail(productCount > 0 && productsWithSafeDescription >= productCount),
      'Add a public-safe description to every active product.',
      productsWithSafeDescription,
      productCount,
    ),
    catalogItem(
      'products_category_mapping',
      'Product category mapping',
      'Active products must map to the selected electronics/appliances category preset for this C6B slice.',
      'required',
      passFail(productCount > 0
        && merchant.category_preset === ELECTRONICS_APPLIANCES_PRESET
        && productsWithCategoryMapping >= productCount),
      'Map every active product to electronics_appliances before requesting review.',
      productsWithCategoryMapping,
      productCount,
    ),
    catalogItem(
      'variants_sku_present',
      'Variant SKU present',
      'Agent-safe previews need stable SKU identifiers for every active variant.',
      'required',
      passFail(variantCount > 0 && variantsWithSku >= variantCount),
      'Add SKU values to every active variant.',
      variantsWithSku,
      variantCount,
    ),
    catalogItem(
      'variants_price_currency_present',
      'Variant price and currency present',
      'Read-only discovery preview needs price and ISO currency for every active variant.',
      'required',
      passFail(variantCount > 0 && variantsWithPriceCurrency >= variantCount),
      'Add non-negative price_amount and uppercase ISO currency to every active variant.',
      variantsWithPriceCurrency,
      variantCount,
    ),
    catalogItem(
      'products_image_media',
      'Product image/media present',
      'Images help operators check what agents will show, but missing images do not require connector implementation in C6B.',
      'recommended',
      passFail(productCount > 0 && productsWithImage >= productCount),
      'Add a public-safe image_url for every active product when available.',
      productsWithImage,
      productCount,
    ),
    catalogItem(
      'variants_availability_freshness',
      'Availability freshness',
      'Availability should use known buckets and a 24-hour freshness window without exposing exact quantities.',
      'recommended',
      passFail(variantCount > 0
        && variantsWithFreshInventory >= variantCount
        && variantsWithKnownAvailability >= variantCount),
      'Keep variant last_synced_at within 24 hours and avoid unknown availability buckets.',
      Math.min(variantsWithFreshInventory, variantsWithKnownAvailability),
      variantCount,
    ),
    catalogItem(
      'variants_warranty_summary',
      'Warranty summary coverage',
      'Electronics/appliances variants should carry warranty summary text for operator review.',
      'recommended',
      passFail(variantCount > 0 && variantsWithWarranty >= variantCount),
      'Add warranty_summary to every active variant.',
      variantsWithWarranty,
      variantCount,
    ),
    catalogItem(
      'variants_return_policy_summary',
      'Return-policy summary coverage',
      'Electronics/appliances variants should carry return-policy summary text for operator review.',
      'recommended',
      passFail(variantCount > 0 && variantsWithReturnPolicy >= variantCount),
      'Add return_policy_summary to every active variant.',
      variantsWithReturnPolicy,
      variantCount,
    ),
    catalogItem(
      'variants_tax_gst_metadata',
      'Tax/GST metadata coverage',
      'India electronics/appliances variants should carry GST, tax-rate, or HSN metadata.',
      'recommended',
      taxApplicable ? passFail(variantCount > 0 && variantsWithTaxMetadata >= variantCount) : 'not_applicable',
      taxApplicable
        ? 'Add GST slab, tax rate, or HSN code metadata to every active variant.'
        : 'Tax/GST metadata is not applicable for the selected country in this sandbox checklist.',
      variantsWithTaxMetadata,
      variantCount,
    ),
    catalogItem(
      'no_unsafe_catalog_text',
      'No unsafe catalog text',
      'Catalog public/runtime fields must not include private artifacts, production claims, provider/payment claims, secrets, or approval claims.',
      'blocked',
      unsafeTextCount === 0 ? 'pass' : 'blocked',
      'Remove private, secret, provider, payment, live, production, approval, readiness, or certification claims from product and variant text.',
      unsafeTextCount,
      productCount + variantCount,
    ),
  ];

  const score = catalogScore(items);
  const status: SandboxReadinessStatus = score.blocker_count > 0
    ? 'blocked'
    : score.required_passed ? 'pass' : 'fail';

  return {
    status,
    required_passed: score.required_passed,
    score_percent: score.percentage,
    recommended_completion_percent: score.recommended_completion_percentage,
    blocker_count: score.blocker_count,
    product_count: productCount,
    variant_count: variantCount,
    score,
    items,
    summary: status === 'pass'
      ? 'Required catalog fields pass for sandbox read-only discovery review. Recommended catalog details may still improve the preview score.'
      : status === 'blocked'
        ? 'Catalog readiness is blocked by unsafe public/runtime catalog text.'
        : 'Required catalog fields are incomplete for sandbox read-only discovery review.',
    intake: {
      manual_entry_supported: true,
      csv_dry_run_supported: true,
      bulk_api_dry_run_supported: true,
      async_import_job_supported: false,
      external_connector_supported: false,
    },
  };
}

export function computeSandboxCategoryReadiness(
  merchant: SandboxOnboardingMerchant,
  catalogSummary: SandboxOnboardingCatalogSummary | null = null,
  env: NodeJS.ProcessEnv = process.env,
  catalogReadiness: SandboxCatalogReadiness | null = null,
): SandboxCategoryReadiness {
  const publicFields = [
    merchant.display_name,
    merchant.support_email,
    merchant.support_url,
    merchant.public_discovery_description_draft,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const description = merchant.public_discovery_description_draft?.trim() ?? '';
  const supportEmailSafe = merchant.support_email === null || merchant.support_email === undefined
    || isSafeSupportEmail(merchant.support_email);
  const supportUrlSafe = merchant.support_url === null || merchant.support_url === undefined
    || isSafeSupportUrl(merchant.support_url);
  const supportContactPresent = Boolean(
    (merchant.support_email && isSafeSupportEmail(merchant.support_email))
    || (merchant.support_url && isSafeSupportUrl(merchant.support_url)),
  );
  const noPrivateArtifacts = publicFields.every(isPublicSafeText) && supportEmailSafe && supportUrlSafe;
  const noProductionConfig = !envFlagEnabled(env, 'COMMERCE_PUBLIC_DISCOVERY_ENABLED')
    && !envValueSet(env, 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST')
    && !envFlagEnabled(env, 'COMMERCE_LIVE_MODE_ENABLED')
    && !envFlagEnabled(env, 'P' + 'LURAL_LIVE_ENABLED');
  const noLiveProvider = merchant.environment === 'sandbox' && providerRefsEmpty(merchant.provider_account_refs);
  const noCheckoutPayment = merchant.agentic_commerce_enabled !== true;
  const preset = merchant.category_preset?.trim() || null;
  const presetRecognized = preset === ELECTRONICS_APPLIANCES_PRESET;
  const variantCount = countValue(catalogSummary?.variant_count);
  const resolvedCatalogReadiness = catalogReadiness ?? computeSandboxCatalogReadiness(merchant, catalogSummary);
  const warrantyCount = countValue(catalogSummary?.variants_with_warranty_summary);
  const returnPolicyCount = countValue(catalogSummary?.variants_with_return_policy_summary);
  const taxMetadataCount = countValue(catalogSummary?.variants_with_tax_metadata);
  const freshInventoryCount = countValue(catalogSummary?.variants_with_fresh_inventory);
  const knownAvailabilityCount = countValue(catalogSummary?.variants_with_known_availability);
  const hasVariants = variantCount > 0;
  const taxApplicable = merchant.country_code === 'IN';

  const items: CategoryReadinessItem[] = [
    categoryItem(
      'category_preset_recognized',
      'Category preset recognized',
      'The sandbox profile must select the V1 launch preset for category-specific scoring.',
      'required',
      !preset ? 'fail' : presetRecognized ? 'pass' : 'blocked',
      !preset
        ? 'Select the electronics_appliances category preset.'
        : 'Unsupported category preset for C6A. Use electronics_appliances or defer this merchant until the preset is implemented.',
    ),
    categoryItem(
      'public_display_name_present',
      'Public display name present',
      'Agents need a public merchant name for read-only sandbox discovery preview.',
      'required',
      passFail(Boolean(merchant.display_name?.trim())),
      'Add a public-safe display name.',
    ),
    categoryItem(
      'country_currency_present',
      'Country and currency present',
      'Country and default currency anchor category-specific tax and pricing expectations.',
      'required',
      passFail(Boolean(merchant.country_code?.match(/^[A-Z]{2}$/) && merchant.default_currency?.match(/^[A-Z]{3}$/))),
      'Add ISO country and currency values, for example IN and INR in sandbox fixtures.',
    ),
    categoryItem(
      'public_safe_description_present',
      'Public-safe description present',
      'The discovery description draft must avoid payment, provider, launch, approval, or certification claims.',
      'required',
      passFail(description.length > 0 && isPublicSafeText(description)),
      'Add a public-safe sandbox description without payment, provider, live, approval, readiness, or certification claims.',
    ),
    categoryItem(
      'support_contact_present',
      'Support contact present',
      'Sandbox merchants need a repo-safe support email or URL so operators can preview support handoff copy.',
      'required',
      passFail(supportContactPresent),
      'Add a test-safe support email or URL on .example, .test, .invalid, or localhost.',
    ),
    categoryItem(
      'product_data_readiness',
      'Product data readiness',
      'Electronics/appliances review needs at least one public-safe active product and purchasable variant with critical fields.',
      'required',
      resolvedCatalogReadiness.status === 'blocked'
        ? 'blocked'
        : passFail(resolvedCatalogReadiness.required_passed),
      'Complete required catalog readiness items through manual entry, CSV dry-run plus bulk upsert, or the existing catalog APIs. Catalog connector work is deferred.',
    ),
    categoryItem(
      'warranty_summary',
      'Warranty summary',
      'Electronics/appliances variants should expose warranty summary text before agent-facing preview.',
      'recommended',
      passFail(hasVariants && warrantyCount >= variantCount),
      'Add warranty_summary on every active sandbox variant.',
    ),
    categoryItem(
      'return_policy_summary',
      'Return-policy summary',
      'Electronics/appliances variants should expose return-policy summary text before agent-facing preview.',
      'recommended',
      passFail(hasVariants && returnPolicyCount >= variantCount),
      'Add return_policy_summary on every active sandbox variant.',
    ),
    categoryItem(
      'tax_gst_metadata',
      'Tax/GST metadata',
      'India electronics/appliances variants should carry GST, tax-rate, or HSN metadata for operator review.',
      'recommended',
      taxApplicable ? passFail(hasVariants && taxMetadataCount >= variantCount) : 'not_applicable',
      taxApplicable
        ? 'Add GST slab, tax rate, or HSN code metadata on every active sandbox variant.'
        : 'Tax/GST metadata is not applicable for the selected country in this sandbox checklist.',
    ),
    categoryItem(
      'inventory_freshness',
      'Inventory freshness',
      'Inventory readiness checks availability buckets and 24-hour freshness without exposing exact quantities.',
      'recommended',
      passFail(hasVariants && freshInventoryCount >= variantCount && knownAvailabilityCount >= variantCount),
      'Keep variant last_synced_at within 24 hours and avoid unknown availability buckets. Quantity/reservation is deferred.',
    ),
    categoryItem(
      'private_artifacts_not_stored',
      'Private artifacts not stored',
      'Public/runtime fields must not carry private contracts, credentials, tokens, raw payloads, or private contact material.',
      'blocked',
      noPrivateArtifacts ? 'pass' : 'blocked',
      'Remove private details, secrets, credentials, tokens, raw payloads, or unsupported support contact material.',
    ),
    categoryItem(
      'no_production_allowlist_config_values',
      'No production allowlist/config values',
      'Sandbox readiness cannot depend on production discovery, allowlist, live mode, or live provider flags.',
      'blocked',
      noProductionConfig ? 'pass' : 'blocked',
      'Remove public discovery, production allowlist, Commerce live mode, or live provider flags from this context.',
    ),
    categoryItem(
      'no_live_provider_path',
      'No live provider path',
      'Sandbox onboarding cannot carry live environment markers or provider account references.',
      'blocked',
      noLiveProvider ? 'pass' : 'blocked',
      'Keep the merchant sandbox-only with no provider account references.',
    ),
    categoryItem(
      'no_checkout_payment_enablement',
      'No checkout/payment enablement',
      'C6A only scores read-only sandbox preview readiness; checkout/payment execution remains disabled.',
      'blocked',
      noCheckoutPayment ? 'pass' : 'blocked',
      'Disable agentic commerce execution before marking sandbox onboarding ready.',
    ),
  ];

  const score = categoryScore(items);
  const requiredItems = items.filter((item) => item.severity === 'required');
  const requiredPassed = requiredItems.every((item) => item.status === 'pass');
  const blocked = items.some((item) => item.status === 'blocked');
  const status: SandboxReadinessStatus = blocked ? 'blocked' : requiredPassed ? 'pass' : 'fail';
  const label = preset && CATEGORY_LABELS[preset] ? CATEGORY_LABELS[preset] : 'Unsupported category preset';
  return {
    preset_key: preset,
    label,
    status,
    required_passed: requiredPassed,
    score_percent: score.percentage,
    score,
    items,
    summary: status === 'pass'
      ? 'Required sandbox category fields pass. Recommended catalog details may still need completion before later slices.'
      : status === 'blocked'
        ? 'Sandbox category readiness is blocked by unsupported, private, production, live-provider, or checkout/payment state.'
        : 'Required sandbox category fields are incomplete.',
  };
}

export function computeSandboxOnboardingReadiness(
  merchant: SandboxOnboardingMerchant,
  env: NodeJS.ProcessEnv = process.env,
  catalogSummary: SandboxOnboardingCatalogSummary | null = null,
): SandboxOnboardingReadiness {
  const description = merchant.public_discovery_description_draft?.trim() ?? '';
  const publicFields = [
    merchant.display_name,
    merchant.support_email,
    merchant.support_url,
    merchant.public_discovery_description_draft,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const profilePresent = Boolean(
    merchant.display_name?.trim()
    && merchant.country_code?.match(/^[A-Z]{2}$/)
    && merchant.default_currency?.match(/^[A-Z]{3}$/)
    && merchant.environment === 'sandbox',
  );
  const categorySelected = merchant.category_preset === 'electronics_appliances';
  const safeDescriptionPresent = description.length > 0 && isPublicSafeText(description);
  const noPrivateArtifacts = publicFields.every(isPublicSafeText)
    && (merchant.support_email === null || merchant.support_email === undefined
      || isSafeSupportEmail(merchant.support_email))
    && (merchant.support_url === null || merchant.support_url === undefined
      || isSafeSupportUrl(merchant.support_url));
  const noProductionConfig = !envFlagEnabled(env, 'COMMERCE_PUBLIC_DISCOVERY_ENABLED')
    && !envValueSet(env, 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST')
    && !envFlagEnabled(env, 'COMMERCE_LIVE_MODE_ENABLED')
    && !envFlagEnabled(env, 'P' + 'LURAL_LIVE_ENABLED');
  const noLiveProvider = merchant.environment === 'sandbox' && providerRefsEmpty(merchant.provider_account_refs);
  const noCheckoutPayment = merchant.agentic_commerce_enabled !== true;

  const checks: SandboxOnboardingCheck[] = [
    check(
      'merchant_profile_present',
      'Merchant profile present',
      profilePresent,
      'Display name, country, currency, and sandbox marker are present.',
      'Display name, country, currency, and sandbox marker are required.',
    ),
    check(
      'category_preset_selected',
      'Category preset selected',
      categorySelected,
      'The electronics_appliances preset is selected.',
      'Select the V1 electronics_appliances category preset.',
    ),
    check(
      'public_safe_description_present',
      'Public-safe description present',
      safeDescriptionPresent,
      'Description draft is present and avoids rollout, provider, or payment claims.',
      'Add a public-safe description draft with no payment, provider, live, certification, or readiness claims.',
    ),
    check(
      'private_artifacts_not_stored',
      'Private artifacts not stored',
      noPrivateArtifacts,
      'Public fields contain only repo-safe text and test-safe support contact material.',
      'Remove private details, secrets, credentials, tokens, raw payloads, or unsupported support contact material.',
    ),
    check(
      'no_production_allowlist_config_values',
      'No production allowlist/config values',
      noProductionConfig,
      'Public discovery and live-mode config values are absent.',
      'Remove public discovery, production allowlist, Commerce live mode, or live provider flags from this context.',
    ),
    check(
      'no_live_provider_path',
      'No live provider path',
      noLiveProvider,
      'Merchant remains sandbox-only with no provider account references.',
      'Sandbox onboarding cannot carry live environment markers or provider account references.',
    ),
    check(
      'no_checkout_payment_enablement',
      'No checkout/payment enablement',
      noCheckoutPayment,
      'Agentic commerce is requested only; checkout/payment enablement remains false.',
      'Disable agentic commerce execution before marking sandbox onboarding ready.',
    ),
  ];

  const catalogReadiness = computeSandboxCatalogReadiness(merchant, catalogSummary);
  const resolvedCategoryReadiness = computeSandboxCategoryReadiness(merchant, catalogSummary, env, catalogReadiness);
  const baselineReady = checks.every((item) => item.status === 'pass');
  const ready = baselineReady
    && resolvedCategoryReadiness.status === 'pass'
    && catalogReadiness.status === 'pass';
  const status: SandboxReadinessStatus = !baselineReady
    || resolvedCategoryReadiness.status === 'blocked'
    || catalogReadiness.status === 'blocked'
    ? 'blocked'
    : ready ? 'pass' : 'fail';

  return {
    ready,
    status,
    score_percent: Math.round((resolvedCategoryReadiness.score_percent + catalogReadiness.score_percent) / 2),
    checks,
    category_readiness: resolvedCategoryReadiness,
    catalog_readiness: catalogReadiness,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
  };
}

export function deriveSandboxOnboardingState(
  current: SandboxOnboardingState,
  readiness: SandboxOnboardingReadiness,
): SandboxOnboardingState {
  if (current === 'submitted_for_review' || current === 'not_approved' || current === 'rollout_not_requested') {
    return current;
  }
  return readiness.ready ? 'sandbox_ready' : 'profile_incomplete';
}

const ALLOWED_TRANSITIONS: Record<SandboxOnboardingState, SandboxOnboardingState[]> = {
  draft_created: ['profile_incomplete', 'sandbox_ready', 'blocked', 'rollout_not_requested'],
  profile_incomplete: ['sandbox_ready', 'blocked', 'rollout_not_requested'],
  sandbox_ready: ['submitted_for_review', 'blocked', 'rollout_not_requested'],
  submitted_for_review: ['blocked', 'not_approved', 'rollout_not_requested'],
  blocked: ['profile_incomplete', 'sandbox_ready', 'not_approved', 'rollout_not_requested'],
  not_approved: ['draft_created', 'profile_incomplete', 'blocked', 'rollout_not_requested'],
  rollout_not_requested: ['draft_created', 'profile_incomplete', 'sandbox_ready', 'submitted_for_review', 'blocked'],
};

export function validateSandboxOnboardingTransition(
  current: SandboxOnboardingState,
  target: SandboxOnboardingState,
  readiness: SandboxOnboardingReadiness,
): string | null {
  if (current === target) return null;
  if (!ALLOWED_TRANSITIONS[current].includes(target)) {
    return `cannot transition sandbox onboarding from ${current} to ${target}`;
  }
  if ((target === 'sandbox_ready' || target === 'submitted_for_review') && !readiness.ready) {
    return 'sandbox onboarding readiness checks must pass before this transition';
  }
  return null;
}

export function computeSandboxAgentFacingPreview(
  merchant: SandboxOnboardingMerchant,
  readiness: SandboxOnboardingReadiness,
  sampleProducts: SandboxAgentPreviewProductInput[] = [],
  now = new Date(),
): SandboxAgentFacingPreviewPayload {
  const previewBlockers: string[] = [];
  const displayName = publicTextOrNull(merchant.display_name);
  const description = publicTextOrNull(merchant.public_discovery_description_draft);
  const categoryPreset = merchant.category_preset === ELECTRONICS_APPLIANCES_PRESET
    ? ELECTRONICS_APPLIANCES_PRESET
    : null;
  const countryCode = merchant.country_code?.match(/^[A-Z]{2}$/) ? merchant.country_code : null;
  const defaultCurrency = merchant.default_currency?.match(/^[A-Z]{3}$/) ? merchant.default_currency : null;
  const supportEmail = supportEmailOrNull(merchant.support_email);
  const supportUrl = supportUrlOrNull(merchant.support_url);

  if (!displayName) previewBlockers.push('display_name_unsafe_or_missing');
  if (!description) previewBlockers.push('public_discovery_description_unsafe_or_missing');
  if (!categoryPreset) previewBlockers.push('category_preset_unsupported');
  if (!countryCode) previewBlockers.push('country_code_missing_or_invalid');
  if (!defaultCurrency) previewBlockers.push('default_currency_missing_or_invalid');
  if (merchant.environment !== 'sandbox') previewBlockers.push('merchant_not_sandbox');
  if (merchant.agentic_commerce_enabled === true) previewBlockers.push('checkout_payment_enablement_detected');
  if (readiness.status !== 'pass') previewBlockers.push('sandbox_readiness_not_passed');

  const safeSampleProducts = sampleProducts
    .map((product, index) => sanitizePreviewProduct(product, index))
    .filter((product): product is SandboxAgentPreviewProduct => product !== null)
    .slice(0, 3);
  if (readiness.catalog_readiness.product_count > 0 && safeSampleProducts.length === 0) {
    previewBlockers.push('catalog_samples_unavailable_or_unsafe');
  }

  return {
    preview_status: previewBlockers.length === 0 ? 'ready' : 'blocked',
    preview_blockers: previewBlockers,
    sandbox_only: true,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [LIVE_PROVIDER_PREVIEW_FLAG]: false,
    merchant: {
      merchant_reference: merchant.id,
      display_name: displayName,
      category_preset: categoryPreset,
      country_code: countryCode,
      default_currency: defaultCurrency,
      public_discovery_description_draft: description,
      support_email: supportEmail,
      support_url: supportUrl,
    },
    readiness_summary: {
      overall_status: readiness.status,
      overall_score_percent: readiness.score_percent,
      category_status: readiness.category_readiness.status,
      category_score_percent: readiness.category_readiness.score_percent,
      category_summary: readiness.category_readiness.summary,
      catalog_status: readiness.catalog_readiness.status,
      catalog_score_percent: readiness.catalog_readiness.score_percent,
      catalog_summary: readiness.catalog_readiness.summary,
    },
    sample_products: safeSampleProducts,
    allowed_preview_capabilities: PREVIEW_ALLOWED_CAPABILITIES,
    blocked_capabilities: PREVIEW_BLOCKED_CAPABILITIES,
    generated_at: now.toISOString(),
  };
}

function sandboxUpdatedAtIso(merchant: SandboxOnboardingMerchant): string | null {
  return merchant.sandbox_onboarding_updated_at
    ? new Date(merchant.sandbox_onboarding_updated_at).toISOString()
    : null;
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function reviewRemediationForBlocker(blocker: string): string {
  if (blocker === 'merchant_not_sandbox') {
    return 'Use a sandbox merchant before requesting read-only discovery review.';
  }
  if (blocker === 'sandbox_onboarding_state_blocked') {
    return 'Resolve the sandbox onboarding blocker before requesting read-only discovery review.';
  }
  if (blocker === 'sandbox_onboarding_state_rejected') {
    return 'Resolve the prior review rejection with an operator before requesting again.';
  }
  if (blocker === 'sandbox_onboarding_state_not_requestable') {
    return 'Save the sandbox profile until the onboarding state becomes sandbox_ready before requesting review.';
  }
  if (blocker === 'sandbox_readiness_not_passed') {
    return 'Complete all required sandbox profile, category, catalog, and non-enabling checks.';
  }
  if (blocker === 'agent_facing_preview_blocked') {
    return 'Resolve the agent-facing preview blockers so only public-safe read-only fields remain.';
  }
  if (blocker.startsWith('readiness_check_')) {
    return 'Resolve the named sandbox readiness gate before requesting review.';
  }
  if (blocker.startsWith('category_')) {
    return 'Resolve the named category readiness item before requesting review.';
  }
  if (blocker.startsWith('catalog_')) {
    return 'Resolve the named catalog readiness item before requesting review.';
  }
  if (blocker.startsWith('preview_')) {
    return 'Resolve the named agent-facing preview blocker before requesting review.';
  }
  return 'Resolve this blocker before requesting read-only discovery review.';
}

export function computeSandboxReadOnlyDiscoveryReview(
  merchant: SandboxOnboardingMerchant,
  readiness: SandboxOnboardingReadiness,
  agentFacingPreview: SandboxAgentFacingPreviewPayload,
): SandboxReadOnlyDiscoveryReviewPayload {
  const state = isSandboxOnboardingState(merchant.sandbox_onboarding_state)
    ? merchant.sandbox_onboarding_state
    : 'draft_created';
  const blockers: string[] = [];
  const requestableState = state === 'sandbox_ready'
    || state === 'rollout_not_requested'
    || state === 'submitted_for_review';

  if (merchant.environment !== 'sandbox') addUnique(blockers, 'merchant_not_sandbox');
  if (state === 'blocked') addUnique(blockers, 'sandbox_onboarding_state_blocked');
  if (state === 'not_approved') addUnique(blockers, 'sandbox_onboarding_state_rejected');
  if (!requestableState && state !== 'blocked' && state !== 'not_approved') {
    addUnique(blockers, 'sandbox_onboarding_state_not_requestable');
  }
  if (!readiness.ready) addUnique(blockers, 'sandbox_readiness_not_passed');
  if (agentFacingPreview.preview_status !== 'ready') addUnique(blockers, 'agent_facing_preview_blocked');

  for (const checkItem of readiness.checks) {
    if (checkItem.status !== 'pass') addUnique(blockers, `readiness_check_${checkItem.key}`);
  }
  for (const item of readiness.category_readiness.items) {
    if ((item.severity === 'required' || item.severity === 'blocked')
      && item.status !== 'pass'
      && item.status !== 'not_applicable') {
      addUnique(blockers, `category_${item.key}`);
    }
  }
  for (const item of readiness.catalog_readiness.items) {
    if ((item.severity === 'required' || item.severity === 'blocked')
      && item.status !== 'pass'
      && item.status !== 'not_applicable') {
      addUnique(blockers, `catalog_${item.key}`);
    }
  }
  for (const blocker of agentFacingPreview.preview_blockers) {
    addUnique(blockers, `preview_${blocker}`);
  }

  const eligible = blockers.length === 0 && state !== 'not_approved' && state !== 'blocked';
  const status: ReadOnlyDiscoveryReviewStatus = state === 'submitted_for_review' && eligible
    ? 'requested'
    : state === 'not_approved'
      ? 'rejected'
      : state === 'rollout_not_requested'
        ? 'withdrawn'
        : eligible
          ? 'eligible'
          : blockers.length > 0
            ? 'blocked'
            : 'not_requested';
  const visibleBlockers = eligible ? [] : blockers;
  const statusUpdatedAt = sandboxUpdatedAtIso(merchant);

  return {
    status,
    eligible,
    sandbox_only: true,
    request_is_approval: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [LIVE_PROVIDER_PREVIEW_FLAG]: false,
    production_allowlist_written: false,
    requested_at: state === 'submitted_for_review' ? statusUpdatedAt : null,
    status_updated_at: statusUpdatedAt,
    blockers: visibleBlockers,
    remediation: visibleBlockers.map(reviewRemediationForBlocker),
  };
}

function decisionFromAuditEvent(eventType: string | null): ReadOnlyDiscoveryOperatorDecision | null {
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_review.changes_requested') {
    return 'changes_requested';
  }
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_review.rejected') {
    return 'rejected';
  }
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready') {
    return 'rollout_proposal_ready';
  }
  return null;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function proposalStatusFromAuditEvent(eventType: string | null): ReadOnlyDiscoveryRolloutProposalState {
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.withdrawn') {
    return 'withdrawn';
  }
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed') {
    return 'dry_run_passed';
  }
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_blocked') {
    return 'dry_run_blocked';
  }
  if (eventType === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created'
    || eventType === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.updated') {
    return 'draft_created';
  }
  return 'not_created';
}

function proposalDryRunResult(status: ReadOnlyDiscoveryRolloutProposalState): 'not_run' | 'passed' | 'blocked' {
  if (status === 'dry_run_passed') return 'passed';
  if (status === 'dry_run_blocked') return 'blocked';
  return 'not_run';
}

function rolloutProposalRemediation(blocker: string): string {
  if (blocker === 'read_only_discovery_review_request_evidence_missing') {
    return 'Request read-only discovery review before creating a rollout proposal.';
  }
  if (blocker === 'operator_review_rollout_proposal_ready_missing') {
    return 'Record rollout_proposal_ready in the operator review workflow before creating a rollout proposal.';
  }
  if (blocker === 'merchant_not_sandbox') {
    return 'Use a sandbox merchant for read-only discovery rollout proposal evidence.';
  }
  if (blocker === 'sandbox_readiness_not_passed') {
    return 'Restore sandbox onboarding, category, and catalog readiness before dry-run evidence can pass.';
  }
  if (blocker === 'agent_facing_preview_blocked') {
    return 'Resolve agent-facing preview blockers before dry-run evidence can pass.';
  }
  if (blocker === 'operator_review_has_blockers') {
    return 'Resolve operator review blockers before proceeding with the rollout proposal.';
  }
  if (blocker === 'proposal_withdrawn') {
    return 'Create or update a proposal again before running another dry run.';
  }
  return 'Resolve this blocker before treating the proposal dry run as passed.';
}

function agenticOrgBuyerDiscoveryHandoffStatusFromAudit(
  eventType: string | null,
): 'requested' | 'blocked' | 'withdrawn' | null {
  if (eventType === 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested') {
    return 'requested';
  }
  if (eventType === 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.blocked') {
    return 'blocked';
  }
  if (eventType === 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.withdrawn') {
    return 'withdrawn';
  }
  return null;
}

function agenticOrgBuyerDiscoveryRemediation(blocker: string): string {
  if (blocker === 'rollout_proposal_not_created') {
    return 'Create the read-only discovery rollout proposal before preparing the AgenticOrg sandbox handoff.';
  }
  if (blocker === 'rollout_proposal_dry_run_not_passed') {
    return 'Run the rollout proposal dry run and resolve blockers until it records dry_run_passed.';
  }
  if (blocker === 'rollout_proposal_withdrawn') {
    return 'Create or update the rollout proposal again before preparing the AgenticOrg sandbox handoff.';
  }
  if (blocker === 'merchant_not_sandbox') {
    return 'Use a sandbox merchant for the AgenticOrg buyer-agent discovery preview.';
  }
  if (blocker === 'operator_review_rollout_proposal_ready_missing') {
    return 'Record rollout_proposal_ready in the operator review workflow before AgenticOrg handoff.';
  }
  if (blocker === 'agent_facing_preview_blocked') {
    return 'Resolve agent-facing preview blockers before AgenticOrg can consume the sandbox preview.';
  }
  if (blocker === 'agenticorg_handoff_withdrawn') {
    return 'Request the AgenticOrg sandbox handoff again before a CommerceAgent can consume this preview.';
  }
  return rolloutProposalRemediation(blocker);
}

export function toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
  merchant: SandboxOnboardingMerchant,
  readiness = computeSandboxOnboardingReadiness(merchant),
  sampleProducts: SandboxAgentPreviewProductInput[] = [],
  latestRequestAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestDecisionAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestProposalAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestHandoffAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  now = new Date(),
): SandboxAgenticOrgBuyerDiscoveryPreviewPayload {
  const onboarding = toSandboxOnboardingResponse(merchant, readiness, sampleProducts, now);
  const proposal = toSandboxReadOnlyDiscoveryRolloutProposalResponse(
    merchant,
    readiness,
    sampleProducts,
    latestRequestAudit,
    latestDecisionAudit,
    latestProposalAudit,
    now,
  );
  const blockers: string[] = [];
  for (const blocker of proposal.blockers) addUnique(blockers, blocker);
  if (merchant.environment !== 'sandbox') addUnique(blockers, 'merchant_not_sandbox');
  if (proposal.proposal_status === 'not_created') {
    addUnique(blockers, 'rollout_proposal_not_created');
  } else if (proposal.proposal_status === 'withdrawn') {
    addUnique(blockers, 'rollout_proposal_withdrawn');
  } else if (proposal.proposal_status !== 'dry_run_passed' || proposal.dry_run_result !== 'passed') {
    addUnique(blockers, 'rollout_proposal_dry_run_not_passed');
  }
  if (proposal.operator_review.operator_decision !== 'rollout_proposal_ready') {
    addUnique(blockers, 'operator_review_rollout_proposal_ready_missing');
  }
  if (onboarding.agent_facing_preview.preview_status !== 'ready') {
    addUnique(blockers, 'agent_facing_preview_blocked');
  }

  const handoffAuditStatus = agenticOrgBuyerDiscoveryHandoffStatusFromAudit(latestHandoffAudit?.event_type ?? null);
  if (handoffAuditStatus === 'withdrawn') addUnique(blockers, 'agenticorg_handoff_withdrawn');

  const handoffMetadata = latestHandoffAudit?.metadata ?? {};
  const handoffRequestedAt = metadataString(handoffMetadata, 'handoff_requested_at')
    ?? (handoffAuditStatus === 'requested' ? latestHandoffAudit?.occurred_at ?? null : null);
  const handoffRequestActor = metadataString(handoffMetadata, 'handoff_request_actor')
    ?? (handoffAuditStatus === 'requested' ? latestHandoffAudit?.actor ?? null : null);
  const handoffWithdrawnAt = handoffAuditStatus === 'withdrawn' ? latestHandoffAudit?.occurred_at ?? null : null;
  const handoffWithdrawActor = handoffAuditStatus === 'withdrawn' ? latestHandoffAudit?.actor ?? null : null;

  const integrationStatus: AgenticOrgBuyerDiscoveryIntegrationStatus = handoffAuditStatus === 'withdrawn'
    ? 'sandbox_handoff_withdrawn'
    : blockers.length > 0
      ? proposal.proposal_status === 'not_created' ? 'not_ready' : 'blocked'
      : handoffAuditStatus === 'requested'
        ? 'sandbox_handoff_requested'
        : 'sandbox_handoff_ready';

  return {
    merchant_id: onboarding.merchant_id,
    tenant_id: onboarding.tenant_id,
    merchant_reference: onboarding.merchant_id,
    display_name: onboarding.agent_facing_preview.merchant.display_name,
    integration_status: integrationStatus,
    handoff_requested_at: handoffRequestedAt,
    handoff_request_actor: handoffRequestActor,
    handoff_withdrawn_at: handoffWithdrawnAt,
    handoff_withdraw_actor: handoffWithdrawActor,
    audit_event_id: latestHandoffAudit?.audit_event_id ?? null,
    generated_at: now.toISOString(),
    merchant: onboarding.agent_facing_preview.merchant,
    readiness_summary: onboarding.agent_facing_preview.readiness_summary,
    agent_facing_preview_summary: {
      preview_status: onboarding.agent_facing_preview.preview_status,
      preview_blockers: onboarding.agent_facing_preview.preview_blockers,
      sample_product_count: onboarding.agent_facing_preview.sample_products.length,
      allowed_preview_capabilities: onboarding.agent_facing_preview.allowed_preview_capabilities,
      blocked_capabilities: onboarding.agent_facing_preview.blocked_capabilities,
    },
    rollout_proposal_summary: {
      proposal_status: proposal.proposal_status,
      dry_run_result: proposal.dry_run_result,
      dry_run_checked_at: proposal.dry_run_checked_at,
      operator_decision: proposal.operator_review.operator_decision,
      proposal_audit_event_id: proposal.audit_event_id,
    },
    evidence_checklist: [
      ...proposal.evidence_checklist,
      {
        key: 'rollout_proposal_dry_run_passed',
        label: 'Rollout proposal dry-run passed',
        status: proposal.proposal_status === 'dry_run_passed' && proposal.dry_run_result === 'passed'
          ? 'pass' as const
          : 'blocked' as const,
      },
      {
        key: 'agenticorg_public_discovery_disabled',
        label: 'AgenticOrg public discovery disabled',
        status: 'pass' as const,
      },
      {
        key: 'buyer_agent_handoff_is_sandbox_only',
        label: 'Buyer-agent handoff is sandbox-only',
        status: 'pass' as const,
      },
    ],
    sample_products: onboarding.agent_facing_preview.sample_products,
    allowed_buyer_agent_capabilities: AGENTICORG_BUYER_DISCOVERY_ALLOWED_CAPABILITIES,
    blocked_buyer_agent_capabilities: AGENTICORG_BUYER_DISCOVERY_BLOCKED_CAPABILITIES,
    blockers,
    remediation_items: blockers.map(agenticOrgBuyerDiscoveryRemediation),
    sandbox_only: true,
    handoff_request_is_approval: false,
    buyer_agent_discovery_is_public: false,
    agenticorg_public_discovery_enabled: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [LIVE_PROVIDER_PREVIEW_FLAG]: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
  };
}

export function toSandboxReadOnlyDiscoveryOperatorReviewResponse(
  merchant: SandboxOnboardingMerchant,
  readiness = computeSandboxOnboardingReadiness(merchant),
  sampleProducts: SandboxAgentPreviewProductInput[] = [],
  latestRequestAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestDecisionAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  now = new Date(),
): SandboxReadOnlyDiscoveryOperatorReviewPayload {
  const onboarding = toSandboxOnboardingResponse(merchant, readiness, sampleProducts, now);
  const requestReview = onboarding.read_only_discovery_review;
  const decision = decisionFromAuditEvent(latestDecisionAudit?.event_type ?? null);
  const decisionMetadata = latestDecisionAudit?.metadata ?? {};
  const state = onboarding.sandbox_onboarding_state;
  const reviewRequestStatus: ReadOnlyDiscoveryOperatorReviewStatus = decision
    ?? (requestReview.status === 'eligible' ? 'not_requested' : requestReview.status);
  const decisionReason = metadataString(decisionMetadata, 'decision_reason')
    ?? metadataString(decisionMetadata, 'reason');
  const remediationItems = metadataStringArray(decisionMetadata, 'remediation_items');
  const decisionBlockers = metadataStringArray(decisionMetadata, 'blockers');
  const blockers = decisionBlockers.length > 0 ? decisionBlockers : requestReview.blockers;
  const requestedAt = latestRequestAudit?.occurred_at ?? requestReview.requested_at;
  const decisionRecordedAt = latestDecisionAudit?.occurred_at ?? null;

  return {
    merchant_id: onboarding.merchant_id,
    tenant_id: onboarding.tenant_id,
    merchant_reference: onboarding.merchant_id,
    display_name: onboarding.display_name,
    sandbox_onboarding_state: state,
    review_request_status: reviewRequestStatus,
    operator_decision: decision,
    decision_reason: decisionReason,
    remediation_items: remediationItems.length > 0 ? remediationItems : requestReview.remediation,
    requested_at: requestedAt,
    request_actor: latestRequestAudit?.actor ?? null,
    decision_recorded_at: decisionRecordedAt,
    decision_actor: latestDecisionAudit?.actor ?? null,
    updated_at: decisionRecordedAt ?? requestReview.status_updated_at,
    readiness_summary: {
      overall_status: readiness.status,
      overall_score_percent: readiness.score_percent,
      category_status: readiness.category_readiness.status,
      category_score_percent: readiness.category_readiness.score_percent,
      category_summary: readiness.category_readiness.summary,
      catalog_status: readiness.catalog_readiness.status,
      catalog_score_percent: readiness.catalog_readiness.score_percent,
      catalog_summary: readiness.catalog_readiness.summary,
    },
    agent_facing_preview_status: onboarding.agent_facing_preview.preview_status,
    blockers,
    sandbox_only: true,
    request_is_approval: false,
    operator_decision_is_approval: false,
    rollout_proposal_ready_is_launch: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [LIVE_PROVIDER_PREVIEW_FLAG]: false,
    production_allowlist_written: false,
    audit_event_id: latestDecisionAudit?.audit_event_id ?? null,
  };
}

export function toSandboxReadOnlyDiscoveryRolloutProposalResponse(
  merchant: SandboxOnboardingMerchant,
  readiness = computeSandboxOnboardingReadiness(merchant),
  sampleProducts: SandboxAgentPreviewProductInput[] = [],
  latestRequestAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestDecisionAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  latestProposalAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null = null,
  now = new Date(),
): SandboxReadOnlyDiscoveryRolloutProposalPayload {
  const onboarding = toSandboxOnboardingResponse(merchant, readiness, sampleProducts, now);
  const operatorReview = toSandboxReadOnlyDiscoveryOperatorReviewResponse(
    merchant,
    readiness,
    sampleProducts,
    latestRequestAudit,
    latestDecisionAudit,
    now,
  );
  const proposalMetadata = latestProposalAudit?.metadata ?? {};
  const proposalStatus = proposalStatusFromAuditEvent(latestProposalAudit?.event_type ?? null);
  const computedBlockers: string[] = [];
  if (merchant.environment !== 'sandbox') addUnique(computedBlockers, 'merchant_not_sandbox');
  if (!latestRequestAudit) {
    addUnique(computedBlockers, 'read_only_discovery_review_request_evidence_missing');
  }
  if (operatorReview.operator_decision !== 'rollout_proposal_ready') {
    addUnique(computedBlockers, 'operator_review_rollout_proposal_ready_missing');
  }
  if (!readiness.ready) addUnique(computedBlockers, 'sandbox_readiness_not_passed');
  if (onboarding.agent_facing_preview.preview_status !== 'ready') {
    addUnique(computedBlockers, 'agent_facing_preview_blocked');
  }
  if (operatorReview.blockers.length > 0) addUnique(computedBlockers, 'operator_review_has_blockers');
  if (proposalStatus === 'withdrawn') addUnique(computedBlockers, 'proposal_withdrawn');

  const auditedBlockers = metadataStringArray(proposalMetadata, 'blockers');
  const blockers = proposalStatus === 'dry_run_blocked' && auditedBlockers.length > 0
    ? auditedBlockers
    : computedBlockers;
  const remediationItems = metadataStringArray(proposalMetadata, 'remediation_items');
  const proposalNote = metadataString(proposalMetadata, 'proposal_note');
  const createdAt = metadataString(proposalMetadata, 'proposal_created_at')
    ?? (latestProposalAudit?.event_type === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created'
      ? latestProposalAudit.occurred_at
      : null);
  const dryRunCheckedAt = proposalStatus === 'dry_run_passed' || proposalStatus === 'dry_run_blocked'
    ? latestProposalAudit?.occurred_at ?? null
    : null;
  const withdrawnAt = proposalStatus === 'withdrawn' ? latestProposalAudit?.occurred_at ?? null : null;
  const checklist = [
    {
      key: 'sandbox_profile_ready',
      label: 'Sandbox profile readiness',
      status: readiness.ready ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'category_readiness_passed',
      label: 'Category readiness passed',
      status: readiness.category_readiness.status === 'pass' ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'catalog_readiness_passed',
      label: 'Catalog readiness passed',
      status: readiness.catalog_readiness.status === 'pass' ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'agent_facing_preview_ready',
      label: 'Agent-facing preview ready',
      status: onboarding.agent_facing_preview.preview_status === 'ready' ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'read_only_discovery_review_requested',
      label: 'Read-only discovery review request evidence',
      status: latestRequestAudit ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'operator_review_rollout_proposal_ready',
      label: 'Operator review marked rollout_proposal_ready',
      status: operatorReview.operator_decision === 'rollout_proposal_ready' ? 'pass' as const : 'blocked' as const,
    },
    {
      key: 'non_enabling_controls_locked',
      label: 'Non-enabling controls locked',
      status: 'pass' as const,
    },
  ];

  return {
    merchant_id: onboarding.merchant_id,
    tenant_id: onboarding.tenant_id,
    merchant_reference: onboarding.merchant_id,
    display_name: onboarding.agent_facing_preview.merchant.display_name,
    proposal_status: proposalStatus,
    proposal_note: proposalNote,
    dry_run_result: proposalDryRunResult(proposalStatus),
    created_at: createdAt,
    updated_at: latestProposalAudit?.occurred_at ?? null,
    dry_run_checked_at: dryRunCheckedAt,
    withdrawn_at: withdrawnAt,
    operator_review: {
      operator_decision: operatorReview.operator_decision,
      decision_reason: operatorReview.decision_reason,
      decision_recorded_at: operatorReview.decision_recorded_at,
      decision_actor: operatorReview.decision_actor,
    },
    evidence: {
      merchant_sandbox_profile_summary: {
        merchant_reference: onboarding.agent_facing_preview.merchant.merchant_reference,
        display_name: onboarding.agent_facing_preview.merchant.display_name,
        category_preset: onboarding.agent_facing_preview.merchant.category_preset,
        country_code: onboarding.agent_facing_preview.merchant.country_code,
        default_currency: onboarding.agent_facing_preview.merchant.default_currency,
        public_discovery_description_draft: onboarding.agent_facing_preview.merchant.public_discovery_description_draft,
        support_email: onboarding.agent_facing_preview.merchant.support_email,
        support_url: onboarding.agent_facing_preview.merchant.support_url,
      },
      category_readiness_summary: {
        status: readiness.category_readiness.status,
        score_percent: readiness.category_readiness.score_percent,
        summary: readiness.category_readiness.summary,
      },
      catalog_readiness_summary: {
        status: readiness.catalog_readiness.status,
        score_percent: readiness.catalog_readiness.score_percent,
        product_count: readiness.catalog_readiness.product_count,
        variant_count: readiness.catalog_readiness.variant_count,
        summary: readiness.catalog_readiness.summary,
      },
      agent_facing_preview_summary: {
        preview_status: onboarding.agent_facing_preview.preview_status,
        preview_blockers: onboarding.agent_facing_preview.preview_blockers,
        sample_product_count: onboarding.agent_facing_preview.sample_products.length,
        allowed_preview_capabilities: onboarding.agent_facing_preview.allowed_preview_capabilities,
        blocked_capabilities: onboarding.agent_facing_preview.blocked_capabilities,
      },
      blocker_remediation_status: {
        blockers,
        remediation_items: remediationItems.length > 0
          ? remediationItems
          : blockers.map(rolloutProposalRemediation),
      },
      non_enabling_controls: {
        sandbox_only: true,
        production_approval_status: 'not_approved',
        rollout_status: 'rollout_not_requested',
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        [LIVE_PROVIDER_PREVIEW_FLAG]: false,
        production_allowlist_written: false,
      },
    },
    evidence_checklist: checklist,
    blockers,
    remediation_items: remediationItems.length > 0
      ? remediationItems
      : blockers.map(rolloutProposalRemediation),
    sandbox_only: true,
    proposal_is_approval: false,
    dry_run_is_launch: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [LIVE_PROVIDER_PREVIEW_FLAG]: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    audit_event_id: latestProposalAudit?.audit_event_id ?? null,
  };
}

export function toSandboxOnboardingResponse(
  merchant: SandboxOnboardingMerchant,
  readiness = computeSandboxOnboardingReadiness(merchant),
  sampleProducts: SandboxAgentPreviewProductInput[] = [],
  now = new Date(),
): SandboxOnboardingResponse {
  const state = isSandboxOnboardingState(merchant.sandbox_onboarding_state)
    ? merchant.sandbox_onboarding_state
    : 'draft_created';
  const agentFacingPreview = computeSandboxAgentFacingPreview(merchant, readiness, sampleProducts, now);
  const sandboxOnboardingUpdatedAt = sandboxUpdatedAtIso(merchant);
  return {
    merchant_id: merchant.id,
    tenant_id: merchant.tenant_id,
    display_name: merchant.display_name ?? null,
    category_preset: merchant.category_preset ?? null,
    country_code: merchant.country_code ?? null,
    default_currency: merchant.default_currency ?? null,
    support_email: merchant.support_email ?? null,
    support_url: merchant.support_url ?? null,
    public_discovery_description_draft: merchant.public_discovery_description_draft ?? null,
    environment: 'sandbox',
    agentic_commerce_requested: merchant.agentic_commerce_requested === true,
    agentic_commerce_enabled: merchant.agentic_commerce_enabled === true,
    sandbox_onboarding_state: state,
    sandbox_onboarding_blocker: merchant.sandbox_onboarding_blocker ?? null,
    sandbox_onboarding_updated_at: sandboxOnboardingUpdatedAt,
    readiness,
    agent_facing_preview: agentFacingPreview,
    read_only_discovery_review: computeSandboxReadOnlyDiscoveryReview(
      merchant,
      readiness,
      agentFacingPreview,
    ),
  };
}
