import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateInternalOacpArtifactStatus,
  hashOacpPayload,
  issueInternalOacpArtifact,
  type OacpArtifactEnvelope,
  type OacpArtifactSafety,
  type OacpDetachedJwsSigner,
  type OacpDetachedJwsVerifier,
  type OacpIssuerKeyMetadata,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w2-oacp-artifact-authority-foundation.md',
);

const ISSUER_KEY: OacpIssuerKeyMetadata = {
  issuer: 'grantex',
  issuer_key_id: 'kid_C6W2_stub',
  algorithm: 'ES256',
  state: 'active',
  not_before: '2026-06-11T00:00:00.000Z',
  expires_at: '2026-06-12T00:00:00.000Z',
};

const SAFETY: OacpArtifactSafety = {
  public_safe: true,
  contains_private_data: false,
  allowed_agent_uses: ['quote_preview', 'price_lock'],
  forbidden_agent_uses: ['payment_capture'],
  commitment_allowed: true,
  offline_commitment_allowed: true,
  requires_online_confirmation: false,
  requires_provider_direct_verification: false,
  requires_merchant_system_confirmation: true,
  stale_behavior: 'refuse_final_commitment',
  refusal_code_if_invalid: 'artifact_invalid',
};

const PAYLOAD = {
  display_name: 'C6W2 public item',
  amount_minor_units: 99900,
  currency: 'INR',
};

const SIGNER: OacpDetachedJwsSigner = ({ payload_hash }) => `eyJhbGciOiJFUzI1NiJ9..sig_${payload_hash}`;
const VERIFIER: OacpDetachedJwsVerifier = ({ payload_hash, signature }) => (
  signature === `eyJhbGciOiJFUzI1NiJ9..sig_${payload_hash}`
);

function issuePriceArtifact(overrides: Partial<Parameters<typeof issueInternalOacpArtifact>[0]> = {}): OacpArtifactEnvelope {
  return issueInternalOacpArtifact({
    artifact_id: 'oacp_price_C6W2',
    artifact_type: 'price',
    issuer: 'grantex',
    issuer_key_id: 'kid_C6W2_stub',
    subject_type: 'merchant_offer',
    subject_id: 'offer_C6W2',
    tenant_id: 'cten_C6W2',
    merchant_id: 'mch_C6W2',
    buyer_agent_id: 'buyer_C6W2',
    seller_agent_id: 'seller_C6W2',
    issued_at: '2026-06-11T00:00:00.000Z',
    expires_at: '2026-06-11T00:05:00.000Z',
    source_observed_at: '2026-06-11T00:00:00.000Z',
    policy_version: 'policy_C6W2',
    revocation_status_url: 'https://grantex.example.invalid/oacp/revocations/oacp_price_C6W2',
    payload: PAYLOAD,
    safety: SAFETY,
    issuer_key: ISSUER_KEY,
    signDetachedJws: SIGNER,
    ...overrides,
  });
}

describe('C6W2 internal OACP artifact authority helpers', () => {
  it('issues canonical-hash envelopes with detached JWS signatures and no JWT artifact container', () => {
    const envelope = issuePriceArtifact();

    expect(envelope.payload_hash).toBe(hashOacpPayload(PAYLOAD));
    expect(envelope.signature_alg).toBe('ES256');
    expect(envelope.signature).toBe(`eyJhbGciOiJFUzI1NiJ9..sig_${hashOacpPayload(PAYLOAD)}`);
    expect(envelope.signature).not.toContain('jwt');
  });

  it('verifies valid internal artifacts and returns all-four-scope cache status', () => {
    const envelope = issuePriceArtifact();
    const status = evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
      expected_scope: {
        tenant_id: 'cten_C6W2',
        merchant_id: 'mch_C6W2',
        seller_agent_id: 'seller_C6W2',
        buyer_agent_id: 'buyer_C6W2',
      },
    });

    expect(status).toMatchObject({
      valid: true,
      status: 'valid',
      artifact_id: 'oacp_price_C6W2',
      artifact_type: 'price',
      cache_key: 'cten_C6W2:mch_C6W2:seller_C6W2:buyer_C6W2:price:oacp_price_C6W2:oacp.internal.v1:policy_C6W2',
    });
  });

  it('fails closed for placeholder signatures, bad payload hashes, revoked artifacts, and scope mismatch', () => {
    const envelope = issuePriceArtifact();

    expect(evaluateInternalOacpArtifactStatus({
      envelope: { ...envelope, signature: 'detached_jws_required_before_publication' },
      payload: PAYLOAD,
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
    })).toMatchObject({
      valid: false,
      refusal_code: 'signature_missing_or_placeholder',
    });

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: { ...PAYLOAD, amount_minor_units: 100000 },
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
    })).toMatchObject({
      valid: false,
      refusal_code: 'payload_hash_mismatch',
    });

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
      revoked_artifact_ids: ['oacp_price_C6W2'],
    })).toMatchObject({
      valid: false,
      refusal_code: 'artifact_revoked',
    });

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
      expected_scope: {
        tenant_id: 'cten_C6W2',
        merchant_id: 'mch_C6W2',
        seller_agent_id: 'seller_C6W2',
        buyer_agent_id: 'other_buyer',
      },
    })).toMatchObject({
      valid: false,
      refusal_code: 'artifact_scope_mismatch',
    });
  });

  it('refuses untrusted or inactive issuer keys and detached JWS verification failure', () => {
    const envelope = issuePriceArtifact();

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
    })).toMatchObject({
      valid: false,
      refusal_code: 'issuer_key_untrusted',
    });

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [{ ...ISSUER_KEY, state: 'revoked' }],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: VERIFIER,
    })).toMatchObject({
      valid: false,
      refusal_code: 'issuer_key_inactive',
    });

    expect(evaluateInternalOacpArtifactStatus({
      envelope,
      payload: PAYLOAD,
      issuer_keys: [ISSUER_KEY],
      now_iso: '2026-06-11T00:01:00.000Z',
      verifyDetachedJws: () => false,
    })).toMatchObject({
      valid: false,
      refusal_code: 'detached_jws_verification_failed',
    });
  });

  it('refuses issuance beyond the pinned artifact TTL', () => {
    expect(() => issuePriceArtifact({
      expires_at: '2026-06-11T00:05:01.000Z',
    })).toThrow(/TTL/);
  });

  it('documents internal-only C6W2 authority behavior and non-enablement posture', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');

    for (const heading of [
      'Scope',
      'Internal Issue Helper',
      'Internal Verify And Status Helper',
      'What This Does Not Enable',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    expect(doc).toContain('canonical JSON payload hash');
    expect(doc).toContain('detached JWS signature');
    expect(doc).toContain('No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live provider, merchant private API, allowlist, cloud, or protocol publication behavior is added');
  });
});
