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
  '../../../docs/internal/commerce-v1/commerce-v1-c6x6-cache-maintenance-report-compatibility.md',
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
    verifier_result_ref: 'verifier_result_inventory_C6X6',
    signature_verified: true,
  });
}

describe('C6X6 AgenticOrg cache maintenance report compatibility guard', () => {
  it('keeps verifier output sufficient for redacted AgenticOrg operator review packets', () => {
    const result = verifiedInventoryResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const maintenanceAction = {
      cache_record_id: `cache_report_${result.artifact_id}_C6X6`,
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
      expires_at: result.expires_at,
      remaining_ttl_seconds: 40,
      freshness_status: result.freshness_status,
      revocation_snapshot_status: result.revocation_status,
      revocation_snapshot_age_seconds: 10,
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
    const reportCandidate = {
      report_kind: 'operator_review_packet',
      generated_at: '2026-06-11T00:01:00.000Z',
      scope_summary: {
        seller_agent: { [sellerAgentId]: 1 },
        tenant: { [tenantId]: 1 },
        merchant: { [merchantId]: 1 },
      },
      artifact_family_counts: { [result.artifact_type]: 1 },
      record_actions: [maintenanceAction],
      evidence_refs: result.evidence_refs,
      source_refs: result.source_refs,
      allowed_to_execute: false,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    };

    for (const requiredField of [
      'report_kind',
      'generated_at',
      'scope_summary',
      'artifact_family_counts',
      'record_actions',
      'evidence_refs',
      'source_refs',
      'allowed_to_execute',
      'non_authoritative_for_transaction',
      'no_checkout_payment_enablement',
      'no_live_provider_enablement',
      'no_public_discovery_enablement',
    ]) {
      expect(reportCandidate[requiredField as keyof typeof reportCandidate]).toBeDefined();
    }
  });

  it('keeps report-compatible fields non-executing and public-safe', () => {
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

  it('documents the C6X6 report compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Report Fields',
      'Grantex Boundary',
      'Guardrails',
      'What C6X6 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('does not receive every report');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('no scheduler');
  });
});
