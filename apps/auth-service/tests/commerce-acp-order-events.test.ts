/**
 * G37: Grantex native orders mapped to ACP 2026-04-17 `order_create` /
 * `order_update` webhook events, validated against the saved ACP webhook and
 * order schemas, and the `Merchant-Signature` HMAC against the shared vectors.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_ORDER_STATUS,
  AcpOrderEventError,
  acpMerchantSignature,
  mapGrantexOrderToAcpEvent,
  verifyAcpMerchantSignature,
  type GrantexOrderHandoffRecord,
  type GrantexOrderRecord,
} from '../src/lib/commerce/acp-order-events.js';
import { COMMERCE_ORDER_STATUSES } from '../src/lib/commerce/order-foundation.js';
import { schemaErrors } from './protocol-schemas.js';
import { buildTestApp, sqlMock } from './helpers.js';

const WEBHOOK = 'https://example.com/schemas/agentic-checkout-webhook/webhook-event.schema.json';
const CHECKOUT = 'https://example.com/schemas/agentic-checkout/bundle.schema.json';
const TENANT = 'cten_ACPORDER';
const SERVICE_TOKEN = 'agenticorg-acp-orders-fixture-token';
const VECTORS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'acp', 'merchant-signature-v1.json'), 'utf8',
)) as { secret: string; cases: Array<{ name: string; raw_body: string; t: number; now: number; header: string; valid: boolean }> };

function order(overrides: Partial<GrantexOrderRecord> = {}): GrantexOrderRecord {
  return {
    id: 'cord_01EXAMPLE',
    cart_id: 'ccart_01EXAMPLE',
    payment_intent_id: null,
    status: 'recorded',
    line_items_snapshot: [
      {
        product_id: 'cprd_01', variant_id: 'cvar_01', title: 'Ceramic mug', sku: 'MUG-01', quantity: 2,
        unit_price_minor_units: 45000, currency: 'INR', tax_amount_minor_units: null, final_price_minor_units: null,
        unknown_markers: ['tax_unknown'], source_refs: [{ source: 'cart', source_id: 'ccart_01EXAMPLE' }],
      },
      {
        product_id: 'cprd_02', variant_id: 'cvar_02', title: 'Linen napkin', sku: 'NAP-02', quantity: 1,
        unit_price_minor_units: null, currency: null, tax_amount_minor_units: null, final_price_minor_units: null,
        unknown_markers: ['price_unknown'], source_refs: [],
      },
    ],
    commercial_facts_snapshot: { totals: { currency: 'INR', subtotal_minor_units: 90000, tax_minor_units: null, final_minor_units: 90000 } },
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

function handoff(overrides: Partial<GrantexOrderHandoffRecord>): GrantexOrderHandoffRecord {
  return {
    id: 'cohf_01',
    handoff_type: 'fulfillment',
    status: 'requested',
    handoff_snapshot: { safe_fields: {} },
    created_at: '2026-10-20T09:05:00.000Z',
    updated_at: '2026-10-20T09:06:00.000Z',
    ...overrides,
  };
}

const PERMALINK = 'https://merchant.example/orders';

describe('mapGrantexOrderToAcpEvent', () => {
  it('emits order_create for a new order, valid against the ACP WebhookEvent schema', () => {
    const event = mapGrantexOrderToAcpEvent({ order: order(), handoffs: [], permalink_base: PERMALINK });
    expect(schemaErrors('acp-2026-04-17', WEBHOOK, event)).toEqual([]);
    expect(event.type).toBe('order_create');
    expect(event.data).toMatchObject({
      type: 'order',
      id: 'cord_01EXAMPLE',
      checkout_session_id: 'ccart_01EXAMPLE',
      permalink_url: 'https://merchant.example/orders/cord_01EXAMPLE',
      status: 'confirmed',
      totals: [
        { type: 'subtotal', display_text: 'Subtotal', amount: 90000 },
        { type: 'total', display_text: 'Total', amount: 90000 },
      ],
    });
    // A price Grantex does not hold is left out, not guessed.
    expect(event.data['line_items']).toEqual([
      { id: 'cvar_01', title: 'Ceramic mug', product_id: 'cprd_01', quantity: { ordered: 2, current: 2, fulfilled: 0 }, unit_price: 45000, subtotal: 90000, status: 'processing' },
      { id: 'cvar_02', title: 'Linen napkin', product_id: 'cprd_02', quantity: { ordered: 1, current: 1, fulfilled: 0 }, status: 'processing' },
    ]);
  });

  it('maps every Grantex order status to a valid ACP order', () => {
    for (const status of COMMERCE_ORDER_STATUSES) {
      const event = mapGrantexOrderToAcpEvent({ order: order({ status }), handoffs: [], permalink_base: PERMALINK });
      expect(event.data['status']).toBe(ACP_ORDER_STATUS[status]);
      expect(schemaErrors('acp-2026-04-17', WEBHOOK, event)).toEqual([]);
    }
    const cancelled = mapGrantexOrderToAcpEvent({ order: order({ status: 'cancelled' }), handoffs: [], permalink_base: PERMALINK });
    expect((cancelled.data['line_items'] as Array<{ status: string; quantity: { current: number } }>)
      .every((item) => item.status === 'removed' && item.quantity.current === 0)).toBe(true);
  });

  it('emits order_update with fulfillments and adjustments from handoffs, as a full snapshot', () => {
    const event = mapGrantexOrderToAcpEvent({
      order: order({ updated_at: '2026-10-20T09:10:00.000Z' }),
      handoffs: [
        handoff({ id: 'cohf_ship', handoff_type: 'fulfillment', status: 'acknowledged', handoff_snapshot: { safe_fields: { fulfillment_method: 'shipping' } } }),
        handoff({ id: 'cohf_unknown', handoff_type: 'delivery', status: 'requested', handoff_snapshot: { safe_fields: {} } }),
        handoff({ id: 'cohf_refund', handoff_type: 'refund', status: 'resolved_manually', handoff_snapshot: { safe_fields: { amount_minor_units: 45000 } } }),
        handoff({ id: 'cohf_return', handoff_type: 'return', status: 'rejected' }),
        handoff({ id: 'cohf_support', handoff_type: 'support', status: 'requested' }),
      ],
      permalink_base: `${PERMALINK}/`,
    });
    expect(schemaErrors('acp-2026-04-17', WEBHOOK, event)).toEqual([]);
    expect(event.type).toBe('order_update');
    expect(event.data['permalink_url']).toBe('https://merchant.example/orders/cord_01EXAMPLE');
    expect(event.data['fulfillments']).toEqual([{ id: 'cohf_ship', type: 'shipping', status: 'processing' }]);
    expect(event.data['adjustments']).toEqual([
      { id: 'cohf_refund', type: 'refund', occurred_at: '2026-10-20T09:06:00.000Z', status: 'completed', amount: 45000, currency: 'inr' },
      { id: 'cohf_return', type: 'return', occurred_at: '2026-10-20T09:06:00.000Z', status: 'failed' },
    ]);
    for (const adjustment of event.data['adjustments'] as unknown[]) {
      expect(schemaErrors('acp-2026-04-17', `${CHECKOUT}#/$defs/Adjustment`, adjustment)).toEqual([]);
    }
  });

  it('never emits buyer, agent, audit or provider identifiers', () => {
    const text = JSON.stringify(mapGrantexOrderToAcpEvent({
      order: { ...order(), ...{ buyer_principal_id: 'buyer-secret', agent_id: 'agent-secret', audit_evidence_refs: [{ ref: 'audit-secret' }] } } as GrantexOrderRecord,
      handoffs: [], permalink_base: PERMALINK,
    }));
    for (const value of ['buyer-secret', 'agent-secret', 'audit-secret', 'source_refs', 'unknown_markers', 'sku']) expect(text).not.toContain(value);
  });

  it('uses the given checkout session and event type, falls back to the payment intent, and refuses without either', () => {
    expect(mapGrantexOrderToAcpEvent({ order: order(), handoffs: [], permalink_base: PERMALINK, checkout_session_id: 'cs_acp_01', event_type: 'order_update' }))
      .toMatchObject({ type: 'order_update', data: { checkout_session_id: 'cs_acp_01' } });
    expect(mapGrantexOrderToAcpEvent({ order: order({ cart_id: null, payment_intent_id: 'cpi_01' }), handoffs: [], permalink_base: PERMALINK }).data['checkout_session_id'])
      .toBe('cpi_01');
    expect(() => mapGrantexOrderToAcpEvent({ order: order({ cart_id: null }), handoffs: [], permalink_base: PERMALINK }))
      .toThrow(AcpOrderEventError);
    for (const base of ['http://merchant.example/orders', 'https://merchant.example/orders?x=1', 'not a url']) {
      expect(() => mapGrantexOrderToAcpEvent({ order: order(), handoffs: [], permalink_base: base })).toThrow(/permalink_base/);
    }
  });
});

describe('Merchant-Signature', () => {
  it.each(VECTORS.cases)('vector $name', (vector) => {
    expect(verifyAcpMerchantSignature(vector.header, VECTORS.secret, vector.raw_body, vector.now)).toBe(vector.valid);
  });

  it('signs exactly as the vectors and as the ACP header pattern requires', () => {
    const vector = VECTORS.cases.find((c) => c.name === 'valid')!;
    const header = acpMerchantSignature(VECTORS.secret, vector.raw_body, vector.t);
    expect(header).toBe(vector.header);
    expect(header).toMatch(/^t=\d+,v1=[a-fA-F0-9]{64}$/);
    expect(verifyAcpMerchantSignature(header, 'another-secret', vector.raw_body, vector.now)).toBe(false);
    expect(verifyAcpMerchantSignature(undefined, VECTORS.secret, vector.raw_body, vector.now)).toBe(false);
  });

  it('signs a mapped event body that the receiver verifies', () => {
    const body = JSON.stringify(mapGrantexOrderToAcpEvent({ order: order(), handoffs: [], permalink_base: PERMALINK }));
    const now = 1_792_483_200;
    expect(verifyAcpMerchantSignature(acpMerchantSignature(VECTORS.secret, body, now), VECTORS.secret, body, now + 5)).toBe(true);
  });
});

describe('GET /v1/commerce/oacp/acp/orders/:orderId/event', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  const get = (query: string, id = 'cord_01EXAMPLE') => app.inject({
    method: 'GET',
    url: `/v1/commerce/oacp/acp/orders/${id}/event?${query}`,
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const base = `tenant_id=${TENANT}&permalink_base=${encodeURIComponent(PERMALINK)}`;

  it('returns the event for the tenant\'s order, read with tenant-scoped queries', async () => {
    sqlMock.mockResolvedValueOnce([{ ...order(), created_at: new Date(order().created_at), updated_at: new Date(order().updated_at) }]);
    sqlMock.mockResolvedValueOnce([]);
    const res = await get(base);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { event } = res.json<{ event: unknown }>();
    expect(schemaErrors('acp-2026-04-17', WEBHOOK, event)).toEqual([]);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([TENANT, 'cord_01EXAMPLE']);
    expect(sqlMock.mock.calls[1]!.slice(1)).toEqual([TENANT, 'cord_01EXAMPLE']);
  });

  it('answers 404 for another tenant\'s or a missing order, 409 without a checkout reference', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect((await get(base)).statusCode).toBe(404);
    sqlMock.mockResolvedValueOnce([order({ cart_id: null })]).mockResolvedValueOnce([]);
    const conflict = await get(base);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('acp_order_checkout_reference_missing');
  });

  it('refuses a tenant outside the allowlist and invalid query members before reading', async () => {
    expect((await get(base.replace(TENANT, 'cten_OTHER'))).statusCode).toBe(403);
    expect((await get(`tenant_id=${TENANT}`)).statusCode).toBe(422);
    expect((await get(`${base}&event_type=order.created`)).statusCode).toBe(422);
    expect((await get(`${base}&checkout_session_id=${encodeURIComponent('a b')}`)).statusCode).toBe(422);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
