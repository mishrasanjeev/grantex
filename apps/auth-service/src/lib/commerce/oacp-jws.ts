// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * OACP artifact JWS profile v1: signing and verifying OACP artifacts.
 *
 * - `envelope.signature` is a detached compact JWS (RFC 7515 Appendix F):
 *   `BASE64URL(header) + ".." + BASE64URL(signature)`.
 * - The protected header is exactly `{"alg":"ES256","kid":<issuer_key_id>,
 *   "typ":"oacp-artifact+jws"}`.
 * - The JWS Signing Input (RFC 7515 §5.1) is `BASE64URL(header) + "." +
 *   BASE64URL(JCS(envelope without "signature"))`, JCS being RFC 8785 after
 *   absent members are removed. The whole envelope is signed (scope, expiry,
 *   payload_hash, status, safety), not only the payload hash.
 * - ES256 (RFC 7518 §3.4): ECDSA P-256 with SHA-256, the signature being the
 *   64-byte r || s.
 *
 * Verification runs in a fixed order with a fixed refusal code per step, so
 * every verifier (this one, the SDKs, AgenticOrg) refuses a given artifact
 * with the same code; the shared vectors in
 * `spec/examples/oacp/oacp-artifact-jws-v1.json` pin steps 1-6.
 *
 *   1. well-formed detached JWS            signature_missing_or_placeholder
 *   2. signature_alg is ES256              signature_algorithm_unsupported
 *   3. payload hash recomputes             payload_hash_mismatch
 *   4. header exactly alg/kid/typ, kid ==
 *      issuer_key_id                       detached_jws_verification_failed
 *   5. exactly one usable JWK with the kid issuer_key_untrusted
 *   6. ECDSA verification                  detached_jws_verification_failed
 *   7. safety, timestamps, TTL, scope      artifact_* codes
 *   8. Token Status List status            artifact_revoked / artifact_suspended /
 *                                          revocation_status_unavailable
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { sha256hex } from '../hash.js';
import {
  OACP_ARTIFACT_SIGNATURE_PROFILE,
  OACP_ARTIFACT_TTLS_SECONDS,
  assertNoForbiddenOacpArtifactFields,
  buildOacpArtifactCacheKey,
  buildUnsignedOacpArtifactEnvelope,
  canonicalizeOacpPayload,
  type OacpArtifactAuthorityStatus,
  type OacpArtifactEnvelope,
  type OacpArtifactSafety,
  type OacpArtifactScope,
  type OacpArtifactType,
  type OacpArtifactVerificationRefusalCode,
} from './oacp-trust-artifacts.js';

/** `typ` of the protected header (RFC 7515 §4.1.9). */
export const OACP_JWS_TYP = 'oacp-artifact+jws';
/** Every OACP issuer key id starts with this, which keeps it apart in the shared JWKS. */
export const OACP_KID_PREFIX = 'oacp-';
/** Clock skew tolerated on `issued_at` and `not_before`. */
export const OACP_CLOCK_SKEW_SECONDS = 60;

/** localhost, 127.0.0.0/8 or ::1, as the SDK verifiers' `isLoopbackHost`. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Local development only: `OACP_ALLOW_LOOPBACK_HTTP=true` lets a service whose
 * PUBLIC_BASE_URL is `http://localhost:<port>` (or 127.0.0.0/8, ::1) issue and
 * self-verify artifacts naming an http status list on that loopback host, so
 * the conformance suite and the SDK verifiers (`allowLoopbackHttp`) can run
 * against a local stack. Ignored when NODE_ENV is production; off by default.
 */
export function oacpLoopbackHttpAllowed(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return process.env['OACP_ALLOW_LOOPBACK_HTTP'] === 'true';
}

/** An https status list URI, or an http one on a loopback host when allowed. */
export function isOacpStatusUriAllowed(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return uri.startsWith('https://');
  return url.protocol === 'http:' && uri.startsWith('http://')
    && oacpLoopbackHttpAllowed() && isLoopbackHostname(url.hostname);
}

/** A private key that signs OACP artifacts, with its published JWK. */
export interface OacpSigningKey {
  kid: string;
  privateKey: KeyObject;
  /** `{kty, crv, x, y, kid, alg, use}` as published in the JWKS. */
  publicJwk: Record<string, unknown>;
}

export interface OacpJwks {
  keys: readonly unknown[];
}

const B64URL = /^[A-Za-z0-9_-]+$/;

const b64url = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');

