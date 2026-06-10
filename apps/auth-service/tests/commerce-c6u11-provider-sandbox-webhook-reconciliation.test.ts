import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  assertNoCommerceProviderSandboxExecutionFields,
  buildCommerceProviderSandboxIntentContract,
  compareCommerceProviderSandboxReplay,
  evaluateCommerceProviderSandboxReconciliation,
  evaluateCommerceProviderSandboxWebhook,
  hashCommerceProviderSandboxRequest,
  normalizeCommerceProviderSandboxError,
  normalizeCommerceProviderSandboxStatus,
  publicCommerceProviderSandboxRefusal,
  redactCommerceProviderSandboxPrivateFields,
  type CommerceProviderSandboxContractInput,
  type CommerceProviderSandboxPriorResult,
} from '../src/lib/commerce/provider-sandbox-contract.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6u11-provider-sandbox-webhook-reconciliation-foundation.md',
);
const HELPER_PATH = join(TEST_DIR, '../src/lib/commerce/provider-sandbox-contract.ts');

const TENANT = 'cten_C6U11';
const MERCHANT = 'mch_C6U11';
const AGENT = 'cag_C6U11';
const CART = 'ccart_C6U11';
const PAYMENT_INTENT = 'cpi_C6U11';

function baseInput(overrides: Partial<CommerceProviderSandboxContractInput> = {}): CommerceProviderSandboxContractInput {
  return {
    tenant_id: TENANT,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    cart_id: CART,
    payment_intent_id: PAYMENT_INTENT,
    provider_key: 'mock',
    environment: 'sandbox',
    amount: {
      amount_minor_units: 109900,
      currency: 'INR',
    },
    line_items_snapshot: [{
      product_id: 'cprd_C6U11',
      title: 'Sandbox Switch',
      quantity: 1,
    }],
    idempotency_key_hash: 'hash_c6u11_idempotency',
    source_freshness_refs: {
      source: 'local_sandbox_fixture',
      checked_at: '2026-06-10T00:00:00.000Z',
    },
    audit_evidence_refs: [
      { audit_event_id: 'caud_C6U11_CONTRACT' },
    ],
    metadata: {
      display_state: 'sandbox_provider_contract_ready',
    },
    ...overrides,
  };
}

