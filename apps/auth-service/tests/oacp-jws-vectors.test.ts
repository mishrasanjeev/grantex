// SPDX-License-Identifier: Apache-2.0
/**
 * The shared OACP artifact JWS profile v1 vectors
 * (spec/examples/oacp/oacp-artifact-jws-v1.json). Every verifier must refuse
 * each case with exactly the `expect` code; these run the auth service's own
 * verifier and signer against them. The vector key is synthetic and is used
 * here only.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_JWS_TYP,
  oacpSignedEnvelopeText,
  signOacpEnvelope,
  verifyOacpArtifact,
  verifyOacpArtifactSignature,
  type OacpSigningKey,
} from '../src/lib/commerce/oacp-jws.js';

interface VectorCase {
  name: string;
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
  expect: string;
}

const VECTORS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../spec/examples/oacp/oacp-artifact-jws-v1.json'),
  'utf8',
)) as {
  profile: string;
  verify_at: string;
  jwks: { keys: Array<Record<string, unknown>> };
  test_private_jwk: Record<string, unknown>;
  signing_payload_canonical: string;
  cases: VectorCase[];
};

const valid = VECTORS.cases.find((entry) => entry.name === 'valid')!;

function vectorSigner(): OacpSigningKey {
  const { kid, alg: _alg, use: _use, ...jwk } = VECTORS.test_private_jwk;
  return {
    kid: kid as string,
    privateKey: createPrivateKey({ key: jwk as never, format: 'jwk' }),
    publicJwk: VECTORS.jwks.keys[0]!,
  };
}

describe('OACP artifact JWS profile v1 vectors', () => {
  it('is the profile this verifier implements', () => {
    expect(VECTORS.profile).toBe('oacp-artifact-jws-v1');
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(11);
  });

  it.each(VECTORS.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const result = verifyOacpArtifact({
      envelope: entry.envelope,
      payload: entry.payload,
      jwks: VECTORS.jwks,
      now_iso: VECTORS.verify_at,
      status: 0,
    });
    if (entry.expect === 'valid') {
      expect(result).toMatchObject({ valid: true, artifact_id: entry.envelope['artifact_id'] });
    } else {
      expect(result).toMatchObject({ valid: false, refusal_code: entry.expect });
    }
  });

  it('signs the RFC 8785 envelope without its signature, as the vectors pin', () => {
    expect(oacpSignedEnvelopeText(valid.envelope)).toBe(VECTORS.signing_payload_canonical);
    const header = JSON.parse(Buffer.from(String(valid.envelope['signature']).split('.')[0]!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: valid.envelope['issuer_key_id'], typ: OACP_JWS_TYP });
  });

  it('produces signatures the vector JWKS verifies', () => {
    const { signature: _old, ...unsigned } = valid.envelope;
    const signature = signOacpEnvelope(unsigned, vectorSigner());
    expect(signature).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]{86}$/);
    expect(verifyOacpArtifactSignature({ envelope: { ...unsigned, signature }, payload: valid.payload, jwks: VECTORS.jwks })).toBeNull();
  });

  it('refuses keys that are not single, usable ES256 P-256 signing keys', () => {
    const kid = valid.envelope['issuer_key_id'];
    const good = VECTORS.jwks.keys[0]!;
    const verify = (keys: unknown[]) => verifyOacpArtifactSignature({ envelope: valid.envelope, payload: valid.payload, jwks: { keys } });
    expect(verify([good])).toBeNull();
    expect(verify([{ ...good, use: undefined, alg: undefined }].map(({ use: _u, alg: _a, ...rest }) => rest))).toBeNull();
    expect(verify([good, good])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    expect(verify([{ ...good, use: 'enc' }])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    expect(verify([{ ...good, alg: 'ES384' }])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    expect(verify([{ ...good, crv: 'P-384' }])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    expect(verify([{ ...good, x: String(good['x']).slice(2) }])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    expect(verify([])).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
    expect(verify([{ ...other, kid, alg: 'ES256', use: 'sig' }])).toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
  });

  it('refuses a signature algorithm other than ES256 before anything else is trusted', () => {
    expect(verifyOacpArtifact({
      envelope: { ...valid.envelope, signature_alg: 'none' },
      payload: valid.payload,
      jwks: VECTORS.jwks,
      now_iso: VECTORS.verify_at,
      status: 0,
    })).toMatchObject({ refusal_code: 'signature_algorithm_unsupported' });
  });

  it('applies freshness, scope and status after the signature verifies', () => {
    const base = { envelope: valid.envelope, payload: valid.payload, jwks: VECTORS.jwks, now_iso: VECTORS.verify_at };
    expect(verifyOacpArtifact({ ...base, status: 1 })).toMatchObject({ refusal_code: 'artifact_revoked' });
    expect(verifyOacpArtifact({ ...base, status: 2 })).toMatchObject({ refusal_code: 'artifact_suspended' });
    expect(verifyOacpArtifact({ ...base, status: 'unavailable' })).toMatchObject({ refusal_code: 'revocation_status_unavailable' });
    expect(verifyOacpArtifact({ ...base, status: 3 })).toMatchObject({ refusal_code: 'revocation_status_unavailable' });
    expect(verifyOacpArtifact({ ...base, now_iso: '2026-10-19T16:00:01.000Z', status: 0 }))
      .toMatchObject({ refusal_code: 'artifact_expired_or_stale' });
    expect(verifyOacpArtifact({ ...base, now_iso: '2026-10-19T09:58:00.000Z', status: 0 }))
      .toMatchObject({ refusal_code: 'artifact_not_yet_valid' });
    expect(verifyOacpArtifact({
      ...base,
      status: 0,
      expected_scope: { tenant_id: 'cten_TEST01', merchant_id: 'mch_OTHER', seller_agent_id: 'seller_TEST01', buyer_agent_id: '' },
    })).toMatchObject({ refusal_code: 'artifact_scope_mismatch' });
    expect(verifyOacpArtifact({
      ...base,
      status: 0,
      expected_scope: { tenant_id: 'cten_TEST01', merchant_id: 'mch_TEST01', seller_agent_id: 'seller_TEST01', buyer_agent_id: '' },
    })).toMatchObject({ valid: true });
  });
});
