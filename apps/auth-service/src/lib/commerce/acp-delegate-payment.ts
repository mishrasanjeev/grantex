/**
 * ACP delegate-payment allowance derived from a Commerce Passport (G35).
 *
 * ACP 2026-04-17 Delegate Payment (`schema.delegate_payment.json`,
 * `DelegatePaymentRequest`): an agent asks the merchant's PSP / vault to
 * tokenise a payment method that may be used only within an `allowance`
 * `{reason: "one_time", max_amount, currency, checkout_session_id,
 * merchant_id, expires_at}` and carries `risk_signals[]` (may be empty since
 * 2026-04-17) and a string-to-string `metadata` map.
 *
 * Grantex supplies the allowance and the risk-signal envelope, never the
 * payment method: the cap is the verified checkout passport's `max_amount` /
 * `currency`, the expiry is the passport's `exp`, and no card data is
 * accepted or returned. Grantex computes no `card_testing` score, so it never
 * invents a `RiskSignal`; its own authority checks travel in `authority`.
 */
import type { VerifiedPassport } from './passport.js';

export const ACP_DELEGATE_PAYMENT_API_VERSION = '2026-04-17';
export const PAYMENT_INITIATE_SCOPE = 'commerce:payment.initiate';

/** Members that would carry payment-method data; their presence refuses the request. */
const CARD_DATA_KEYS = new Set([
  'payment_method', 'card', 'number', 'card_number', 'pan', 'cvc', 'cvv', 'exp_month', 'exp_year',
  'cryptogram', 'eci_value', 'track_data', 'billing_address',
]);

export interface AcpAllowance {
  reason: 'one_time';
  max_amount: number;
  currency: string;
  checkout_session_id: string;
  merchant_id: string;
  expires_at: string;
}

export interface AcpRiskSignal {
  type: 'card_testing';
  score: number;
  action: 'blocked' | 'manual_review' | 'authorized';
}

export interface AcpDelegatePaymentEnvelope {
  api_version: typeof ACP_DELEGATE_PAYMENT_API_VERSION;
  allowance: AcpAllowance;
  risk_signals: AcpRiskSignal[];
  /** For `DelegatePaymentRequest.metadata`: correlation only, strings only. */
  metadata: Record<string, string>;
  authority: {
    passport_jti: string;
    passport_type: 'checkout';
    agent_id: string;
    environment: 'sandbox' | 'live';
    policy_version: string | null;
    checks: string[];
  };
}

export type AcpAllowanceRefusal =
  | 'card_data_refused'
  | 'passport_not_checkout'
  | 'passport_scope_missing'
  | 'passport_cap_missing'
  | 'allowance_exceeds_passport_cap'
  | 'currency_mismatch'
  | 'invalid_checkout_session_id'
  | 'invalid_amount';

export class AcpAllowanceError extends Error {
  constructor(readonly code: AcpAllowanceRefusal, readonly status: 403 | 422, message: string) {
    super(message);
    this.name = 'AcpAllowanceError';
  }
}

/** Throws `card_data_refused` when any member, at any depth, names payment-method data. */
export function assertNoCardData(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCardData(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, member] of Object.entries(value)) {
    if (CARD_DATA_KEYS.has(key.toLowerCase())) {
      throw new AcpAllowanceError('card_data_refused', 422,
        `Grantex never accepts payment-method data; remove ${path}.${key} and send it to the PSP directly`);
    }
    assertNoCardData(member, `${path}.${key}`);
  }
}

export interface AllowanceRequest {
  checkout_session_id: string;
  /** Optional amount the session will charge, minor units: must not exceed the cap. */
  amount?: number | undefined;
  /** Optional currency of `amount` (ISO 4217, any case): must equal the passport currency. */
  currency?: string | undefined;
}

/**
 * The allowance and risk-signal envelope for one checkout session, from a
 * passport already verified in payment-affecting mode (signature, audience,
 * expiry, revocation, tenant and merchant).
 */
export function deriveAcpDelegatePaymentEnvelope(passport: VerifiedPassport, request: AllowanceRequest): AcpDelegatePaymentEnvelope {
  if (typeof request.checkout_session_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(request.checkout_session_id)) {
    throw new AcpAllowanceError('invalid_checkout_session_id', 422, 'checkout_session_id must be 1 to 256 URL-safe characters');
  }
  if (passport.passportType !== 'checkout') {
    throw new AcpAllowanceError('passport_not_checkout', 422, 'A delegate-payment allowance needs a checkout Commerce Passport');
  }
  if (!passport.scopes.includes(PAYMENT_INITIATE_SCOPE)) {
    throw new AcpAllowanceError('passport_scope_missing', 403, `The passport does not carry ${PAYMENT_INITIATE_SCOPE}`);
  }
  if (passport.maxAmount === null || !Number.isSafeInteger(passport.maxAmount) || passport.maxAmount < 0
    || passport.currency === null || !/^[A-Za-z]{3}$/.test(passport.currency)) {
    throw new AcpAllowanceError('passport_cap_missing', 422, 'The passport carries no amount cap and currency');
  }
  const currency = passport.currency.toLowerCase();
  if (request.currency !== undefined && (typeof request.currency !== 'string' || request.currency.toLowerCase() !== currency)) {
    throw new AcpAllowanceError('currency_mismatch', 422, 'currency must equal the passport currency');
  }
  if (request.amount !== undefined) {
    if (!Number.isSafeInteger(request.amount) || request.amount < 0) {
      throw new AcpAllowanceError('invalid_amount', 422, 'amount must be a non-negative integer in minor units');
    }
    if (request.amount > passport.maxAmount) {
      throw new AcpAllowanceError('allowance_exceeds_passport_cap', 422, 'amount exceeds the passport amount cap');
    }
  }
  return {
    api_version: ACP_DELEGATE_PAYMENT_API_VERSION,
    allowance: {
      reason: 'one_time',
      max_amount: passport.maxAmount,
      currency,
      checkout_session_id: request.checkout_session_id,
      merchant_id: passport.merchantId,
      expires_at: new Date(passport.expiresAt * 1000).toISOString(),
    },
    risk_signals: [],
    metadata: {
      grantex_passport_jti: passport.jti,
      grantex_agent_id: passport.agentId,
      grantex_environment: passport.environment,
    },
    authority: {
      passport_jti: passport.jti,
      passport_type: 'checkout',
      agent_id: passport.agentId,
      environment: passport.environment,
      policy_version: passport.policyVersion,
      checks: [
        'passport_signature',
        'passport_not_expired',
        'passport_not_revoked_online',
        'tenant_match',
        'merchant_match',
        'checkout_passport',
        'payment_initiate_scope',
        'amount_cap_present',
        ...(request.amount !== undefined ? ['amount_within_cap'] : []),
      ],
    },
  };
}
