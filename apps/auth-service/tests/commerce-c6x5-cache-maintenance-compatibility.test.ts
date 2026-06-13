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
  '../../../docs/internal/commerce-v1/commerce-v1-c6x5-cache-maintenance-compatibility.md',
);

function doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

function verifiedPriceResult() {
  return verifyOacpC6X2CachedArtifactEnvelope({
    artifact: OACP_C6W3_VALID_ARTIFACT_FIXTURES.price,
    now_iso: '2026-06-11T00:01:00.000Z',
    expected_scope: {
      tenant_id: 'cten_C6W3',
      merchant_id: 'mch_C6W3',
      seller_agent_id: 'seller_C6W3',
    },
    risk_tier: 'low',
    revocation_snapshot: {
      status: 'fresh',
      observed_at: '2026-06-11T00:00:30.000Z',
      age_seconds: 30,
      revoked_artifact_ids: [],
      revoked_subject_ids: [],
    },
    verifier_result_ref: 'verifier_result_price_C6X5',
    signature_verified: true,
  });
}

describe('C6X5 AgenticOrg cache maintenance compatibility guard', () => {
  it('keeps Grantex verifier output sufficient for AgenticOrg maintenance planning', () => {
    const result = verifiedPriceResult();
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.message);

    const maintenanceCandidate = {
      cache_record_id: `maintenance_${result.artifact_id}_C6X5`,
      artifact_id: result.artifact_id,
      artifact_type: result.artifact_type,
      artifact_family: result.artifact_family,
      authority: result.source_authority,
      issuer: result.issuer,
      tenant_id: result.cache_scope.tenant_id,
      merchant_id: result.cache_scope.merchant_id,
      seller_agent_id: result.cache_scope.seller_agent_id,
      buyer_agent_id: result.cache_scope.buyer_agent_id ?? null,
      source_refs: result.source_refs,
      evidence_refs: result.evidence_refs,
      generated_at: result.generated_at,
      cached_at: result.issued_at,
      expires_at: result.expires_at,
      freshness_status: result.freshness_status,
      revocation_snapshot_status: result.revocation_status,
      revocation_snapshot_age_seconds: 30,
      revocation_snapshot_observed_at: result.revocation_snapshot_observed_at,
      ttl_policy_seconds: result.max_ttl_seconds,
      risk_tier: 'low',
      blocked_capabilities: result.blocked_capabilities,
      unsupported_capabilities: result.unsupported_capabilities,
      verifier_result_ref: result.verifier_result_ref,
      allowed_to_execute: result.allowed_to_execute,
      non_authoritative_for_transaction: result.non_authoritative_for_transaction,
      no_checkout_payment_enablement: result.no_checkout_payment_enablement,
      no_live_provider_enablement: result.no_live_provider_enablement,
      no_public_discovery_enablement: result.no_public_discovery_enablement,
    };

    for (const requiredField of [
      'artifact_id',
      'artifact_type',
      'authority',
      'issuer',
      'tenant_id',
      'merchant_id',
      'seller_agent_id',
      'source_refs',
      'evidence_refs',
      'generated_at',
      'cached_at',
      'expires_at',
      'freshness_status',
      'revocation_snapshot_status',
      'revocation_snapshot_age_seconds',
      'revocation_snapshot_observed_at',
      'ttl_policy_seconds',
      'risk_tier',
      'blocked_capabilities',
      'unsupported_capabilities',
      'verifier_result_ref',
    ]) {
      expect(maintenanceCandidate[requiredField as keyof typeof maintenanceCandidate]).toBeDefined();
    }
  });

  it('keeps maintenance-compatible verifier output non-executing and public-safe', () => {
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
    expect(result.verifier_result_only).toBe(true);

    const refs = [...result.source_refs, ...result.evidence_refs, result.verifier_result_ref];
    for (const ref of refs) {
      expect(ref).not.toMatch(/raw|private|secret|token|jwt|password|credential|allowlist/i);
    }
  });

  it('documents the C6X5 maintenance compatibility boundary', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Compatibility Guard',
      'Maintenance Fields',
      'Maintenance Outcomes',
      'Grantex Boundary',
      'Guardrails',
      'What C6X5 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('not a transaction toll booth');
    expect(text).toContain('allowed_to_execute = false');
    expect(text).toContain('no scheduler');
    expect(text).toContain('no raw provider payloads');
  });
});
