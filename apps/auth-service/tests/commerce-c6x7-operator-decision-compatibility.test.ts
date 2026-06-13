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
  '../../../docs/internal/commerce-v1/commerce-v1-c6x7-operator-decision-compatibility.md',
);

function doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

function verifiedInventoryResult() {
  return verifyOacpC6X2CachedArtifactEnvelope({
    artifact: OACP_C6W3_VALID_ARTIFACT_FIXTURES.inventory,
    now_iso: '2026-06-11T00:00:20.000Z',
    expected_scope: {
      tenant_id: 'cten_C6W3',
      merchant_id: 'mch_C6W3',
      seller_agent_id: 'seller_C6W3',
    },
    risk_tier: 'low',
    revocation_snapshot: {
      status: 'fresh',
      observed_at: '2026-06-11T00:00:10.000Z',
      age_seconds: 10,
      revoked_artifact_ids: [],
      revoked_subject_ids: [],
    },
    verifier_result_ref: 'verifier_result_inventory_C6X7',
    signature_verified: true,
  });
}

describe('C6X7 AgenticOrg operator decision compatibility guard', () => {
  it('keeps verifier output sufficient for redacted AgenticOrg operator decision records', () => {
    const result = verifiedInventoryResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const maintenanceAction = {
      cache_record_id: `cache_decision_${result.artifact_id}_C6X7`,
      artifact_id: result.artifact_id,
      artifact_type: result.artifact_type,
      scope_kind: 'seller_agent',
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      maintenance_outcome: 'refresh_recommended',
      reason_codes: ['ttl_or_revocation_refresh_window_reached'],
      risk_tier: 'low',
      source_refs: result.source_refs,
      evidence_refs: result.evidence_refs,
      verifier_result_ref: result.verifier_result_ref,
      freshness_status: result.freshness_status,
      revocation_snapshot_status: result.revocation_status,
      blocked_capabilities: result.blocked_capabilities,
      unsupported_capabilities: result.unsupported_capabilities,
      allowed_to_execute: result.allowed_to_execute,
      maintenance_plan_only: true,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };
    const tenantId = maintenanceAction.tenant_id ?? 'tenant_missing';
    const merchantId = maintenanceAction.merchant_id ?? 'merchant_missing';
    const sellerAgentId = maintenanceAction.seller_agent_id ?? 'seller_agent_missing';
    const reviewPacketCandidate = {
      report_id: 'oacp_c6x6_cache_report_inventory_C6X7',
      report_kind: 'operator_review_packet',
      source_plan_id: 'oacp_c6x5_maintenance_plan_inventory_C6X7',
      generated_at: '2026-06-11T00:01:00.000Z',
      scope_summary: {
        seller_agent: { [sellerAgentId]: 1 },
        tenant: { [tenantId]: 1 },
        merchant: { [merchantId]: 1 },
      },
      artifact_family_counts: { [result.artifact_type]: 1 },
      per_record_reason_codes: {
        [maintenanceAction.cache_record_id]: maintenanceAction.reason_codes,
      },
      record_actions: [maintenanceAction],
      evidence_refs: result.evidence_refs,
      source_refs: result.source_refs,
      allowed_to_execute: false,
      no_execution: true,
      operator_review_only: true,
      maintenance_report_only: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    };
    const decisionCandidate = {
      decision_kind: 'approve_future_refresh_request',
      review_packet_id: reviewPacketCandidate.report_id,
      maintenance_plan_id: reviewPacketCandidate.source_plan_id,
      reviewer_identity_ref: 'operator_ref_c6x7_opaque',
      scope_summary: reviewPacketCandidate.scope_summary,
      artifact_families_affected: Object.keys(reviewPacketCandidate.artifact_family_counts),
      redacted_reason_codes: reviewPacketCandidate.per_record_reason_codes,
      evidence_refs: reviewPacketCandidate.evidence_refs,
      source_refs: reviewPacketCandidate.source_refs,
      next_step_labels: ['future_refresh_request_label_only_no_api_call'],
      allowed_to_execute: false,
      no_execution: true,
      operator_decision_only: true,
      audit_safe_decision_record: true,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    };

    for (const requiredField of [
      'decision_kind',
      'review_packet_id',
      'maintenance_plan_id',
      'reviewer_identity_ref',
      'scope_summary',
      'artifact_families_affected',
      'redacted_reason_codes',
      'evidence_refs',
      'source_refs',
      'next_step_labels',
      'allowed_to_execute',
      'operator_decision_only',
      'audit_safe_decision_record',
    ]) {
      expect(decisionCandidate[requiredField as keyof typeof decisionCandidate]).toBeDefined();
    }
  });

  it('keeps decision-compatible fields non-executing and public-safe', () => {
    const result = verifiedInventoryResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    expect(result.allowed_to_execute).toBe(false);
    expect(result.non_authoritative_for_transaction).toBe(true);
    expect(result.no_checkout_payment_enablement).toBe(true);
    expect(result.no_public_discovery_enablement).toBe(true);
    expect(result.no_live_provider_enablement).toBe(true);
    expect(result.no_provider_calls).toBe(true);
    expect(result.no_merchant_private_api_calls).toBe(true);

    const refs = [...result.source_refs, ...result.evidence_refs, result.verifier_result_ref];
    for (const ref of refs) {
      expect(ref).not.toMatch(/raw|private|secret|token|jwt|password|credential|allowlist/i);
    }
  });

  it('documents the C6X7 operator decision compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Decision Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6X7 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('not Grantex approvals');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('no scheduler');
  });
});
