import { CommerceHttpError } from './errors.js';
import { hashRequestBody } from './idempotency.js';
import type {
  CommerceEnvironment,
  Money,
  NormalizedProviderError,
  ProviderErrorCode,
  ProviderKey,
} from './payment-providers/types.js';
import type { CommercePaymentStatus } from './payment-state.js';

export const COMMERCE_PROVIDER_SANDBOX_NORMALIZED_STATUSES = [
  'authorized',
  'payment_pending',
  'paid',
  'failed',
  'expired',
  'cancelled',
  'manual_review_required',
] as const;

export type CommerceProviderSandboxNormalizedStatus =
  typeof COMMERCE_PROVIDER_SANDBOX_NORMALIZED_STATUSES[number];

export type CommerceProviderSandboxRefusalCode =
  | 'provider_sandbox_tenant_context_required'
  | 'provider_sandbox_merchant_context_required'
  | 'provider_sandbox_payment_intent_required'
  | 'provider_sandbox_idempotency_required'
  | 'provider_sandbox_audit_evidence_required'
  | 'provider_sandbox_environment_refused'
  | 'provider_sandbox_adapter_blocked'
  | 'provider_sandbox_webhook_event_id_required'
  | 'provider_sandbox_webhook_signature_required'
  | 'provider_sandbox_webhook_replay_refused'
  | 'provider_sandbox_webhook_unknown_event'
  | 'provider_sandbox_reconciliation_manual_review';

export interface CommerceProviderSandboxRefusal {
  code: CommerceProviderSandboxRefusalCode;
  message: string;
  retryable: boolean;
}

export interface CommerceProviderSandboxContractInput {
  tenant_id?: string | null;
  merchant_id?: string | null;
  agent_id?: string | null;
  cart_id?: string | null;
  payment_intent_id?: string | null;
  provider_key?: ProviderKey | 'unknown' | null;
  environment?: CommerceEnvironment | 'unknown' | null;
  amount?: Money | null;
  line_items_snapshot?: unknown[] | null;
  idempotency_key_hash?: string | null;
  source_freshness_refs?: Record<string, unknown> | null;
  audit_evidence_refs?: Array<Record<string, string>> | null;
  metadata?: Record<string, unknown> | null;
}

export interface CommerceProviderSandboxAcceptedResult {
  status: 'accepted';
  tenant_id: string;
  merchant_id: string;
  payment_intent_id: string;
  environment: 'sandbox';
  idempotency_scope: 'provider.sandbox.adapter.contract';
  idempotency_key_hash: string;
  request_body_hash: string;
  normalized_status: 'authorized';
  provider_reference: {
    payment_ref: string;
    order_ref: string;
    raw_status_ref: string;
  };
  buyer_safe_status: {
    code: 'sandbox_intent_authorized';
    message: string;
  };
  source_freshness_refs: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  redacted_provider_evidence: Record<string, unknown>;
  non_enablement: CommerceProviderSandboxNonEnablement;
}

export interface CommerceProviderSandboxRefusedResult {
  status: 'refused';
  refusal: CommerceProviderSandboxRefusal;
  environment: 'sandbox' | 'live' | 'unknown';
  non_enablement: CommerceProviderSandboxNonEnablement;
}

export type CommerceProviderSandboxContractResult =
  | CommerceProviderSandboxAcceptedResult
  | CommerceProviderSandboxRefusedResult;

export interface CommerceProviderSandboxPriorResult {
  tenant_id: string;
  merchant_id: string;
  idempotency_scope: 'provider.sandbox.adapter.contract';
  idempotency_key_hash: string;
  request_body_hash: string;
  response: CommerceProviderSandboxContractResult;
}

export type CommerceProviderSandboxReplayResult =
  | { kind: 'new'; request_body_hash: string }
  | { kind: 'replay'; response: CommerceProviderSandboxContractResult }
  | { kind: 'conflict'; expected_body_hash: string; actual_body_hash: string };

export interface CommerceProviderSandboxStatusSummary {
  normalized_status: CommerceProviderSandboxNormalizedStatus;
  payment_status: CommercePaymentStatus | 'manual_review_required';
  fail_closed: boolean;
  raw_status_ref: string;
  buyer_safe_message: string;
}

export interface CommerceProviderSandboxErrorSummary {
  code: ProviderErrorCode;
  retryable: boolean;
  buyer_safe_message: string;
  provider_error_ref?: string | undefined;
  safe_metadata: Record<string, unknown>;
}

