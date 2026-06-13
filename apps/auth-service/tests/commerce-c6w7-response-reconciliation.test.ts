import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  buildOacpC6W4ProtocolAdapterPreview,
  evaluateOacpC6W5CommitmentBoundaryMetadata,
  prepareOacpC6W6CommitmentRequestEnvelope,
  reconcileOacpC6W7PreparedCommitmentResponse,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w7-response-reconciliation.md',
);

function c6w7Artifacts() {
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
    artifacts: c6w7Artifacts(),
    generated_at: '2026-06-11T00:00:30.000Z',
  });
  if (!preview.generated) throw new Error(preview.message);
  return preview;
}

function decision(action = 'price_lock' as const) {
  return evaluateOacpC6W5CommitmentBoundaryMetadata({
    action,
    artifacts: c6w7Artifacts(),
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

function envelope(kind = 'buyer_confirmation_request' as const) {
  const prepared = prepareOacpC6W6CommitmentRequestEnvelope({
    envelope_kind: kind,
    resolver_decision: decision(),
    created_at: '2026-06-11T00:01:15.000Z',
    evidence_refs: ['prepared-price-ref'],
    unsupported_capabilities: ['checkout_create', 'payment_authorize'],
    currency: 'INR',
    amount_minor_units: 200000,
    total_quantity: 1,
  });
  if (!prepared.generated) throw new Error(prepared.message);
  return prepared.envelope;
}

describe('C6W7 OACP response reconciliation', () => {
  it('reconciles buyer and merchant responses as prepared-only evidence', () => {
    const buyer = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: envelope(),
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-confirmation-cache-ref'],
      response_claimed_action: 'price_lock',
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(buyer.reconciled).toBe(true);
    if (!buyer.reconciled) throw new Error(buyer.message);
    expect(buyer.reconciliation).toMatchObject({
      envelope_kind: 'buyer_confirmation_request',
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      requested_action: 'price_lock',
      allowed_to_execute: false,
      prepared_only: true,
      reconciled_only: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    });
    expect(buyer.reconciliation.source_artifact_ids).toContain('price_C6W3');
    expect(buyer.reconciliation.response_evidence_refs).toContain('buyer-confirmation-cache-ref');
    expect(buyer.reconciliation.next_system_step_label).not.toMatch(/https?:\/\//);
    expect(buyer.reconciliation.buyer_safe_message).toContain('no order, hold, checkout, payment');

    const merchantEnvelope = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'merchant_confirmation_request',
      resolver_decision: decision(),
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['prepared-price-ref'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    if (!merchantEnvelope.generated) throw new Error(merchantEnvelope.message);
    const merchant = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: merchantEnvelope.envelope,
      response_kind: 'merchant_confirmation_response',
      response_status: 'needs_human_review',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['merchant-confirmation-cache-ref'],
      response_claimed_envelope_id: merchantEnvelope.envelope.envelope_id,
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(merchant.reconciled).toBe(true);
    if (!merchant.reconciled) throw new Error(merchant.message);
    expect(merchant.reconciliation.allowed_to_prepare).toBe(false);
    expect(merchant.reconciliation.next_system_step_label).toBe('human_review_reconciliation_label');
  });

  it('reconciles source refresh, mandate, and support response kinds', () => {
    const refreshDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'ask_refresh_source_facts',
      artifacts: c6w7Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
    });
    const refreshEnvelope = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'seller_source_refresh_request',
      resolver_decision: refreshDecision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['refresh-request-ref'],
    });
    if (!refreshEnvelope.generated) throw new Error(refreshEnvelope.message);
    const refresh = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: refreshEnvelope.envelope,
      response_kind: 'seller_source_refresh_response',
      response_status: 'needs_source_refresh',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['refreshed-artifact-id-only-ref'],
    });
    expect(refresh.reconciled).toBe(true);
    if (!refresh.reconciled) throw new Error(refresh.message);
    expect(refresh.reconciliation.response_status).toBe('needs_source_refresh');

    const mandateDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'prepare_mandate_capability_check_request',
      artifacts: c6w7Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
    });
    const mandateEnvelope = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'mandate_capability_evidence_request',
      resolver_decision: mandateDecision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['mandate-request-ref'],
    });
    if (!mandateEnvelope.generated) throw new Error(mandateEnvelope.message);
    const mandate = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: mandateEnvelope.envelope,
      response_kind: 'mandate_capability_evidence_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['mandate-capability-cache-ref'],
      response_evidence_issued_at: '2026-06-11T00:00:45.000Z',
    });
    expect(mandate.reconciled).toBe(true);
    if (!mandate.reconciled) throw new Error(mandate.message);
    expect(mandate.reconciliation.max_ttl_seconds).toBeLessThanOrEqual(120);

    const supportDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'support_escalation_sla_promise',
      artifacts: c6w7Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
      currency: 'USD',
      amount_minor_units: 5000,
      total_quantity: 1,
    });
    const supportEnvelope = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'support_escalation_preparation',
      resolver_decision: supportDecision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['support-request-ref'],
      currency: 'USD',
      amount_minor_units: 5000,
      total_quantity: 1,
    });
    if (!supportEnvelope.generated) throw new Error(supportEnvelope.message);
    const support = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: supportEnvelope.envelope,
      response_kind: 'support_escalation_response',
      response_status: 'rejected',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['support-response-ref'],
      currency: 'USD',
      amount_minor_units: 5000,
      total_quantity: 1,
    });
    expect(support.reconciled).toBe(true);
    if (!support.reconciled) throw new Error(support.message);
    expect(support.reconciliation.seller_safe_message).toContain('does not create operational obligations');
  });

  it('fails closed for unsafe or mismatched response evidence', () => {
    const prepared = envelope();
    const missing = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: null,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-ref'],
    });
    expect(missing.reconciled).toBe(false);
    if (missing.reconciled) throw new Error('expected refusal');
    expect(missing.refusal_code).toBe('prepared_envelope_missing');

    const executable = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: { ...prepared, allowed_to_execute: true as false },
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-ref'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(executable.reconciled).toBe(false);
    if (executable.reconciled) throw new Error('expected refusal');
    expect(executable.refusal_code).toBe('prepared_envelope_allows_execution');

    const mismatch = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'merchant_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['merchant-ref'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(mismatch.reconciled).toBe(false);
    if (mismatch.reconciled) throw new Error('expected refusal');
    expect(mismatch.refusal_code).toBe('response_kind_envelope_mismatch');

    const privateRef = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['https://private.example/customer/address'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(privateRef.reconciled).toBe(false);
    if (privateRef.reconciled) throw new Error('expected refusal');
    expect(privateRef.refusal_code).toBe('private_or_forbidden_response_field');

    const execution = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-ref'],
      response_flags: ['payment_executed'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(execution.reconciled).toBe(false);
    if (execution.reconciled) throw new Error('expected refusal');
    expect(execution.refusal_code).toBe('response_indicates_forbidden_execution');
  });

  it('fails closed for stale, ambiguous, old mandate, and conflicting evidence', () => {
    const prepared = envelope();
    const stale = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:10:30.000Z',
      response_evidence_refs: ['buyer-ref'],
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(stale.reconciled).toBe(false);
    if (stale.reconciled) throw new Error('expected refusal');
    expect(stale.refusal_code).toBe('source_freshness_missing_or_stale');

    const ambiguous = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-ref'],
    });
    expect(ambiguous.reconciled).toBe(false);
    if (ambiguous.reconciled) throw new Error('expected refusal');
    expect(ambiguous.refusal_code).toBe('risk_context_missing_or_ambiguous');

    const conflict = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: prepared,
      response_kind: 'buyer_confirmation_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['buyer-ref'],
      response_claimed_action: 'inventory_hold',
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(conflict.reconciled).toBe(false);
    if (conflict.reconciled) throw new Error('expected refusal');
    expect(conflict.refusal_code).toBe('response_conflicts_with_envelope');

    const mandateDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'prepare_mandate_capability_check_request',
      artifacts: c6w7Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
    });
    const mandateEnvelope = prepareOacpC6W6CommitmentRequestEnvelope({
      envelope_kind: 'mandate_capability_evidence_request',
      resolver_decision: mandateDecision,
      created_at: '2026-06-11T00:01:15.000Z',
      evidence_refs: ['mandate-request-ref'],
    });
    if (!mandateEnvelope.generated) throw new Error(mandateEnvelope.message);
    const oldMandate = reconcileOacpC6W7PreparedCommitmentResponse({
      envelope: mandateEnvelope.envelope,
      response_kind: 'mandate_capability_evidence_response',
      response_status: 'accepted_for_preparation',
      created_at: '2026-06-11T00:01:30.000Z',
      response_evidence_refs: ['mandate-cache-ref'],
      response_evidence_issued_at: '2026-06-10T23:58:00.000Z',
    });
    expect(oldMandate.reconciled).toBe(false);
    if (oldMandate.reconciled) throw new Error('expected refusal');
    expect(oldMandate.refusal_code).toBe('mandate_evidence_stale');
  });

  it('documents C6W7 response reconciliation boundaries', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const heading of [
      'Scope',
      'Response Evidence Kinds',
      'Reconciliation Output',
      'Status Enum',
      'Fail-Closed Rules',
      'Human And Source Responses',
      'Toll Booth Boundary',
      'What This Does Not Enable',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }
    expect(doc).toContain('allowed_to_execute remains false');
    expect(doc).toContain('reconciled_only remains true');
  });
});
