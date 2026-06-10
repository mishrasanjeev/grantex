import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  allowedCommerceOrderStatusTransitions,
  assertCommerceOrderStatusTransition,
  assertCommerceOrderTenantBoundary,
  buildCommerceOrderFoundationDraft,
  buildCommerceOrderLineItemSnapshot,
  publicCommerceOrderRefusal,
} from '../src/lib/commerce/order-foundation.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/057_commerce_order_foundation.sql');
const DOC_PATH = join(TEST_DIR, '../../../docs/internal/commerce-v1/commerce-v1-c6u7-order-foundation.md');

const TENANT = 'cten_C6U7';
const MERCHANT = 'mch_C6U7';
const AGENT = 'cag_C6U7';
const CART = 'ccart_C6U7';
const PAYMENT_INTENT = 'cpi_C6U7';

function baseLineItem() {
  return {
    product_id: 'cprd_C6U7',
    variant_id: 'cvar_C6U7',
    title: 'Countertop Oven',
    sku: 'OVEN-C6U7',
    quantity: 2,
    unit_price_minor_units: 125000,
    currency: 'INR',
    tax_amount_minor_units: null,
    final_price_minor_units: null,
    source_refs: [{ source: 'cart' as const, source_id: CART, checked_at: '2026-06-10T00:00:00.000Z', freshness: 'fresh' as const }],
  };
}

describe('C6U7 commerce order foundation', () => {
  it('adds a tenant-scoped order table without provider or checkout execution fields', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_orders/);
    expect(migration).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES commerce_tenants\(id\)/);
    expect(migration).toMatch(/buyer_principal_id\s+TEXT NOT NULL/);
    expect(migration).toMatch(/line_items_snapshot\s+JSONB NOT NULL/);
    expect(migration).toMatch(/commercial_facts_snapshot\s+JSONB NOT NULL/);
    expect(migration).toMatch(/support_reference\s+JSONB NOT NULL/);
    expect(migration).toMatch(/audit_evidence_refs\s+JSONB NOT NULL/);
    expect(migration).toMatch(/uq_commerce_orders_idempotency/);
    expect(migration).toMatch(/fk_commerce_orders_cart/);
    expect(migration).toMatch(/fk_commerce_orders_payment_intent/);
    expect(migration).toMatch(/commerce_orders_block_immutable_update/);
    expect(migration).toMatch(/commerce_orders immutable fields cannot be changed/);
    expect(migration).not.toMatch(/provider_payment_id/);
    expect(migration).not.toMatch(/provider_order_id/);
    expect(migration).not.toMatch(/checkout_url/);
  });

  it('builds immutable line-item and commercial fact snapshots with unknown tax/final-price markers', () => {
    const sourceItem = baseLineItem();
    const draft = buildCommerceOrderFoundationDraft({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      buyer_principal_id: 'buyer_C6U7',
      agent_id: AGENT,
      cart_id: CART,
      payment_intent_id: PAYMENT_INTENT,
      created_from: 'payment_intent_snapshot',
      idempotency_key_hash: 'hash_idempotency',
      line_items: [sourceItem],
      source_freshness_refs: { cart_checked_at: '2026-06-10T00:00:00.000Z' },
      audit_evidence_refs: [{ audit_event_id: 'caud_C6U7_CART' }],
      scoped_refs: [
        { label: 'cart', tenant_id: TENANT, merchant_id: MERCHANT, id: CART },
        { label: 'payment_intent', tenant_id: TENANT, merchant_id: MERCHANT, id: PAYMENT_INTENT },
      ],
    });

    sourceItem.title = 'Mutated title after snapshot';

    expect(draft.id).toMatch(/^cord_/);
    expect(draft.status).toBe('pending_source_facts');
    expect(draft.line_items_snapshot[0]?.title).toBe('Countertop Oven');
    expect(draft.commercial_facts_snapshot.totals).toMatchObject({
      currency: 'INR',
      subtotal_minor_units: 250000,
      tax_minor_units: null,
      final_minor_units: null,
    });
    expect(draft.commercial_facts_snapshot.totals.unknown_markers).toEqual([
      'final_price_unknown',
      'tax_unknown',
    ]);
    expect(draft.support_reference).toEqual({ state: 'support_status_not_enabled_by_c6u7' });
  });

  it('refuses mismatched tenant and merchant source references fail closed', () => {
    expect(() => assertCommerceOrderTenantBoundary({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      refs: [{ label: 'cart', tenant_id: 'cten_OTHER', merchant_id: MERCHANT, id: CART }],
    })).toThrow(/Order source facts do not match this tenant/);

    expect(() => assertCommerceOrderTenantBoundary({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      refs: [{ label: 'payment_intent', tenant_id: TENANT, merchant_id: 'mch_OTHER', id: PAYMENT_INTENT }],
    })).toThrow(/Order source facts do not match this merchant/);
  });

  it('keeps order status transitions fail-closed and non-payment-enabling', () => {
    expect(allowedCommerceOrderStatusTransitions('pending_source_facts')).toEqual([
      'recorded',
      'blocked',
      'cancelled',
      'expired',
      'unknown',
    ]);
    expect(() => assertCommerceOrderStatusTransition('pending_source_facts', 'recorded')).not.toThrow();
    expect(() => assertCommerceOrderStatusTransition('closed', 'recorded')).toThrow(/not allowed/);
    expect(() => assertCommerceOrderStatusTransition('recorded', 'paid' as never)).toThrow(/not allowed/);
  });

  it('rejects live payment/provider execution fields in order facts', () => {
    expect(() => buildCommerceOrderLineItemSnapshot({
      ...baseLineItem(),
      source_refs: [{ source: 'cart', source_id: CART, provider_payment_id: 'pay_private' } as never],
    })).toThrow(/live payment or provider execution fields/);

    expect(() => buildCommerceOrderLineItemSnapshot({
      ...baseLineItem(),
      source_refs: [{ source: 'cart', source_id: CART, checkoutUrl: 'https://checkout.example.invalid' } as never],
    })).toThrow(/live payment or provider execution fields/);
  });

  it('keeps public order refusals buyer-safe', () => {
    const refusal = publicCommerceOrderRefusal('order_status_not_enabled_by_c6u7');
    const serialized = JSON.stringify(refusal);

    expect(refusal).toMatchObject({
      code: 'order_status_not_enabled_by_c6u7',
      retryable: false,
    });
    expect(serialized).not.toContain('passport');
    expect(serialized).not.toContain('jwt');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('provider_payment_id');
    expect(serialized).not.toContain('merchant-private');
    expect(serialized).not.toContain('raw_payload');
  });

  it('documents AgenticOrg refusal unless Grantex safe order facts exist', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    expect(doc).toContain('AgenticOrg must refuse order or support status when Grantex has not provided buyer-safe source facts');
    expect(doc).toContain('checkout/payment creation remains blocked by C6U7');
    expect(doc).toContain('not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, or protocol publication');
  });
});
