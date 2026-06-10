import { CommerceHttpError } from './errors.js';
import { newCommerceOrderId } from './ids.js';

export const COMMERCE_ORDER_STATUSES = [
  'pending_source_facts',
  'recorded',
  'merchant_acknowledged',
  'closed',
  'cancelled',
  'expired',
  'blocked',
  'unknown',
] as const;

export type CommerceOrderStatus = typeof COMMERCE_ORDER_STATUSES[number];

export const COMMERCE_ORDER_UNKNOWN_MARKERS = [
  'price_unknown',
  'tax_unknown',
  'final_price_unknown',
  'source_reference_missing',
] as const;

export type CommerceOrderUnknownMarker = typeof COMMERCE_ORDER_UNKNOWN_MARKERS[number];

export interface CommerceOrderScopedRef {
  label: string;
  tenant_id: string;
  merchant_id?: string | null;
  id?: string | null;
}

export interface CommerceOrderSourceRef {
  source: 'cart' | 'payment_intent' | 'merchant_safe_source' | 'operator_record';
  source_id: string;
  checked_at?: string | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

export interface CommerceOrderLineItemFactInput {
  product_id: string;
  variant_id: string;
  title: string;
  sku: string;
  quantity: number;
  unit_price_minor_units?: number | null;
  currency?: string | null;
  tax_amount_minor_units?: number | null;
  final_price_minor_units?: number | null;
  source_refs?: CommerceOrderSourceRef[];
  unknown_markers?: CommerceOrderUnknownMarker[];
}

export interface CommerceOrderLineItemSnapshot {
  product_id: string;
  variant_id: string;
  title: string;
  sku: string;
  quantity: number;
  unit_price_minor_units: number | null;
  currency: string | null;
  tax_amount_minor_units: number | null;
  final_price_minor_units: number | null;
  unknown_markers: CommerceOrderUnknownMarker[];
  source_refs: CommerceOrderSourceRef[];
}

export interface CommerceOrderFoundationInput {
  tenant_id: string;
  merchant_id: string;
  buyer_principal_id: string;
  agent_id?: string | null;
  cart_id?: string | null;
  payment_intent_id?: string | null;
  created_from: 'cart_snapshot' | 'payment_intent_snapshot' | 'merchant_safe_source' | 'operator_record';
  idempotency_key_hash: string;
  line_items: CommerceOrderLineItemFactInput[];
  source_freshness_refs?: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  scoped_refs?: CommerceOrderScopedRef[];
  support_reference?: Record<string, unknown>;
}

export interface CommerceOrderFoundationDraft {
  id: string;
  tenant_id: string;
  merchant_id: string;
  buyer_principal_id: string;
  agent_id: string | null;
  cart_id: string | null;
  payment_intent_id: string | null;
  status: CommerceOrderStatus;
  line_items_snapshot: CommerceOrderLineItemSnapshot[];
  commercial_facts_snapshot: {
    line_items: CommerceOrderLineItemSnapshot[];
    totals: {
      currency: string | null;
      subtotal_minor_units: number | null;
      tax_minor_units: number | null;
      final_minor_units: number | null;
      unknown_markers: CommerceOrderUnknownMarker[];
    };
  };
  source_freshness_refs: Record<string, unknown>;
  support_reference: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  idempotency_scope: 'order.foundation.record';
  idempotency_key_hash: string;
  created_from: CommerceOrderFoundationInput['created_from'];
}

const ALLOWED_ORDER_TRANSITIONS: Record<CommerceOrderStatus, CommerceOrderStatus[]> = {
  pending_source_facts: ['recorded', 'blocked', 'cancelled', 'expired', 'unknown'],
  recorded: ['merchant_acknowledged', 'closed', 'blocked', 'cancelled', 'unknown'],
  merchant_acknowledged: ['closed', 'blocked', 'cancelled', 'unknown'],
  unknown: ['pending_source_facts', 'blocked'],
  blocked: [],
  cancelled: [],
  expired: [],
  closed: [],
};

const FORBIDDEN_PROVIDER_OR_PAYMENT_KEYS = new Set([
  'checkout_url',
  'checkout_payment_enabled',
  'live_provider_enabled',
  'provider_key',
  'provider_metadata',
  'provider_order_id',
  'provider_payment_id',
  'provider_raw_payload',
  'raw_provider_payload',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validationError(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Order foundation input is invalid', {
    retryable: false,
    details: { fields: { [field]: message } },
  });
}

function normalizeGuardKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

export function canTransitionCommerceOrderStatus(
  from: CommerceOrderStatus,
  to: CommerceOrderStatus,
): boolean {
  return ALLOWED_ORDER_TRANSITIONS[from].includes(to);
}

export function assertCommerceOrderStatusTransition(
  from: CommerceOrderStatus,
  to: CommerceOrderStatus,
): void {
  if (!canTransitionCommerceOrderStatus(from, to)) {
    throw new CommerceHttpError(409, 'order_status_transition_refused',
      'Order status transition is not allowed by the C6U7 order foundation', {
        retryable: false,
        details: { from, to },
      });
  }
}

export function allowedCommerceOrderStatusTransitions(
  from: CommerceOrderStatus,
): CommerceOrderStatus[] {
  return [...ALLOWED_ORDER_TRANSITIONS[from]];
}

export function assertCommerceOrderTenantBoundary(input: {
  tenant_id: string;
  merchant_id: string;
  refs?: CommerceOrderScopedRef[];
}): void {
  for (const ref of input.refs ?? []) {
    if (ref.tenant_id !== input.tenant_id) {
      throw new CommerceHttpError(403, 'order_tenant_mismatch',
        'Order source facts do not match this tenant', { retryable: false });
    }
    if (ref.merchant_id !== undefined && ref.merchant_id !== null && ref.merchant_id !== input.merchant_id) {
      throw new CommerceHttpError(403, 'order_merchant_mismatch',
        'Order source facts do not match this merchant', { retryable: false });
    }
  }
}

export function assertNoCommerceOrderProviderEnablement(value: unknown): void {
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
        if (FORBIDDEN_PROVIDER_OR_PAYMENT_KEYS.has(normalizeGuardKey(key))) {
          throw new CommerceHttpError(422, 'order_provider_fields_not_allowed',
            'Order foundation cannot carry live payment or provider execution fields', { retryable: false });
        }
        stack.push(child);
      }
    }
  }
}

