import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_ARTIFACT_SCHEMA_DESCRIPTORS,
  OACP_ARTIFACT_TYPES,
  OACP_C6W3_BLOCKED_ARTIFACT_FIXTURES,
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  hashOacpPayload,
  validateOacpArtifactSchema,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w3-oacp-artifact-schema-family.md',
);

describe('C6W3 OACP artifact schema family and fixture corpus', () => {
  it('defines a schema descriptor for every OACP artifact family', () => {
    expect(Object.keys(OACP_ARTIFACT_SCHEMA_DESCRIPTORS).sort()).toEqual([...OACP_ARTIFACT_TYPES].sort());
    for (const artifactType of OACP_ARTIFACT_TYPES) {
      const descriptor = OACP_ARTIFACT_SCHEMA_DESCRIPTORS[artifactType];
      expect(descriptor.artifact_type).toBe(artifactType);
      expect(descriptor.required_envelope_fields).toContain('artifact_type');
      expect(descriptor.required_envelope_fields).toContain('payload_hash');
      expect(descriptor.required_envelope_fields).toContain('signature');
      expect(descriptor.required_safety_fields).toContain('public_safe');
      expect(descriptor.required_safety_fields).toContain('requires_provider_direct_verification');
      expect(descriptor.required_payload_fields.length).toBeGreaterThan(0);
    }
  });

  it('accepts one synthetic public-safe valid fixture for each artifact family', () => {
    for (const artifactType of OACP_ARTIFACT_TYPES) {
      const fixture = OACP_C6W3_VALID_ARTIFACT_FIXTURES[artifactType];
      expect(validateOacpArtifactSchema({
        envelope: fixture.envelope,
        payload: fixture.payload,
        now_iso: '2026-06-11T00:00:00.000Z',
      })).toMatchObject({
        valid: true,
        artifact_type: artifactType,
      });
    }
  });

  it('rejects one blocked fixture per artifact family with the expected reason', () => {
    for (const artifactType of OACP_ARTIFACT_TYPES) {
      const blocked = OACP_C6W3_BLOCKED_ARTIFACT_FIXTURES[artifactType];
      expect(validateOacpArtifactSchema({
        envelope: blocked.fixture.envelope,
        payload: blocked.fixture.payload,
        now_iso: '2026-06-11T00:00:00.000Z',
      })).toMatchObject({
        valid: false,
        artifact_type: artifactType,
        refusal_code: blocked.expected_refusal_code,
      });
    }
  });

  it('fails closed for unknown artifact types, missing safety fields, and forbidden payload fields', () => {
    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;

    expect(validateOacpArtifactSchema({
      envelope: {
        ...price.envelope,
        artifact_type: 'unknown_artifact',
      },
      payload: price.payload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'unknown_artifact_type',
    });

    expect(validateOacpArtifactSchema({
      envelope: {
        ...price.envelope,
        safety: {
          public_safe: true,
          contains_private_data: false,
        },
      },
      payload: price.payload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'safety_field_missing',
    });

    expect(validateOacpArtifactSchema({
      envelope: {
        ...price.envelope,
        payload_hash: hashOacpPayload({
          ...price.payload,
          rawProviderPayload: { private: true },
        }),
      },
      payload: {
        ...price.payload,
        rawProviderPayload: { private: true },
      },
    })).toMatchObject({
      valid: false,
      refusal_code: 'private_or_forbidden_payload_field',
    });
  });

  it('fails closed for expired artifacts, future not-before artifacts, bad hashes, and missing all-four scope when required', () => {
    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;

    expect(validateOacpArtifactSchema({
      envelope: price.envelope,
      payload: price.payload,
      now_iso: '2026-06-11T00:06:00.000Z',
    })).toMatchObject({
      valid: false,
      refusal_code: 'artifact_expired_or_stale',
    });

    expect(validateOacpArtifactSchema({
      envelope: {
        ...price.envelope,
        not_before: '2026-06-11T00:02:00.000Z',
      },
      payload: price.payload,
      now_iso: '2026-06-11T00:01:00.000Z',
    })).toMatchObject({
      valid: false,
      refusal_code: 'artifact_not_yet_valid',
    });

    expect(validateOacpArtifactSchema({
      envelope: {
        ...price.envelope,
        payload_hash: 'bad_hash',
      },
      payload: price.payload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'payload_hash_mismatch',
    });

    const { buyer_agent_id: _buyerAgentId, ...missingBuyerScope } = price.envelope;
    expect(validateOacpArtifactSchema({
      envelope: missingBuyerScope,
      payload: price.payload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'scope_field_missing',
    });
  });

  it('pins protocol adapter, mandate, public discovery, and commitment evidence safety rules', () => {
    const protocolAdapter = OACP_C6W3_VALID_ARTIFACT_FIXTURES.protocol_adapter;
    expect(validateOacpArtifactSchema({
      envelope: protocolAdapter.envelope,
      payload: {
        ...protocolAdapter.payload,
        referenced_artifact_expires_at: ['2026-06-11T00:04:00.000Z'],
      },
    })).toMatchObject({
      valid: false,
      refusal_code: 'payload_hash_mismatch',
    });
    const protocolPayload = {
      ...protocolAdapter.payload,
      referenced_artifact_expires_at: ['2026-06-11T00:04:00.000Z'],
    };
    expect(validateOacpArtifactSchema({
      envelope: {
        ...protocolAdapter.envelope,
        payload_hash: hashOacpPayload(protocolPayload),
      },
      payload: protocolPayload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'protocol_adapter_outlives_references',
    });

    const mandate = OACP_C6W3_VALID_ARTIFACT_FIXTURES.mandate_capability;
    const mandatePayload = {
      ...mandate.payload,
      provider_direct_verification_required: false,
    };
    expect(validateOacpArtifactSchema({
      envelope: {
        ...mandate.envelope,
        payload_hash: hashOacpPayload(mandatePayload),
      },
      payload: mandatePayload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'mandate_provider_verification_required',
    });

    const discovery = OACP_C6W3_VALID_ARTIFACT_FIXTURES.public_discovery;
    const discoveryPayload = {
      ...discovery.payload,
      publish_offline_allowed: true,
    };
    expect(validateOacpArtifactSchema({
      envelope: {
        ...discovery.envelope,
        payload_hash: hashOacpPayload(discoveryPayload),
      },
      payload: discoveryPayload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'public_discovery_offline_change_forbidden',
    });

    const commitment = OACP_C6W3_VALID_ARTIFACT_FIXTURES.commitment_evidence;
    const commitmentPayload = {
      ...commitment.payload,
      commitment_type: 'payment_capture',
    };
    expect(validateOacpArtifactSchema({
      envelope: {
        ...commitment.envelope,
        payload_hash: hashOacpPayload(commitmentPayload),
      },
      payload: commitmentPayload,
    })).toMatchObject({
      valid: false,
      refusal_code: 'commitment_evidence_forbidden_implication',
    });
  });

  it('documents internal-only C6W3 schema family behavior and adapter consumption posture', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    for (const heading of [
      'Scope',
      'Artifact Families',
      'Fixture Corpus',
      'Future Adapter Consumption',
      'What This Does Not Enable',
      'Stop Conditions',
      'Next Slices',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    expect(doc).toContain('schema.org, UCP-style, ACP-style, AP2-style, A2A, and MCP');
    expect(doc).toContain('No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment');
  });
});
