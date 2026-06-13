import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  OACP_C6W4_PROTOCOL_ADAPTER_SURFACES,
  buildOacpC6W4ProtocolAdapterPreview,
  hashOacpPayload,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w4-oacp-protocol-adapter-previews.md',
);

function c6w4SourceArtifacts() {
  return [
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.merchant_capability,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.seller_agent_capability,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.catalog_snapshot,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.policy,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.protocol_adapter,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.commitment_evidence,
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.price,
  ];
}

function c6w4SourceArtifactsWithInventory() {
  return [
    ...c6w4SourceArtifacts(),
    OACP_C6W3_VALID_ARTIFACT_FIXTURES.inventory,
  ];
}

describe('C6W4 OACP protocol adapter preview foundation', () => {
  it('builds bounded preview payloads for every internal adapter surface', () => {
    for (const surface of OACP_C6W4_PROTOCOL_ADAPTER_SURFACES) {
      const preview = buildOacpC6W4ProtocolAdapterPreview({
        surface,
        artifacts: c6w4SourceArtifacts(),
        generated_at: '2026-06-11T00:01:00.000Z',
      });

      expect(preview).toMatchObject({
        generated: true,
        status: 'preview_only',
        surface,
        source_authority: 'grantex_canonical_oacp_artifact_authority',
        generated_at: '2026-06-11T00:01:00.000Z',
        expires_at: '2026-06-11T00:05:00.000Z',
        max_ttl_seconds: 240,
        freshness_tier: 'fresh',
        non_authoritative_for_transaction: true,
        no_checkout_payment_enablement: true,
        no_live_provider_enablement: true,
        no_public_discovery_enablement: true,
      });
      if (preview.generated) {
        expect(preview.source_artifact_families).toContain('protocol_adapter');
        expect(preview.source_artifact_ids).toContain('protocol_adapter_C6W3');
        expect(preview.unsupported_capabilities).toContain('checkout_create');
        expect(preview.unsupported_capabilities).toContain('live_provider_call');
        expect(preview.surface_payload).toMatchObject({
          preview_only: true,
          internal_only: true,
          non_publication: true,
          non_certifying: true,
        });
      }
    }
  });

  it('projects surface-specific shapes without creating transaction authority', () => {
    const artifacts = c6w4SourceArtifacts();
    const schemaOrg = buildOacpC6W4ProtocolAdapterPreview({
      surface: 'schema_org_jsonld',
      artifacts,
      generated_at: '2026-06-11T00:01:00.000Z',
    });
    const ap2 = buildOacpC6W4ProtocolAdapterPreview({
      surface: 'ap2_evidence_intent_summary',
      artifacts,
      generated_at: '2026-06-11T00:01:00.000Z',
    });
    const mcp = buildOacpC6W4ProtocolAdapterPreview({
      surface: 'mcp_tool_resource_capability',
      artifacts: c6w4SourceArtifactsWithInventory(),
      generated_at: '2026-06-11T00:00:30.000Z',
    });

    expect(schemaOrg.generated && schemaOrg.surface_payload).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'OfferCatalog',
      final_price_inventory_or_delivery_promise: false,
    });
    expect(ap2.generated && ap2.surface_payload).toMatchObject({
      summary_kind: 'ap2_style_evidence_intent_preview',
      intent_status: 'non_binding_preview_only',
      payment_or_mandate_authorization: false,
    });
    expect(mcp.generated && mcp.surface_payload).toMatchObject({
      capability_kind: 'mcp_style_tool_resource_preview',
      write_tools: [],
      non_final_price_preview: {
        source_artifact_id: 'price_C6W3',
        final_price_promise: false,
      },
      non_final_inventory_preview: {
        source_artifact_id: 'inventory_C6W3',
        hold_or_delivery_promise: false,
      },
    });
  });

  it('fails closed for missing, invalid, private, or expired source artifacts', () => {
    const missingProtocolAdapter = c6w4SourceArtifacts().filter(
      (artifact) => artifact.envelope.artifact_type !== 'protocol_adapter',
    );
    expect(buildOacpC6W4ProtocolAdapterPreview({
      surface: 'mcp_tool_resource_capability',
      artifacts: missingProtocolAdapter,
      generated_at: '2026-06-11T00:01:00.000Z',
    })).toMatchObject({
      generated: false,
      refusal_code: 'source_artifact_missing',
    });

    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;
    const privatePayload = { ...price.payload, rawProviderPayload: { private: true } };
    const privateArtifact = {
      envelope: {
        ...price.envelope,
        payload_hash: hashOacpPayload(privatePayload),
      },
      payload: privatePayload,
    };
    expect(buildOacpC6W4ProtocolAdapterPreview({
      surface: 'mcp_tool_resource_capability',
      artifacts: [
        ...c6w4SourceArtifacts().filter((artifact) => artifact.envelope.artifact_type !== 'price'),
        privateArtifact,
      ],
      generated_at: '2026-06-11T00:01:00.000Z',
    })).toMatchObject({
      generated: false,
      refusal_code: 'private_or_forbidden_payload_field',
    });

    expect(buildOacpC6W4ProtocolAdapterPreview({
      surface: 'ucp_capability_profile',
      artifacts: c6w4SourceArtifacts(),
      generated_at: '2026-06-11T00:06:00.000Z',
    })).toMatchObject({
      generated: false,
      refusal_code: 'source_artifact_expired_or_stale',
    });
  });

  it('documents non-enabling C6W4 adapter behavior', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    for (const heading of [
      'Scope',
      'Adapter Surfaces',
      'Preview Safety Contract',
      'Source Fact Rules',
      'What This Does Not Enable',
      'Stop Conditions',
      'Next Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    expect(doc).toContain('Adapter previews are not transaction authority');
    expect(doc).toContain('Grantex does not become a synchronous toll booth');
  });
});