export interface CommerceProviderSandboxWebhookInput {
  tenant_id?: string | null;
  merchant_id?: string | null;
  payment_intent_id?: string | null;
  provider_key?: ProviderKey | 'unknown' | null;
  environment?: CommerceEnvironment | 'unknown' | null;
  event_id?: string | null;
  event_type?: string | null;
  signature_state?: 'valid' | 'missing' | 'invalid' | 'unconfirmed' | null;
  replay_state?: 'fresh' | 'duplicate' | 'stale' | 'unknown' | null;
  normalized_status?: unknown;
  received_at?: string | null;
  audit_evidence_refs?: Array<Record<string, string>> | null;
  metadata?: Record<string, unknown> | null;
}

export type CommerceProviderSandboxWebhookResult =
  | {
    status: 'processed';
    payment_status: CommercePaymentStatus;
    idempotent: false;
    evidence: CommerceProviderSandboxEventEvidence;
    buyer_safe_message: string;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | {
    status: 'ignored';
    reason: 'duplicate_event';
    idempotent: true;
    evidence: CommerceProviderSandboxEventEvidence;
    buyer_safe_message: string;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | {
    status: 'manual_review_required';
    reason: 'unknown_event' | 'ambiguous_status';
    evidence: CommerceProviderSandboxEventEvidence;
    buyer_safe_message: string;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | CommerceProviderSandboxRefusedResult;

export interface CommerceProviderSandboxReconciliationInput {
  tenant_id?: string | null;
  merchant_id?: string | null;
  payment_intent_id?: string | null;
  provider_key?: ProviderKey | 'unknown' | null;
  environment?: CommerceEnvironment | 'unknown' | null;
  current_status?: CommercePaymentStatus | 'unknown' | null;
  provider_status?: unknown;
  pending_age_seconds?: number | null;
  mismatch_detected?: boolean | null;
  audit_evidence_refs?: Array<Record<string, string>> | null;
  metadata?: Record<string, unknown> | null;
}

export type CommerceProviderSandboxReconciliationResult =
  | {
    status: 'transition_recommended';
    from_status: CommercePaymentStatus;
    to_status: Extract<CommercePaymentStatus, 'paid' | 'failed' | 'expired' | 'cancelled'>;
    reason: 'sandbox_provider_terminal_status';
    evidence: CommerceProviderSandboxEventEvidence;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | {
    status: 'no_change';
    payment_status: CommercePaymentStatus;
    reason: 'pending_window_open' | 'provider_still_pending' | 'terminal_status';
    evidence: CommerceProviderSandboxEventEvidence;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | {
    status: 'manual_review_required';
    reason: 'status_mismatch' | 'ambiguous_status' | 'unsupported_transition';
    evidence: CommerceProviderSandboxEventEvidence;
    non_enablement: CommerceProviderSandboxNonEnablement;
  }
  | CommerceProviderSandboxRefusedResult;

export interface CommerceProviderSandboxEventEvidence {
  event_ref?: string | undefined;
  payment_intent_ref: string | null;
  normalized_status: CommerceProviderSandboxNormalizedStatus;
  raw_status_ref: string;
  audit_evidence_refs: Array<Record<string, string>>;
  redacted_metadata: Record<string, unknown>;
}

export interface CommerceProviderSandboxNonEnablement {
  production_checkout: false;
  live_payment: false;
  live_provider: false;
  provider_call: false;
  partner_payment_rail_call: false;
  carrier_call: false;
  merchant_private_api_call: false;
  settlement_execution: false;
  payout_execution: false;
  refund_execution: false;
  public_discovery: false;
}

const SANDBOX_RECONCILIATION_REVIEW_WINDOW_SECONDS = 120;

const PUBLIC_PROVIDER_SANDBOX_REFUSALS: Record<CommerceProviderSandboxRefusalCode, CommerceProviderSandboxRefusal> = {
  provider_sandbox_tenant_context_required: {
    code: 'provider_sandbox_tenant_context_required',
    message: 'Sandbox provider contract requires a tenant-bound Grantex context.',
    retryable: false,
  },
  provider_sandbox_merchant_context_required: {
    code: 'provider_sandbox_merchant_context_required',
    message: 'Sandbox provider contract requires a merchant-bound Grantex context.',
    retryable: false,
  },
  provider_sandbox_payment_intent_required: {
    code: 'provider_sandbox_payment_intent_required',
    message: 'Sandbox provider contract requires a Grantex payment intent reference.',
    retryable: false,
  },
  provider_sandbox_idempotency_required: {
    code: 'provider_sandbox_idempotency_required',
    message: 'Sandbox provider contract requires a hashed idempotency key reference.',
    retryable: false,
  },
  provider_sandbox_audit_evidence_required: {
    code: 'provider_sandbox_audit_evidence_required',
    message: 'Sandbox provider contract requires redacted audit evidence references.',
    retryable: true,
  },
  provider_sandbox_environment_refused: {
    code: 'provider_sandbox_environment_refused',
    message: 'Sandbox provider contract refuses live or unknown payment environments.',
    retryable: false,
  },
  provider_sandbox_adapter_blocked: {
    code: 'provider_sandbox_adapter_blocked',
    message: 'Only the local sandbox adapter contract is available in this slice.',
    retryable: false,
  },
  provider_sandbox_webhook_event_id_required: {
    code: 'provider_sandbox_webhook_event_id_required',
    message: 'Sandbox webhook handling requires a stable provider event reference.',
    retryable: false,
  },
  provider_sandbox_webhook_signature_required: {
    code: 'provider_sandbox_webhook_signature_required',
    message: 'Sandbox webhook handling requires a verified signature before status facts can be used.',
    retryable: true,
  },
  provider_sandbox_webhook_replay_refused: {
    code: 'provider_sandbox_webhook_replay_refused',
    message: 'Sandbox webhook handling refused a stale replay window.',
    retryable: false,
  },
  provider_sandbox_webhook_unknown_event: {
    code: 'provider_sandbox_webhook_unknown_event',
    message: 'Sandbox webhook event type is not recognized and requires manual review.',
    retryable: true,
  },
  provider_sandbox_reconciliation_manual_review: {
    code: 'provider_sandbox_reconciliation_manual_review',
    message: 'Sandbox reconciliation is ambiguous and requires manual review.',
    retryable: true,
  },
};

const KNOWN_SANDBOX_WEBHOOK_EVENTS = new Set([
  'payment.updated',
  'payment.succeeded',
  'payment.failed',
  'payment.expired',
  'payment.cancelled',
]);

const FORBIDDEN_PROVIDER_SANDBOX_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bearer',
  'carrier_api_key',
  'carrier_call',
  'carrier_execution_enabled',
  'carrier_label_url',
  'carrier_provider',
  'carrier_request_id',
  'carrier_tracking_url',
  'checkout_payment_enabled',
  'checkout_url',
  'credential',
  'credentials',
  'delivery_execution_enabled',
  'encrypted_secret_blob',
  'fulfillment_execution_enabled',
  'live_payment_enabled',
  'live_payment_provider_enabled',
  'live_provider_enabled',
  'merchant_private_api_call',
  'merchant_private_api_key',
  'merchant_private_api_url',
  'payment_provider_call',
  'private_api_key',
  'private_api_url',
  'production_allowlist',
  'production_checkout_enabled',
  'provider_call',
  'provider_credentials',
  'provider_metadata',
  'provider_order_id',
  'provider_payment_id',
  'provider_raw_payload',
  'raw_body',
  'raw_connector_payload',
  'raw_payload',
  'raw_provider_payload',
  'refund_execution_enabled',
  'refund_provider_id',
  'refund_transaction_id',
  'settlement_enabled',
  'settlement_id',
  'shipping_enabled',
  'shipping_label_url',
  'tracking_number',
  'payout_enabled',
  'payout_id',
  'webhook_secret',
]);

const PRIVATE_PROVIDER_SANDBOX_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'db_url',
  'encrypted_secret_blob',
  'evidence',
  'jwt',
  'merchant_private_url',
  'passport',
  'private_url',
  'provider_credential',
  'raw_body',
  'raw_connector_payload',
  'raw_payload',
  'raw_provider_payload',
  'redis_url',
  'refresh_token',
  'secret',
  'token',
  'webhook_secret',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeGuardKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function nonEnablement(): CommerceProviderSandboxNonEnablement {
  return {
    production_checkout: false,
    live_payment: false,
    live_provider: false,
    provider_call: false,
    partner_payment_rail_call: false,
    carrier_call: false,
    merchant_private_api_call: false,
    settlement_execution: false,
    payout_execution: false,
    refund_execution: false,
    public_discovery: false,
  };
}

function publicRefusal(code: CommerceProviderSandboxRefusalCode): CommerceProviderSandboxRefusal {
  return { ...PUBLIC_PROVIDER_SANDBOX_REFUSALS[code] };
}

function refusalResult(
  code: CommerceProviderSandboxRefusalCode,
  environment: CommerceEnvironment | 'unknown' | null | undefined,
): CommerceProviderSandboxRefusedResult {
  return {
    status: 'refused',
    refusal: publicRefusal(code),
    environment: environment === 'sandbox' || environment === 'live' ? environment : 'unknown',
    non_enablement: nonEnablement(),
  };
}

function validateSandboxContext(input: {
  tenant_id?: string | null;
  merchant_id?: string | null;
  payment_intent_id?: string | null;
  provider_key?: ProviderKey | 'unknown' | null;
  environment?: CommerceEnvironment | 'unknown' | null;
}): CommerceProviderSandboxRefusalCode | null {
  if (!isNonEmptyString(input.tenant_id)) return 'provider_sandbox_tenant_context_required';
  if (!isNonEmptyString(input.merchant_id)) return 'provider_sandbox_merchant_context_required';
  if (!isNonEmptyString(input.payment_intent_id)) return 'provider_sandbox_payment_intent_required';
  if (input.environment !== 'sandbox') return 'provider_sandbox_environment_refused';
  if (input.provider_key !== 'mock') return 'provider_sandbox_adapter_blocked';
  return null;
}

function safeAuditRefs(
  refs: Array<Record<string, string>> | null | undefined,
): Array<Record<string, string>> {
  return refs ? redactCommerceProviderSandboxPrivateFields(cloneJson(refs)) : [];
}

function eventEvidence(input: {
  event_id?: string | null | undefined;
  payment_intent_id?: string | null | undefined;
  normalized_status: CommerceProviderSandboxNormalizedStatus;
  raw_status_ref: string;
  audit_evidence_refs?: Array<Record<string, string>> | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}): CommerceProviderSandboxEventEvidence {
  return {
    event_ref: isNonEmptyString(input.event_id)
      ? `sandbox_event_${hashRequestBody({ event_id: input.event_id }).slice(0, 24)}`
      : undefined,
    payment_intent_ref: isNonEmptyString(input.payment_intent_id)
      ? `sandbox_payment_intent_${hashRequestBody({ payment_intent_id: input.payment_intent_id }).slice(0, 24)}`
      : null,
    normalized_status: input.normalized_status,
    raw_status_ref: input.raw_status_ref,
    audit_evidence_refs: safeAuditRefs(input.audit_evidence_refs),
    redacted_metadata: redactCommerceProviderSandboxPrivateFields(cloneJson(input.metadata ?? {})),
  };
}

function paymentStatusForNormalized(
  status: CommerceProviderSandboxNormalizedStatus,
): CommercePaymentStatus | 'manual_review_required' {
  if (status === 'authorized') return 'authorized';
  if (status === 'payment_pending') return 'payment_pending';
  if (status === 'paid') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  if (status === 'cancelled') return 'cancelled';
  return 'manual_review_required';
}

function terminalStatusForNormalized(
  status: CommerceProviderSandboxNormalizedStatus,
): Extract<CommercePaymentStatus, 'paid' | 'failed' | 'expired' | 'cancelled'> | null {
  if (status === 'paid' || status === 'failed' || status === 'expired' || status === 'cancelled') {
    return status;
  }
  return null;
}

export function assertNoCommerceProviderSandboxExecutionFields(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (FORBIDDEN_PROVIDER_SANDBOX_KEYS.has(normalizeGuardKey(key))) {
          throw new CommerceHttpError(
            422,
            'provider_sandbox_execution_fields_not_allowed',
            'Provider sandbox contract cannot carry live payment, provider execution, credential, raw payload, carrier, private API, refund, settlement, or payout fields',
            { retryable: false },
          );
        }
        stack.push(child);
      }
    }
  }
}

export function redactCommerceProviderSandboxPrivateFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactCommerceProviderSandboxPrivateFields(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = PRIVATE_PROVIDER_SANDBOX_KEYS.has(normalizeGuardKey(key))
        ? '[redacted]'
        : redactCommerceProviderSandboxPrivateFields(child);
    }
    return output as T;
  }
  return value;
}

export function publicCommerceProviderSandboxRefusal(
  code: CommerceProviderSandboxRefusalCode,
): CommerceProviderSandboxRefusal {
  return publicRefusal(code);
}

export function normalizeCommerceProviderSandboxStatus(
  rawStatus: unknown,
): CommerceProviderSandboxStatusSummary {
  const normalizedInput = typeof rawStatus === 'string'
    ? rawStatus.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    : '';
  let normalized_status: CommerceProviderSandboxNormalizedStatus;
  if (normalizedInput === 'mock_authorized' || normalizedInput === 'authorized') {
    normalized_status = 'authorized';
  } else if (
    normalizedInput === 'mock_payment_pending'
    || normalizedInput === 'payment_pending'
    || normalizedInput === 'pending'
  ) {
    normalized_status = 'payment_pending';
  } else if (normalizedInput === 'mock_paid' || normalizedInput === 'paid' || normalizedInput === 'succeeded') {
    normalized_status = 'paid';
  } else if (normalizedInput === 'mock_failed' || normalizedInput === 'failed' || normalizedInput === 'declined') {
    normalized_status = 'failed';
  } else if (normalizedInput === 'mock_expired' || normalizedInput === 'expired') {
    normalized_status = 'expired';
  } else if (normalizedInput === 'mock_cancelled' || normalizedInput === 'cancelled' || normalizedInput === 'canceled') {
    normalized_status = 'cancelled';
  } else {
    normalized_status = 'manual_review_required';
  }

  const failClosed = normalized_status === 'manual_review_required';
  return {
    normalized_status,
    payment_status: paymentStatusForNormalized(normalized_status),
    fail_closed: failClosed,
    raw_status_ref: `sandbox_status_${hashRequestBody({ rawStatus }).slice(0, 24)}`,
    buyer_safe_message: failClosed
      ? 'Sandbox provider status is ambiguous and requires manual review.'
      : `Sandbox provider status normalized to ${normalized_status}.`,
  };
}

