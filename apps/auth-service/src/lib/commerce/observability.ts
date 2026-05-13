import { sha256hex } from '../hash.js';

export interface CommerceLogContextInput {
  requestId?: string | null | undefined;
  tenantId?: string | null | undefined;
  merchantId?: string | null | undefined;
  agentId?: string | null | undefined;
  passportJti?: string | null | undefined;
  passportJtiRef?: string | null | undefined;
  cartId?: string | null | undefined;
  paymentIntentId?: string | null | undefined;
  providerKey?: string | null | undefined;
  providerPaymentId?: string | null | undefined;
  webhookEventId?: string | null | undefined;
  webhookProviderEventId?: string | null | undefined;
  policyVersion?: string | null | undefined;
  decisionId?: string | null | undefined;
  idempotencyKeyHash?: string | null | undefined;
  errorCode?: string | null | undefined;
  status?: string | null | undefined;
}

export function hashedReference(value: string, prefix = 'sha256'): string {
  return `${prefix}:${sha256hex(value).slice(0, 16)}`;
}

export function commerceLogContext(input: CommerceLogContextInput): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, value: string | null | undefined): void => {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  };

  add('request_id', input.requestId);
  add('tenant_id', input.tenantId);
  add('merchant_id', input.merchantId);
  add('agent_id', input.agentId);
  add('passport_jti_ref', input.passportJtiRef ?? (
    typeof input.passportJti === 'string' && input.passportJti.length > 0
      ? hashedReference(input.passportJti)
      : undefined
  ));
  add('cart_id', input.cartId);
  add('payment_intent_id', input.paymentIntentId);
  add('provider_key', input.providerKey);
  add('provider_payment_id', input.providerPaymentId);
  add('webhook_event_id', input.webhookEventId);
  add('webhook_provider_event_id', input.webhookProviderEventId);
  add('policy_version', input.policyVersion);
  add('decision_id', input.decisionId);
  add('idempotency_key_hash', input.idempotencyKeyHash);
  add('error_code', input.errorCode);
  add('status', input.status);
  return out;
}
