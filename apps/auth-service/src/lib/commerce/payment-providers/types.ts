export type ProviderKey = 'mock' | 'plural';
export type CommerceEnvironment = 'sandbox' | 'live';

export interface Money {
  amount_minor_units: number;
  currency: string;
}

export type ProviderErrorCode =
  | 'provider_unavailable'
  | 'invalid_provider_credentials'
  | 'provider_validation_failed'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'payment_declined'
  | 'payment_expired'
  | 'webhook_signature_invalid'
  | 'webhook_replay_detected'
  | 'unsupported_provider_event'
  | 'unknown_provider_error';

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  provider_key: ProviderKey;
  provider_error_code?: string;
  provider_request_id?: string;
  safe_metadata?: Record<string, unknown>;
}

export class PaymentProviderError extends Error {
  public readonly normalized: NormalizedProviderError;

  constructor(error: NormalizedProviderError) {
    super(error.message);
    this.normalized = error;
  }
}

export interface PaymentProvider {
  readonly providerKey: ProviderKey;

  healthCheck(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
  }): Promise<{
    ok: boolean;
    status: 'healthy' | 'degraded' | 'down';
    checked_at: string;
    details?: Record<string, unknown>;
  }>;

  validateCredentials(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
    credential_ref: string;
  }): Promise<{
    valid: boolean;
    merchant_account_ref?: string;
    capabilities: string[];
    checked_at: string;
    error?: NormalizedProviderError;
  }>;

  createPaymentIntent(input: {
    tenant_id: string;
    merchant_id: string;
    agent_id: string;
    payment_intent_id: string;
    cart_id: string;
    passport_jti: string;
    amount: Money;
    line_items_snapshot: unknown[];
    idempotency_key: string;
    environment: CommerceEnvironment;
    metadata: Record<string, string>;
  }): Promise<{
    provider_payment_id: string;
    provider_order_id?: string;
    status: 'created' | 'authorized' | 'payment_pending';
    raw_status: string;
    provider_metadata?: Record<string, unknown>;
  }>;

  createCheckoutLink(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
    amount: Money;
    success_url: string;
    cancel_url: string;
    expires_at: string;
    idempotency_key: string;
  }): Promise<{
    checkout_url: string;
    expires_at: string;
    raw_status: string;
    provider_metadata?: Record<string, unknown>;
  }>;

  getPaymentStatus(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
  }): Promise<{
    status: 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    raw_status: string;
    provider_metadata?: Record<string, unknown>;
  }>;

  handleWebhook(input: {
    provider_key: ProviderKey;
    headers: Record<string, string>;
    raw_body: string;
    received_at: string;
  }): Promise<{
    event_id: string;
    event_type: string;
    merchant_ref?: string;
    provider_payment_id?: string;
    status?: string;
    signature_valid: boolean;
    replay: boolean;
    provider_metadata?: Record<string, unknown>;
  }>;

  normalizeError(error: unknown): NormalizedProviderError;
}

export function providerError(error: NormalizedProviderError): PaymentProviderError {
  return new PaymentProviderError(error);
}

export function isPaymentProviderError(error: unknown): error is PaymentProviderError {
  return error instanceof PaymentProviderError;
}