export function normalizeCommerceProviderSandboxError(
  error: NormalizedProviderError | unknown,
): CommerceProviderSandboxErrorSummary {
  const candidate = error as Partial<NormalizedProviderError> | null;
  const code = typeof candidate?.code === 'string'
    ? candidate.code as ProviderErrorCode
    : 'unknown_provider_error';
  const retryable = Boolean(candidate?.retryable);
  const providerErrorCode = typeof candidate?.provider_error_code === 'string'
    ? candidate.provider_error_code
    : null;

  const messages: Record<ProviderErrorCode, string> = {
    provider_unavailable: 'Sandbox provider status is temporarily unavailable.',
    invalid_provider_credentials: 'Sandbox provider credentials are not accepted by this contract.',
    provider_validation_failed: 'Sandbox provider validation failed without exposing private details.',
    provider_rate_limited: 'Sandbox provider status is temporarily rate limited.',
    provider_timeout: 'Sandbox provider status timed out.',
    payment_declined: 'Sandbox payment outcome was declined by local test facts.',
    payment_expired: 'Sandbox payment outcome has expired.',
    webhook_signature_invalid: 'Sandbox webhook signature could not be verified.',
    webhook_replay_detected: 'Sandbox webhook replay window was refused.',
    unsupported_provider_event: 'Sandbox provider event is unsupported and requires review.',
    unknown_provider_error: 'Sandbox provider error is unknown and requires review.',
  };

  return {
    code,
    retryable,
    buyer_safe_message: messages[code] ?? messages.unknown_provider_error,
    provider_error_ref: providerErrorCode
      ? `sandbox_provider_error_${hashRequestBody({ providerErrorCode }).slice(0, 24)}`
      : undefined,
    safe_metadata: redactCommerceProviderSandboxPrivateFields(cloneJson(candidate?.safe_metadata ?? {})),
  };
}

