/**
 * Grantex native orders as ACP order webhook events (G37).
 *
 * ACP 2026-04-17 (`openapi.agentic_checkout_webhook.yaml`, `WebhookEvent`):
 * the merchant POSTs `{type, data}` to the agent platform, `type` is
 * `order_create` or `order_update`, and `data` is the full `Order`
 * (`schema.agentic_checkout.json#/$defs/Order`) with `type: "order"`,
 * `checkout_session_id`, `permalink_url` and `status` required: a full
 * snapshot, never a delta. The body is signed with
 * `Merchant-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 * and the receiver allows 300 s of skew.
 *
 * The mapper reads a `commerce_orders` row and its `commerce_order_handoffs`;
 * it never emits buyer, agent, audit or provider identifiers. Facts Grantex
 * does not hold (a price, a fulfilment method) are left out, not guessed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CommerceOrderLineItemSnapshot, CommerceOrderStatus } from './order-foundation.js';
import type { CommerceOrderHandoffStatus, CommerceOrderHandoffType } from './order-handoff.js';

export const ACP_ORDER_EVENT_TYPES = ['order_create', 'order_update'] as const;
export type AcpOrderEventType = typeof ACP_ORDER_EVENT_TYPES[number];

/** Default receiver skew (ACP webhook OpenAPI, `Merchant-Signature`). */
export const ACP_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface GrantexOrderRecord {
  id: string;
  cart_id: string | null;
  payment_intent_id: string | null;
  status: CommerceOrderStatus;
  line_items_snapshot: CommerceOrderLineItemSnapshot[];
  commercial_facts_snapshot: {
    totals?: {
      currency?: string | null;
      subtotal_minor_units?: number | null;
      tax_minor_units?: number | null;
      final_minor_units?: number | null;
    };
  };
  created_at: string;
  updated_at: string;
}

export interface GrantexOrderHandoffRecord {
  id: string;
  handoff_type: CommerceOrderHandoffType;
  status: CommerceOrderHandoffStatus;
  handoff_snapshot: { safe_fields?: Record<string, unknown> };
  created_at: string;
  updated_at: string;
}

/** ACP order-level status for each Grantex order status (ACP orders RFC section 4.1 values). */
export const ACP_ORDER_STATUS: Readonly<Record<CommerceOrderStatus, string>> = {
  pending_source_facts: 'created',
  recorded: 'confirmed',
  merchant_acknowledged: 'processing',
  closed: 'completed',
  cancelled: 'canceled',
  expired: 'canceled',
  blocked: 'manual_review',
  unknown: 'manual_review',
};

const ADJUSTMENT_STATUS: Readonly<Record<CommerceOrderHandoffStatus, 'pending' | 'completed' | 'failed'>> = {
  draft: 'pending',
  requested: 'pending',
  acknowledged: 'pending',
  manual_review_required: 'pending',
  resolved_manually: 'completed',
  blocked: 'failed',
  rejected: 'failed',
  expired: 'failed',
  cancelled: 'failed',
};

const FULFILLMENT_STATUS: Readonly<Partial<Record<CommerceOrderHandoffStatus, string>>> = {
  draft: 'pending',
  requested: 'pending',
  manual_review_required: 'pending',
  acknowledged: 'processing',
  cancelled: 'canceled',
  blocked: 'failed',
  rejected: 'failed',
  expired: 'failed',
};

const FULFILLMENT_TYPES = new Set(['shipping', 'pickup', 'digital']);

export class AcpOrderEventError extends Error {
  constructor(readonly code: 'acp_order_checkout_reference_missing' | 'invalid_permalink_base' | 'invalid_event_type', message: string) {
    super(message);
    this.name = 'AcpOrderEventError';
  }
}

export interface AcpOrderEventInput {
  order: GrantexOrderRecord;
  handoffs: readonly GrantexOrderHandoffRecord[];
  /** https origin and path the order page lives under; the order id is appended. */
  permalink_base: string;
  /** The ACP checkout session that produced the order; defaults to the Grantex cart, then payment intent. */
  checkout_session_id?: string | undefined;
  /** Defaults to `order_create` for an order never changed and without handoffs, else `order_update`. */
  event_type?: AcpOrderEventType | undefined;
}

function assertPermalinkBase(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new AcpOrderEventError('invalid_permalink_base', 'permalink_base must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AcpOrderEventError('invalid_permalink_base', 'permalink_base must be an https URL without credentials, query or fragment');
  }
}

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function lineItems(order: GrantexOrderRecord): Array<Record<string, unknown>> {
  const removed = order.status === 'cancelled' || order.status === 'expired';
  const seen = new Map<string, number>();
  return order.line_items_snapshot.map((item) => {
    const count = (seen.get(item.variant_id) ?? 0) + 1;
    seen.set(item.variant_id, count);
    const unitPrice = safeInt(item.unit_price_minor_units);
    return {
      id: count === 1 ? item.variant_id : `${item.variant_id}#${count}`,
      title: item.title,
      product_id: item.product_id,
      quantity: { ordered: item.quantity, current: removed ? 0 : item.quantity, fulfilled: 0 },
      ...(unitPrice !== null ? { unit_price: unitPrice, subtotal: unitPrice * item.quantity } : {}),
      status: removed ? 'removed' : 'processing',
    };
  });
}

