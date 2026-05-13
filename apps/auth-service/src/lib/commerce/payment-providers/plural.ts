import {
  providerError,
  type CommerceEnvironment,
  type NormalizedProviderError,
  type PaymentProvider,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function blockedError(environment: CommerceEnvironment): NormalizedProviderError {
  const liveDisabled = environment === 'live' && process.env['PLURAL_LIVE_ENABLED'] !== 'true';
  const sandboxBlocked = environment === 'sandbox' && process.env['PLURAL_SANDBOX_ENABLED'] !== 'true';
  const providerErrorCode = liveDisabled
    ? 'plural_live_disabled'
    : sandboxBlocked
      ? 'plural_sandbox_blocked'
      : 'plural_api_contract_unconfirmed';
  return {
    code: 'provider_validation_failed',
    message: liveDisabled
      ? 'Plural live mode is disabled pending legal, partner, and production readiness review'
      : 'Plural integration is blocked until exact API and webhook signature details are confirmed',
    retryable: false,
    provider_key: 'plural',
    provider_error_code: providerErrorCode,
    safe_metadata: {
      environment,
      blocker: providerErrorCode,
      api_contract_confirmed: false,
      webhook_signature_confirmed: false,
    },
  };
}

export class PluralPaymentProvider implements PaymentProvider {
  public readonly providerKey = 'plural' as const;

  async healthCheck(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
  }): Promise<{
    ok: boolean;
    status: 'down';
    checked_at: string;
    details: Record<string, unknown>;
  }> {
    const error = blockedError(input.environment);
    return {
      ok: false,
      status: 'down',
      checked_at: nowIso(),
      details: error.safe_metadata ?? {},
    };
  }

  async validateCredentials(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
    credential_ref: string;
  }): Promise<{
    valid: false;
    capabilities: string[];
    checked_at: string;
    error: NormalizedProviderError;
  }> {
    return {
      valid: false,
      capabilities: [],
      checked_at: nowIso(),
      error: blockedError(input.environment),
    };
  }

  async createPaymentIntent(input: {
    tenant_id: string;
    merchant_id: string;
    agent_id: string;
    payment_intent_id: string;
    cart_id: string;
    passport_jti: string;
    amount: { amount_minor_units: number; currency: string };
    line_items_snapshot: unknown[];
    idempotency_key: string;
    environment: CommerceEnvironment;
    metadata: Record<string, string>;
  }): Promise<never> {
    throw providerError(blockedError(input.environment));
  }

  async createCheckoutLink(): Promise<never> {
    throw providerError(blockedError('sandbox'));
  }

  async getPaymentStatus(): Promise<never> {
    throw providerError(blockedError('sandbox'));
  }

  async handleWebhook(): Promise<never> {
    throw providerError({
      ...blockedError('sandbox'),
      provider_error_code: 'plural_webhook_signature_unconfirmed',
      safe_metadata: {
        blocker: 'plural_webhook_signature_unconfirmed',
        webhook_signature_confirmed: false,
      },
    });
  }

  normalizeError(error: unknown): NormalizedProviderError {
    if (error && typeof error === 'object' && 'normalized' in error) {
      return (error as { normalized: NormalizedProviderError }).normalized;
    }
    return blockedError('sandbox');
  }
}
