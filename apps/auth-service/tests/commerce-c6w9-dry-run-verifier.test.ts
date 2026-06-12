import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  OACP_C6W9_DRY_RUN_VERIFICATION_KINDS,
  OACP_C6W9_VERIFIER_STATUSES,
  buildOacpC6W4ProtocolAdapterPreview,
  evaluateOacpC6W5CommitmentBoundaryMetadata,
  prepareOacpC6W6CommitmentRequestEnvelope,
  prepareOacpC6W8ExecutionHandoffEligibilityPacket,
  reconcileOacpC6W7PreparedCommitmentResponse,
  verifyOacpC6W9ExecutionControllerHandoffDryRun,
  type OacpC6W6PreparedEnvelopeKind,
  type OacpC6W7PreparedResponseReconciliation,
  type OacpC6W7ReconciliationStatus,
  type OacpC6W7ResponseEvidenceKind,
  type OacpC6W8EligibilityPacketKind,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w9-dry-run-verifier.md',
);

function c6w9Artifacts() {
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
    artifacts: c6w9Artifacts(),
    generated_at: '2026-06-11T00:00:30.000Z',
  });
  if (!preview.generated) throw new Error(preview.message);
  return preview;
}

function decision(action = 'price_lock' as const) {
  return evaluateOacpC6W5CommitmentBoundaryMetadata({
    action,
    artifacts: c6w9Artifacts(),
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
    artifacts: c6w9Artifacts(),
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

function eligibilityPacket(input?: {
  packet_kind?: OacpC6W8EligibilityPacketKind;
  reconciliation?: OacpC6W7PreparedResponseReconciliation;
}) {
  const prepared = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
    packet_kind: input?.packet_kind ?? 'execution_handoff_eligibility_packet',
    reconciliation: input?.reconciliation ?? reconciliation(),
    created_at: '2026-06-11T00:01:45.000Z',
    provided_confirmations: ['buyer_confirmation'],
    amount_minor_units: 200000,
    currency: 'INR',
    total_quantity: 1,
  });
  if (!prepared.prepared) throw new Error(prepared.message);
  return prepared.packet;
}

describe('C6W9 OACP dry-run verifier', () => {
  it('verifies accepted execution-controller and audit-readiness contracts without execution authority', () => {
    const packet = eligibilityPacket();
    const dryRun = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: packet,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(dryRun.verified).toBe(true);
    if (!dryRun.verified) throw new Error(dryRun.message);
    expect(dryRun.status).toBe('dry_run_accepted_for_future_controller');
    expect(dryRun.verification).toMatchObject({
      verification_kind: 'execution_controller_handoff_dry_run',
      verification_status: 'dry_run_accepted_for_future_controller',
      eligibility_packet_id: packet.packet_id,
      packet_kind: 'execution_handoff_eligibility_packet',
      eligibility_status: 'eligible_for_future_handoff',
      requested_action: 'price_lock',
      allowed_for_future_handoff: true,
      allowed_to_execute: false,
      dry_run_only: true,
      eligibility_only: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    });
    expect(dryRun.verification.source_artifact_ids).toContain('price_C6W3');
    expect(dryRun.verification.response_evidence_refs).toContain('buyer-confirmation-cache-ref');
    expect(dryRun.verification.audit_lineage_refs).toContain(packet.reconciliation_id);
    expect(dryRun.verification.contract_checks.non_enablement_flags_intact).toBe(true);
    expect(dryRun.verification.contract_checks.no_executable_url_or_target).toBe(true);
    expect(dryRun.verification.audit_readiness_checks.decision_lineage_complete).toBe(true);
    expect(dryRun.verification.operator_safe_message).toContain('not execution readiness');

    const auditPacket = eligibilityPacket({ packet_kind: 'audit_trail_preparation_packet' });
    const audit = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'audit_readiness_verification',
      eligibility_packet: auditPacket,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(audit.verified).toBe(true);
    if (!audit.verified) throw new Error(audit.message);
    expect(audit.verification.verification_kind).toBe('audit_readiness_verification');
    expect(audit.verification.allowed_to_execute).toBe(false);
  });

  it('reports missing, manual-review, blocked, stale, expired, mismatched, and unsupported statuses', () => {
    const missingPacket = eligibilityPacket({
      packet_kind: 'missing_evidence_packet',
      reconciliation: reconciliation({ response_status: 'needs_source_refresh' }),
    });
    const missing = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'missing_contract_requirement',
      eligibility_packet: missingPacket,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(missing.verified).toBe(true);
    if (!missing.verified) throw new Error(missing.message);
    expect(missing.status).toBe('missing_contract_requirement');
    expect(missing.verification.allowed_for_future_handoff).toBe(false);

    const reviewPacket = eligibilityPacket({
      packet_kind: 'manual_review_packet',
      reconciliation: reconciliation({ response_status: 'needs_human_review' }),
    });
    const review = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'manual_review_required_verification',
      eligibility_packet: reviewPacket,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(review.verified).toBe(true);
    if (!review.verified) throw new Error(review.message);
    expect(review.status).toBe('needs_human_review');

    for (const responseStatus of ['rejected', 'stale', 'mismatched'] as const) {
      const blockedPacket = eligibilityPacket({
        packet_kind: 'blocked_execution_packet',
        reconciliation: reconciliation({ response_status: responseStatus }),
      });
      const blocked = verifyOacpC6W9ExecutionControllerHandoffDryRun({
        verification_kind: 'blocked_handoff_verification',
        eligibility_packet: blockedPacket,
        created_at: '2026-06-11T00:02:00.000Z',
        provided_confirmations: ['buyer_confirmation'],
        amount_minor_units: 200000,
        currency: 'INR',
        total_quantity: 1,
      });
      expect(blocked.verified).toBe(true);
      if (!blocked.verified) throw new Error(blocked.message);
      expect(blocked.verification.allowed_to_execute).toBe(false);
      expect(blocked.verification.allowed_for_future_handoff).toBe(false);
    }

    const expired = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'blocked_handoff_verification',
      eligibility_packet: eligibilityPacket(),
      created_at: '2026-06-11T00:12:01.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(expired.verified).toBe(true);
    if (!expired.verified) throw new Error(expired.message);
    expect(expired.status).toBe('expired');

    const mismatched = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'blocked_handoff_verification',
      eligibility_packet: eligibilityPacket(),
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      claimed_packet_id: 'wrong-packet-id',
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(mismatched.verified).toBe(true);
    if (!mismatched.verified) throw new Error(mismatched.message);
    expect(mismatched.status).toBe('mismatched');

    const unsupportedPacket = eligibilityPacket({
      packet_kind: 'blocked_execution_packet',
      reconciliation: { ...reconciliation(), risk_tier: 'critical' },
    });
    const unsupported = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'blocked_handoff_verification',
      eligibility_packet: unsupportedPacket,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(unsupported.verified).toBe(true);
    if (!unsupported.verified) throw new Error(unsupported.message);
    expect(unsupported.status).toBe('unsupported');

    expect(OACP_C6W9_DRY_RUN_VERIFICATION_KINDS).toContain('blocked_handoff_verification');
    expect(OACP_C6W9_VERIFIER_STATUSES).toContain('unsafe');
  });

  it('fails closed for missing, executable, non-eligibility, unsafe, or mismatched verifier input', () => {
    const packet = eligibilityPacket();
    const missing = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: null,
      created_at: '2026-06-11T00:02:00.000Z',
    });
    expect(missing.verified).toBe(false);
    if (missing.verified) throw new Error('expected refusal');
    expect(missing.refusal_code).toBe('packet_missing');

    const executable = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: { ...packet, allowed_to_execute: true as false },
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(executable.verified).toBe(false);
    if (executable.verified) throw new Error('expected refusal');
    expect(executable.refusal_code).toBe('packet_allows_execution');

    const nonEligibility = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: { ...packet, eligibility_only: false as true },
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(nonEligibility.verified).toBe(false);
    if (nonEligibility.verified) throw new Error('expected refusal');
    expect(nonEligibility.refusal_code).toBe('packet_not_prepared_reconciled_or_eligibility_only');

    const unsafeRef = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: { ...packet, response_evidence_refs: ['raw_jwt_private_ref'] },
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(unsafeRef.verified).toBe(false);
    if (unsafeRef.verified) throw new Error('expected refusal');
    expect(unsafeRef.refusal_code).toBe('private_or_forbidden_verification_field');

    const missingConfirmation = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'missing_contract_requirement',
      eligibility_packet: packet,
      created_at: '2026-06-11T00:02:00.000Z',
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(missingConfirmation.verified).toBe(true);
    if (!missingConfirmation.verified) throw new Error(missingConfirmation.message);
    expect(missingConfirmation.status).toBe('missing_contract_requirement');
    expect(missingConfirmation.verification.missing_requirements).toContain('confirmation:buyer_confirmation');

    const ambiguousRisk = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'missing_contract_requirement',
      eligibility_packet: packet,
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
    });
    expect(ambiguousRisk.verified).toBe(true);
    if (!ambiguousRisk.verified) throw new Error(ambiguousRisk.message);
    expect(ambiguousRisk.status).toBe('missing_contract_requirement');

    const kindMismatch = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'execution_controller_handoff_dry_run',
      eligibility_packet: eligibilityPacket({
        packet_kind: 'manual_review_packet',
        reconciliation: reconciliation({ response_status: 'needs_human_review' }),
      }),
      created_at: '2026-06-11T00:02:00.000Z',
      provided_confirmations: ['buyer_confirmation'],
      amount_minor_units: 200000,
      currency: 'INR',
      total_quantity: 1,
    });
    expect(kindMismatch.verified).toBe(false);
    if (kindMismatch.verified) throw new Error('expected refusal');
    expect(kindMismatch.refusal_code).toBe('verification_kind_status_mismatch');
  });

  it('fails closed for stale mandate evidence at dry-run boundary', () => {
    const prepared = prepareOacpC6W8ExecutionHandoffEligibilityPacket({
      packet_kind: 'execution_handoff_eligibility_packet',
      reconciliation: mandateReconciliation(),
      created_at: '2026-06-11T00:01:45.000Z',
      provided_confirmations: ['mandate_capability_evidence'],
      mandate_evidence_issued_at: '2026-06-11T00:00:45.000Z',
    });
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) throw new Error(prepared.message);
    const staleMandate = verifyOacpC6W9ExecutionControllerHandoffDryRun({
      verification_kind: 'blocked_handoff_verification',
      eligibility_packet: prepared.packet,
      created_at: '2026-06-11T00:01:55.000Z',
      provided_confirmations: ['mandate_capability_evidence'],
      mandate_evidence_issued_at: '2026-06-10T23:58:00.000Z',
    });
    expect(staleMandate.verified).toBe(true);
    if (!staleMandate.verified) throw new Error(staleMandate.message);
    expect(staleMandate.status).toBe('stale');
    expect(staleMandate.verification.allowed_to_execute).toBe(false);
  });

  it('documents C6W9 dry-run verifier boundaries', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const heading of [
      'Scope',
      'Dry-Run Result Kinds',
      'Verifier Statuses',
      'Required Fields',
      'Contract Checks',
      'Audit Readiness',
      'Fail-Closed Rules',
      'Dry-Run Acceptance Is Not Execution',
      'Toll Booth Boundary',
      'What This Does Not Enable',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }
    expect(doc).toContain('allowed_to_execute remains false');
    expect(doc).toContain('dry_run_only remains true');
  });
});
