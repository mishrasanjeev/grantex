import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  allowedCommerceSandboxCheckoutStatusTransitions,
  assertCommerceSandboxCheckoutStatusTransition,
  buildCommerceSandboxCheckoutE2EPlan,
  compareCommerceSandboxCheckoutReplay,
  hashCommerceSandboxCheckoutRequest,
  publicCommerceSandboxCheckoutRefusal,
  redactCommerceSandboxCheckoutPrivateFields,
  type CommerceSandboxCheckoutE2EInput,
  type CommerceSandboxCheckoutPriorResult,
} from '../src/lib/commerce/sandbox-checkout-e2e.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(TEST_DIR, '../../../docs/internal/commerce-v1/commerce-v1-c6u9-sandbox-checkout-e2e-foundation.md');

const TENANT = 'cten_C6U9';
const MERCHANT = 'mch_C6U9';
const AGENT = 'cag_C6U9';
const BUYER = 'buyer_C6U9';
const SESSION = 'buyer_session_C6U9';
const CART = 'ccart_C6U9';
const PAYMENT_INTENT = 'cpi_C6U9';

function baseInput(overrides: Partial<CommerceSandboxCheckoutE2EInput> = {}): CommerceSandboxCheckoutE2EInput {
  return {
    tenant_id: TENANT,
    merchant_id: MERCHANT,
    buyer_principal_id: BUYER,
    agent_id: AGENT,
    session_id: SESSION,
    environment: 'sandbox',
    public_discovery_state: 'hidden',
    cart: {
      cart_id: CART,
      source_checked_at: '2026-06-10T00:00:00.000Z',
      line_items: [{
        product_id: 'cprd_C6U9',
        variant_id: 'cvar_C6U9',
        title: 'Sandbox Router',
        sku: 'RTR-C6U9',
        quantity: 1,
        unit_price_minor_units: 199900,
        currency: 'INR',
        tax_amount_minor_units: null,
        final_price_minor_units: null,
        source_refs: [{
          source: 'cart',
          source_id: CART,
          checked_at: '2026-06-10T00:00:00.000Z',
          freshness: 'fresh',
        }],
      }],
    },
    payment_intent_id: PAYMENT_INTENT,
    synthetic_payment_outcome: 'synthetic_authorized',
    authority: {
      consent_granted: true,
      passport_status: 'valid',
      passport_type: 'checkout',
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      agent_id: AGENT,
      buyer_principal_id: BUYER,
      session_id: SESSION,
      environment: 'sandbox',
      scopes: ['commerce:checkout.create', 'commerce:payment.initiate'],
    },
    source_freshness_refs: {
      cart_checked_at: '2026-06-10T00:00:00.000Z',
      source: 'local_sandbox_fixture',
    },
    buyer_safe_context: {
      display_state: 'sandbox_sequence_ready',
    },
    audit_evidence_refs: [
      { audit_event_id: 'caud_C6U9_CONSENT' },
      { audit_event_id: 'caud_C6U9_CART' },
    ],
    idempotency_key_hash: 'hash_c6u9_idempotency',
    ...overrides,
  };
}

