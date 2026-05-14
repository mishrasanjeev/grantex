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
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
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
  replay_blocker: string;
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
  replay_blocker: string;
}> {
  return api.get<{
    items: CommerceProviderWebhookEvent[];
    next_cursor: string | null;
    replay_available: boolean;
    replay_blocker: string;
  }>(`/v1/commerce/ops/provider-webhook-events${qs({
    merchant_id: params.merchantId,
    provider_key: params.providerKey,
    processing_status: params.processingStatus,
    limit: params.limit,
  })}`);
}

export function getCommerceWellKnownProfile(
  merchantId?: string,
): Promise<CommerceWellKnownProfile> {
  return api.get<CommerceWellKnownProfile>(`/.well-known/grantex-commerce${qs({ merchant_id: merchantId })}`);
}
