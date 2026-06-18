#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  C6Z_ARTIFACT_FAMILIES,
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
} from '../apps/auth-service/dist/lib/commerce/oacp-runtime-vertical.js';

const nowIso = process.env.OACP_LAUNCH_NOW_ISO || '2026-06-18T03:00:00.000Z';

const request = {
  request_id: 'agenticorg_oacp_launch_request_001',
  tenant_id: '11111111-1111-1111-1111-111111111111',
  merchant_id: 'merchant_oacp_launch_evidence',
  seller_agent_id: 'seller_agent_oacp_launch',
  merchant_display_name: 'OACP Launch Evidence Merchant',
  commerce_categories: ['launch_evidence'],
  connector_choice: 'shopify',
  connector_mode: 'read_only',
  requested_authority_scope: [...C6Z_ARTIFACT_FAMILIES],
  artifact_cache_scope: {
    tenant_id: '11111111-1111-1111-1111-111111111111',
    merchant_id: 'merchant_oacp_launch_evidence',
    seller_agent_id: 'seller_agent_oacp_launch',
  },
  source_freshness_policy: { max_age_seconds: 600 },
  source_evidence_ref: 'agenticorg:shopify:evidence:oacp-launch:redacted',
  source_observed_at: '2026-06-18T02:55:00.000Z',
  no_payment_execution: true,
  no_public_discovery_enablement: true,
};

const evidence = {
  evidence_id: 'shopify_evidence_oacp_launch',
  tenant_id: request.tenant_id,
  merchant_id: request.merchant_id,
  seller_agent_id: request.seller_agent_id,
  source_system: 'shopify',
  source_evidence_ref: request.source_evidence_ref,
  source_observed_at: request.source_observed_at,
  product_count: 1,
  variant_count: 1,
  currency: 'INR',
  catalog_sample_refs: ['agenticorg:catalog:item:oacp-launch:redacted'],
  price_snapshot_refs: ['agenticorg:price:item:oacp-launch:redacted'],
  inventory_snapshot_refs: ['agenticorg:inventory:item:oacp-launch:redacted'],
  no_payment_execution: true,
  no_public_discovery_enablement: true,
};

const validation = validateC6ZSellerAuthorityRequest(request, nowIso);
const issuance = issueC6ZInternalOacpArtifacts({ request, evidence, now_iso: nowIso });

assert.equal(validation.status, 'artifact_issuance_ready');
assert.equal(issuance.status, 'artifact_issuance_ready');
assert.equal(issuance.allowed_to_execute, false);
assert.equal(issuance.no_payment_execution, true);
assert.equal(issuance.no_public_discovery_enablement, true);
assert.equal(issuance.artifacts.length, C6Z_ARTIFACT_FAMILIES.length);

const families = issuance.artifacts.map((artifact) => artifact.artifact_family).sort();
assert.deepEqual(families, [...C6Z_ARTIFACT_FAMILIES].sort());
for (const artifact of issuance.artifacts) {
  assert.equal(artifact.verifier_status.valid, true);
  assert.equal(artifact.payload.allowed_to_execute, false);
  assert.equal(artifact.payload.no_payment_execution, true);
  assert.equal(artifact.payload.no_public_discovery_enablement, true);
  assert.equal(artifact.payload.non_authoritative_for_transaction, true);
}

const summary = {
  generated_at: new Date().toISOString(),
  repo: 'grantex',
  request_id: request.request_id,
  evidence_id: evidence.evidence_id,
  source_evidence_ref: evidence.source_evidence_ref,
  authority_request_status: validation.status,
  artifact_family_count: issuance.artifacts.length,
  artifact_families: families,
  artifact_ids: issuance.artifacts.map((artifact) => artifact.envelope.artifact_id).sort(),
  verifier_summary: {
    valid: issuance.artifacts.filter((artifact) => artifact.verifier_status.valid).length,
    invalid: issuance.artifacts.filter((artifact) => !artifact.verifier_status.valid).length,
  },
  public_discovery_state: issuance.artifacts.find((artifact) => artifact.artifact_family === 'public_discovery_state')?.payload.public_discovery_state,
  mandate_capability_status: issuance.artifacts.find((artifact) => artifact.artifact_family === 'mandate_capability')?.payload.mandate_capability_status,
  protocol_adapter_boundary: issuance.artifacts.find((artifact) => artifact.artifact_family === 'protocol_adapter')?.payload.adapter_claim_boundary,
  allowed_to_execute: false,
  raw_payload_stored: false,
  no_payment_execution: true,
  non_authoritative_for_transaction: true,
};

const rendered = JSON.stringify(summary, null, 2);
if (/shpat_|bearer |-----BEGIN|client_secret=|password=/i.test(rendered)) {
  throw new Error('Unsafe launch summary contained a secret-like value');
}
console.log(rendered);