export function hashCommerceProviderSandboxRequest(input: CommerceProviderSandboxContractInput): string {
  return hashRequestBody({
    tenant_id: input.tenant_id ?? null,
    merchant_id: input.merchant_id ?? null,
    agent_id: input.agent_id ?? null,
    cart_id: input.cart_id ?? null,
    payment_intent_id: input.payment_intent_id ?? null,
    provider_key: input.provider_key ?? null,
    environment: input.environment ?? null,
    amount: input.amount ?? null,
    line_items_snapshot: input.line_items_snapshot ?? [],
    idempotency_key_hash: input.idempotency_key_hash ?? null,
  });
}

export function compareCommerceProviderSandboxReplay(
  input: CommerceProviderSandboxContractInput,
  previous?: CommerceProviderSandboxPriorResult | null,
): CommerceProviderSandboxReplayResult {
  const actual = hashCommerceProviderSandboxRequest(input);
  if (!previous) return { kind: 'new', request_body_hash: actual };
  if (
    previous.tenant_id !== input.tenant_id
    || previous.merchant_id !== input.merchant_id
    || previous.idempotency_scope !== 'provider.sandbox.adapter.contract'
    || previous.idempotency_key_hash !== input.idempotency_key_hash
  ) {
    return { kind: 'new', request_body_hash: actual };
  }
  if (previous.request_body_hash !== actual) {
    return {
      kind: 'conflict',
      expected_body_hash: previous.request_body_hash,
      actual_body_hash: actual,
    };
  }
  return { kind: 'replay', response: previous.response };
}

