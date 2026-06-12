import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  buildOacpC6W4ProtocolAdapterPreview,
  evaluateOacpC6W5CommitmentBoundaryMetadata,
  prepareOacpC6W6CommitmentRequestEnvelope,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w6-prepared-commitment-envelopes.md',
);

function c6w6Artifacts() {
  return [
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.merchant_capability,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.seller_agent_capability,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.catalog_snapshot,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.offer,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.price,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.inventory,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.policy,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.mandate_capability,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.commitment_evidence,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.protocol_adapter,
  ];
}

function adapterPreview() {
  const preview = buildOacpC6W4ProtocolAdapterPreview({
    surface: 'mcp_tool_resource_capability',
    artifacts: c6w6Artifacts(),
    generated_at: '2026-06-11T00:00:30.000Z',
  });
  if (!preview.generated) throw new Error(preview.message);
  return preview;
}

function priceLockDecision() {
  return evaluateOacpC6W5CommitmentBoundaryMetadata({
    action: 'price_lock',
    artifacts: c6w6Artifacts(),
    adapter_preview: adapterPreview(),
    now_iso: '2026-06-11T00:01:00.000Z',
    grantex_available: false,
    revocation_snapshot_age_seconds: 30,
    currency: 'INR',
    amount_minor_units: 200000,
    total_quantity: 1,
    max_quantity_per_sku: 1,
  });
}

describe('C6W6 OACP prepared commitment envelopes', () => {
  it('prepares buyer and merchant confirmation envelopes without execution authority', () => {
    const decision = priceLockDecision();
    const buyer = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'buyer_confirmation_request',
      resolver_decision: decision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['merchant-ledger-preview-ref', 'https://private.example/merchant/api'],
      unsupported_capabilities: ['checkout_create', 'payment_authorize'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });

    expect(buyer.generated).toBe(true);
    if (!buyer.generated) throw new Error(buyer.message);
    expect(buyer.envelope).toMatchObject({
      envelope_kind: 'buyer_confirmation_request',
      envelope_status: 'prepared_only',
      action_class: 'commitment_bound',
      requested_action: 'price_lock',
      allowed_to_execute: false,
      prepared_only: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
      next_system_step_label: 'local_human_confirmation_handoff',
    });
    expect(buyer.envelope.source_artifact_ids).toContain('price_C6W3');
    expect(buyer.envelope.required_fresh_artifact_families).toContain('price');
    expect(buyer.envelope.redacted_evidence_refs).toContain('redacted_private_evidence_ref');
    expect(buyer.envelope.next_human_step).not.toMatch(/https?:\/\//);

    const merchant = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'merchant_confirmation_request',
      resolver_decision: decision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['price-evidence-ref'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(merchant.generated).toBe(true);
    if (!merchant.generated) throw new Error(merchant.message);
    expect(merchant.envelope.seller_safe_message).toContain('no order, hold, checkout, or payment is created');
    expect(merchant.envelope.next_system_step_label).toBe('merchant_source_confirmation_handoff_label');
  });

  it('prepares seller refresh, mandate evidence, and support envelopes as local handoffs', () => {
    const refreshDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'ask_refresh_source_facts',
      artifacts: c6w6Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
    });
    const refresh = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'seller_source_refresh_request',
      resolver_decision: refreshDecision,
      created_at: '2026-06-11T00:01:15.000Z',
    });
    expect(refresh.generated).toBe(true);
    if (!refresh.generated) throw new Error(refresh.message);
    expect(refresh.envelope.next_system_step_label).toBe('seller_source_refresh_handoff_label');

    const mandateDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'prepare_mandate_capability_check_request',
      artifacts: c6w6Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
    });
    const mandate = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'mandate_capability_evidence_request',
      resolver_decision: mandateDecision,
      created_at: '2026-06-11T00:01:15.000Z',
    });
    expect(mandate.generated).toBe(true);
    if (!mandate.generated) throw new Error(mandate.message);
    expect(mandate.envelope.max_ttl_seconds).toBeLessThanOrEqual(120);
    expect(mandate.envelope.seller_safe_message).toContain('no provider rail is called');

    const supportDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'support_escalation_sla_promise',
      artifacts: c6w6Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
      currency: 'USD',
      amount_minor_units: 5000,
      total_quantity: 1,
    });
    const support = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'support_escalation_preparation',
      resolver_decision: supportDecision,
      created_at: '2026-06-11T00:01:15.000Z',
      currency: 'USD',
      amount_minor_units: 5000,
      total_quantity: 1,
    });
    expect(support.generated).toBe(true);
    if (!support.generated) throw new Error(support.message);
    expect(support.envelope.seller_safe_message).toContain('must not promise SLA');
  });

  it('fails closed for missing decisions, executable decisions, blocked actions, and ambiguous risk context', () => {
    const missing = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'buyer_confirmation_request',
      resolver_decision: null,
      created_at: '2026-06-11T00:01:15.000Z',
    });
    expect(missing.generated).toBe(false);
    expect(missing.status).toBe('blocked');
    if (missing.generated) throw new Error('expected refusal');
    expect(missing.refusal_code).toBe('resolver_decision_missing');

    const decision = priceLockDecision();
    const executable = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'buyer_confirmation_request',
      resolver_decision: { ...decision, allowed_to_execute: true as false },
      created_at: '2026-06-11T00:01:15.000Z',
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(executable.generated).toBe(false);
    if (executable.generated) throw new Error('expected refusal');
    expect(executable.refusal_code).toBe('resolver_decision_allows_execution');

    const blockedDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'live_payment_execution',
      artifacts: c6w6Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: false,
    });
    const blocked = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'buyer_confirmation_request',
      resolver_decision: blockedDecision,
      created_at: '2026-06-11T00:01:15.000Z',
    });
    expect(blocked.generated).toBe(false);
    if (blocked.generated) throw new Error('expected refusal');
    expect(blocked.refusal_code).toBe('action_blocked_in_c6w6');

    const ambiguous = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'buyer_confirmation_request',
      resolver_decision: decision,
      created_at: '2026-06-11T00:01:15.000Z',
    });
    expect(ambiguous.generated).toBe(false);
    if (ambiguous.generated) throw new Error('expected refusal');
    expect(ambiguous.refusal_code).toBe('risk_context_missing_or_ambiguous');
  });

  it('documents C6W6 prepared-only envelope boundaries', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const heading of [
      'Scope',
      'Envelope Kinds',
      'Required Fields',
      'Fail-Closed Rules',
      'Confirmation Handoff',
      'Toll Booth Boundary',
      'What This Does Not Enable',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }
    expect(doc).toContain('allowed_to_execute remains false');
  });
});
