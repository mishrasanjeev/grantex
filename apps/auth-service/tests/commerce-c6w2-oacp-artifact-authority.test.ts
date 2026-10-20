// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * OACP artifact issuance and verification with a real ES256 key: the signer
 * produces a detached JWS over the whole RFC 8785 envelope and the verifier
 * checks it against a JWKS before anything else is trusted. Replaces the
 * template-string signer and string-equality verifier (G1).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issueOacpArtifact,
  verifyOacpArtifact,
  type OacpSigningKey,
} from '../src/lib/commerce/oacp-jws.js';
import { hashOacpPayload, type OacpArtifactSafety } from '../src/lib/commerce/oacp-trust-artifacts.js';

const NOW = '2026-06-11T00:00:00.000Z';
const STATUS = { uri: 'https://issuer.example/status/oacp/oacpl_01J0000000000000000000000A', idx: 42 };
const SCOPE = { tenant_id: 'cten_C6W2', merchant_id: 'mch_C6W2', seller_agent_id: 'seller_C6W2', buyer_agent_id: 'buyer_C6W2' };

const safety: OacpArtifactSafety = {
  public_safe: true,
  contains_private_data: false,
  allowed_agent_uses: ['browse', 'compare'],
  forbidden_agent_uses: ['payment_capture'],
  commitment_allowed: false,
  offline_commitment_allowed: false,
  requires_online_confirmation: true,
  requires_provider_direct_verification: false,
  requires_merchant_system_confirmation: true,
  stale_behavior: 'refuse_final_commitment',
  refusal_code_if_invalid: 'artifact_invalid',
};

const payload = { product_id: 'prod_1', variant_id: 'var_1', amount_minor_units: 99900, currency: 'INR', price_source: 'redacted', price_valid_until: '2026-06-11T00:05:00.000Z' };

function newSigner(kid = 'oacp-20260611-0123456789abcdef'): OacpSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } };
}

function issue(signer: OacpSigningKey, overrides: Partial<Parameters<typeof issueOacpArtifact>[0]> = {}) {
  return issueOacpArtifact({
    artifact_id: 'oacp_art_01J0000000000000000000C6W2',
    artifact_type: 'price',
    issuer: 'https://issuer.example',
    signer,
    subject_type: 'price',
    subject_id: 'prod_1:var_1',
    ...SCOPE,
    issued_at: NOW,
    expires_at: '2026-06-11T00:05:00.000Z',
    source_observed_at: NOW,
    policy_version: 'policy_C6W2',
    status_list: STATUS,
    payload,
    safety,
    ...overrides,
  });
}

describe('OACP artifact authority (ES256 detached JWS)', () => {
  const signer = newSigner();
  const jwks = { keys: [signer.publicJwk] };

  it('issues envelopes carrying the payload hash, status list entry and a detached JWS', () => {
    const envelope = issue(signer);
    expect(envelope).toMatchObject({
      schema_version: 'oacp.artifact.v1',
      issuer_key_id: signer.kid,
      signature_alg: 'ES256',
      payload_hash: hashOacpPayload(payload),
      revocation_status_url: STATUS.uri,
      status: { status_list: STATUS },
    });
    const [header, middle, signature] = envelope.signature.split('.');
    expect(middle).toBe('');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'ES256', kid: signer.kid, typ: 'oacp-artifact+jws' });
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });

  it('verifies a valid artifact against the published key', () => {
    const envelope = issue(signer);
    expect(verifyOacpArtifact({ envelope, payload, jwks, now_iso: '2026-06-11T00:01:00.000Z', status: 0, expected_scope: SCOPE }))
      .toMatchObject({ valid: true, artifact_id: envelope.artifact_id, payload_hash: envelope.payload_hash });
  });

  it('refuses a tampered payload and a tampered envelope', () => {
    const envelope = issue(signer);
    const at = { jwks, now_iso: '2026-06-11T00:01:00.000Z', status: 0 as const };
    expect(verifyOacpArtifact({ ...at, envelope, payload: { ...payload, amount_minor_units: 1 } }))
      .toMatchObject({ refusal_code: 'payload_hash_mismatch' });
    const forged = { ...payload, amount_minor_units: 1 };
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, payload_hash: hashOacpPayload(forged) }, payload: forged }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, expires_at: '2026-06-11T00:04:59.000Z' }, payload }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, status: { status_list: { ...STATUS, idx: 43 } } }, payload }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, safety: { ...envelope.safety, commitment_allowed: true } }, payload }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
  });

  it('refuses the former template signature and a placeholder', () => {
    const envelope = issue(signer);
    const at = { payload, jwks, now_iso: '2026-06-11T00:01:00.000Z', status: 0 as const };
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, signature: `eyJhbGciOiJFUzI1NiJ9..sig_${envelope.artifact_id}_${envelope.payload_hash.slice(0, 16)}` } }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
    expect(verifyOacpArtifact({ ...at, envelope: { ...envelope, signature: 'detached_jws_required_before_publication' } }))
      .toMatchObject({ refusal_code: 'signature_missing_or_placeholder' });
  });

  it('refuses a key that is not published, and a key that signs under another kid', () => {
    const envelope = issue(signer);
    const at = { envelope, payload, now_iso: '2026-06-11T00:01:00.000Z', status: 0 as const };
    expect(verifyOacpArtifact({ ...at, jwks: { keys: [] } })).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    const impostor = newSigner(signer.kid);
    expect(verifyOacpArtifact({ ...at, jwks: { keys: [impostor.publicJwk] } }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
  });

  it('refuses expired, revoked, suspended and out-of-scope artifacts after the signature verifies', () => {
    const envelope = issue(signer);
    const at = { envelope, payload, jwks };
    expect(verifyOacpArtifact({ ...at, now_iso: '2026-06-11T00:05:01.000Z', status: 0 })).toMatchObject({ refusal_code: 'artifact_expired_or_stale' });
    expect(verifyOacpArtifact({ ...at, now_iso: '2026-06-11T00:01:00.000Z', status: 1 })).toMatchObject({ refusal_code: 'artifact_revoked' });
    expect(verifyOacpArtifact({ ...at, now_iso: '2026-06-11T00:01:00.000Z', status: 2 })).toMatchObject({ refusal_code: 'artifact_suspended' });
    expect(verifyOacpArtifact({ ...at, now_iso: '2026-06-11T00:01:00.000Z', status: 0, expected_scope: { ...SCOPE, buyer_agent_id: 'other' } }))
      .toMatchObject({ refusal_code: 'artifact_scope_mismatch' });
  });

  it('refuses to issue beyond the pinned TTL, with a non-OACP kid, or with a non-https status list', () => {
    expect(() => issue(signer, { expires_at: '2026-06-11T01:00:00.000Z' })).toThrow(/TTL/);
    expect(() => issue(newSigner('kid_c6z_internal_demo'))).toThrow(/oacp-/);
    expect(() => issue(signer, { status_list: { uri: 'internal:oacp:c6z:revocation:t:m', idx: 1 } })).toThrow(/https/);
  });
});
