// Generates shared OACP artifact JWS v1 test vectors (synthetic test key only).
// Usage: node gen.mjs <path-to-canonical.ts> <out.json>
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , canonicalPath, outPath] = process.argv;
const { canonicalize } = await import(pathToFileURL(canonicalPath).href);

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const kid = 'oacp-test-2026-10-a';
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const jwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' };

const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherPub = other.publicKey.export({ format: 'jwk' });
const otherJwk = { kty: 'EC', crv: 'P-256', x: otherPub.x, y: otherPub.y, kid: 'oacp-test-2026-10-b', alg: 'ES256', use: 'sig' };

const TYP = 'oacp-artifact+jws';
const statusUri = 'https://issuer.example/status/oacp/lst_01TEST';

function signEnvelope(envelope, key = privateKey, headerKid = kid, typ = TYP) {
  const { signature: _drop, ...unsigned } = envelope;
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: headerKid, typ }));
  const payload = canonicalize(unsigned);
  const input = `${header}.${b64u(payload)}`;
  const sig = sign('sha256', Buffer.from(input, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return { signature: `${header}..${b64u(sig)}`, signing_payload: payload };
}

const payload = {
  artifact_family: 'catalog_snapshot',
  tenant_id: 'cten_TEST01',
  merchant_id: 'mch_TEST01',
  seller_agent_id: 'seller_TEST01',
  source_system: 'shopify',
  source_evidence_ref: 'shopify:evidence:redacted:01',
  source_observed_at: '2026-10-19T10:00:00.000Z',
  product_count: 12,
  variant_count: 30,
  catalog_sample_refs: ['sku:A-1', 'sku:B_2', 'sku:a3', 'sku:Z'],
  // Member names chosen so locale ordering and code-point ordering differ.
  Zeta_upper: 'upper case sorts before lower case under RFC 8785',
  a_b: 1,
  ab: 2,
  'é_accent': 'non-ASCII member name',
  allowed_to_execute: false,
  no_payment_execution: true,
  no_public_discovery_enablement: true,
  non_authoritative_for_transaction: true,
};
const payloadCanonical = canonicalize(payload);
const payloadHash = sha(payloadCanonical);

const envelope = {
  artifact_id: 'oacp_art_01TESTCATALOG',
  artifact_type: 'catalog_snapshot',
  schema_version: 'oacp.artifact.v1',
  issuer: 'https://issuer.example',
  issuer_key_id: kid,
  subject_type: 'catalog_snapshot',
  subject_id: 'mch_TEST01:seller_TEST01',
  tenant_id: 'cten_TEST01',
  merchant_id: 'mch_TEST01',
  seller_agent_id: 'seller_TEST01',
  buyer_agent_id: '',
  issued_at: '2026-10-19T10:00:00.000Z',
  expires_at: '2026-10-19T16:00:00.000Z',
  source_observed_at: '2026-10-19T10:00:00.000Z',
  freshness_class: 'fresh',
  revocation_status_url: statusUri,
  status: { status_list: { idx: 7, uri: statusUri } },
  policy_version: 'oacp-policy-test',
  evidence_refs: ['shopify:evidence:redacted:01'],
  payload_hash: payloadHash,
  signature_alg: 'ES256',
  safety: {
    public_safe: true,
    contains_private_data: false,
    allowed_agent_uses: ['browse', 'compare'],
    forbidden_agent_uses: ['checkout_payment_execution'],
    commitment_allowed: false,
    offline_commitment_allowed: false,
    requires_online_confirmation: true,
    requires_provider_direct_verification: false,
    requires_merchant_system_confirmation: false,
    stale_behavior: 'refuse_final_commitment',
    refusal_code_if_invalid: 'oacp_artifact_invalid',
  },
};
const good = signEnvelope(envelope);
const signed = { ...envelope, signature: good.signature };

const cases = [];
cases.push({ name: 'valid', envelope: signed, payload, expect: 'valid' });
cases.push({ name: 'tampered_payload', envelope: signed, payload: { ...payload, product_count: 13 }, expect: 'payload_hash_mismatch' });
// Payload hash recomputed by an attacker, envelope edited, old signature kept.
const tamperedPayload = { ...payload, product_count: 13 };
cases.push({ name: 'tampered_payload_and_hash', envelope: { ...signed, payload_hash: sha(canonicalize(tamperedPayload)) }, payload: tamperedPayload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'tampered_envelope_expiry', envelope: { ...signed, expires_at: '2026-10-19T16:30:00.000Z' }, payload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'tampered_envelope_scope', envelope: { ...signed, merchant_id: 'mch_OTHER' }, payload, expect: 'detached_jws_verification_failed' });
const otherSigned = signEnvelope({ ...envelope, issuer_key_id: 'oacp-test-2026-10-b' }, other.privateKey, 'oacp-test-2026-10-b');
cases.push({ name: 'unknown_kid', envelope: { ...envelope, issuer_key_id: 'oacp-test-2026-10-z', signature: signEnvelope({ ...envelope, issuer_key_id: 'oacp-test-2026-10-z' }, privateKey, 'oacp-test-2026-10-z').signature }, payload, expect: 'issuer_key_untrusted' });
cases.push({ name: 'signed_by_other_key_claiming_kid', envelope: { ...envelope, signature: signEnvelope(envelope, other.privateKey, kid).signature }, payload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'header_kid_mismatch', envelope: { ...envelope, issuer_key_id: kid, signature: otherSigned.signature }, payload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'wrong_typ', envelope: { ...envelope, signature: signEnvelope(envelope, privateKey, kid, 'JWT').signature }, payload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'legacy_template_signature', envelope: { ...envelope, signature: `eyJhbGciOiJFUzI1NiJ9..sig_${envelope.artifact_id}_${payloadHash.slice(0, 16)}` }, payload, expect: 'detached_jws_verification_failed' });
cases.push({ name: 'attached_payload_not_detached', envelope: { ...envelope, signature: good.signature.replace('..', `.${b64u(good.signing_payload)}.`) }, payload, expect: 'signature_missing_or_placeholder' });

const out = {
  profile: 'oacp-artifact-jws-v1',
  note: 'Synthetic test key generated for conformance vectors only. Never trust oacp-test-* kids outside tests.',
  verify_at: '2026-10-19T11:00:00.000Z',
  jwks: { keys: [jwk, otherJwk] },
  test_private_jwk: { ...priv, kid, alg: 'ES256', use: 'sig' },
  payload_canonical: payloadCanonical,
  payload_hash: payloadHash,
  signing_payload_canonical: good.signing_payload,
  status_list: { uri: statusUri, idx: 7, expected_status_at_issue: 0 },
  cases,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${cases.length} cases`);
