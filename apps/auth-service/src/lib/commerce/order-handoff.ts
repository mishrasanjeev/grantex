import { CommerceHttpError } from './errors.js';
import { newCommerceOrderHandoffId } from './ids.js';

export const COMMERCE_ORDER_HANDOFF_TYPES = [
  'fulfillment',
  'delivery',
  'support',
  'return',
  'refund',
] as const;

export type CommerceOrderHandoffType = typeof COMMERCE_ORDER_HANDOFF_TYPES[number];

export const COMMERCE_ORDER_HANDOFF_STATUSES = [
  'draft',
  'requested',
  'acknowledged',
  'blocked',
  'rejected',
  'expired',
  'cancelled',
  'manual_review_required',
  'resolved_manually',
] as const;

export type CommerceOrderHandoffStatus = typeof COMMERCE_ORDER_HANDOFF_STATUSES[number];

export const COMMERCE_ORDER_HANDOFF_UNKNOWN_MARKERS = [
  'handoff_source_missing',
  'fulfillment_source_missing',
  'delivery_source_missing',
  'support_source_missing',
  'return_source_missing',
  'refund_source_missing',
] as const;

export type CommerceOrderHandoffUnknownMarker = typeof COMMERCE_ORDER_HANDOFF_UNKNOWN_MARKERS[number];

export interface CommerceOrderHandoffScopedRef {
  label: string;
  tenant_id: string;
  order_id?: string | null;
  merchant_id?: string | null;
  buyer_principal_id?: string | null;
}

