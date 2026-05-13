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

export function disableMerchantAgenticCommerce(
  merchantId: string,
  reason: string,
): Promise<{ data: { merchant_id: string; agentic_commerce_enabled: boolean; disabled: boolean }; audit_event_id: string }> {
  return api.post<{
    data: { merchant_id: string; agentic_commerce_enabled: boolean; disabled: boolean };
    audit_event_id: string;
  }>(`/v1/commerce/merchants/${encodeURIComponent(merchantId)}/disable-agentic-commerce`, { reason });
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