function totals(order: GrantexOrderRecord): Array<Record<string, unknown>> {
  const t = order.commercial_facts_snapshot.totals ?? {};
  const out: Array<Record<string, unknown>> = [];
  const subtotal = safeInt(t.subtotal_minor_units);
  const tax = safeInt(t.tax_minor_units);
  const total = safeInt(t.final_minor_units);
  if (subtotal !== null) out.push({ type: 'subtotal', display_text: 'Subtotal', amount: subtotal });
  if (tax !== null) out.push({ type: 'tax', display_text: 'Tax', amount: tax });
  if (total !== null) out.push({ type: 'total', display_text: 'Total', amount: total });
  return out;
}

function adjustments(order: GrantexOrderRecord, handoffs: readonly GrantexOrderHandoffRecord[]): Array<Record<string, unknown>> {
  const currency = order.commercial_facts_snapshot.totals?.currency;
  return handoffs
    .filter((handoff) => handoff.handoff_type === 'refund' || handoff.handoff_type === 'return')
    .map((handoff) => {
      const amount = safeInt(handoff.handoff_snapshot.safe_fields?.['amount_minor_units']);
      return {
        id: handoff.id,
        type: handoff.handoff_type,
        occurred_at: new Date(handoff.updated_at).toISOString(),
        status: ADJUSTMENT_STATUS[handoff.status],
        ...(amount !== null ? { amount } : {}),
        ...(amount !== null && typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? { currency: currency.toLowerCase() } : {}),
      };
    });
}

function fulfillments(handoffs: readonly GrantexOrderHandoffRecord[]): Array<Record<string, unknown>> {
  return handoffs
    .filter((handoff) => handoff.handoff_type === 'fulfillment' || handoff.handoff_type === 'delivery')
    .flatMap((handoff) => {
      const method = handoff.handoff_snapshot.safe_fields?.['fulfillment_method'];
      if (typeof method !== 'string' || !FULFILLMENT_TYPES.has(method)) return [];
      const status = FULFILLMENT_STATUS[handoff.status];
      return [{ id: handoff.id, type: method, ...(status !== undefined ? { status } : {}) }];
    });
}

/** The ACP `WebhookEvent` for a Grantex order: `{type, data}` with the full order snapshot. */
export function mapGrantexOrderToAcpEvent(input: AcpOrderEventInput): { type: AcpOrderEventType; data: Record<string, unknown> } {
  assertPermalinkBase(input.permalink_base);
  if (input.event_type !== undefined && !(ACP_ORDER_EVENT_TYPES as readonly string[]).includes(input.event_type)) {
    throw new AcpOrderEventError('invalid_event_type', `event_type must be one of ${ACP_ORDER_EVENT_TYPES.join(', ')}`);
  }
  const { order, handoffs } = input;
  const checkoutSessionId = input.checkout_session_id ?? order.cart_id ?? order.payment_intent_id;
  if (!checkoutSessionId) {
    throw new AcpOrderEventError('acp_order_checkout_reference_missing',
      'The order has no cart or payment intent; pass the ACP checkout_session_id that produced it');
  }
  const unchanged = Date.parse(order.updated_at) <= Date.parse(order.created_at) && handoffs.length === 0;
  const items = lineItems(order);
  const orderTotals = totals(order);
  const orderAdjustments = adjustments(order, handoffs);
  const orderFulfillments = fulfillments(handoffs);
  return {
    type: input.event_type ?? (unchanged ? 'order_create' : 'order_update'),
    data: {
      type: 'order',
      id: order.id,
      checkout_session_id: checkoutSessionId,
      permalink_url: `${stripTrailingSlashes(input.permalink_base)}/${encodeURIComponent(order.id)}`,
      status: ACP_ORDER_STATUS[order.status],
      line_items: items,
      ...(orderFulfillments.length > 0 ? { fulfillments: orderFulfillments } : {}),
      ...(orderAdjustments.length > 0 ? { adjustments: orderAdjustments } : {}),
      ...(orderTotals.length > 0 ? { totals: orderTotals } : {}),
    },
  };
}

/**
 * `base` without its trailing slashes, in linear time. A `/\/+$/` replace
 * backtracks quadratically on a caller-supplied base made of many slashes.
 */
export function stripTrailingSlashes(base: string): string {
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end -= 1;
  return base.slice(0, end);
}

/** `Merchant-Signature` for a raw webhook body: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. */
export function acpMerchantSignature(secret: string, rawBody: string, unixSeconds: number): string {
  if (secret.length === 0) throw new Error('acpMerchantSignature: empty secret');
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) throw new Error('acpMerchantSignature: invalid timestamp');
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`, 'utf8').digest('hex');
  return `t=${unixSeconds},v1=${v1}`;
}

/**
 * Receiver check: header shape `^t=\d+,v1=[a-fA-F0-9]{64}$`, timestamp within
 * the tolerance of `nowSeconds`, HMAC compared in constant time.
 */
export function verifyAcpMerchantSignature(
  header: string | undefined,
  secret: string,
  rawBody: string,
  nowSeconds: number,
  toleranceSeconds = ACP_WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  const match = typeof header === 'string' ? /^t=(\d+),v1=([a-fA-F0-9]{64})$/.exec(header) : null;
  if (!match || secret.length === 0) return false;
  const t = Number(match[1]);
  if (!Number.isSafeInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'), 'utf8');
  const presented = Buffer.from(match[2]!.toLowerCase(), 'utf8');
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