export function buildCommerceOrderLineItemSnapshot(
  input: CommerceOrderLineItemFactInput,
): CommerceOrderLineItemSnapshot {
  if (!isNonEmptyString(input.product_id)) throw validationError('product_id', 'is required');
  if (!isNonEmptyString(input.variant_id)) throw validationError('variant_id', 'is required');
  if (!isNonEmptyString(input.title)) throw validationError('title', 'is required');
  if (!isNonEmptyString(input.sku)) throw validationError('sku', 'is required');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw validationError('quantity', 'must be a positive integer');
  }

  const unknownMarkers = new Set<CommerceOrderUnknownMarker>(input.unknown_markers ?? []);
  if (input.unit_price_minor_units === undefined || input.unit_price_minor_units === null || !input.currency) {
    unknownMarkers.add('price_unknown');
  }
  if (input.tax_amount_minor_units === undefined || input.tax_amount_minor_units === null) {
    unknownMarkers.add('tax_unknown');
  }
  if (input.final_price_minor_units === undefined || input.final_price_minor_units === null) {
    unknownMarkers.add('final_price_unknown');
  }
  if (!input.source_refs || input.source_refs.length === 0) {
    unknownMarkers.add('source_reference_missing');
  }

  const snapshot: CommerceOrderLineItemSnapshot = {
    product_id: input.product_id,
    variant_id: input.variant_id,
    title: input.title,
    sku: input.sku,
    quantity: input.quantity,
    unit_price_minor_units: input.unit_price_minor_units ?? null,
    currency: input.currency ?? null,
    tax_amount_minor_units: input.tax_amount_minor_units ?? null,
    final_price_minor_units: input.final_price_minor_units ?? null,
    unknown_markers: [...unknownMarkers].sort(),
    source_refs: cloneJson(input.source_refs ?? []),
  };
  assertNoCommerceOrderProviderEnablement(snapshot);
  return snapshot;
}

