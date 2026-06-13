import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  hashOacpPayload,
  verifyOacpC6X2CachedArtifactEnvelope,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6x2-oacp-cache-verifier-runtime.md',
);

function doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

function verifierInput(overrides = {}) {
  const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;
  return {
    artifact: price,
    now_iso: '2026-06-11T00:01:00.000Z',
    expected_scope: {
      tenant_id: 'cten_C6W3',
      merchant_id: 'mch_C6W3',
      seller_agent_id: 'seller_C6W3',
    },
    risk_tier: 'low' as const,
    revocation_snapshot: {
      status: 'fresh' as const,
      observed_at: '2026-06-11T00:00:30.000Z',
      age_seconds: 30,
      revoked_artifact_ids: [],
      revoked_subject_ids: [],
    },
    verifier_result_ref: 'verifier_result_price_C6X2',
    signature_verified: true,
    ...overrides,
  };
}

describe('C6X2 cached OACP artifact verifier helper', () => {
  it('accepts a fresh cached artifact for non-binding cache use only', () => {
    const result = verifyOacpC6X2CachedArtifactEnvelope(verifierInput());

    expect(result).toMatchObject({
      verified: true,
      status: 'accepted_for_non_binding_cache_use',
      artifact_id: 'price_C6W3',
      artifact_family: 'price',
      issuer: 'grantex',
      source_authority: 'grantex',
      cache_scope: {
        tenant_id: 'cten_C6W3',
        merchant_id: 'mch_C6W3',
        seller_agent_id: 'seller_C6W3',
      },
      freshness_status: 'fresh',
      revocation_status: 'fresh',
      detached_jws_signature_present: true,
      signature_verified: true,
      allowed_to_execute: false,
      non_authoritative_for_transaction: true,
      no_checkout_payment_enablement: true,
      no_live_provider_enablement: true,
      no_public_discovery_enablement: true,
      no_provider_calls: true,
      no_merchant_private_api_calls: true,
      verifier_result_only: true,
    });
  });

  it('fails closed for missing id, expired freshness, revoked state, and scope mismatch', () => {
    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      artifact: {
        ...price,
        envelope: {
          ...price.envelope,
          artifact_id: '',
        },
      },
    }))).toMatchObject({
      verified: false,
      refusal_code: 'artifact_id_missing',
      allowed_to_execute: false,
    });

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      now_iso: '2026-06-11T00:06:01.000Z',
    }))).toMatchObject({
      verified: false,
      status: 'expired',
      refusal_code: 'artifact_expired_or_stale',
    });

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      revocation_snapshot: {
        status: 'fresh',
        observed_at: '2026-06-11T00:00:30.000Z',
        age_seconds: 30,
        revoked_artifact_ids: ['price_C6W3'],
        revoked_subject_ids: [],
      },
    }))).toMatchObject({
      verified: false,
      status: 'revoked',
      refusal_code: 'artifact_revoked',
    });

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      expected_scope: {
        tenant_id: 'cten_C6W3',
        merchant_id: 'other_merchant',
      },
    }))).toMatchObject({
      verified: false,
      status: 'mismatched',
      refusal_code: 'scope_mismatch',
    });
  });

  it('fails closed for private fields, missing verifier posture, and publication-oriented refs', () => {
    const price = OACP_C6W3_VALID_ARTIFACT_FIXTURES.price;

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      artifact: {
        ...price,
        envelope: {
          ...price.envelope,
          payload_hash: hashOacpPayload({
            ...price.payload,
            raw_jwt: 'private',
          }),
        },
        payload: {
          ...price.payload,
          raw_jwt: 'private',
        },
      },
    }))).toMatchObject({
      verified: false,
      status: 'unsafe',
      refusal_code: 'private_or_forbidden_cached_artifact_field',
    });

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      verifier_result_ref: null,
      signature_verified: null,
    }))).toMatchObject({
      verified: false,
      status: 'unsafe',
      refusal_code: 'signature_or_verifier_posture_missing',
    });

    expect(verifyOacpC6X2CachedArtifactEnvelope(verifierInput({
      verifier_result_ref: 'protocol_publication_ready_ref',
    }))).toMatchObject({
      verified: false,
      status: 'unsafe',
      refusal_code: 'publication_or_readiness_claim',
    });
  });

  it('documents runtime boundaries without adding execution or migration behavior', () => {
    const text = doc();
    for (const heading of [
      'Scope',
      'Correct Ownership Model',
      'Cached Artifact Verifier Contract',
      'Verifier Result Fields',
      'Freshness, Revocation, And TTL',
      'Fail-Closed Rules',
      'Persistence And Migration Decision',
      'Guardrails',
      'What C6X2 Does Not Enable',
      'Future Work',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }

    expect(text).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(text).toContain('verifier-result-only');
    expect(text).toContain('no public endpoint');
    expect(text).toContain('no DB migration');
    expect(text).toContain('no checkout or payment enablement');
    expect(text).toContain('no live provider rail enablement');
    expect(text).toContain('not a transaction toll booth');
  });
});
