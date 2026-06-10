import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  allowedCommerceOrderHandoffStatusTransitions,
  assertCommerceOrderHandoffBoundary,
  assertCommerceOrderHandoffStatusTransition,
  assertCommerceOrderHandoffType,
  buildCommerceOrderHandoffFoundationDraft,
  buildCommerceOrderHandoffSnapshot,
  commerceOrderHandoffIdempotencyScope,
  publicCommerceOrderHandoffRefusal,
  publicCommerceOrderHandoffStatusSummary,
  redactCommerceOrderHandoffPrivateFields,
} from '../src/lib/commerce/order-handoff.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/058_commerce_order_handoff_foundation.sql');
const DOC_PATH = join(TEST_DIR, '../../../docs/internal/commerce-v1/commerce-v1-c6u8-fulfillment-delivery-support-return-refund-handoff.md');

const TENANT = 'cten_C6U8';
const MERCHANT = 'mch_C6U8';
const ORDER = 'cord_C6U8';
const BUYER = 'buyer_C6U8';
const AGENT = 'cag_C6U8';
const SESSION = 'buyer_session_C6U8';

function baseDraftInput() {
  return {
    tenant_id: TENANT,
    order_id: ORDER,
    merchant_id: MERCHANT,
    buyer_principal_id: BUYER,
    agent_id: AGENT,
    session_id: SESSION,
    handoff_type: 'delivery',
    handoff_snapshot: {
      handoff_type: 'delivery',
      summary: 'Delivery source facts pending from Grantex-safe source.',
      safe_fields: { promised_window: null, current_state: 'source_facts_pending' },
      source_refs: [{ source: 'order' as const, source_id: ORDER, checked_at: '2026-06-10T00:00:00.000Z', freshness: 'fresh' as const }],
    },
    source_freshness_refs: { order_checked_at: '2026-06-10T00:00:00.000Z' },
    audit_evidence_refs: [{ audit_event_id: 'caud_C6U8_HANDOFF' }],
    idempotency_key_hash: 'hash_handoff_idempotency',
    created_from: 'order_safe_source' as const,
    scoped_refs: [
      { label: 'order', tenant_id: TENANT, order_id: ORDER, merchant_id: MERCHANT, buyer_principal_id: BUYER },
    ],
  };
}

