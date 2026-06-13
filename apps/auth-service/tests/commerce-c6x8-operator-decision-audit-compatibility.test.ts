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
  '../../../docs/internal/commerce-v1/commerce-v1-c6x8-operator-decision-audit-compatibility.md',
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
    verifier_result_ref: 'verifier_result_price_C6X8',
    signature_verified: true,
  });
}

describe('C6X8 AgenticOrg operator decision audit-chain compatibility guard', () => {
  it('keeps Grantex verifier output sufficient for durable AgenticOrg decision audit references', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const operatorDecisionCandidate = {
      decision_id: `decision_${result.artifact_id}_C6X8`,
      review_packet_id: 'oacp_c6x6_operator_review_price_C6X8',
      maintenance_plan_id: 'oacp_c6x5_maintenance_plan_price_C6X8',
      decision_kind: 'approve_future_refresh_request',
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id,
      artifact_families_affected: [result.artifact_type],
      source_refs: result.source_refs,
      evidence_refs: result.evidence_refs,
      verifier_result_ref: result.verifier_result_ref,
      reviewer_ref: 'operator_ref_c6x8_opaque',
      next_step_labels: ['future_refresh_request_label_only_no_api_call'],
      allowed_to_execute: result.allowed_to_execute,
      future_action_allowed: false,
      prepared_only: true,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };

    for (const requiredField of [
      'decision_id',
      'review_packet_id',
      'maintenance_plan_id',
      'decision_kind',
      'tenant_id',
      'merchant_id',
      'seller_agent_id',
      'buyer_agent_id',
      'artifact_families_affected',
      'source_refs',
      'evidence_refs',
      'reviewer_ref',
      'next_step_labels',
      'allowed_to_execute',
      'future_action_allowed',
      'non_authoritative_for_transaction',
    ]) {
      expect(operatorDecisionCandidate[requiredField as keyof typeof operatorDecisionCandidate]).toBeDefined();
    }
  });

  it('keeps audit-chain fields redacted and non-executing', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    expect(result.allowed_to_execute).toBe(false);
    expect(result.non_authoritative_for_transaction).toBe(true);
    expect(result.no_checkout_payment_enablement).toBe(true);
    expect(result.no_live_provider_enablement).toBe(true);
    expect(result.no_public_discovery_enablement).toBe(true);
    expect(result.no_provider_calls).toBe(true);
    expect(result.no_merchant_private_api_calls).toBe(true);

    const refs = [...result.source_refs, ...result.evidence_refs, result.verifier_result_ref];
    for (const ref of refs) {
      expect(ref).not.toMatch(/raw|private|secret|token|jwt|password|credential|allowlist/i);
    }
  });

  it('documents the C6X8 audit compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Audit-Chain Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6X8 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('not Grantex approvals');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('future_action_allowed = false');
    expect(text).toContain('no scheduler');
  });
});