describe('C6U11 provider sandbox adapter, webhook, and reconciliation foundation', () => {
  it('builds a deterministic provider-neutral sandbox adapter contract without live/provider execution', () => {
    const first = buildCommerceProviderSandboxIntentContract(baseInput());
    const second = buildCommerceProviderSandboxIntentContract(baseInput());

    expect(first).toEqual(second);
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('expected accepted contract result');

    expect(first).toMatchObject({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      environment: 'sandbox',
      idempotency_scope: 'provider.sandbox.adapter.contract',
      normalized_status: 'authorized',
      buyer_safe_status: {
        code: 'sandbox_intent_authorized',
      },
      non_enablement: {
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
      },
    });
    expect(first.provider_reference.payment_ref).toMatch(/^sandbox_payment_ref_/);
    expect(JSON.stringify(first)).not.toContain('provider_payment_id');
    expect(JSON.stringify(first)).not.toContain('raw_payload');
    expect(JSON.stringify(first)).not.toContain('credential');
  });

  it('refuses missing context, live mode, non-local adapter selection, missing audit, and missing idempotency', () => {
    const cases: Array<[Partial<CommerceProviderSandboxContractInput>, string]> = [
      [{ tenant_id: '' }, 'provider_sandbox_tenant_context_required'],
      [{ merchant_id: '' }, 'provider_sandbox_merchant_context_required'],
      [{ payment_intent_id: '' }, 'provider_sandbox_payment_intent_required'],
      [{ environment: 'live' }, 'provider_sandbox_environment_refused'],
      [{ environment: 'unknown' }, 'provider_sandbox_environment_refused'],
      [{ provider_key: 'plural' }, 'provider_sandbox_adapter_blocked'],
      [{ idempotency_key_hash: '' }, 'provider_sandbox_idempotency_required'],
      [{ audit_evidence_refs: [] }, 'provider_sandbox_audit_evidence_required'],
    ];

    for (const [override, code] of cases) {
      const result = buildCommerceProviderSandboxIntentContract(baseInput(override));
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') throw new Error('expected refused result');
      expect(result.refusal.code).toBe(code);
      expect(result.non_enablement.live_provider).toBe(false);
      expect(result.non_enablement.production_checkout).toBe(false);
    }
  });

  it('supports hashed idempotency replay and conflicts on changed request bodies', () => {
    const input = baseInput();
    const response = buildCommerceProviderSandboxIntentContract(input);
    const previous: CommerceProviderSandboxPriorResult = {
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      idempotency_scope: 'provider.sandbox.adapter.contract',
      idempotency_key_hash: 'hash_c6u11_idempotency',
      request_body_hash: hashCommerceProviderSandboxRequest(input),
      response,
    };

    expect(compareCommerceProviderSandboxReplay(input, null)).toMatchObject({ kind: 'new' });
    expect(compareCommerceProviderSandboxReplay(input, previous)).toMatchObject({ kind: 'replay', response });
    expect(compareCommerceProviderSandboxReplay(baseInput({
      amount: { amount_minor_units: 209900, currency: 'INR' },
    }), previous)).toMatchObject({ kind: 'conflict' });
  });

  it('normalizes statuses and provider errors fail closed for ambiguous values', () => {
    expect(normalizeCommerceProviderSandboxStatus('mock_paid')).toMatchObject({
      normalized_status: 'paid',
      payment_status: 'paid',
      fail_closed: false,
    });
    expect(normalizeCommerceProviderSandboxStatus('provider-side-weird-state')).toMatchObject({
      normalized_status: 'manual_review_required',
      payment_status: 'manual_review_required',
      fail_closed: true,
    });

    const normalizedError = normalizeCommerceProviderSandboxError({
      code: 'provider_timeout',
      message: 'raw timeout details',
      retryable: true,
      provider_key: 'mock',
      provider_error_code: 'timeout-private-code',
      provider_request_id: 'private-request-id',
      safe_metadata: {
        public_state: 'timeout',
        token: 'private-token',
      },
    });

    expect(normalizedError).toMatchObject({
      code: 'provider_timeout',
      retryable: true,
      buyer_safe_message: 'Sandbox provider status timed out.',
      safe_metadata: {
        public_state: 'timeout',
        token: '[redacted]',
      },
    });
    expect(JSON.stringify(normalizedError)).not.toContain('private-request-id');
    expect(JSON.stringify(normalizedError)).not.toContain('timeout-private-code');
    expect(JSON.stringify(normalizedError)).not.toContain('private-token');
  });

  it('handles webhook signature, replay, duplicate, malformed, unknown, and ambiguous cases safely', () => {
    const processed = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_PAID',
      event_type: 'payment.succeeded',
      signature_state: 'valid',
      replay_state: 'fresh',
      normalized_status: 'paid',
      audit_evidence_refs: [{ audit_event_id: 'caud_C6U11_WEBHOOK' }],
      metadata: { source: 'local_sandbox_fixture' },
    });

    expect(processed).toMatchObject({
      status: 'processed',
      payment_status: 'paid',
      idempotent: false,
      non_enablement: { provider_call: false },
    });

    const duplicate = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_DUP',
      event_type: 'payment.updated',
      signature_state: 'valid',
      replay_state: 'duplicate',
      normalized_status: 'payment_pending',
    });
    expect(duplicate).toMatchObject({ status: 'ignored', reason: 'duplicate_event', idempotent: true });

    const missingSignature = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_MISSING_SIGNATURE',
      event_type: 'payment.updated',
      signature_state: 'missing',
      replay_state: 'fresh',
      normalized_status: 'paid',
    });
    expect(missingSignature).toMatchObject({
      status: 'refused',
      refusal: { code: 'provider_sandbox_webhook_signature_required' },
    });

    const replay = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_STALE',
      event_type: 'payment.updated',
      signature_state: 'valid',
      replay_state: 'stale',
      normalized_status: 'paid',
    });
    expect(replay).toMatchObject({
      status: 'refused',
      refusal: { code: 'provider_sandbox_webhook_replay_refused' },
    });

    const unknownEvent = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_UNKNOWN',
      event_type: 'payment.refunded',
      signature_state: 'valid',
      replay_state: 'fresh',
      normalized_status: 'paid',
    });
    expect(unknownEvent).toMatchObject({ status: 'manual_review_required', reason: 'unknown_event' });

    const ambiguous = evaluateCommerceProviderSandboxWebhook({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      event_id: 'evt_C6U11_AMBIGUOUS',
      event_type: 'payment.updated',
      signature_state: 'valid',
      replay_state: 'fresh',
      normalized_status: 'not-a-known-status',
    });
    expect(ambiguous).toMatchObject({ status: 'manual_review_required', reason: 'ambiguous_status' });
  });

  it('keeps reconciliation as supplied-fact hardening without settlement, payout, refund, or live status pulls', () => {
    const youngPending = evaluateCommerceProviderSandboxReconciliation({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      current_status: 'payment_pending',
      provider_status: 'payment_pending',
      pending_age_seconds: 30,
      audit_evidence_refs: [{ audit_event_id: 'caud_C6U11_RECON' }],
    });
    expect(youngPending).toMatchObject({ status: 'no_change', reason: 'pending_window_open' });

    const mismatch = evaluateCommerceProviderSandboxReconciliation({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      current_status: 'payment_pending',
      provider_status: 'paid',
      pending_age_seconds: 300,
      mismatch_detected: true,
      audit_evidence_refs: [{ audit_event_id: 'caud_C6U11_RECON' }],
    });
    expect(mismatch).toMatchObject({ status: 'manual_review_required', reason: 'status_mismatch' });

    const paid = evaluateCommerceProviderSandboxReconciliation({
      tenant_id: TENANT,
      merchant_id: MERCHANT,
      payment_intent_id: PAYMENT_INTENT,
      provider_key: 'mock',
      environment: 'sandbox',
      current_status: 'payment_pending',
      provider_status: 'paid',
      pending_age_seconds: 300,
      audit_evidence_refs: [{ audit_event_id: 'caud_C6U11_RECON' }],
    });
    expect(paid).toMatchObject({
      status: 'transition_recommended',
      from_status: 'payment_pending',
      to_status: 'paid',
      non_enablement: {
        settlement_execution: false,
        payout_execution: false,
        refund_execution: false,
      },
    });

    const serialized = JSON.stringify([youngPending, mismatch, paid]);
    expect(serialized).not.toContain('settlement_id');
    expect(serialized).not.toContain('payout_id');
    expect(serialized).not.toContain('refund_transaction_id');
  });

  it('rejects credentials, provider payloads, carrier fields, private API fields, and money movement fields recursively', () => {
    const forbiddenSamples = [
      { apiKey: 'private-api-key' },
      { providerPaymentId: 'provider-private-id' },
      { rawProviderPayload: { private: true } },
      { checkoutUrl: 'https://checkout.example.invalid/private' },
      { carrierTrackingUrl: 'https://carrier.example.invalid/private' },
      { merchantPrivateApiUrl: 'https://merchant-private.example.invalid/orders' },
      { settlementId: 'set_private' },
      { payoutId: 'po_private' },
      { refundTransactionId: 'refund_private' },
      { webhookSecret: 'whsec_private' },
    ];

    for (const metadata of forbiddenSamples) {
      expect(() => assertNoCommerceProviderSandboxExecutionFields({ nested: metadata }))
        .toThrow(/Provider sandbox contract cannot carry/);
    }
  });

  it('redacts public summaries and helper source contains no direct network or non-local adapter calls', () => {
    const redacted = redactCommerceProviderSandboxPrivateFields({
      public_state: 'sandbox_review',
      nested: {
        jwt: 'private-jwt',
        webhook_secret: 'private-secret',
        private_url: 'https://private.example.invalid/path',
      },
    });

    expect(redacted).toEqual({
      public_state: 'sandbox_review',
      nested: {
        jwt: '[redacted]',
        webhook_secret: '[redacted]',
        private_url: '[redacted]',
      },
    });
    expect(publicCommerceProviderSandboxRefusal('provider_sandbox_adapter_blocked').message)
      .toContain('local sandbox adapter contract');

    const helper = readFileSync(HELPER_PATH, 'utf8');
    expect(helper).not.toMatch(/\bfetch\s*\(/);
    expect(helper).not.toMatch(/\baxios\b/);
    expect(helper).not.toMatch(/\bundici\b/);
    expect(helper).not.toMatch(/\bgetPaymentProvider\s*\(/);
    expect(helper).not.toMatch(/\bnew\s+MockPaymentProvider\b/);
    expect(helper.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '').toLowerCase()).not.toContain('plural');
  });

  it('documents C6U11 scope, hardening requirements, unchanged API surface, and non-approval language', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    for (const section of [
      'Sandbox Provider Adapter Contract',
      'Normalized Status Taxonomy',
      'Normalized Error Taxonomy',
      'Webhook Signature, Replay, And Idempotency Expectations',
      'Reconciliation Expectations',
      'Audit And Evidence Requirements',
      'Redaction Rules',
      'Manual Review And Stop Conditions',
      'What This Does Not Enable',
      'Evidence Required Before Later Live Review',
      'API, OpenAPI, Migration, Workflow, And Config Note',
      'Future Slices',
      'Explicit Non-Approval Language',
    ]) {
      expect(doc).toContain(`## ${section}`);
    }

    expect(doc).toContain('C6U11 adds no migration, route, endpoint, OpenAPI surface, workflow, config, secret');
    expect(doc).toContain('This C6U11 slice does not approve live provider use');
    expect(doc).toContain('C6U11 does not enable:');
    expect(doc).toContain('AgenticOrg must continue refusing provider, payment, fulfillment, refund, settlement, or payout status');
  });
});