describe('C6U8 commerce order handoff foundation', () => {
  it('adds tenant-scoped order handoffs without execution fields or endpoints', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_order_handoffs/);
    expect(migration).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES commerce_tenants\(id\)/);
    expect(migration).toMatch(/order_id\s+TEXT NOT NULL/);
    expect(migration).toMatch(/merchant_id\s+TEXT NOT NULL/);
    expect(migration).toMatch(/buyer_principal_id\s+TEXT NOT NULL/);
    expect(migration).toMatch(/handoff_type IN \('fulfillment','delivery','support','return','refund'\)/);
    expect(migration).toMatch(/status IN \(/);
    expect(migration).toMatch(/uq_commerce_order_handoffs_idempotency/);
    expect(migration).toMatch(/fk_commerce_order_handoff_order/);
    expect(migration).toMatch(/commerce_order_handoffs_block_immutable_update/);
    expect(migration).toMatch(/commerce_order_handoffs immutable fields cannot be changed/);
    expect(migration).toMatch(/uq_commerce_orders_tenant_order_merchant/);
    expect(migration).not.toMatch(/provider_payment_id/);
    expect(migration).not.toMatch(/checkout_url/);
    expect(migration).not.toMatch(/carrier_tracking_url/);
    expect(migration).not.toMatch(/refund_transaction_id/);
    expect(migration).not.toMatch(/settlement_id/);
    expect(migration).not.toMatch(/payout_id/);
    expect(migration).not.toMatch(/merchant_private_api/);
  });

  it('builds immutable handoff snapshots and redacts private fields', () => {
    const source = {
      handoff_type: 'support',
      summary: 'Support source facts pending.',
      safe_fields: {
        ticket_state: 'not_started',
        jwt: 'private-token',
        nested: { webhook_secret: 'private-secret' },
      },
      source_refs: [{ source: 'order' as const, source_id: ORDER, freshness: 'fresh' as const }],
    };
    const snapshot = buildCommerceOrderHandoffSnapshot(source);

    source.safe_fields.ticket_state = 'mutated';

    expect(snapshot).toMatchObject({
      handoff_type: 'support',
      summary: 'Support source facts pending.',
    });
    expect(snapshot.safe_fields).toMatchObject({
      ticket_state: 'not_started',
      jwt: '[redacted]',
      nested: { webhook_secret: '[redacted]' },
    });
  });

  it('builds draft records with tenant/order scoped idempotency', () => {
    const draft = buildCommerceOrderHandoffFoundationDraft(baseDraftInput());

    expect(draft.id).toMatch(/^cohf_/);
    expect(draft.status).toBe('draft');
    expect(draft.handoff_type).toBe('delivery');
    expect(draft.idempotency_scope).toBe('order.handoff.delivery.record');
    expect(commerceOrderHandoffIdempotencyScope('refund')).toBe('order.handoff.refund.record');
    expect(draft.support_reference).toEqual({ state: 'handoff_support_not_enabled_by_c6u8' });
  });

  it('refuses mismatched tenant, order, merchant, and buyer source references fail closed', () => {
    expect(() => assertCommerceOrderHandoffBoundary({
      tenant_id: TENANT,
      order_id: ORDER,
      merchant_id: MERCHANT,
      refs: [{ label: 'order', tenant_id: 'cten_OTHER', order_id: ORDER, merchant_id: MERCHANT }],
    })).toThrow(/do not match this tenant/);

    expect(() => assertCommerceOrderHandoffBoundary({
      tenant_id: TENANT,
      order_id: ORDER,
      merchant_id: MERCHANT,
      refs: [{ label: 'order', tenant_id: TENANT, order_id: 'cord_OTHER', merchant_id: MERCHANT }],
    })).toThrow(/do not match this order/);

    expect(() => assertCommerceOrderHandoffBoundary({
      tenant_id: TENANT,
      order_id: ORDER,
      merchant_id: MERCHANT,
      refs: [{ label: 'order', tenant_id: TENANT, order_id: ORDER, merchant_id: 'mch_OTHER' }],
    })).toThrow(/do not match this merchant/);

    expect(() => assertCommerceOrderHandoffBoundary({
      tenant_id: TENANT,
      order_id: ORDER,
      merchant_id: MERCHANT,
      buyer_principal_id: BUYER,
      refs: [{ label: 'order', tenant_id: TENANT, order_id: ORDER, merchant_id: MERCHANT, buyer_principal_id: 'buyer_OTHER' }],
    })).toThrow(/do not match this buyer/);
  });

  it('validates handoff types and fail-closed status transitions', () => {
    expect(assertCommerceOrderHandoffType('fulfillment')).toBe('fulfillment');
    expect(() => assertCommerceOrderHandoffType('settlement')).toThrow(/Order handoff foundation input is invalid/);
    expect(allowedCommerceOrderHandoffStatusTransitions('draft')).toEqual([
      'requested',
      'blocked',
      'cancelled',
      'expired',
      'manual_review_required',
    ]);
    expect(() => assertCommerceOrderHandoffStatusTransition('draft', 'requested')).not.toThrow();
    expect(() => assertCommerceOrderHandoffStatusTransition('resolved_manually', 'requested')).toThrow(/not allowed/);
    expect(() => assertCommerceOrderHandoffStatusTransition('requested', 'fulfilled' as never)).toThrow(/Order handoff foundation input is invalid/);
  });

  it('rejects provider, carrier, refund, private API, settlement, and payout execution fields', () => {
    const forbiddenSamples = [
      { carrierTrackingUrl: 'https://carrier.example.invalid/track/private' },
      { refundTransactionId: 'refund_private' },
      { merchantPrivateApiUrl: 'https://merchant-private.example.invalid/orders' },
      { provider_payment_id: 'pay_private' },
      { checkoutUrl: 'https://checkout.example.invalid' },
      { settlementId: 'set_private' },
      { payoutId: 'po_private' },
      { raw_payload: { private: true } },
    ];

    for (const safe_fields of forbiddenSamples) {
      expect(() => buildCommerceOrderHandoffSnapshot({
        handoff_type: 'refund',
        safe_fields,
        source_refs: [{ source: 'order', source_id: ORDER }],
      })).toThrow(/cannot carry/);
    }
  });

  it('keeps buyer-facing handoff refusals and status summaries safe', () => {
    const refusal = publicCommerceOrderHandoffRefusal('order_handoff_execution_not_enabled_by_c6u8');
    const summary = publicCommerceOrderHandoffStatusSummary({ handoff_type: 'return', status: 'manual_review_required' });
    const redacted = redactCommerceOrderHandoffPrivateFields({
      raw_payload: { passport: 'private-passport' },
      public_state: 'manual_review_required',
    });
    const serialized = JSON.stringify({ refusal, summary, redacted });

    expect(refusal.retryable).toBe(false);
    expect(summary.retryable).toBe(true);
    expect(redacted).toMatchObject({
      raw_payload: '[redacted]',
      public_state: 'manual_review_required',
    });
    expect(serialized).not.toContain('private-passport');
    expect(serialized).not.toContain('provider_payment_id');
    expect(serialized).not.toContain('merchant-private');
    expect(serialized).not.toContain('webhook_secret');
  });

  it('documents non-enabling scope and AgenticOrg refusal rules', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    expect(doc).toContain('No endpoint or OpenAPI surface is added by C6U8');
    expect(doc).toContain('AgenticOrg must refuse fulfillment, delivery, support, return, and refund status');
    expect(doc).toContain('not a production launch, public discovery approval, checkout approval, payment approval, merchant approval, protocol publication, external submission');
    expect(doc).toContain('Rollback requires care because migration 058 adds a composite uniqueness constraint to `commerce_orders`');
  });
});