export interface CommerceOrderHandoffSourceRef {
  source: 'order' | 'merchant_safe_source' | 'operator_record' | 'manual_review';
  source_id: string;
  checked_at?: string | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

export interface CommerceOrderHandoffSnapshotInput {
  handoff_type: unknown;
  summary?: string | null;
  safe_fields?: Record<string, unknown>;
  source_refs?: CommerceOrderHandoffSourceRef[];
  unknown_markers?: CommerceOrderHandoffUnknownMarker[];
}

export interface CommerceOrderHandoffSnapshot {
  handoff_type: CommerceOrderHandoffType;
  summary: string;
  safe_fields: Record<string, unknown>;
  source_refs: CommerceOrderHandoffSourceRef[];
  unknown_markers: CommerceOrderHandoffUnknownMarker[];
}

export interface CommerceOrderHandoffFoundationInput {
  tenant_id: string;
  order_id: string;
  merchant_id: string;
  buyer_principal_id: string;
  agent_id?: string | null;
  session_id?: string | null;
  handoff_type: unknown;
  handoff_snapshot: CommerceOrderHandoffSnapshotInput;
  source_freshness_refs?: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  idempotency_key_hash: string;
  created_from: 'order_safe_source' | 'merchant_safe_source' | 'operator_record' | 'manual_review';
  scoped_refs?: CommerceOrderHandoffScopedRef[];
  support_reference?: Record<string, unknown>;
}

export interface CommerceOrderHandoffFoundationDraft {
  id: string;
  tenant_id: string;
  order_id: string;
  merchant_id: string;
  buyer_principal_id: string;
  agent_id: string | null;
  session_id: string | null;
  handoff_type: CommerceOrderHandoffType;
  status: CommerceOrderHandoffStatus;
  handoff_snapshot: CommerceOrderHandoffSnapshot;
  source_freshness_refs: Record<string, unknown>;
  support_reference: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  idempotency_scope: CommerceOrderHandoffIdempotencyScope;
  idempotency_key_hash: string;
  created_from: CommerceOrderHandoffFoundationInput['created_from'];
}

export type CommerceOrderHandoffIdempotencyScope =
  | 'order.handoff.fulfillment.record'
  | 'order.handoff.delivery.record'
  | 'order.handoff.support.record'
  | 'order.handoff.return.record'
  | 'order.handoff.refund.record';

const HANDOFF_IDEMPOTENCY_SCOPE_BY_TYPE: Record<CommerceOrderHandoffType, CommerceOrderHandoffIdempotencyScope> = {
  fulfillment: 'order.handoff.fulfillment.record',
  delivery: 'order.handoff.delivery.record',
  support: 'order.handoff.support.record',
  return: 'order.handoff.return.record',
  refund: 'order.handoff.refund.record',
};

const ALLOWED_HANDOFF_TRANSITIONS: Record<CommerceOrderHandoffStatus, CommerceOrderHandoffStatus[]> = {
  draft: ['requested', 'blocked', 'cancelled', 'expired', 'manual_review_required'],
  requested: ['acknowledged', 'blocked', 'rejected', 'cancelled', 'expired', 'manual_review_required'],
  acknowledged: ['manual_review_required', 'resolved_manually', 'blocked', 'rejected', 'cancelled', 'expired'],
  manual_review_required: ['resolved_manually', 'blocked', 'rejected', 'cancelled', 'expired'],
  blocked: [],
  rejected: [],
  expired: [],
  cancelled: [],
  resolved_manually: [],
};

const FORBIDDEN_HANDOFF_EXECUTION_KEYS = new Set([
  'carrier_api_key',
  'carrier_execution_enabled',
  'carrier_label_url',
  'carrier_provider',
  'carrier_request_id',
  'carrier_tracking_url',
  'checkout_payment_enabled',
  'checkout_url',
  'delivery_execution_enabled',
  'fulfillment_execution_enabled',
  'live_payment_provider_enabled',
  'live_provider_enabled',
  'merchant_private_api_key',
  'merchant_private_api_url',
  'payment_approval',
  'private_api_key',
  'private_api_url',
  'provider_key',
  'provider_metadata',
  'provider_order_id',
  'provider_payment_id',
  'provider_raw_payload',
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
]);

const PRIVATE_SUMMARY_KEYS = new Set([
  'credential',
  'credentials',
  'db_url',
  'evidence',
  'jwt',
  'merchant_private_url',
  'passport',
  'private_url',
  'provider_credential',
  'raw_connector_payload',
  'raw_payload',
  'raw_provider_payload',
  'redis_url',
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

function validationError(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Order handoff foundation input is invalid', {
    retryable: false,
    details: { fields: { [field]: message } },
  });
}

export function assertCommerceOrderHandoffType(value: unknown): CommerceOrderHandoffType {
  if (typeof value === 'string' && (COMMERCE_ORDER_HANDOFF_TYPES as readonly string[]).includes(value)) {
    return value as CommerceOrderHandoffType;
  }
  throw validationError('handoff_type', 'must be one of fulfillment, delivery, support, return, refund');
}

export function assertCommerceOrderHandoffStatus(value: unknown): CommerceOrderHandoffStatus {
  if (typeof value === 'string' && (COMMERCE_ORDER_HANDOFF_STATUSES as readonly string[]).includes(value)) {
    return value as CommerceOrderHandoffStatus;
  }
  throw validationError('status', 'must be a fail-closed C6U8 handoff status');
}

export function commerceOrderHandoffIdempotencyScope(
  handoffType: CommerceOrderHandoffType,
): CommerceOrderHandoffIdempotencyScope {
  return HANDOFF_IDEMPOTENCY_SCOPE_BY_TYPE[handoffType];
}

export function canTransitionCommerceOrderHandoffStatus(
  from: CommerceOrderHandoffStatus,
  to: CommerceOrderHandoffStatus,
): boolean {
  return ALLOWED_HANDOFF_TRANSITIONS[from].includes(to);
}

export function assertCommerceOrderHandoffStatusTransition(
  from: CommerceOrderHandoffStatus,
  to: CommerceOrderHandoffStatus,
): void {
  assertCommerceOrderHandoffStatus(from);
  assertCommerceOrderHandoffStatus(to);
  if (!canTransitionCommerceOrderHandoffStatus(from, to)) {
    throw new CommerceHttpError(409, 'order_handoff_status_transition_refused',
      'Order handoff status transition is not allowed by the C6U8 handoff foundation', {
        retryable: false,
        details: { from, to },
      });
  }
}

export function allowedCommerceOrderHandoffStatusTransitions(
  from: CommerceOrderHandoffStatus,
): CommerceOrderHandoffStatus[] {
  assertCommerceOrderHandoffStatus(from);
  return [...ALLOWED_HANDOFF_TRANSITIONS[from]];
}

export function assertCommerceOrderHandoffBoundary(input: {
  tenant_id: string;
  order_id: string;
  merchant_id: string;
  buyer_principal_id?: string;
  refs?: CommerceOrderHandoffScopedRef[];
}): void {
  for (const ref of input.refs ?? []) {
    if (ref.tenant_id !== input.tenant_id) {
      throw new CommerceHttpError(403, 'order_handoff_tenant_mismatch',
        'Order handoff source facts do not match this tenant', { retryable: false });
    }
    if (ref.order_id !== undefined && ref.order_id !== null && ref.order_id !== input.order_id) {
      throw new CommerceHttpError(403, 'order_handoff_order_mismatch',
        'Order handoff source facts do not match this order', { retryable: false });
    }
    if (ref.merchant_id !== undefined && ref.merchant_id !== null && ref.merchant_id !== input.merchant_id) {
      throw new CommerceHttpError(403, 'order_handoff_merchant_mismatch',
        'Order handoff source facts do not match this merchant', { retryable: false });
    }
    if (
      input.buyer_principal_id !== undefined
      && ref.buyer_principal_id !== undefined
      && ref.buyer_principal_id !== null
      && ref.buyer_principal_id !== input.buyer_principal_id
    ) {
      throw new CommerceHttpError(403, 'order_handoff_buyer_mismatch',
        'Order handoff source facts do not match this buyer', { retryable: false });
    }
  }
}

export function assertNoCommerceOrderHandoffExecutionFields(value: unknown): void {
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
        if (FORBIDDEN_HANDOFF_EXECUTION_KEYS.has(normalizeGuardKey(key))) {
          throw new CommerceHttpError(422, 'order_handoff_execution_fields_not_allowed',
            'Order handoff cannot carry fulfillment, shipping, refund, provider, payment, payout, settlement, or private API execution fields', {
              retryable: false,
            });
        }
        stack.push(child);
      }
    }
  }
}

export function redactCommerceOrderHandoffPrivateFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactCommerceOrderHandoffPrivateFields(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = PRIVATE_SUMMARY_KEYS.has(normalizeGuardKey(key))
        ? '[redacted]'
        : redactCommerceOrderHandoffPrivateFields(child);
    }
    return output as T;
  }
  return value;
}

export function buildCommerceOrderHandoffSnapshot(
  input: CommerceOrderHandoffSnapshotInput,
): CommerceOrderHandoffSnapshot {
  const handoffType = assertCommerceOrderHandoffType(input.handoff_type);
  const unknownMarkers = new Set<CommerceOrderHandoffUnknownMarker>(input.unknown_markers ?? []);
  if (!input.source_refs || input.source_refs.length === 0) {
    unknownMarkers.add(`${handoffType}_source_missing` as CommerceOrderHandoffUnknownMarker);
    unknownMarkers.add('handoff_source_missing');
  }

  const snapshot: CommerceOrderHandoffSnapshot = {
    handoff_type: handoffType,
    summary: isNonEmptyString(input.summary) ? input.summary : 'Handoff status requires Grantex safe source facts.',
    safe_fields: redactCommerceOrderHandoffPrivateFields(cloneJson(input.safe_fields ?? {})),
    source_refs: cloneJson(input.source_refs ?? []),
    unknown_markers: [...unknownMarkers].sort(),
  };
  assertNoCommerceOrderHandoffExecutionFields(snapshot);
  return snapshot;
}

