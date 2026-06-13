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
  '../../../docs/internal/commerce-v1/commerce-v1-c6y2-review-manifest-repository-compatibility.md',
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
    verifier_result_ref: 'verifier_result_price_C6Y2',
    signature_verified: true,
  });
}

describe('C6Y2 AgenticOrg audit review manifest repository compatibility guard', () => {
  it('keeps verifier output sufficient for durable AgenticOrg review manifest records', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const durableManifestRecordCandidate = {
      repository_record_kind: 'oacp_audit_review_manifest_repository_record',
      manifest_id: `manifest_${result.artifact_id}_C6Y2`,
      bundle_id: `audit_bundle_${result.artifact_id}_C6Y2`,
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      artifact_family_counts: { [result.artifact_type]: 1 },
      cache_record_references: [`cache_${result.artifact_id}_C6Y2`],
      maintenance_plan_references: ['oacp_c6x5_maintenance_plan_price_C6Y2'],
      review_packet_references: ['oacp_c6x6_operator_review_price_C6Y2'],
      decision_record_references: ['oacp_c6x7_operator_decision_price_C6Y2'],
      redacted_source_refs: result.source_refs,
      redacted_evidence_refs: result.evidence_refs,
      verifier_result_ref: result.verifier_result_ref,
      freshness_ttl_summary: {
        freshness: { [result.freshness_status]: 1 },
        earliest_expires_at: result.expires_at,
      },
      revocation_snapshot_summary: { [result.revocation_status]: 1 },
      risk_tier_summary: { low: 1 },
      blocked_capability_summary: result.blocked_capabilities,
      unsupported_capability_summary: result.unsupported_capabilities,
      retention_boundary: {
        retention_class: 'standard_internal_review',
        retention_days: 90,
        persistence_required: true,
        export_file_writer_added: false,
        generated_artifact_written: false,
      },
      redaction_boundary: {
        redacted_refs_only: true,
        raw_payloads_included: false,
        non_sensitive_evidence_refs_only: true,
      },
      allowed_to_execute: result.allowed_to_execute,
      no_execution: true,
      review_manifest_only: true,
      retention_boundary_only: true,
      audit_export_bundle_review_only: true,
      export_file_written: false,
      export_writer_added: false,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };

    for (const requiredField of [
      'repository_record_kind',
      'manifest_id',
      'bundle_id',
      'tenant_id',
      'merchant_id',
      'artifact_family_counts',
      'cache_record_references',
      'maintenance_plan_references',
      'review_packet_references',
      'decision_record_references',
      'redacted_source_refs',
      'redacted_evidence_refs',
      'freshness_ttl_summary',
      'revocation_snapshot_summary',
      'risk_tier_summary',
      'retention_boundary',
      'redaction_boundary',
      'allowed_to_execute',
      'review_manifest_only',
      'retention_boundary_only',
      'non_authoritative_for_transaction',
    ]) {
      expect(durableManifestRecordCandidate[requiredField as keyof typeof durableManifestRecordCandidate]).toBeDefined();
    }
  });

  it('keeps repository-compatible fields redacted and non-executing', () => {
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

    const refs = [...result.source_refs, ...result.evidence_refs, result.verifier_result_ref];
    for (const ref of refs) {
      expect(ref).not.toMatch(/raw|private|secret|token|jwt|passport|password|credential|allowlist/i);
    }
  });

  it('documents the C6Y2 durable review manifest repository compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Durable Review Manifest Fields',
      'Retention Boundary Persistence',
      'Grantex Boundary',
      'Guardrails',
      'What C6Y2 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('does not receive every durable review manifest');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('does not write export files');
  });
});