describe('C6U9 sandbox checkout E2E foundation', () => {
  it('builds a tenant-scoped sandbox sequence linking cart, authority, order, handoff, synthetic payment, and audit facts', () => {
    const result = buildCommerceSandboxCheckoutE2EPlan(baseInput());

    expect(result.status).toBe('synthetic_outcome_recorded');
    if (result.status !== 'synthetic_outcome_recorded') throw new Error('expected ready result');

    expect(result).toMatchObject({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      buyer_principal_id: BUYER,
      agent_id: AGENT,
      session_id: SESSION,
      environment: 'sandbox',
      buyer_facing_checkout_surface: 'not_exposed',
      public_discovery_state: 'hidden',
      idempotency_scope: 'sandbox.checkout.e2e.contract',
      idempotency_key_hash: 'hash_c6u9_idempotency',
    });
    expect(result.order).toMatchObject({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      buyer_principal_id: BUYER,
      cart_id: CART,
      payment_intent_id: PAYMENT_INTENT,
      status: 'pending_source_facts',
    });
    expect(result.order.line_items_snapshot[0]?.title).toBe('Sandbox Router');
    expect(result.order.commercial_facts_snapshot.totals.unknown_markers).toEqual([
      'final_price_unknown',
      'tax_unknown',
    ]);
    expect(result.handoff).toMatchObject({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      buyer_principal_id: BUYER,
      session_id: SESSION,
      handoff_type: 'fulfillment',
      status: 'draft',
    });
    expect(result.handoff.order_id).toBe(result.order.id);
    expect(result.synthetic_payment).toMatchObject({
      payment_intent_id: PAYMENT_INTENT,
      outcome: 'synthetic_authorized',
      mode: 'local_sandbox_contract_only',
      live_mode: false,
      provider_call: false,
      partner_payment_rail_call: false,
      carrier_call: false,
      merchant_private_api_call: false,
      production_checkout_enabled: false,
    });
    expect(result.non_enablement).toEqual({
      production_checkout: false,
      live_payment: false,
      live_partner_payment_rail: false,
      provider_call: false,
      partner_payment_rail_call: false,
      carrier_call: false,
      merchant_private_api_call: false,
      public_discovery: false,
    });
    expect(result.audit_evidence_refs).toHaveLength(2);
    expect(result.sequence.map((step) => step.status)).toEqual([
      'authority_checked',
      'order_linked',
      'handoff_linked',
      'synthetic_outcome_recorded',
    ]);
  });

  it('refuses missing tenant, merchant, buyer, agent, session, cart, audit, and idempotency context fail closed', () => {
    const cases: Array<[Partial<CommerceSandboxCheckoutE2EInput>, string]> = [
      [{ tenant_id: '' }, 'sandbox_checkout_tenant_context_required'],
      [{ merchant_id: '' }, 'sandbox_checkout_merchant_context_required'],
      [{ buyer_principal_id: '' }, 'sandbox_checkout_buyer_context_required'],
      [{ agent_id: '' }, 'sandbox_checkout_agent_context_required'],
      [{ session_id: '' }, 'sandbox_checkout_session_context_required'],
      [{ cart: { cart_id: '', line_items: [] } }, 'sandbox_checkout_cart_required'],
      [{ cart: { cart_id: CART, line_items: [] } }, 'sandbox_checkout_cart_facts_required'],
      [{ audit_evidence_refs: [] }, 'sandbox_checkout_audit_evidence_required'],
      [{ idempotency_key_hash: '' }, 'sandbox_checkout_idempotency_required'],
    ];

    for (const [override, code] of cases) {
      const result = buildCommerceSandboxCheckoutE2EPlan(baseInput(override));
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') throw new Error('expected refused result');
      expect(result.refusal.code).toBe(code);
      expect(result.buyer_facing_checkout_surface).toBe('not_exposed');
      expect(result.non_enablement.public_discovery).toBe(false);
    }
  });

  it('refuses missing, expired, revoked, mismatched, unknown, and non-checkout authority', () => {
    const cases: Array<[Partial<CommerceSandboxCheckoutE2EInput>, string]> = [
      [{ authority: { ...baseInput().authority, consent_granted: false } }, 'sandbox_checkout_consent_required'],
      [{ authority: { ...baseInput().authority, passport_status: 'missing' } }, 'sandbox_checkout_passport_required'],
      [{ authority: { ...baseInput().authority, passport_status: 'expired' } }, 'sandbox_checkout_passport_expired'],
      [{ authority: { ...baseInput().authority, passport_status: 'revoked' } }, 'sandbox_checkout_passport_revoked'],
      [{ authority: { ...baseInput().authority, passport_status: 'mismatched' } }, 'sandbox_checkout_passport_mismatch'],
      [{ authority: { ...baseInput().authority, passport_status: 'unknown' } }, 'sandbox_checkout_passport_unknown'],
      [{ authority: { ...baseInput().authority, passport_type: 'browse' } }, 'sandbox_checkout_checkout_passport_required'],
      [{ authority: { ...baseInput().authority, scopes: ['commerce:checkout.create'] } }, 'sandbox_checkout_scope_required'],
      [{ authority: { ...baseInput().authority, merchant_id: 'mch_OTHER' } }, 'sandbox_checkout_passport_mismatch'],
      [{ authority: { ...baseInput().authority, environment: 'live' } }, 'sandbox_checkout_environment_refused'],
    ];

    for (const [override, code] of cases) {
      const result = buildCommerceSandboxCheckoutE2EPlan(baseInput(override));
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') throw new Error('expected refused result');
      expect(result.refusal.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain('provider_payment_id');
      expect(JSON.stringify(result)).not.toContain('raw_payload');
    }
  });

  it('keeps public discovery and buyer-facing checkout unavailable in this slice', () => {
    const hidden = buildCommerceSandboxCheckoutE2EPlan(baseInput({ public_discovery_state: 'disabled' }));
    expect(hidden.status).toBe('synthetic_outcome_recorded');
    if (hidden.status !== 'synthetic_outcome_recorded') throw new Error('expected ready result');
    expect(hidden.buyer_facing_checkout_surface).toBe('not_exposed');
    expect(hidden.non_enablement.public_discovery).toBe(false);

    const enabled = buildCommerceSandboxCheckoutE2EPlan(baseInput({ public_discovery_state: 'enabled' }));
    expect(enabled.status).toBe('refused');
    if (enabled.status !== 'refused') throw new Error('expected refused result');
    expect(enabled.refusal.code).toBe('sandbox_checkout_public_discovery_not_available');
  });

  it('supports replay for the same idempotency scope and conflicts on changed request bodies', () => {
    const input = baseInput();
    const response = buildCommerceSandboxCheckoutE2EPlan(input);
    const previous: CommerceSandboxCheckoutPriorResult = {
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      idempotency_scope: 'sandbox.checkout.e2e.contract',
      idempotency_key_hash: 'hash_c6u9_idempotency',
      request_body_hash: hashCommerceSandboxCheckoutRequest(input),
      response,
    };

    expect(compareCommerceSandboxCheckoutReplay(input, null)).toMatchObject({ kind: 'new' });
    expect(compareCommerceSandboxCheckoutReplay(input, previous)).toMatchObject({ kind: 'replay', response });
    expect(compareCommerceSandboxCheckoutReplay(baseInput({
      cart: {
        cart_id: CART,
        source_checked_at: '2026-06-10T00:00:00.000Z',
        line_items: (input.cart?.line_items ?? []).map((item) => ({ ...item, quantity: 2 })),
      },
    }), previous)).toMatchObject({ kind: 'conflict' });
  });

  it('keeps sandbox status transitions narrow and fail closed', () => {
    expect(allowedCommerceSandboxCheckoutStatusTransitions('draft')).toEqual([
      'authority_checked',
      'refused',
      'blocked',
    ]);
    expect(() => assertCommerceSandboxCheckoutStatusTransition('draft', 'authority_checked')).not.toThrow();
    expect(() => assertCommerceSandboxCheckoutStatusTransition('authority_checked', 'order_linked')).not.toThrow();
    expect(() => assertCommerceSandboxCheckoutStatusTransition('handoff_linked', 'synthetic_outcome_recorded')).not.toThrow();
    expect(() => assertCommerceSandboxCheckoutStatusTransition('synthetic_outcome_recorded', 'order_linked')).toThrow(/not allowed/);
    expect(() => assertCommerceSandboxCheckoutStatusTransition('draft', 'paid' as never)).toThrow(/not allowed/);
  });

  it('rejects provider, Plural, carrier, private API, raw payload, production allowlist, and execution fields recursively', () => {
    const forbiddenSamples = [
      { provider_payment_id: 'pay_private' },
      { checkoutUrl: 'https://checkout.example.invalid' },
      { liveProviderEnabled: true },
      { pluralCall: true },
      { carrierTrackingUrl: 'https://carrier.example.invalid/track/private' },
      { merchantPrivateApiUrl: 'https://merchant-private.example.invalid/orders' },
      { rawProviderPayload: { private: true } },
      { productionAllowlist: ['tenant-prod'] },
      { settlementId: 'set_private' },
      { payoutId: 'po_private' },
      { refundTransactionId: 'refund_private' },
    ];

    for (const buyer_safe_context of forbiddenSamples) {
      expect(() => buildCommerceSandboxCheckoutE2EPlan(baseInput({
        buyer_safe_context: { nested: buyer_safe_context },
      }))).toThrow(/Sandbox checkout cannot carry/);
    }
  });

  it('redacts private fields and keeps public refusals buyer safe', () => {
    const redacted = redactCommerceSandboxCheckoutPrivateFields({
      public_state: 'sandbox_sequence_ready',
      nested: {
        jwt: 'private-token',
        webhook_secret: 'private-secret',
        private_url: 'https://private.example.invalid/path',
      },
    });
    expect(redacted).toEqual({
      public_state: 'sandbox_sequence_ready',
      nested: {
        jwt: '[redacted]',
        webhook_secret: '[redacted]',
        private_url: '[redacted]',
      },
    });

    const result = buildCommerceSandboxCheckoutE2EPlan(baseInput({
      buyer_safe_context: redacted,
    }));
    const refusal = publicCommerceSandboxCheckoutRefusal('sandbox_checkout_passport_revoked');
    const serialized = JSON.stringify({ result, refusal });
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('private.example.invalid');
    expect(serialized).not.toContain('raw_payload');
    expect(serialized).not.toContain('provider_payment_id');
  });

  it('documents sandbox-only scope, unchanged API surface, and AgenticOrg refusal rules', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    expect(doc).toContain('No migration, route, endpoint, or OpenAPI surface is added by C6U9');
    expect(doc).toContain('AgenticOrg must continue refusing checkout, order, payment, support, fulfillment, delivery, return, or refund status');
    expect(doc).toContain('This is not a production launch, public discovery approval, checkout approval, payment approval, merchant approval');
    expect(doc).toContain('Sandbox checkout E2E must stop if a future change requires provider, Plural, carrier, merchant-private API, or public discovery behavior');
  });
});
