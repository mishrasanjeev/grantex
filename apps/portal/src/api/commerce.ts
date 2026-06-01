import { api } from './client';

export type CommercePaymentStatus =
  | 'created'
  | 'authorized'
  | 'checkout_created'
  | 'payment_pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type CommerceEnvironment = 'sandbox' | 'live';
export type CommerceProviderKey = 'mock' | 'plural';
export type SandboxOnboardingState =
  | 'draft_created'
  | 'profile_incomplete'
  | 'sandbox_ready'
  | 'submitted_for_review'
  | 'blocked'
  | 'not_approved'
  | 'rollout_not_requested';

export interface CommercePaymentIntent {
  id: string;
  payment_intent_id?: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  cart_id: string;
  passport_jti: string;
  amount: number | string;
  amount_minor_units?: number | string;
  currency: string;
  provider: CommerceProviderKey;
  provider_environment: CommerceEnvironment;
  provider_payment_id: string | null;
  provider_order_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  status: CommercePaymentStatus;
  policy_version: string | null;
  decision_id: string | null;
  provider_raw_status: string | null;
  idempotency_key_hash?: string | null;
  reconciled_at: string | null;
  last_reconciliation_attempt_at: string | null;
  last_reconciliation_error: string | null;
  last_reconciliation_retryable: boolean | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceAuditEvent {
  id: string;
  tenant_id: string;
  merchant_id: string | null;
  agent_id: string | null;
  user_principal_id: string | null;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  passport_jti: string | null;
  policy_version: string | null;
  decision_id: string | null;
  idempotency_key_hash: string | null;
  request_id: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export interface CommercePassport {
  jti: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  passport_type: 'browse' | 'checkout';
  subject: string;
  scopes: string[];
  max_amount: number | string | null;
  currency: string | null;
  environment: CommerceEnvironment;
  issued_at: string;
  expires_at: string;
  revoked: boolean;
  revocation_reason: string | null;
}

export interface CommerceMerchant {
  id: string;
  tenant_id: string;
  legal_name: string;
  display_name: string;
  category_preset: string;
  verification_status: string;
  environment: CommerceEnvironment;
  agentic_commerce_enabled: boolean;
  default_currency: string;
  country_code: string;
  support_email: string | null;
  support_url?: string | null;
  public_discovery_description_draft?: string | null;
  agentic_commerce_requested?: boolean;
  sandbox_onboarding_state?: SandboxOnboardingState;
  sandbox_onboarding_blocker?: string | null;
  sandbox_onboarding_updated_at?: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommerceSandboxOnboardingCheck {
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

export interface CommerceCategoryReadinessItem {
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
  severity: 'required' | 'recommended' | 'blocked';
  status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  remediation: string;
}

export interface CommerceCategoryReadiness {
  preset_key: string | null;
  label: string;
  status: 'pass' | 'fail' | 'blocked';
  required_passed: boolean;
  score_percent: number;
  score: {
    passed: number;
    total: number;
    percentage: number;
    required_passed: number;
    required_total: number;
    blocked: number;
  };
  items: CommerceCategoryReadinessItem[];
  summary: string;
}

export interface CommerceCatalogReadinessItem {
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
  severity: 'required' | 'recommended' | 'blocked';
  status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  count?: number;
  total?: number;
  remediation: string;
}

export interface CommerceCatalogReadiness {
  status: 'pass' | 'fail' | 'blocked';
  required_passed: boolean;
  score_percent: number;
  recommended_completion_percent: number;
  blocker_count: number;
  product_count: number;
  variant_count: number;
  score: {
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
  };
  items: CommerceCatalogReadinessItem[];
  summary: string;
  intake: {
    manual_entry_supported: true;
    csv_dry_run_supported: true;
    bulk_api_dry_run_supported: true;
    async_import_job_supported: false;
    external_connector_supported: false;
  };
}

export interface CommerceAgentFacingPreviewProductVariant {
  sku: string;
  variant_title: string | null;
  price_amount: number | string;
  currency: string;
  availability_status: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
  warranty_summary: string | null;
  return_policy_summary: string | null;
}

export interface CommerceAgentFacingPreviewProduct {
  sample_reference: string;
  title: string;
  description: string;
  image_url: string | null;
  category_preset: 'electronics_appliances';
  variants: CommerceAgentFacingPreviewProductVariant[];
}

export interface CommerceAgentFacingPreview {
  preview_status: 'ready' | 'blocked';
  preview_blockers: string[];
  sandbox_only: true;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  live_plural_enabled: false;
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
    overall_status: 'pass' | 'fail' | 'blocked';
    overall_score_percent: number;
    category_status: 'pass' | 'fail' | 'blocked';
    category_score_percent: number;
    category_summary: string;
    catalog_status: 'pass' | 'fail' | 'blocked';
    catalog_score_percent: number;
    catalog_summary: string;
  };
  sample_products: CommerceAgentFacingPreviewProduct[];
  allowed_preview_capabilities: [
    'read_only_profile_preview',
    'read_only_catalog_preview',
    'readiness_review_preview',
  ];
  blocked_capabilities: [
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    'live_plural',
    'provider_credentials',
    'order_fulfillment',
    'refunds_returns_execution',
    'production_allowlist',
  ];
  generated_at: string;
}

export interface CommerceReadOnlyDiscoveryReview {
  status: 'not_requested' | 'blocked' | 'eligible' | 'requested' | 'withdrawn' | 'rejected';
  eligible: boolean;
  sandbox_only: true;
  request_is_approval: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  live_plural_enabled: false;
  production_allowlist_written: false;
  requested_at: string | null;
  status_updated_at: string | null;
  blockers: string[];
  remediation: string[];
}

export type CommerceReadOnlyDiscoveryOperatorDecision =
  | 'changes_requested'
  | 'rejected'
  | 'rollout_proposal_ready';

export interface CommerceReadOnlyDiscoveryOperatorReview {
  merchant_id: string;
  tenant_id: string;
  merchant_reference: string;
  display_name: string | null;
  sandbox_onboarding_state: SandboxOnboardingState;
  review_request_status:
    | CommerceReadOnlyDiscoveryReview['status']
    | CommerceReadOnlyDiscoveryOperatorDecision;
  operator_decision: CommerceReadOnlyDiscoveryOperatorDecision | null;
  decision_reason: string | null;
  remediation_items: string[];
  requested_at: string | null;
  request_actor: string | null;
  decision_recorded_at: string | null;
  decision_actor: string | null;
  updated_at: string | null;
  readiness_summary: CommerceAgentFacingPreview['readiness_summary'];
  agent_facing_preview_status: CommerceAgentFacingPreview['preview_status'];
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
  live_plural_enabled: false;
  production_allowlist_written: false;
  audit_event_id: string | null;
}

export interface CommerceSandboxOnboarding {
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
  readiness: {
    ready: boolean;
    status: 'pass' | 'fail' | 'blocked';
    score_percent: number;
    checks: CommerceSandboxOnboardingCheck[];
    category_readiness: CommerceCategoryReadiness;
    catalog_readiness: CommerceCatalogReadiness;
    live_mode_status: 'not_live';
    production_approval_status: 'not_approved';
    rollout_status: 'rollout_not_requested';
  };
  agent_facing_preview: CommerceAgentFacingPreview;
  read_only_discovery_review: CommerceReadOnlyDiscoveryReview;
}

export interface CommerceAgent {
  id: string;
  tenant_id: string;
  display_name: string;
  agent_type: string;
  public_key_jwk: Record<string, unknown> | null;
  trust_status: 'pending' | 'trusted' | 'suspended' | 'disabled';
  status: 'active' | 'disabled';
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommerceCatalogVariantSummary {
  variant_id: string;
  sku: string;
  variant_title: string | null;
  model: string | null;
  price_amount: number | string;
  currency: string;
  availability_status: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
  last_synced_at: string | null;
  stale: boolean;
  freshness: 'fresh' | 'stale';
}

export interface CommerceCatalogProductSummary {
  id: string;
  product_id: string;
  merchant_id: string;
  title: string;
  brand: string | null;
  image_url: string | null;
  category_preset: string;
  variants_summary: CommerceCatalogVariantSummary[];
  updated_at: string;
}

export interface CommerceProductVariant {
  id: string;
  sku: string;
  parent_sku: string | null;
  model: string | null;
  variant_title: string | null;
  attributes: Record<string, unknown>;
  price_amount: number | string;
  currency: string;
  tax_inclusive: boolean;
  gst_slab: string | null;
  tax_rate: number | string | null;
  hsn_code: string | null;
  availability_status: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
  warranty_summary: string | null;
  return_policy_summary: string | null;
  last_synced_at: string | null;
  archived_at: string | null;
  stale?: boolean;
  freshness?: 'fresh' | 'stale';
}

export interface CommerceProduct {
  id: string;
  tenant_id: string;
  merchant_id: string;
  product_id: string;
  title: string;
  brand: string | null;
  description: string | null;
  image_url: string | null;
  category_preset: string;
  source_system: string;
  manually_maintained: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  variants: CommerceProductVariant[];
}

export type CommerceBulkProductInput = {
  merchant_id?: string;
  product_id: string;
  title: string;
  brand?: string | null;
  description?: string | null;
  image_url?: string | null;
  category_preset: string;
  source_system?: string;
  manually_maintained?: boolean;
  variants: Array<{
    sku: string;
    parent_sku?: string | null;
    model?: string | null;
    variant_title?: string | null;
    attributes?: Record<string, unknown>;
    price_amount: number;
    currency?: string;
    tax_inclusive?: boolean;
    gst_slab?: string | null;
    tax_rate?: number | null;
    hsn_code?: string | null;
    availability_status?: 'in_stock' | 'out_of_stock' | 'pre_order' | 'back_order' | 'unknown';
    warranty_summary?: string | null;
    return_policy_summary?: string | null;
    source_system?: string;
  }>;
};

export interface CommerceBulkProductRowResult {
  index: number;
  product_id: string | null;
  status: 'valid' | 'invalid' | 'upserted';
  variant_count?: number | null;
  field_errors: Record<string, string>;
}

export interface CommerceBulkProductIngestResponse {
  dry_run: boolean;
  summary: Record<string, number | string | boolean>;
  rows: CommerceBulkProductRowResult[];
  audit_event_id?: string | null;
}

export interface CommerceWebhookSource {
  tenant_id: string;
  merchant_id: string;
  source_key: string;
  display_name: string;
  status: 'active' | 'disabled';
  secret_last_rotated_at: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceWebhookSourceWithSecret extends CommerceWebhookSource {
  webhook_secret: string;
}

export interface CommercePolicy {
  id: string;
  tenant_id: string;
  merchant_id: string;
  version: string;
  rules: Record<string, unknown>;
  status: 'draft' | 'active' | 'archived';
  created_by: string;
  activated_by: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommercePolicyDecision {
  decision: 'allow' | 'deny' | 'requires_user_consent';
  reason: string;
  policy_id: string;
  policy_version: string;
  decision_id: string;
  passport_jti?: string | null;
}

export interface CommerceProviderCredential {
  id: string;
  tenant_id: string;
  merchant_id: string;
  provider_key: CommerceProviderKey;
  environment: CommerceEnvironment;
  credential_ref: string;
  secret_version: number;
  status: 'pending' | 'valid' | 'invalid' | 'disabled';
  last_validated_at: string | null;
  last_validation_error: Record<string, unknown> | null;
  capabilities: string[];
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  validation?: {
    valid: boolean;
    capabilities: string[];
    checked_at: string;
    merchant_account_ref?: string;
    error?: Record<string, unknown>;
  };
}

export interface CommerceOpsHealth {
  status: 'healthy' | 'degraded' | 'down';
  checked_at: string;
  tenant_id: string;
  merchant_id: string | null;
  environment: CommerceEnvironment;
  checks: {
    api: Record<string, unknown>;
    database: Record<string, unknown>;
    provider_adapters: {
      mock: Record<string, unknown>;
      plural: Record<string, unknown>;
    };
    reconciliation_worker: Record<string, unknown>;
    webhook_backlog: {
      backlog_count: number | null;
      recent_failure_count: number | null;
      error_code?: string | null;
    };
  };
  blockers: string[];
}

export interface CommerceProviderWebhookEvent {
  id: string;
  tenant_id: string | null;
  provider_key: CommerceProviderKey;
  merchant_id: string | null;
  payment_intent_id: string | null;
  provider_payment_id: string | null;
  provider_event_id: string;
  provider_event_type: string;
  signature_validation_status: 'valid' | 'invalid' | 'blocked';
  replay_status: 'fresh' | 'duplicate' | 'stale';
  processing_status: 'received' | 'processed' | 'ignored' | 'failed';
  payload_hash: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number | string;
  received_at: string;
  processed_at: string | null;
  updated_at: string;
  replay_available: boolean;
  replay_blocker: string | null;
  replay_count: number | string;
  last_replayed_at: string | null;
}

export interface CommerceWellKnownProfile {
  version: string;
  merchant: {
    merchant_id: string;
    display_name: string;
    legal_name: string;
    environment: CommerceEnvironment;
    capabilities: string[];
  };
  environment: CommerceEnvironment;
  supported_tools: string[];
  capabilities: string[];
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      q.set(key, String(value));
    }
  }
  const text = q.toString();
  return text ? `?${text}` : '';
}

export function listCommercePaymentIntents(params: {
  merchantId?: string;
  status?: string;
  limit?: number;
} = {}): Promise<{ items: CommercePaymentIntent[]; next_cursor: string | null }> {
  return api.get<{ items: CommercePaymentIntent[]; next_cursor: string | null }>(`/v1/commerce/payments/intents${qs({
    merchant_id: params.merchantId,
    status: params.status,
    limit: params.limit,
  })}`);
}

export function reconcileCommercePaymentIntent(id: string): Promise<{
  data: CommercePaymentIntent;
  reconciliation: Record<string, unknown>;
  audit_event_id?: string;
}> {
  return api.post<{
    data: CommercePaymentIntent;
    reconciliation: Record<string, unknown>;
    audit_event_id?: string;
  }>(`/v1/commerce/payments/intents/${encodeURIComponent(id)}/reconcile`);
}

export function listCommerceAuditEvents(params: {
  merchantId?: string;
  agentId?: string;
  eventType?: string;
  passportJti?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<{ items: CommerceAuditEvent[]; next_cursor: string | null }> {
  return api.get<{ items: CommerceAuditEvent[]; next_cursor: string | null }>(`/v1/commerce/audit/events${qs({
    merchant_id: params.merchantId,
    agent_id: params.agentId,
    event_type: params.eventType,
    passport_jti: params.passportJti,
    limit: params.limit,
    cursor: params.cursor,
  })}`);
}

export function listCommercePassports(): Promise<{ items: CommercePassport[]; next_cursor: string | null }> {
  return api.get<{ items: CommercePassport[]; next_cursor: string | null }>('/v1/commerce/passports');
}

export function revokeCommercePassport(input: {
  jti: string;
  reason: string;
}): Promise<{ data: { jti: string; revoked: boolean; reason: string }; audit_event_id: string }> {
  return api.post<{ data: { jti: string; revoked: boolean; reason: string }; audit_event_id: string }>(
    '/v1/commerce/passports/revoke',
    input,
  );
}

export function getCommerceMerchant(merchantId: string): Promise<{ data: CommerceMerchant }> {
  return api.get<{ data: CommerceMerchant }>(`/v1/commerce/merchants/${encodeURIComponent(merchantId)}`);
}

export function getCommerceMerchantSandboxOnboarding(
  merchantId: string,
): Promise<{ data: CommerceSandboxOnboarding }> {
  return api.get<{ data: CommerceSandboxOnboarding }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding`,
  );
}

export function updateCommerceMerchantSandboxOnboarding(
  merchantId: string,
  patch: Partial<Pick<CommerceSandboxOnboarding,
    'display_name' | 'category_preset' | 'default_currency' | 'country_code' | 'support_email' | 'support_url' | 'public_discovery_description_draft' | 'agentic_commerce_requested'>>,
): Promise<{ data: CommerceSandboxOnboarding; audit_event_id: string }> {
  return api.put<{ data: CommerceSandboxOnboarding; audit_event_id: string }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding`,
    patch,
  );
}

export function transitionCommerceMerchantSandboxOnboarding(
  merchantId: string,
  input: { targetState: SandboxOnboardingState; reason?: string },
): Promise<{ data: CommerceSandboxOnboarding; audit_event_id: string }> {
  return api.post<{ data: CommerceSandboxOnboarding; audit_event_id: string }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding/transition`,
    {
      target_state: input.targetState,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  );
}

export function requestCommerceMerchantReadOnlyDiscoveryReview(
  merchantId: string,
): Promise<{ data: CommerceSandboxOnboarding; audit_event_id: string }> {
  return api.post<{ data: CommerceSandboxOnboarding; audit_event_id: string }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding/read-only-discovery-review-request`,
    {},
  );
}

export function listCommerceReadOnlyDiscoveryReviewRequests(params: {
  limit?: number;
} = {}): Promise<{ items: CommerceReadOnlyDiscoveryOperatorReview[]; next_cursor: string | null }> {
  return api.get<{ items: CommerceReadOnlyDiscoveryOperatorReview[]; next_cursor: string | null }>(
    `/v1/commerce/read-only-discovery-review-requests${qs({ limit: params.limit })}`,
  );
}

export function getCommerceMerchantReadOnlyDiscoveryReview(
  merchantId: string,
): Promise<{ data: CommerceReadOnlyDiscoveryOperatorReview }> {
  return api.get<{ data: CommerceReadOnlyDiscoveryOperatorReview }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding/read-only-discovery-review`,
  );
}

export function recordCommerceReadOnlyDiscoveryReviewDecision(
  merchantId: string,
  input: {
    decision: CommerceReadOnlyDiscoveryOperatorDecision;
    reason: string;
    remediationItems?: string[];
  },
): Promise<{ data: CommerceReadOnlyDiscoveryOperatorReview; audit_event_id: string }> {
  return api.post<{ data: CommerceReadOnlyDiscoveryOperatorReview; audit_event_id: string }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}/sandbox-onboarding/read-only-discovery-review/decision`,
    {
      decision: input.decision,
      reason: input.reason,
      remediation_items: input.remediationItems ?? [],
    },
  );
}

export function updateCommerceMerchant(
  merchantId: string,
  patch: Partial<Pick<CommerceMerchant,
    'legal_name' | 'display_name' | 'category_preset' | 'default_currency' | 'country_code' | 'support_email' | 'agentic_commerce_enabled'>>,
): Promise<{ data: CommerceMerchant; audit_event_id: string }> {
  return api.patch<{ data: CommerceMerchant; audit_event_id: string }>(
    `/v1/commerce/merchants/${encodeURIComponent(merchantId)}`,
    patch,
  );
}

export function disableMerchantAgenticCommerce(
  merchantId: string,
  reason: string,
): Promise<{ data: { merchant_id: string; agentic_commerce_enabled: boolean; disabled: boolean }; audit_event_id: string }> {
  return api.post<{
    data: { merchant_id: string; agentic_commerce_enabled: boolean; disabled: boolean };
    audit_event_id: string;
  }>(`/v1/commerce/merchants/${encodeURIComponent(merchantId)}/disable-agentic-commerce`, { reason });
}

export function enableMerchantAgenticCommerce(
  merchantId: string,
  input: {
    reason: string;
    reviewedPolicyId: string;
    incidentReference?: string;
    confirmReenable: boolean;
  },
): Promise<{
  data: {
    merchant_id: string;
    agentic_commerce_enabled: boolean;
    disabled: boolean;
    reviewed_policy_id: string;
  };
  audit_event_id: string;
}> {
  return api.post<{
    data: {
      merchant_id: string;
      agentic_commerce_enabled: boolean;
      disabled: boolean;
      reviewed_policy_id: string;
    };
    audit_event_id: string;
  }>(`/v1/commerce/merchants/${encodeURIComponent(merchantId)}/enable-agentic-commerce`, {
    reason: input.reason,
    reviewed_policy_id: input.reviewedPolicyId,
    ...(input.incidentReference ? { incident_reference: input.incidentReference } : {}),
    confirm_reenable: input.confirmReenable,
  });
}

export function listCommerceAgents(params: {
  merchantId?: string;
  status?: 'active' | 'disabled';
  trustStatus?: 'pending' | 'trusted' | 'suspended' | 'disabled';
  limit?: number;
  cursor?: string;
} = {}): Promise<{ items: CommerceAgent[]; next_cursor: string | null }> {
  return api.get<{ items: CommerceAgent[]; next_cursor: string | null }>(`/v1/commerce/agents${qs({
    merchant_id: params.merchantId,
    status: params.status,
    trust_status: params.trustStatus,
    limit: params.limit,
    cursor: params.cursor,
  })}`);
}

export function updateCommerceAgent(
  agentId: string,
  patch: Partial<Pick<CommerceAgent, 'display_name' | 'status' | 'trust_status'>>,
): Promise<{ data: CommerceAgent; audit_event_id: string }> {
  return api.patch<{ data: CommerceAgent; audit_event_id: string }>(
    `/v1/commerce/agents/${encodeURIComponent(agentId)}`,
    patch,
  );
}

export function listCommerceProducts(params: {
  merchantId?: string;
  status?: 'active' | 'archived' | 'all';
  query?: string;
  categoryPreset?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<{ items: CommerceCatalogProductSummary[]; next_cursor: string | null }> {
  return api.get<{ items: CommerceCatalogProductSummary[]; next_cursor: string | null }>(`/v1/commerce/catalog/products${qs({
    merchant_id: params.merchantId,
    status: params.status,
    query: params.query,
    category_preset: params.categoryPreset,
    limit: params.limit,
    cursor: params.cursor,
  })}`);
}

export function updateCommerceProduct(
  productId: string,
  patch: Record<string, unknown>,
  merchantId?: string,
): Promise<{ data: CommerceProduct; audit_event_id: string }> {
  return api.patch<{ data: CommerceProduct; audit_event_id: string }>(
    `/v1/commerce/catalog/products/${encodeURIComponent(productId)}${qs({ merchant_id: merchantId })}`,
    patch,
  );
}

export function bulkIngestCommerceProducts(input: {
  merchantId: string;
  dryRun?: boolean;
  products: CommerceBulkProductInput[];
}): Promise<CommerceBulkProductIngestResponse> {
  return api.post<CommerceBulkProductIngestResponse>('/v1/commerce/catalog/products/bulk', {
    merchant_id: input.merchantId,
    dry_run: input.dryRun ?? true,
    products: input.products,
  });
}

export function listCommerceWebhookSources(params: {
  merchantId?: string;
  status?: 'active' | 'disabled';
} = {}): Promise<{ items: CommerceWebhookSource[] }> {
  return api.get<{ items: CommerceWebhookSource[] }>(`/v1/commerce/webhook-sources${qs({
    merchant_id: params.merchantId,
    status: params.status,
  })}`);
}

export function createCommerceWebhookSource(input: {
  merchantId: string;
  sourceKey: string;
  displayName: string;
}): Promise<{ data: CommerceWebhookSourceWithSecret; audit_event_id: string }> {
  return api.post<{ data: CommerceWebhookSourceWithSecret; audit_event_id: string }>(
    '/v1/commerce/webhook-sources',
    {
      merchant_id: input.merchantId,
      source_key: input.sourceKey,
      display_name: input.displayName,
    },
  );
}

export function updateCommerceWebhookSource(
  sourceKey: string,
  input: { merchantId: string; displayName?: string; status?: 'active' | 'disabled' },
): Promise<{ data: CommerceWebhookSource; audit_event_id: string }> {
  return api.patch<{ data: CommerceWebhookSource; audit_event_id: string }>(
    `/v1/commerce/webhook-sources/${encodeURIComponent(sourceKey)}${qs({ merchant_id: input.merchantId })}`,
    {
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  );
}

export function rotateCommerceWebhookSourceSecret(
  sourceKey: string,
  merchantId: string,
): Promise<{ data: CommerceWebhookSourceWithSecret; audit_event_id: string }> {
  return api.post<{ data: CommerceWebhookSourceWithSecret; audit_event_id: string }>(
    `/v1/commerce/webhook-sources/${encodeURIComponent(sourceKey)}/rotate-secret`,
    { merchant_id: merchantId },
  );
}

export function listCommercePolicies(params: {
  merchantId?: string;
  status?: 'draft' | 'active' | 'archived';
  limit?: number;
} = {}): Promise<{ items: CommercePolicy[]; next_cursor: string | null }> {
  return api.get<{ items: CommercePolicy[]; next_cursor: string | null }>(`/v1/commerce/policies${qs({
    merchant_id: params.merchantId,
    status: params.status,
    limit: params.limit,
  })}`);
}

export function evaluateCommercePolicy(input: {
  merchantId: string;
  agentId: string;
  actionScope: string;
  passportJwt: string;
  amountMinorUnits?: number;
  currency?: string;
  environment?: CommerceEnvironment;
  resourceType?: string;
  resourceId?: string;
}): Promise<{ data: CommercePolicyDecision; audit_event_id?: string | null }> {
  return api.post<{ data: CommercePolicyDecision; audit_event_id?: string | null }>(
    '/v1/commerce/policies/evaluate',
    {
      merchant_id: input.merchantId,
      agent_id: input.agentId,
      passport_jwt: input.passportJwt,
      action_scope: input.actionScope,
      amount_minor_units: input.amountMinorUnits,
      currency: input.currency,
      environment: input.environment,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
    },
  );
}

export function listCommerceProviderCredentials(params: {
  merchantId?: string;
  providerKey?: CommerceProviderKey;
  environment?: CommerceEnvironment;
} = {}): Promise<{ items: CommerceProviderCredential[]; next_cursor: string | null }> {
  return api.get<{ items: CommerceProviderCredential[]; next_cursor: string | null }>(`/v1/commerce/provider-credentials${qs({
    merchant_id: params.merchantId,
    provider_key: params.providerKey,
    environment: params.environment,
  })}`);
}

export function validateCommerceProviderCredential(
  credentialId: string,
): Promise<{ data: CommerceProviderCredential; audit_event_id: string }> {
  return api.post<{ data: CommerceProviderCredential; audit_event_id: string }>(
    `/v1/commerce/provider-credentials/${encodeURIComponent(credentialId)}/validate`,
  );
}

export function getCommerceOpsHealth(params: {
  merchantId?: string;
  environment?: CommerceEnvironment;
} = {}): Promise<CommerceOpsHealth> {
  return api.get<CommerceOpsHealth>(`/v1/commerce/ops/health${qs({
    merchant_id: params.merchantId,
    environment: params.environment,
  })}`);
}

export function listCommerceProviderWebhookEvents(params: {
  merchantId?: string;
  providerKey?: CommerceProviderKey;
  processingStatus?: 'received' | 'processed' | 'ignored' | 'failed';
  limit?: number;
} = {}): Promise<{
  items: CommerceProviderWebhookEvent[];
  next_cursor: string | null;
  replay_available: boolean;
  replay_blocker: string | null;
}> {
  return api.get<{
    items: CommerceProviderWebhookEvent[];
    next_cursor: string | null;
    replay_available: boolean;
    replay_blocker: string | null;
  }>(`/v1/commerce/ops/provider-webhook-events${qs({
    merchant_id: params.merchantId,
    provider_key: params.providerKey,
    processing_status: params.processingStatus,
    limit: params.limit,
  })}`);
}

export function replayCommerceProviderWebhookEvent(
  eventId: string,
  input: { reason: string; dryRun?: boolean },
): Promise<{
  data: {
    status: 'eligible' | 'processed' | 'duplicate';
    dry_run?: boolean;
    event_id: string;
    provider_key?: CommerceProviderKey;
    provider_event_id: string;
    provider_event_type?: string;
    payment_intent_id: string;
    current_payment_status?: CommercePaymentStatus;
    target_payment_status?: CommercePaymentStatus;
    payment_status?: CommercePaymentStatus;
    replay_count?: number | string;
  };
  requested_audit_event_id?: string;
  audit_event_id?: string;
  payment_audit_event_id?: string;
}> {
  return api.post<{
    data: {
      status: 'eligible' | 'processed' | 'duplicate';
      dry_run?: boolean;
      event_id: string;
      provider_key?: CommerceProviderKey;
      provider_event_id: string;
      provider_event_type?: string;
      payment_intent_id: string;
      current_payment_status?: CommercePaymentStatus;
      target_payment_status?: CommercePaymentStatus;
      payment_status?: CommercePaymentStatus;
      replay_count?: number | string;
    };
    requested_audit_event_id?: string;
    audit_event_id?: string;
    payment_audit_event_id?: string;
  }>(`/v1/commerce/ops/provider-webhook-events/${encodeURIComponent(eventId)}/replay`, {
    reason: input.reason,
    dry_run: input.dryRun ?? false,
  });
}

export function getCommerceWellKnownProfile(
  merchantId?: string,
): Promise<CommerceWellKnownProfile> {
  return api.get<CommerceWellKnownProfile>(`/.well-known/grantex-commerce${qs({ merchant_id: merchantId })}`);
}
