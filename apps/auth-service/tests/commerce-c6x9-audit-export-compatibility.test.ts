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
  '../../../docs/internal/commerce-v1/commerce-v1-c6x9-audit-export-compatibility.md',
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
    verifier_result_ref: 'verifier_result_price_C6X9',
    signature_verified: true,
  });
}

describe('C6X9 AgenticOrg audit export bundle compatibility guard', () => {
  it('keeps verifier output sufficient for redacted AgenticOrg audit export bundle refs', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const auditBundleCandidate = {
      bundle_kind: 'oacp_cache_operator_decision_audit_export_bundle',
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      artifact_family_counts: { [result.artifact_type]: 1 },
      cache_record_references: [`cache_${result.artifact_id}_C6X9`],
      maintenance_plan_references: ['oacp_c6x5_maintenance_plan_price_C6X9'],
      review_packet_references: ['oacp_c6x6_operator_review_price_C6X9'],
      decision_record_references: ['oacp_c6x7_operator_decision_price_C6X9'],
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
      allowed_to_execute: result.allowed_to_execute,
      audit_export_bundle_only: true,
      generated_artifact_written: false,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };

    for (const requiredField of [
      'bundle_kind',
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
      'allowed_to_execute',
      'audit_export_bundle_only',
      'non_authoritative_for_transaction',
    ]) {
      expect(auditBundleCandidate[requiredField as keyof typeof auditBundleCandidate]).toBeDefined();
    }
  });

  it('keeps bundle-compatible fields evidence-only and non-executing', () => {
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

  it('documents the C6X9 audit export compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Audit Bundle Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6X9 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('does not receive every audit bundle');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('does not write generated export files');
  });
});