/** Strict base64url: unpadded and exactly the canonical encoding, else null. */
function b64urlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  return b64url(raw) === text ? raw : null;
}

function refusal(
  artifactId: string | null,
  code: OacpArtifactVerificationRefusalCode,
  message: string,
): OacpArtifactAuthorityStatus {
  return { valid: false, status: 'refused', artifact_id: artifactId, refusal_code: code, message };
}

function parseMillis(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The protected header every OACP artifact signature uses, base64url-encoded. */
export function oacpProtectedHeader(kid: string): string {
  return b64url(JSON.stringify({ alg: 'ES256', kid, typ: OACP_JWS_TYP }));
}

/** RFC 8785 text of the envelope without its `signature` member: what is signed. */
export function oacpSignedEnvelopeText(envelope: Record<string, unknown>): string {
  const { signature: _signature, ...unsigned } = envelope;
  return canonicalizeOacpPayload(unsigned);
}

/** The JWS Signing Input (RFC 7515 §5.1) for a header and an envelope. */
export function oacpSigningInput(headerB64: string, envelope: Record<string, unknown>): Buffer {
  return Buffer.from(`${headerB64}.${b64url(oacpSignedEnvelopeText(envelope))}`, 'ascii');
}

/** Sign an envelope; returns the detached compact JWS for `envelope.signature`. */
export function signOacpEnvelope(envelope: Record<string, unknown>, signer: OacpSigningKey): string {
  if (!signer.kid.startsWith(OACP_KID_PREFIX)) throw new Error('OACP issuer key ids start with oacp-');
  if (envelope['issuer_key_id'] !== signer.kid) throw new Error('envelope issuer_key_id must be the signing key id');
  const details = signer.privateKey.asymmetricKeyDetails ?? {};
  if (signer.privateKey.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
    throw new Error('OACP artifacts are signed with ES256 (P-256) keys only');
  }
  const headerB64 = oacpProtectedHeader(signer.kid);
  const signature = cryptoSign('sha256', oacpSigningInput(headerB64, envelope), {
    key: signer.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}..${b64url(signature)}`;
}

/**
 * The public key of the one usable JWK for `kid`, or null (step 5). Shared
 * with the OACP mandate verifier (oacp-mandate-jwt.ts), whose keys are the
 * same `oacp-` issuer keys.
 */
export function oacpTrustedKey(jwks: OacpJwks | null | undefined, kid: string): KeyObject | null {
  if (!kid.startsWith(OACP_KID_PREFIX)) return null;
  const keys = jwks && Array.isArray(jwks.keys) ? jwks.keys : [];
  const matching = keys.filter((key) => isRecord(key) && key['kid'] === kid);
  if (matching.length !== 1) return null;
  const jwk = matching[0] as Record<string, unknown>;
  // RFC 7517 §4.2, §4.4: an absent `use` or `alg` does not restrict the key;
  // a present one must allow ES256 signatures.
  const use = 'use' in jwk ? jwk['use'] : 'sig';
  const alg = 'alg' in jwk ? jwk['alg'] : 'ES256';
  if (use !== 'sig' || alg !== 'ES256' || jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return null;
  const x = typeof jwk['x'] === 'string' ? b64urlDecode(jwk['x']) : null;
  const y = typeof jwk['y'] === 'string' ? b64urlDecode(jwk['y']) : null;
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  try {
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Steps 1-6: the detached JWS over the envelope, checked against a JWKS.
 * Null when the signature verifies, else the refusal.
 */
export function verifyOacpArtifactSignature(input: {
  envelope: unknown;
  payload: unknown;
  jwks: OacpJwks | null | undefined;
}): OacpArtifactAuthorityStatus | null {
  if (!isRecord(input.envelope)) {
    return refusal(null, 'artifact_missing_or_invalid', 'Artifact envelope must be an object.');
  }
  const envelope = input.envelope;
  const artifactId = typeof envelope['artifact_id'] === 'string' && envelope['artifact_id'] ? envelope['artifact_id'] : null;

  // 1. A detached compact JWS: exactly three parts, the middle one empty.
  const signature = envelope['signature'];
  const parts = typeof signature === 'string' ? signature.split('.') : [];
  if (parts.length !== 3 || parts[1] !== '' || !B64URL.test(parts[0]!) || !B64URL.test(parts[2]!)) {
    return refusal(artifactId, 'signature_missing_or_placeholder', 'Artifact signature is not a detached JWS.');
  }
  const [headerB64, , signatureB64] = parts as [string, string, string];

  // 2.
  if (envelope['signature_alg'] !== OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm) {
    return refusal(artifactId, 'signature_algorithm_unsupported', 'Artifact signature algorithm is unsupported.');
  }

  // 3.
  let payloadHash: string;
  try {
    payloadHash = sha256hex(canonicalizeOacpPayload(input.payload));
  } catch {
    return refusal(artifactId, 'artifact_missing_or_invalid', 'Artifact payload has no canonical JSON form.');
  }
  if (payloadHash !== envelope['payload_hash']) {
    return refusal(artifactId, 'payload_hash_mismatch', 'Artifact payload hash does not match payload.');
  }

  // 4. Exactly alg, kid and typ; kid names the envelope's issuer key.
  const headerRaw = b64urlDecode(headerB64);
  let header: unknown = null;
  if (headerRaw) {
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerRaw));
    } catch {
      header = null;
    }
  }
  if (
    !isRecord(header)
    || Object.keys(header).length !== 3
    || header['alg'] !== 'ES256'
    || header['typ'] !== OACP_JWS_TYP
    || typeof header['kid'] !== 'string'
    || header['kid'] !== envelope['issuer_key_id']
  ) {
    return refusal(artifactId, 'detached_jws_verification_failed', 'JWS header must be exactly alg ES256, the issuer key id and typ oacp-artifact+jws.');
  }

  // 5.
  const key = oacpTrustedKey(input.jwks, header['kid']);
  if (!key) {
    return refusal(artifactId, 'issuer_key_untrusted', 'No single usable ES256 key with this kid is published.');
  }

  // 6.
  let envelopeText: Buffer;
  try {
    envelopeText = oacpSigningInput(headerB64, envelope);
  } catch {
    return refusal(artifactId, 'artifact_missing_or_invalid', 'Artifact envelope has no canonical JSON form.');
  }
  const signatureRaw = b64urlDecode(signatureB64);
  const ok = signatureRaw !== null
    && signatureRaw.length === 64
    && cryptoVerify('sha256', envelopeText, { key, dsaEncoding: 'ieee-p1363' }, signatureRaw);
  if (!ok) {
    return refusal(artifactId, 'detached_jws_verification_failed', 'Detached JWS verification failed.');
  }
  return null;
}

/**
 * The status the caller read for this artifact from its Token Status List
 * (draft-ietf-oauth-status-list §7.1: 0 VALID, 1 INVALID, 2 SUSPENDED), or
 * 'unavailable' when the list could not be fetched or verified.
 */
export type OacpStatusValue = number | 'unavailable';

/** Steps 1-8. */
export function verifyOacpArtifact(input: {
  envelope: unknown;
  payload: unknown;
  jwks: OacpJwks | null | undefined;
  now_iso: string;
  status: OacpStatusValue;
  expected_scope?: OacpArtifactScope | undefined;
}): OacpArtifactAuthorityStatus {
  const signatureRefusal = verifyOacpArtifactSignature(input);
  if (signatureRefusal) return signatureRefusal;
  const envelope = input.envelope as unknown as OacpArtifactEnvelope;
  const artifactId = envelope.artifact_id || null;

  // 7. What the signed envelope says about itself.
  try {
    assertNoForbiddenOacpArtifactFields(input.payload);
  } catch {
    return refusal(artifactId, 'artifact_missing_or_invalid', 'Payload contains private or enabling fields.');
  }
  if (!isRecord(envelope.safety) || envelope.safety.public_safe !== true || envelope.safety.contains_private_data !== false) {
    return refusal(artifactId, 'artifact_missing_or_invalid', 'Artifact safety metadata is not public-safe.');
  }
  const nowMillis = parseMillis(input.now_iso);
  const issuedMillis = parseMillis(envelope.issued_at);
  const expiresMillis = parseMillis(envelope.expires_at);
  const notBeforeMillis = parseMillis(envelope.not_before);
  if (nowMillis === null || issuedMillis === null || expiresMillis === null) {
    return refusal(artifactId, 'artifact_missing_or_invalid', 'Artifact contains invalid timestamps.');
  }
  const skew = OACP_CLOCK_SKEW_SECONDS * 1000;
  if (nowMillis + skew < issuedMillis || (notBeforeMillis !== null && nowMillis + skew < notBeforeMillis)) {
    return refusal(artifactId, 'artifact_not_yet_valid', 'Artifact is not yet valid.');
  }
  if (nowMillis > expiresMillis) {
    return refusal(artifactId, 'artifact_expired_or_stale', 'Artifact has expired.');
  }
  const defaultTtl = (OACP_ARTIFACT_TTLS_SECONDS as Record<string, number | undefined>)[envelope.artifact_type];
  const actualTtl = Math.floor((expiresMillis - issuedMillis) / 1000);
  if (defaultTtl === undefined || actualTtl < 0 || actualTtl > defaultTtl) {
    return refusal(artifactId, 'artifact_ttl_exceeds_default', 'Artifact TTL exceeds the pinned default.');
  }
  const expected = input.expected_scope;
  if (expected && (
    envelope.tenant_id !== expected.tenant_id
    || envelope.merchant_id !== expected.merchant_id
    || envelope.seller_agent_id !== expected.seller_agent_id
    || (envelope.buyer_agent_id ?? '') !== expected.buyer_agent_id
  )) {
    return refusal(artifactId, 'artifact_scope_mismatch', 'Artifact is outside the expected tenant/merchant/agent scope.');
  }

  // 8. Token Status List.
  const reference = isRecord(envelope.status) && isRecord(envelope.status.status_list) ? envelope.status.status_list : null;
  const uri = reference?.['uri'];
  const idx = reference?.['idx'];
  if (
    !isOacpStatusUriAllowed(uri)
    || typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0
    || envelope.revocation_status_url !== uri
  ) {
    return refusal(artifactId, 'revocation_status_unavailable', 'Artifact does not name an https status list entry.');
  }
  if (input.status === 1) return refusal(artifactId, 'artifact_revoked', 'Artifact is revoked.');
  if (input.status === 2) return refusal(artifactId, 'artifact_suspended', 'Artifact is suspended.');
  if (input.status !== 0) {
    return refusal(artifactId, 'revocation_status_unavailable', 'Artifact status could not be established.');
  }

  return {
    valid: true,
    status: 'valid',
    artifact_id: envelope.artifact_id,
    artifact_type: envelope.artifact_type,
    cache_key: envelope.tenant_id && envelope.merchant_id && envelope.seller_agent_id && envelope.buyer_agent_id
      ? buildOacpArtifactCacheKey({
        tenant_id: envelope.tenant_id,
        merchant_id: envelope.merchant_id,
        seller_agent_id: envelope.seller_agent_id,
        buyer_agent_id: envelope.buyer_agent_id,
        artifact_type: envelope.artifact_type,
        artifact_id: envelope.artifact_id,
        schema_version: envelope.schema_version,
        policy_version: envelope.policy_version,
      })
      : null,
    payload_hash: envelope.payload_hash,
    expires_at: envelope.expires_at,
  };
}

/**
 * Build, sign and self-check one artifact. Throws when the inputs cannot make
 * a valid artifact: a TTL above the pinned default, private or enabling
 * payload fields, a key that is not an OACP key, or a status list that is not
 * https.
 */
export function issueOacpArtifact(input: {
  artifact_id: string;
  artifact_type: OacpArtifactType;
  issuer: string;
  signer: OacpSigningKey;
  subject_type: string;
  subject_id: string;
  tenant_id?: string | undefined;
  merchant_id?: string | undefined;
  buyer_agent_id?: string | undefined;
  seller_agent_id?: string | undefined;
  issued_at: string;
  expires_at: string;
  source_observed_at?: string | undefined;
  policy_version: string;
  status_list: { idx: number; uri: string };
  evidence_refs?: string[] | undefined;
  payload: unknown;
  safety: OacpArtifactSafety;
}): OacpArtifactEnvelope {
  if (!isOacpStatusUriAllowed(input.status_list.uri)) {
    throw new Error('OACP status list URIs must be https');
  }
  const issuedMillis = parseMillis(input.issued_at);
  const expiresMillis = parseMillis(input.expires_at);
  if (
    issuedMillis === null
    || expiresMillis === null
    || expiresMillis < issuedMillis
    || Math.floor((expiresMillis - issuedMillis) / 1000) > OACP_ARTIFACT_TTLS_SECONDS[input.artifact_type]
  ) {
    throw new Error('OACP artifact TTL must be valid and no longer than the pinned default');
  }
  const unsigned = buildUnsignedOacpArtifactEnvelope({
    ...input,
    issuer_key_id: input.signer.kid,
  });
  const { signature: _placeholder, ...body } = unsigned;
  const signature = signOacpEnvelope(body as Record<string, unknown>, input.signer);
  return { ...body, signature } as OacpArtifactEnvelope;
}