export function buildCommerceProviderSandboxIntentContract(
  input: CommerceProviderSandboxContractInput,
): CommerceProviderSandboxContractResult {
  assertNoCommerceProviderSandboxExecutionFields(input);
  const contextRefusal = validateSandboxContext(input);
  if (contextRefusal) return refusalResult(contextRefusal, input.environment);
  const tenantId = input.tenant_id;
  const merchantId = input.merchant_id;
  const paymentIntentId = input.payment_intent_id;
  const idempotencyKeyHash = input.idempotency_key_hash;
  if (!isNonEmptyString(tenantId)) {
    return refusalResult('provider_sandbox_tenant_context_required', input.environment);
  }
  if (!isNonEmptyString(merchantId)) {
    return refusalResult('provider_sandbox_merchant_context_required', input.environment);
  }
  if (!isNonEmptyString(paymentIntentId)) {
    return refusalResult('provider_sandbox_payment_intent_required', input.environment);
  }
  if (!isNonEmptyString(idempotencyKeyHash)) {
    return refusalResult('provider_sandbox_idempotency_required', input.environment);
  }
  if (!input.audit_evidence_refs || input.audit_evidence_refs.length === 0) {
    return refusalResult('provider_sandbox_audit_evidence_required', input.environment);
  }

  const requestBodyHash = hashCommerceProviderSandboxRequest(input);
  const seedHash = hashRequestBody({
    tenant_id: tenantId,
    merchant_id: merchantId,
    payment_intent_id: paymentIntentId,
    idempotency_key_hash: idempotencyKeyHash,
    request_body_hash: requestBodyHash,
  });

  return {
    status: 'accepted',
    tenant_id: tenantId,
    merchant_id: merchantId,
    payment_intent_id: paymentIntentId,
    environment: 'sandbox',
    idempotency_scope: 'provider.sandbox.adapter.contract',
    idempotency_key_hash: idempotencyKeyHash,
    request_body_hash: requestBodyHash,
    normalized_status: 'authorized',
    provider_reference: {
      payment_ref: `sandbox_payment_ref_${seedHash.slice(0, 24)}`,
      order_ref: `sandbox_order_ref_${seedHash.slice(24, 48)}`,
      raw_status_ref: `sandbox_status_${seedHash.slice(48, 64)}`,
    },
    buyer_safe_status: {
      code: 'sandbox_intent_authorized',
      message: 'Sandbox payment intent contract is locally authorized for test sequencing only.',
    },
    source_freshness_refs: redactCommerceProviderSandboxPrivateFields(cloneJson(input.source_freshness_refs ?? {})),
    audit_evidence_refs: safeAuditRefs(input.audit_evidence_refs),
    redacted_provider_evidence: redactCommerceProviderSandboxPrivateFields(cloneJson(input.metadata ?? {})),
    non_enablement: nonEnablement(),
  };
}

