import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  verifyOacpC6X2CachedArtifactEnvelope,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6y5-retention-disposition-decision-compatibility.md',
);

function doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

function verifiedPriceResult() {
  return verifyOacpC6X2CachedArtifactEnvelope({
    artifact: OACP_C6W3_VALID_ARTIFACT_FIXTURES.price,
    now_iso: '2026-06-11T00:00:20.000Z',
    expected_scope: {
      tenant_id: 'cten_C6W3',
      merchant_id: 'mch_C6W3',
      seller_agent_id: 'seller_C6W3',
      buyer_agent_id: 'buyer_C6W3',
    },
    risk_tier: 'low',
    revocation_snapshot: {
      status: 'fresh',
      observed_at: '2026-06-11T00:00:10.000Z',
      age_seconds: 10,
      revoked_artifact_ids: [],
      revoked_subject_ids: [],
    },
    verifier_result_ref: 'verifier_result_price_C6Y5',
    signature_verified: true,
  });
}

describe('C6Y5 AgenticOrg retention disposition decision compatibility guard', () => {
  it('keeps verifier fields sufficient for durable disposition decision records', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const dispositionDecision = {
      disposition_decision_id: `retention_disposition_decision_${result.artifact_id}_C6Y5`,
      source_summary_id: `summary_${result.artifact_id}_C6Y5`,
      source_dry_run_id: `retention_dry_run_${result.artifact_id}_C6Y5`,
      source_operator_packet_id: `retention_operator_packet_${result.artifact_id}_C6Y5`,
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      generated_at: '2026-06-12T00:07:00.000Z',
      decided_at: '2026-06-12T00:08:00.000Z',
      decision_kind: 'approve_future_retention_review',
      retention_class: 'standard_internal_review',
      retain_until: '2026-09-10T00:07:00.000Z',
      manifest_count: 1,
      retention_due_count: 0,
      legal_hold_candidate_count: 0,
      artifact_family_counts: { [result.artifact_type]: 1 },
      risk_tier_counts: { low: 1 },
      blocked_capability_summary: result.blocked_capabilities,
      unsupported_capability_summary: result.unsupported_capabilities,
      redacted_evidence_ref_count: result.evidence_refs.length,
      redacted_reason_codes: { retention_boundary_not_due: 1 },
      reviewer_ref: 'operator_ref_c6y5_reviewer_001',
      next_step_labels: ['operator_future_retention_review_label_only'],
      allowed_to_execute: result.allowed_to_execute,
      future_retention_action_allowed: false,
      records_deleted: false,
      retention_executed: false,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };

    for (const requiredField of [
      'disposition_decision_id',
      'source_summary_id',
      'source_dry_run_id',
      'source_operator_packet_id',
      'tenant_id',
      'merchant_id',
      'decision_kind',
      'retention_class',
      'retain_until',
      'manifest_count',
      'retention_due_count',
      'legal_hold_candidate_count',
      'artifact_family_counts',
      'risk_tier_counts',
      'blocked_capability_summary',
      'unsupported_capability_summary',
      'redacted_evidence_ref_count',
      'redacted_reason_codes',
      'reviewer_ref',
      'next_step_labels',
      'allowed_to_execute',
      'future_retention_action_allowed',
      'records_deleted',
      'retention_executed',
      'non_authoritative_for_transaction',
    ]) {
      expect(dispositionDecision[requiredField as keyof typeof dispositionDecision]).toBeDefined();
    }
  });

  it('keeps disposition decision records redacted and non-executing', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    expect(result.allowed_to_execute).toBe(false);
    expect(result.non_authoritative_for_transaction).toBe(true);
    expect(result.no_checkout_payment_enablement).toBe(true);
    expect(result.no_public_discovery_enablement).toBe(true);
    expect(result.no_live_provider_enablement).toBe(true);
    expect(result.no_provider_calls).toBe(true);
    expect(result.no_merchant_private_api_calls).toBe(true);

    const storedDecisionRefs = [
      `summary_${result.artifact_id}_C6Y5`,
      `retention_dry_run_${result.artifact_id}_C6Y5`,
      `retention_operator_packet_${result.artifact_id}_C6Y5`,
      result.verifier_result_ref,
    ];
    for (const ref of storedDecisionRefs) {
      expect(ref).not.toMatch(/raw|private|secret|token|jwt|passport|password|credential|allowlist/i);
    }
  });

  it('documents the C6Y5 durable disposition decision compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Durable Decision Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6Y5 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('does not receive every retention disposition decision');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('future_retention_action_allowed = false');
    expect(text).toContain('records_deleted = false');
    expect(text).toContain('retention_executed = false');
  });
});
