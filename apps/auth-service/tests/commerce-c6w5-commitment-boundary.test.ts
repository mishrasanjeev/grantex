import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  buildOacpC6W4ProtocolAdapterPreview,
  evaluateOacpC6W5CommitmentBoundaryMetadata,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w5-commitment-boundary-resolver.md',
);

function c6w5Artifacts() {
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
    artifacts: c6w5Artifacts(),
    generated_at: '2026-06-11T00:00:30.000Z',
  });
  if (!preview.generated) throw new Error(preview.message);
  return preview;
}

describe('C6W5 OACP commitment-boundary metadata', () => {
  it('allows non-binding preview while preserving source and non-enablement metadata', () => {
    const decision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'compare_catalog_summaries',
      artifacts: c6w5Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
    });

    expect(decision).toMatchObject({
      action_class: 'non_binding_preview',
      allowed_to_preview: true,
      allowed_to_prepare: false,
      allowed_to_execute: false,
      refusal_or_escalation_reason: null,
      risk_tier: 'informational',
      offline_mode_status: 'online_policy_available',
      source_authority: 'grantex_canonical_oacp_artifact_authority',
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
    });
    expect(decision.source_artifact_ids).toContain('catalog_snapshot_C6W3');
    expect(decision.blocked_capabilities).toContain('checkout_create');
    expect(decision.buyer_safe_message).toContain('not purchase approval');
  });

  it('prepares commitment-bound requests offline but never executes them in C6W5', () => {
    const decision = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'price_lock',
      artifacts: c6w5Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: false,
      revocation_snapshot_age_seconds: 30,
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
      max_quantity_per_sku: 1,
    });

    expect(decision).toMatchObject({
      action_class: 'commitment_bound',
      allowed_to_preview: true,
      allowed_to_prepare: true,
      allowed_to_execute: false,
      refusal_or_escalation_reason: 'prepared_not_executed_c6w5',
      risk_tier: 'medium',
      offline_mode_status: 'offline_prepared_not_executed',
    });
    expect(decision.required_fresh_artifact_families).toContain('price');
    expect(decision.buyer_safe_message).toContain('Prepared, not executed');
  });

  it('fails closed when adapter previews try to replace missing or stale source artifacts', () => {
    const withoutPrice = c6w5Artifacts().filter((artifact) => artifact.envelope.artifact_type !== 'price');
    const missing = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'price_lock',
      artifacts: withoutPrice,
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(missing.allowed_to_prepare).toBe(false);
    expect(missing.refusal_or_escalation_reason).toBe('required_artifact_missing:price');

    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;
    const stalePrice = {
      envelope: { ...price.envelope, freshness_class: 'stale' },
      payload: price.payload,
    };
    const stale = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'price_lock',
      artifacts: [
        ...c6w5Artifacts().filter((artifact) => artifact.envelope.artifact_type !== 'price'),
        stalePrice,
      ],
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: true,
      revocation_snapshot_age_seconds: 30,
      currency: 'INR',
      amount_minor_units: 200000,
      total_quantity: 1,
    });
    expect(stale.allowed_to_prepare).toBe(false);
    expect(stale.refusal_or_escalation_reason).toBe('artifact_freshness_missing_stale_or_ambiguous');
  });

  it('blocks live or publication style actions and documents the boundary model', () => {
    const blocked = evaluateOacpC6W5CommitmentBoundaryMetadata({
      action: 'live_payment_execution',
      artifacts: c6w5Artifacts(),
      adapter_preview: adapterPreview(),
      now_iso: '2026-06-11T00:01:00.000Z',
      grantex_available: false,
    });

    expect(blocked).toMatchObject({
      action_class: 'always_blocked',
      allowed_to_preview: false,
      allowed_to_prepare: false,
      allowed_to_execute: false,
      refusal_or_escalation_reason: 'blocked_in_c6w5',
      risk_tier: 'critical',
      offline_mode_status: 'offline_blocked',
    });

    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const heading of [
      'Scope',
      'Commitment Boundary Model',
      'Offline Commitment Mode',
      'TTL And Risk Defaults',
      'What This Does Not Enable',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }
    expect(doc).toContain('Grantex does not become a synchronous toll booth');
  });
});
