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
  '../../../docs/internal/commerce-v1/commerce-v1-c6y3-review-manifest-summary-compatibility.md',
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
    verifier_result_ref: 'verifier_result_price_C6Y3',
    signature_verified: true,
  });
}

describe('C6Y3 AgenticOrg review manifest summary compatibility guard', () => {
  it('keeps Grantex verifier fields sufficient for redacted AgenticOrg manifest summaries', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const summaryCandidate = {
      summary_kind: 'oacp_audit_review_manifest_redacted_summary',
      summary_id: `summary_${result.artifact_id}_C6Y3`,
      generated_at: '2026-06-12T00:05:00.000Z',
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      manifest_count: 1,
      retention_class_counts: { standard_internal_review: 1 },
      retention_due_count: 0,
      legal_hold_candidate_count: 0,
      artifact_family_counts: { [result.artifact_type]: 1 },
      risk_tier_counts: { low: 1 },
      freshness_ttl_summary: {
        freshness: { [result.freshness_status]: 1 },
        expires_at_refs: [result.expires_at],
      },
      revocation_snapshot_summary: { [result.revocation_status]: 1 },
      blocked_capability_summary: result.blocked_capabilities,
      unsupported_capability_summary: result.unsupported_capabilities,
      redacted_evidence_ref_count: result.evidence_refs.length,
      next_step_labels: ['internal_review_summary_label_only'],
      allowed_to_execute: result.allowed_to_execute,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
      no_export_file_written: true,
    };

    for (const requiredField of [
      'summary_kind',
      'summary_id',
      'generated_at',
      'tenant_id',
      'merchant_id',
      'manifest_count',
      'retention_class_counts',
      'artifact_family_counts',
      'freshness_ttl_summary',
      'revocation_snapshot_summary',
      'risk_tier_counts',
      'blocked_capability_summary',
      'unsupported_capability_summary',
      'redacted_evidence_ref_count',
      'allowed_to_execute',
      'non_authoritative_for_transaction',
      'no_export_file_written',
    ]) {
      expect(summaryCandidate[requiredField as keyof typeof summaryCandidate]).toBeDefined();
    }
  });

  it('keeps summary-compatible references redacted and non-executing', () => {
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

  it('documents the C6Y3 review manifest summary compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Manifest Query And Summary Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6Y3 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('does not receive every manifest summary');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('does not write export files');
  });
});