export function evaluateCommerceProviderSandboxWebhook(
  input: CommerceProviderSandboxWebhookInput,
): CommerceProviderSandboxWebhookResult {
  assertNoCommerceProviderSandboxExecutionFields(input);
  const contextRefusal = validateSandboxContext(input);
  if (contextRefusal) return refusalResult(contextRefusal, input.environment);
  if (!isNonEmptyString(input.event_id)) {
    return refusalResult('provider_sandbox_webhook_event_id_required', input.environment);
  }
  if (input.signature_state !== 'valid') {
    return refusalResult('provider_sandbox_webhook_signature_required', input.environment);
  }
  if (input.replay_state === 'stale') {
    return refusalResult('provider_sandbox_webhook_replay_refused', input.environment);
  }

  const status = normalizeCommerceProviderSandboxStatus(input.normalized_status);
  const evidence = eventEvidence({
    event_id: input.event_id,
    payment_intent_id: input.payment_intent_id,
    normalized_status: status.normalized_status,
    raw_status_ref: status.raw_status_ref,
    audit_evidence_refs: input.audit_evidence_refs,
    metadata: input.metadata,
  });

  if (input.replay_state === 'duplicate') {
    return {
      status: 'ignored',
      reason: 'duplicate_event',
      idempotent: true,
      evidence,
      buyer_safe_message: 'Duplicate sandbox webhook event was idempotently ignored.',
      non_enablement: nonEnablement(),
    };
  }

  if (!KNOWN_SANDBOX_WEBHOOK_EVENTS.has(input.event_type ?? '')) {
    return {
      status: 'manual_review_required',
      reason: 'unknown_event',
      evidence,
      buyer_safe_message: publicRefusal('provider_sandbox_webhook_unknown_event').message,
      non_enablement: nonEnablement(),
    };
  }

  if (status.normalized_status === 'manual_review_required') {
    return {
      status: 'manual_review_required',
      reason: 'ambiguous_status',
      evidence,
      buyer_safe_message: status.buyer_safe_message,
      non_enablement: nonEnablement(),
    };
  }

  return {
    status: 'processed',
    payment_status: status.payment_status as CommercePaymentStatus,
    idempotent: false,
    evidence,
    buyer_safe_message: 'Sandbox webhook event was normalized from supplied test facts.',
    non_enablement: nonEnablement(),
  };
}

export function evaluateCommerceProviderSandboxReconciliation(
  input: CommerceProviderSandboxReconciliationInput,
): CommerceProviderSandboxReconciliationResult {
  assertNoCommerceProviderSandboxExecutionFields(input);
  const contextRefusal = validateSandboxContext(input);
  if (contextRefusal) return refusalResult(contextRefusal, input.environment);
  if (!input.audit_evidence_refs || input.audit_evidence_refs.length === 0) {
    return refusalResult('provider_sandbox_audit_evidence_required', input.environment);
  }

  const status = normalizeCommerceProviderSandboxStatus(input.provider_status);
  const current = input.current_status ?? 'unknown';
  const evidence = eventEvidence({
    payment_intent_id: input.payment_intent_id,
    normalized_status: status.normalized_status,
    raw_status_ref: status.raw_status_ref,
    audit_evidence_refs: input.audit_evidence_refs,
    metadata: input.metadata,
  });

  if (
    current === 'paid'
    || current === 'failed'
    || current === 'cancelled'
    || current === 'expired'
  ) {
    return {
      status: 'no_change',
      payment_status: current,
      reason: 'terminal_status',
      evidence,
      non_enablement: nonEnablement(),
    };
  }

  if ((input.pending_age_seconds ?? 0) < SANDBOX_RECONCILIATION_REVIEW_WINDOW_SECONDS) {
    return {
      status: 'no_change',
      payment_status: current === 'unknown' ? 'payment_pending' : current,
      reason: 'pending_window_open',
      evidence,
      non_enablement: nonEnablement(),
    };
  }

  if (input.mismatch_detected || status.normalized_status === 'manual_review_required') {
    return {
      status: 'manual_review_required',
      reason: input.mismatch_detected ? 'status_mismatch' : 'ambiguous_status',
      evidence,
      non_enablement: nonEnablement(),
    };
  }

  if (status.normalized_status === 'payment_pending') {
    return {
      status: 'no_change',
      payment_status: 'payment_pending',
      reason: 'provider_still_pending',
      evidence,
      non_enablement: nonEnablement(),
    };
  }

  const toStatus = terminalStatusForNormalized(status.normalized_status);
  if (current === 'payment_pending' && toStatus) {
    return {
      status: 'transition_recommended',
      from_status: 'payment_pending',
      to_status: toStatus,
      reason: 'sandbox_provider_terminal_status',
      evidence,
      non_enablement: nonEnablement(),
    };
  }

  return {
    status: 'manual_review_required',
    reason: 'unsupported_transition',
    evidence,
    non_enablement: nonEnablement(),
  };
}
