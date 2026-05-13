import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  providerError,
  type CommerceEnvironment,
  type NormalizedProviderError,
  type PaymentProvider,
} from './types.js';
import { sha256hex } from '../../hash.js';

const MOCK_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

function nowIso(): string {
  return new Date().toISOString();
}

function webhookSecret(): string {
  return process.env['MOCK_PAYMENT_WEBHOOK_SECRET'] ?? DEFAULT_MOCK_WEBHOOK_SECRET;
}

function hmacSignature(rawBody: string, timestamp: string): string {
  return createHmac('sha256', webhookSecret())
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function signatureMatches(actual: string, expected: string): boolean {
  const normalizedActual = actual.startsWith('sha256=') ? actual.slice('sha256='.length) : actual;
  if (!/^[a-f0-9]{64}$/i.test(normalizedActual)) return false;
  const actualBuffer = Buffer.from(normalizedActual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export class MockPaymentProvider implements PaymentProvider {
  public readonly providerKey = 'mock' as const;

  async healthCheck(): Promise<{
    ok: boolean;
    status: 'healthy';
    checked_at: string;
    details: Record<string, unknown>;
  }> {
    return {
      ok: true,
      status: 'healthy',
      checked_at: nowIso(),
      details: { deterministic: true },
    };
  }

  async validateCredentials(input: {
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
  }> {
    if (input.credential_ref.includes('invalid')) {
      return {
        valid: false,
        capabilities: [],
        checked_at: nowIso(),
        error: this.normalizeError({ code: 'invalid_mock_credentials' }),
      };
    }
    return {
      valid: true,
      merchant_account_ref: `mock_${input.environment}_${input.merchant_id}`,
      capabilities: ['payment_intent.create', 'checkout_link.create', 'payment_status.read'],
      checked_at: nowIso(),
    };
  }

  async createPaymentIntent(input: {
    tenant_id: string;
    merchant_id: string;
    agent_id: string;
    payment_intent_id: string;
    cart_id: string;
    passport_jti: string;
    idempotency_key: string;
    amount: { amount_minor_units: number; currency: string };
    line_items_snapshot: unknown[];
    environment: CommerceEnvironment;
    metadata: Record<string, string>;
  }): Promise<{
    provider_payment_id: string;
    provider_order_id: string;
    status: 'created';
    raw_status: string;
    provider_metadata: Record<string, unknown>;
  }> {
    const outcome = input.metadata['mock_outcome'];
    if (outcome === 'decline') {
      throw providerError(this.normalizeError({ code: 'mock_decline' }));
    }
    if (outcome === 'timeout') {
      throw providerError(this.normalizeError({ code: 'mock_timeout' }));
    }
    if (outcome === 'error') {
      throw providerError(this.normalizeError({ code: 'mock_error' }));
    }

    return {
      provider_payment_id: `mock_pay_${input.payment_intent_id}`,
      provider_order_id: `mock_order_${input.payment_intent_id}`,
      status: 'created',
      raw_status: 'mock_created',
      provider_metadata: {
        environment: input.environment,
        amount_minor_units: input.amount.amount_minor_units,
        currency: input.amount.currency,
        idempotency_key_hash: sha256hex(input.idempotency_key),
      },
    };
  }

  async createCheckoutLink(input: {
    payment_intent_id: string;
    expires_at: string;
  }): Promise<{
    checkout_url: string;
    expires_at: string;
    raw_status: string;
    provider_metadata: Record<string, unknown>;
  }> {
    return {
      checkout_url: `https://mock-payments.grantex.local/checkout/${encodeURIComponent(input.payment_intent_id)}`,
      expires_at: input.expires_at,
      raw_status: 'mock_checkout_created',
      provider_metadata: { deterministic: true },
    };
  }

  async getPaymentStatus(input: {
    provider_payment_id: string;
  }): Promise<{
    status: 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    raw_status: string;
    provider_metadata: Record<string, unknown>;
  }> {
    const raw =
      input.provider_payment_id.includes('_paid') ? 'mock_paid'
      : input.provider_payment_id.includes('_failed') ? 'mock_failed'
      : input.provider_payment_id.includes('_expired') ? 'mock_expired'
      : input.provider_payment_id.includes('_cancelled') ? 'mock_cancelled'
      : 'mock_payment_pending';
    const status =
      raw === 'mock_paid' ? 'paid'
      : raw === 'mock_failed' ? 'failed'
      : raw === 'mock_expired' ? 'expired'
      : raw === 'mock_cancelled' ? 'cancelled'
      : 'payment_pending';
    return { status, raw_status: raw, provider_metadata: { deterministic: true } };
  }

  async handleWebhook(input: {
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
    provider_metadata: Record<string, unknown>;
  }> {
    const timestamp = input.headers['x-mock-timestamp'];
    const signature = input.headers['x-mock-signature'];
    if (!timestamp || !signature || !signatureMatches(signature, hmacSignature(input.raw_body, timestamp))) {
      throw providerError(this.normalizeError({ code: 'mock_signature_invalid' }));
    }
    const timestampSeconds = Number.parseInt(timestamp, 10);
    const receivedSeconds = Math.floor(new Date(input.received_at).getTime() / 1000);
    if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(receivedSeconds - timestampSeconds) > MOCK_WEBHOOK_REPLAY_WINDOW_SECONDS) {
      throw providerError(this.normalizeError({ code: 'mock_webhook_replay' }));
    }
    const parsed = JSON.parse(input.raw_body) as Record<string, unknown>;
    const out: {
      event_id: string;
      event_type: string;
      merchant_ref?: string;
      provider_payment_id?: string;
      status?: string;
      signature_valid: boolean;
      replay: boolean;
      provider_metadata: Record<string, unknown>;
    } = {
      event_id: String(parsed['event_id'] ?? `mock_evt_${Date.now()}`),
      event_type: String(parsed['event_type'] ?? 'payment.updated'),
      signature_valid: true,
      replay: false,
      provider_metadata: { received_at: input.received_at, signature_scheme: 'mock-hmac-sha256-v1' },
    };
    if (typeof parsed['merchant_ref'] === 'string') {
      out.merchant_ref = parsed['merchant_ref'];
    }
    if (typeof parsed['provider_payment_id'] === 'string') {
      out.provider_payment_id = parsed['provider_payment_id'];
    }
    if (typeof parsed['status'] === 'string') out.status = parsed['status'];
    return out;
  }

  normalizeError(error: unknown): NormalizedProviderError {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'mock_error';
    if (code === 'mock_decline') {
      return {
        code: 'payment_declined',
        message: 'Mock provider declined the payment',
        retryable: false,
        provider_key: 'mock',
        provider_error_code: code,
      };
    }
    if (code === 'mock_timeout') {
      return {
        code: 'provider_timeout',
        message: 'Mock provider timeout',
        retryable: true,
        provider_key: 'mock',
        provider_error_code: code,
      };
    }
    if (code === 'mock_signature_invalid') {
      return {
        code: 'webhook_signature_invalid',
        message: 'Mock webhook signature is invalid',
        retryable: false,
        provider_key: 'mock',
        provider_error_code: code,
      };
    }
    if (code === 'mock_webhook_replay') {
      return {
        code: 'webhook_replay_detected',
        message: 'Mock webhook timestamp is outside the replay window',
        retryable: false,
        provider_key: 'mock',
        provider_error_code: code,
      };
    }
    if (code === 'invalid_mock_credentials') {
      return {
        code: 'invalid_provider_credentials',
        message: 'Mock provider credentials are invalid',
        retryable: false,
        provider_key: 'mock',
        provider_error_code: code,
      };
    }
    return {
      code: 'unknown_provider_error',
      message: 'Mock provider returned an unknown error',
      retryable: false,
      provider_key: 'mock',
      provider_error_code: code,
    };
  }
}