export function buildCommerceOrderHandoffFoundationDraft(
  input: CommerceOrderHandoffFoundationInput,
): CommerceOrderHandoffFoundationDraft {
  if (!isNonEmptyString(input.tenant_id)) throw validationError('tenant_id', 'is required');
  if (!isNonEmptyString(input.order_id)) throw validationError('order_id', 'is required');
  if (!isNonEmptyString(input.merchant_id)) throw validationError('merchant_id', 'is required');
  if (!isNonEmptyString(input.buyer_principal_id)) throw validationError('buyer_principal_id', 'is required');
  if (!isNonEmptyString(input.idempotency_key_hash)) {
    throw validationError('idempotency_key_hash', 'is required');
  }
  if (input.audit_evidence_refs.length === 0) {
    throw validationError('audit_evidence_refs', 'must contain at least one redacted audit reference');
  }

  const handoffType = assertCommerceOrderHandoffType(input.handoff_type);
  assertCommerceOrderHandoffBoundary({
    tenant_id: input.tenant_id,
    order_id: input.order_id,
    merchant_id: input.merchant_id,
    buyer_principal_id: input.buyer_principal_id,
    ...(input.scoped_refs === undefined ? {} : { refs: input.scoped_refs }),
  });

  const snapshot = buildCommerceOrderHandoffSnapshot({
    ...input.handoff_snapshot,
    handoff_type: handoffType,
  });
  const draft: CommerceOrderHandoffFoundationDraft = {
    id: newCommerceOrderHandoffId(),
    tenant_id: input.tenant_id,
    order_id: input.order_id,
    merchant_id: input.merchant_id,
    buyer_principal_id: input.buyer_principal_id,
    agent_id: input.agent_id ?? null,
    session_id: input.session_id ?? null,
    handoff_type: handoffType,
    status: 'draft',
    handoff_snapshot: snapshot,
    source_freshness_refs: redactCommerceOrderHandoffPrivateFields(cloneJson(input.source_freshness_refs ?? {})),
    support_reference: redactCommerceOrderHandoffPrivateFields(
      cloneJson(input.support_reference ?? { state: 'handoff_support_not_enabled_by_c6u8' }),
    ),
    audit_evidence_refs: cloneJson(input.audit_evidence_refs),
    idempotency_scope: commerceOrderHandoffIdempotencyScope(handoffType),
    idempotency_key_hash: input.idempotency_key_hash,
    created_from: input.created_from,
  };
  assertNoCommerceOrderHandoffExecutionFields(draft);
  return draft;
}

export type CommerceOrderHandoffRefusalCode =
  | 'order_handoff_source_facts_required'
  | 'order_handoff_status_not_enabled_by_c6u8'
  | 'order_handoff_support_not_enabled_by_c6u8'
  | 'order_handoff_execution_not_enabled_by_c6u8'
  | 'order_handoff_tenant_mismatch'
  | 'order_handoff_order_mismatch'
  | 'order_handoff_state_unknown';

const PUBLIC_HANDOFF_REFUSALS: Record<CommerceOrderHandoffRefusalCode, string> = {
  order_handoff_source_facts_required: 'Handoff status is unavailable until Grantex has safe source facts.',
  order_handoff_status_not_enabled_by_c6u8: 'Handoff status is not available from Grantex for this request yet.',
  order_handoff_support_not_enabled_by_c6u8: 'Support status is not available from Grantex for this order yet.',
  order_handoff_execution_not_enabled_by_c6u8: 'Fulfillment, delivery, return, and refund execution are not enabled by the C6U8 handoff foundation.',
  order_handoff_tenant_mismatch: 'Order handoff source facts do not match this tenant.',
  order_handoff_order_mismatch: 'Order handoff source facts do not match this order.',
  order_handoff_state_unknown: 'Handoff state is unknown. Refresh from Grantex before presenting status.',
};

export function publicCommerceOrderHandoffRefusal(code: CommerceOrderHandoffRefusalCode): {
  code: CommerceOrderHandoffRefusalCode;
  message: string;
  retryable: boolean;
} {
  return {
    code,
    message: PUBLIC_HANDOFF_REFUSALS[code],
    retryable: code === 'order_handoff_source_facts_required' || code === 'order_handoff_state_unknown',
  };
}

export function publicCommerceOrderHandoffStatusSummary(input: {
  handoff_type: CommerceOrderHandoffType;
  status: CommerceOrderHandoffStatus;
}): {
  handoff_type: CommerceOrderHandoffType;
  status: CommerceOrderHandoffStatus;
  message: string;
  retryable: boolean;
} {
  const status = assertCommerceOrderHandoffStatus(input.status);
  const handoffType = assertCommerceOrderHandoffType(input.handoff_type);
  if (status === 'draft' || status === 'manual_review_required') {
    return {
      handoff_type: handoffType,
      status,
      message: 'Handoff status requires Grantex safe source facts or manual review.',
      retryable: true,
    };
  }
  if (status === 'resolved_manually') {
    return {
      handoff_type: handoffType,
      status,
      message: 'Handoff status was recorded from a manual Grantex-safe source.',
      retryable: false,
    };
  }
  return {
    handoff_type: handoffType,
    status,
    message: 'Handoff status is recorded without enabling live execution.',
    retryable: false,
  };
}