export function buildCommerceOrderFoundationDraft(
  input: CommerceOrderFoundationInput,
): CommerceOrderFoundationDraft {
  if (!isNonEmptyString(input.tenant_id)) throw validationError('tenant_id', 'is required');
  if (!isNonEmptyString(input.merchant_id)) throw validationError('merchant_id', 'is required');
  if (!isNonEmptyString(input.buyer_principal_id)) throw validationError('buyer_principal_id', 'is required');
  if (!isNonEmptyString(input.idempotency_key_hash)) {
    throw validationError('idempotency_key_hash', 'is required');
  }
  if (input.line_items.length === 0) throw validationError('line_items', 'must contain at least one item');
  if (input.audit_evidence_refs.length === 0) {
    throw validationError('audit_evidence_refs', 'must contain at least one redacted audit reference');
  }

  assertCommerceOrderTenantBoundary({
    tenant_id: input.tenant_id,
    merchant_id: input.merchant_id,
    ...(input.scoped_refs === undefined ? {} : { refs: input.scoped_refs }),
  });

  const lineItems = input.line_items.map(buildCommerceOrderLineItemSnapshot);
  const totalMarkers = new Set<CommerceOrderUnknownMarker>();
  let currency: string | null = null;
  let subtotal = 0;
  let tax = 0;
  let final = 0;
  for (const item of lineItems) {
    for (const marker of item.unknown_markers) totalMarkers.add(marker);
    if (item.currency) currency = currency ?? item.currency;
    if (item.unit_price_minor_units === null) {
      totalMarkers.add('price_unknown');
    } else {
      subtotal += item.unit_price_minor_units * item.quantity;
    }
    if (item.tax_amount_minor_units === null) {
      totalMarkers.add('tax_unknown');
    } else {
      tax += item.tax_amount_minor_units * item.quantity;
    }
    if (item.final_price_minor_units === null) {
      totalMarkers.add('final_price_unknown');
    } else {
      final += item.final_price_minor_units * item.quantity;
    }
  }

  const draft: CommerceOrderFoundationDraft = {
    id: newCommerceOrderId(),
    tenant_id: input.tenant_id,
    merchant_id: input.merchant_id,
    buyer_principal_id: input.buyer_principal_id,
    agent_id: input.agent_id ?? null,
    cart_id: input.cart_id ?? null,
    payment_intent_id: input.payment_intent_id ?? null,
    status: 'pending_source_facts',
    line_items_snapshot: cloneJson(lineItems),
    commercial_facts_snapshot: {
      line_items: cloneJson(lineItems),
      totals: {
        currency,
        subtotal_minor_units: totalMarkers.has('price_unknown') ? null : subtotal,
        tax_minor_units: totalMarkers.has('tax_unknown') ? null : tax,
        final_minor_units: totalMarkers.has('final_price_unknown') ? null : final,
        unknown_markers: [...totalMarkers].sort(),
      },
    },
    source_freshness_refs: cloneJson(input.source_freshness_refs ?? {}),
    support_reference: cloneJson(input.support_reference ?? { state: 'support_status_not_enabled_by_c6u7' }),
    audit_evidence_refs: cloneJson(input.audit_evidence_refs),
    idempotency_scope: 'order.foundation.record',
    idempotency_key_hash: input.idempotency_key_hash,
    created_from: input.created_from,
  };
  assertNoCommerceOrderProviderEnablement(draft);
  return draft;
}

export type CommerceOrderRefusalCode =
  | 'order_source_facts_required'
  | 'order_status_not_enabled_by_c6u7'
  | 'order_support_status_not_enabled_by_c6u7'
  | 'order_payment_not_enabled_by_c6u7'
  | 'order_tenant_mismatch'
  | 'order_state_unknown';

const PUBLIC_ORDER_REFUSALS: Record<CommerceOrderRefusalCode, string> = {
  order_source_facts_required: 'Order status is unavailable until Grantex has safe source facts.',
  order_status_not_enabled_by_c6u7: 'Order status is not available from Grantex for this request yet.',
  order_support_status_not_enabled_by_c6u7: 'Support status is not available from Grantex for this order yet.',
  order_payment_not_enabled_by_c6u7: 'Checkout and payment creation are not enabled by the C6U7 order foundation.',
  order_tenant_mismatch: 'Order source facts do not match this tenant.',
  order_state_unknown: 'Order state is unknown. Refresh from Grantex before presenting status.',
};

export function publicCommerceOrderRefusal(code: CommerceOrderRefusalCode): {
  code: CommerceOrderRefusalCode;
  message: string;
  retryable: boolean;
} {
  return {
    code,
    message: PUBLIC_ORDER_REFUSALS[code],
    retryable: code === 'order_source_facts_required' || code === 'order_state_unknown',
  };
}
