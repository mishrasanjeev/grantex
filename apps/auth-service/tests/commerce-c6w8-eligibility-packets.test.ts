import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  buildOacpC6W4ProtocolAdapterPreview,
  evaluateOacpC6W5CommitmentBoundaryMetadata,
  prepareOacpC6W6CommitmentRequestEnvelope,
  prepareOacpC6W8ExecutionHandoffEligibilityPacket,
  reconcileOacpC6W7PreparedCommitmentResponse,
  type OacpC6W6PreparedEnvelopeKind,
  type OacpC6W7PreparedResponseReconciliation,
  type OacpC6W7ReconciliationStatus,
  type OacpC6W7ResponseEvidenceKind,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w8-eligibility-packets.md',
);

function c6w8Artifacts() {
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
    artifacts: c6w8Artifacts(),
    generated_at: '2026-06-11T00:00:30.000Z',
  });
  if (!preview.generated) throw new Error(preview.message);
  return preview;
}

function decision(action = 'price_lock' as const) {
  return evaluateOacpC6W5CommitmentBoundaryMetadata({
    action,
    artifacts: c6w8Artifacts(),
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

function envelope(kind: OacpC6W6PreparedEnvelopeKind = 'buyer_confirmation_request') {
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

function reconciliation(input?: {
  response_status?: OacpC6W7ReconciliationStatus;
  response_kind?: OacpC6W7ResponseEvidenceKind;
  envelope_kind?: OacpC6W6PreparedEnvelopeKind;
}): OacpC6W7PreparedResponseReconciliation {
  const responseKind = input?.response_kind ?? 'buyer_confirmation_response';
  const reconciled = reconcileOacpC6W7PreparedCommitmentResponse({
    envelope: envelope(input?.envelope_kind),
    response_kind: responseKind,
    response_status: input?.response_status ?? 'accepted_for_preparation',
    created_at: '2026-06-11T00:01:30.000Z',
    response_evidence_refs: ['buyer-confirmation-cache-ref'],
    response_claimed_action: 'price_lock',
    currency: 'INR',
    amount_minor_units: 200000,
    total_quantity: 1,
  });
  if (!reconciled.reconciled) throw new Error(reconciled.message);
  return reconciled.reconciliation;
}

function mandateReconciliation(): OacpC6W7PreparedResponseReconciliation {
  const mandateDecision = evaluateOacpC6W5CommitmentBoundaryMetadata({
    action: 'prepare_mandate_capability_check_request',
    artifacts: c6w8Artifacts(),
    adapter_preview: adapterPreview(),
    now_iso: '2026-06-11T00:01:00.000Z',
    grantex_available: true,
    revocation_snapshot_age_seconds: 30,
  });
  const prepared = prepareOacpC6W6CommitmentRequestEnvelope({
    envelope_kind: 'mandate_capability_evidence_request',
    resolver_decision: mandateDecision,
    created_at: '2026-06-11T00:01:15.000Z',
    evidence_refs: ['mandate-request-ref'],
  });
  if (!prepared.generated) throw new Error(prepared.message);
  const reconciled = reconcileOacpC6W7PreparedCommitmentResponse({
    envelope: prepared.envelope,
    response_kind: 'mandate_capability_evidence_response',
    response_status: 'accepted_for_preparation',
    created_at: '2026-06-11T00:01:30.000Z',
    response_evidence_refs: ['mandate-capability-cache-ref'],
    response_evidence_issued_at: '2026-06-11T00:00:45.000Z',
  });
  if (!reconciled.reconciled) throw new Error(reconciled.message);
  return reconciled.reconciliation;
}

describe('C6W8 OACP eligibility packets', () => {
  it('prepares future handoff eligibility and audit packets without execution authority', () => {
    const accepted = reconciliation();
    const packet = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(packet.prepared).toBe(true);
    if (!packet.prepared) throw new Error(packet.message);
    expect(packet.packet).toMatchObject({
      packet_kind: 'execution_handoff_eligibility_packet',
      eligibility_status: 'eligible_for_future_handoff',
      response_status: 'accepted_for_preparation',
      requested_action: 'price_lock',
      allowed_for_future_handoff: true,
      allowed_to_execute: false,
      prepared_only: true,
      reconciled_only: true,
      eligibility_only: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    });
    expect(packet.packet.source_artifact_ids).toContain('price_C6W3');
    expect(packet.packet.response_evidence_refs).toContain('buyer-confirmation-cache-ref');
    expect(packet.packet.audit_lineage_refs).toContain(accepted.reconciliation_id);
    expect(packet.packet.next_system_step_label).not.toMatch(/https?:\/\//);
    expect(packet.packet.buyer_safe_message).toContain('Nothing has been executed');

    const audit = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'audit_trail_preparation_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      audit_lineage_refs: ['redacted-lineage-ref'],
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(audit.prepared).toBe(true);
    if (!audit.prepared) throw new Error(audit.message);
    expect(audit.packet.packet_kind).toBe('audit_trail_preparation_packet');
    expect(audit.packet.audit_lineage_refs).toEqual(['redacted-lineage-ref']);
  });

  it('prepares missing-evidence, manual-review, and blocked packets from non-accepted reconciliations', () => {
    const missing = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'missing_evidence_packet',
      reconciliation: reconciliation({ response_status: 'needs_source_refresh' }),
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(missing.prepared).toBe(true);
    if (!missing.prepared) throw new Error(missing.message);
    expect(missing.packet.eligibility_status).toBe('missing_evidence');
    expect(missing.packet.allowed_for_future_handoff).toBe(false);

    const review = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'manual_review_packet',
      reconciliation: reconciliation({ response_status: 'needs_human_review' }),
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(review.prepared).toBe(true);
    if (!review.prepared) throw new Error(review.message);
    expect(review.packet.eligibility_status).toBe('needs_human_review');

    for (const status of ['rejected', 'blocked', 'stale', 'expired', 'mismatched'] as const) {
      const blocked = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
        packet_kind: 'blocked_execution_packet',
        reconciliation: reconciliation({ response_status: status }),
        created_at: '2026-06-11T00:01:45.000Z',
        provided_confirmations: ['buyer_confirmation'],
        amount_minor_units: 200000,
        currency: 'INR',
        total_quantity: 1,
      });
      expect(blocked.prepared).toBe(true);
      if (!blocked.prepared) throw new Error(blocked.message);
      expect(blocked.packet.allowed_to_execute).toBe(false);
      expect(blocked.packet.allowed_for_future_handoff).toBe(false);
    }

    const unsupported = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'blocked_execution_packet',
      reconciliation: { ...reconciliation(), risk_tier: 'critical' },
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(unsupported.prepared).toBe(true);
    if (!unsupported.prepared) throw new Error(unsupported.message);
    expect(unsupported.packet.eligibility_status).toBe('unsupported');
  });

  it('fails closed for unsafe, executable, mismatched, or ambiguous packet input', () => {
    const accepted = reconciliation();
    const missing = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: null,
      created_at: '2026-06-11T00:01:45.000Z',
    });
    expect(missing.prepared).toBe(false);
    if (missing.prepared) throw new Error('expected refusal');
    expect(missing.refusal_code).toBe('reconciliation_missing');

    const executable = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: { ...accepted, allowed_to_execute: true as false },
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(executable.prepared).toBe(false);
    if (executable.prepared) throw new Error('expected refusal');
    expect(executable.refusal_code).toBe('reconciliation_allows_execution');

    const privateRef = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      audit_lineage_refs: ['raw_jwt_private_ref'],
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(privateRef.prepared).toBe(false);
    if (privateRef.prepared) throw new Error('expected refusal');
    expect(privateRef.refusal_code).toBe('private_or_forbidden_packet_field');

    const executionFlag = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      packet_flags: ['order_created'],
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(executionFlag.prepared).toBe(false);
    if (executionFlag.prepared) throw new Error('expected refusal');
    expect(executionFlag.refusal_code).toBe('packet_indicates_forbidden_execution');

    const ambiguous = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
    });
    expect(ambiguous.prepared).toBe(false);
    if (ambiguous.prepared) throw new Error('expected refusal');
    expect(ambiguous.refusal_code).toBe('risk_context_missing_or_ambiguous');

    const missingConfirmation = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'missing_evidence_packet',
      reconciliation: accepted,
      created_at: '2026-06-11T00:01:45.000Z',
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(missingConfirmation.prepared).toBe(true);
    if (!missingConfirmation.prepared) throw new Error(missingConfirmation.message);
    expect(missingConfirmation.packet.eligibility_status).toBe('missing_evidence');
    expect(missingConfirmation.packet.missing_requirements).toContain('confirmation:buyer_confirmation');

    const kindMismatch = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: reconciliation({ response_status: 'needs_human_review' }),
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(kindMismatch.prepared).toBe(false);
    if (kindMismatch.prepared) throw new Error('expected refusal');
    expect(kindMismatch.refusal_code).toBe('packet_kind_status_mismatch');
  });

  it('fails closed for stale mandate evidence at future handoff boundary', () => {
    const oldMandate = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: mandateReconciliation(),
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['mandate_capability_evidence'],
      mandate_evidence_issued_at: '2026-06-10T23:58:00.000Z',
    });
    expect(oldMandate.prepared).toBe(false);
    if (oldMandate.prepared) throw new Error('expected refusal');
    expect(oldMandate.refusal_code).toBe('mandate_evidence_stale');
  });

  it('documents C6W8 eligibility packet boundaries', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const heading of [
      'Scope',
      'Packet Kinds',
      'Eligibility Statuses',
      'Required Fields',
      'Fail-Closed Rules',
      'Evidence Lineage',
      'Eligibility Is Not Execution',
      'Toll Booth Boundary',
      'What This Does Not Enable',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }
    expect(doc).toContain('allowed_to_execute remains false');
    expect(doc).toContain('eligibility_only remains true');
  });
});
