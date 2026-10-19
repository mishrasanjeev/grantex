/**
 * Relying-party verification of OACP artifacts (profile `oacp-artifact-jws-v1`).
 *
 * An OACP artifact is an envelope and a payload. The envelope carries
 * `payload_hash`, the lowercase hex SHA-256 of the RFC 8785 canonical payload,
 * and `signature`, a detached compact JWS (RFC 7515 Appendix F) whose
 * protected header is exactly `{"alg":"ES256","kid":<issuer_key_id>,
 * "typ":"oacp-artifact+jws"}` and whose payload is the RFC 8785 canonical
 * envelope without `signature`. Signing the whole envelope binds the scope,
 * expiry, status entry and safety block as well as the payload hash.
 *
 * `verifyOacpArtifact` runs the checks in a fixed order and stops at the
 * first failure, so every implementation (this SDK, `grantex.oacp` in Python,
 * `VerifyOacpArtifact` in Go, the auth service) refuses a given artifact with
 * the same code:
 *
 *  1. `signature` is a detached JWS: three base64url parts, empty middle
 *     (`signature_missing_or_placeholder`);
 *  2. `signature_alg` is ES256 (`signature_algorithm_unsupported`);
 *  3. the payload hashes to `payload_hash` (`payload_hash_mismatch`);
 *  4. the header is exactly alg/kid/typ with ES256, `oacp-artifact+jws` and
 *     `kid == issuer_key_id` (`detached_jws_verification_failed`);
 *  5. the envelope names the pinned issuer and the JWK Set holds exactly one
 *     usable P-256 key with that kid (`issuer_key_untrusted`);
 *  6. the ES256 signature verifies (`detached_jws_verification_failed`);
 *  7. artifact type, safety block, private fields, timestamps, TTL and scope
 *     (`artifact_missing_or_invalid`, `artifact_not_yet_valid`,
 *     `artifact_expired_or_stale`, `artifact_ttl_exceeds_default`,
 *     `artifact_scope_mismatch`);
 *  8. the Token Status List entry is VALID (`artifact_revoked`,
 *     `artifact_suspended`, or `revocation_status_unavailable` when the list
 *     cannot be fetched or verified: fail closed).
 *
 * Shared test vectors: `spec/examples/oacp/oacp-artifact-jws-v1.json`.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../canonical.js';
import {
  decodeBase64urlStrict,
  decodeJsonSegment,
  encodeBase64url,
  isBase64urlShaped,
  selectVerificationKey,
  verifyJwsSignature,
  type OacpJwks,
} from './jose.js';
import { OACP_TOKEN_STATUS, readOacpStatus } from './status-list.js';
import { isLoopbackHost, type OacpJwksSource, type OacpStatusListFetcher } from './fetchers.js';

export const OACP_ARTIFACT_JWS_TYP = 'oacp-artifact+jws';
export const OACP_SIGNATURE_ALG = 'ES256';
export const OACP_PROFILE = 'oacp-artifact-jws-v1';

/** Longest `signature` accepted, in characters. */
const MAX_SIGNATURE_LENGTH = 4096;

/** Every refusal code `verifyOacpArtifact` returns, in check order. */
export const OACP_REFUSAL_CODES = [
  'artifact_missing_or_invalid',
  'signature_missing_or_placeholder',
  'signature_algorithm_unsupported',
  'payload_hash_mismatch',
  'detached_jws_verification_failed',
  'issuer_key_untrusted',
  'artifact_not_yet_valid',
  'artifact_expired_or_stale',
  'artifact_ttl_exceeds_default',
  'artifact_scope_mismatch',
  'artifact_revoked',
  'artifact_suspended',
  'revocation_status_unavailable',
] as const;

export type OacpRefusalCode = typeof OACP_REFUSAL_CODES[number];

/**
 * The longest lifetime (`expires_at - issued_at`) each artifact type may
 * have, in seconds, as the auth service pins them.
 */
export const OACP_ARTIFACT_MAX_TTL_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  merchant_capability: 24 * 60 * 60,
  seller_agent_capability: 6 * 60 * 60,
  catalog_snapshot: 6 * 60 * 60,
  offer: 15 * 60,
  price: 5 * 60,
  inventory: 60,
  policy: 6 * 60 * 60,
  public_discovery: 15 * 60,
  mandate_capability: 2 * 60,
  commitment_evidence: 5 * 60,
  revocation: 0,
  protocol_adapter: 24 * 60 * 60,
});

/**
 * Payload member names that would carry private or enabling data, compared
 * after folding camelCase, hyphens and spaces to snake_case.
 */
export const OACP_FORBIDDEN_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'access_token', 'api_key', 'authorization', 'bank_account', 'card_number',
  'checkout_payment_enabled', 'credential', 'credentials', 'customer_identifier',
  'live_payment_enabled', 'live_provider_enabled', 'merchant_private_api_key',
  'merchant_private_api_url', 'password', 'private_key', 'production_allowlist',
  'public_discovery_enabled', 'raw_connector_payload', 'raw_jwt',
  'raw_provider_payload', 'secret', 'token', 'webhook_secret',
]);

/** The scope an artifact is expected to be bound to. Members left out are not compared. */
export interface OacpArtifactScope {
  tenant_id?: string;
  merchant_id?: string;
  seller_agent_id?: string;
  buyer_agent_id?: string;
}

export interface VerifyOacpArtifactOptions {
  /** The pinned issuer identifier; `envelope.issuer` must equal it. */
  issuer: string;
  /** The issuer's JWK Set, or a source bound to its pinned JWKS URI (`createOacpJwksFetcher`). */
  jwks: OacpJwksSource;
  /** The time to verify at. Default now. */
  now?: Date;
  /** Refuse an artifact outside this scope (`artifact_scope_mismatch`). */
  expectedScope?: OacpArtifactScope;
  /**
   * Fetches the Token Status List the envelope points at
   * (`createOacpStatusListFetcher`). Without one the artifact is refused
   * with `revocation_status_unavailable` unless `checkStatus` is false.
   */
  statusListFetcher?: OacpStatusListFetcher;
  /**
   * Set false only to verify signatures offline (test vectors, archives):
   * the result then says `status: 'not_checked'`. Default true.
   */
  checkStatus?: boolean;
  /** Overrides of `OACP_ARTIFACT_MAX_TTL_SECONDS` per artifact type. */
  maxTtlSeconds?: Readonly<Record<string, number>>;
  /** Accept an http status URI on a loopback host (local development only). Default false. */
  allowLoopbackHttp?: boolean;
}

export type OacpVerification =
  | {
    valid: true;
    artifactId: string;
    artifactType: string;
    issuerKeyId: string;
    payloadHash: string;
    expiresAt: string;
    /** `valid` after a Token Status List check, `not_checked` when `checkStatus` was false. */
    status: 'valid' | 'not_checked';
  }
  | {
    valid: false;
    artifactId: string | null;
    refusalCode: OacpRefusalCode;
    message: string;
  };

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch for an RFC 3339 date-time, or null. */
export function parseOacpTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  let millis = Date.UTC(Number(y), month - 1, day, Number(h), Number(mi), Number(s));
  if (new Date(millis).getUTCDate() !== day) return null;
  if (frac) millis += Math.floor(Number(`0${frac}`) * 1000);
  if (zone !== 'Z') {
    const sign = zone!.startsWith('-') ? -1 : 1;
    const [zh, zm] = zone!.slice(1).split(':').map(Number) as [number, number];
    if (zh > 23 || zm > 59) return null;
    millis -= sign * (zh * 60 + zm) * 60_000;
  }
  return millis;
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

function hasForbiddenField(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isPlainObject(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (OACP_FORBIDDEN_PAYLOAD_FIELDS.has(normalizeKey(key))) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function statusUriAllowed(uri: string, allowLoopbackHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

async function loadJwks(source: OacpJwksSource, refresh: boolean): Promise<OacpJwks> {
  return typeof source === 'function' ? source(refresh ? { refresh: true } : undefined) : source;
}

/** Verifies an OACP artifact. Never throws for a bad artifact: the result says why it is refused. */
export async function verifyOacpArtifact(
  envelope: unknown,
  payload: unknown,
  options: VerifyOacpArtifactOptions,
): Promise<OacpVerification> {
  const artifactId = isPlainObject(envelope) && typeof envelope['artifact_id'] === 'string' && envelope['artifact_id']
    ? envelope['artifact_id']
    : null;
  const refuse = (refusalCode: OacpRefusalCode, message: string): OacpVerification =>
    ({ valid: false, artifactId, refusalCode, message });

  if (!isPlainObject(envelope)) return refuse('artifact_missing_or_invalid', 'The envelope is not a JSON object.');
  if (!isPlainObject(payload)) return refuse('artifact_missing_or_invalid', 'The payload is not a JSON object.');

  // 1. A detached compact JWS: BASE64URL(header) || '..' || BASE64URL(signature).
  const signature = envelope['signature'];
  if (typeof signature !== 'string' || signature.length > MAX_SIGNATURE_LENGTH) {
    return refuse('signature_missing_or_placeholder', 'The artifact has no detached JWS signature.');
  }
  const parts = signature.split('.');
  if (
    parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]
    || !isBase64urlShaped(parts[0]) || !isBase64urlShaped(parts[2])
  ) {
    return refuse('signature_missing_or_placeholder', 'The signature is not a detached compact JWS.');
  }
  const [headerSegment, , signatureSegment] = parts as [string, string, string];

  // 2. The profile has one algorithm.
  if (envelope['signature_alg'] !== OACP_SIGNATURE_ALG) {
    return refuse('signature_algorithm_unsupported', 'The artifact signature algorithm is not ES256.');
  }

  // 3. The payload is the one the envelope commits to.
  let payloadHash: string;
  try {
    payloadHash = createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
  } catch {
    return refuse('artifact_missing_or_invalid', 'The payload has no RFC 8785 canonical form.');
  }
  if (payloadHash !== envelope['payload_hash']) {
    return refuse('payload_hash_mismatch', 'The payload does not hash to the envelope payload_hash.');
  }

  // 4. The protected header is exactly the profile's.
  const header = decodeJsonSegment(headerSegment);
  const issuerKeyId = envelope['issuer_key_id'];
  if (
    header === null
    || Object.keys(header).sort().join(',') !== 'alg,kid,typ'
    || header['alg'] !== OACP_SIGNATURE_ALG
    || header['typ'] !== OACP_ARTIFACT_JWS_TYP
    || typeof issuerKeyId !== 'string'
    || header['kid'] !== issuerKeyId
  ) {
    return refuse('detached_jws_verification_failed', 'The JWS protected header is not the OACP artifact header.');
  }

  // 5. The pinned issuer's key.
  if (envelope['issuer'] !== options.issuer) {
    return refuse('issuer_key_untrusted', 'The artifact names an issuer other than the pinned one.');
  }
  let jwks: OacpJwks;
  try {
    jwks = await loadJwks(options.jwks, false);
  } catch {
    return refuse('issuer_key_untrusted', 'The issuer JWK Set is unavailable.');
  }
  let key = selectVerificationKey(jwks, issuerKeyId, 'ES256');
  if (!key.ok && typeof options.jwks === 'function') {
    try {
      jwks = await loadJwks(options.jwks, true);
      key = selectVerificationKey(jwks, issuerKeyId, 'ES256');
    } catch {
      // keep the first answer
    }
  }
  if (!key.ok) return refuse('issuer_key_untrusted', `The issuer key is not trusted: ${key.reason}.`);

  // 6. ES256 over BASE64URL(header) || '.' || BASE64URL(JCS(envelope without signature)).
  const { signature: _signature, ...unsigned } = envelope;
  let signingInput: string;
  try {
    signingInput = `${headerSegment}.${encodeBase64url(canonicalize(unsigned))}`;
  } catch {
    return refuse('detached_jws_verification_failed', 'The envelope has no RFC 8785 canonical form.');
  }
  const signatureBytes = decodeBase64urlStrict(signatureSegment);
  if (signatureBytes === null || !verifyJwsSignature('ES256', key.key, signingInput, signatureBytes)) {
    return refuse('detached_jws_verification_failed', 'The detached JWS does not verify.');
  }

  // 7. Type, safety, private fields, time, TTL and scope.
  const artifactType = envelope['artifact_type'];
  const maxTtl = typeof artifactType === 'string'
    ? (options.maxTtlSeconds?.[artifactType] ?? OACP_ARTIFACT_MAX_TTL_SECONDS[artifactType])
    : undefined;
  if (typeof artifactType !== 'string' || maxTtl === undefined || artifactId === null) {
    return refuse('artifact_missing_or_invalid', 'The artifact type or id is missing or unknown.');
  }
  const safety = envelope['safety'];
  if (!isPlainObject(safety) || safety['public_safe'] !== true || safety['contains_private_data'] !== false) {
    return refuse('artifact_missing_or_invalid', 'The artifact safety metadata is not public-safe.');
  }
  if (hasForbiddenField(payload)) {
    return refuse('artifact_missing_or_invalid', 'The payload contains private or enabling fields.');
  }
  const now = (options.now ?? new Date()).getTime();
  const issuedAt = parseOacpTimestamp(envelope['issued_at']);
  const expiresAt = parseOacpTimestamp(envelope['expires_at']);
  const notBefore = envelope['not_before'] === undefined ? null : parseOacpTimestamp(envelope['not_before']);
  if (issuedAt === null || expiresAt === null || (envelope['not_before'] !== undefined && notBefore === null)) {
    return refuse('artifact_missing_or_invalid', 'The artifact timestamps are invalid.');
  }
  if (notBefore !== null && now < notBefore) {
    return refuse('artifact_not_yet_valid', 'The artifact is not yet valid.');
  }
  if (now > expiresAt) return refuse('artifact_expired_or_stale', 'The artifact has expired.');
  const ttlSeconds = Math.floor((expiresAt - issuedAt) / 1000);
  if (ttlSeconds < 0 || ttlSeconds > maxTtl) {
    return refuse('artifact_ttl_exceeds_default', 'The artifact lifetime exceeds the pinned default.');
  }
  const scope = options.expectedScope;
  if (scope) {
    for (const member of ['tenant_id', 'merchant_id', 'seller_agent_id', 'buyer_agent_id'] as const) {
      if (scope[member] !== undefined && envelope[member] !== scope[member]) {
        return refuse('artifact_scope_mismatch', `The artifact ${member} is outside the expected scope.`);
      }
    }
  }

  const accepted = {
    valid: true as const,
    artifactId,
    artifactType,
    issuerKeyId,
    payloadHash,
    expiresAt: envelope['expires_at'] as string,
  };
  if (options.checkStatus === false) return { ...accepted, status: 'not_checked' };

  // 8. Token Status List (draft-ietf-oauth-status-list §6.2, §8.3), fail closed.
  const reference = isPlainObject(envelope['status']) ? envelope['status']['status_list'] : undefined;
  if (!isPlainObject(reference)) {
    return refuse('revocation_status_unavailable', 'The envelope has no status list entry.');
  }
  const { idx, uri } = reference;
  if (
    typeof uri !== 'string' || !Number.isSafeInteger(idx) || (idx as number) < 0
    || envelope['revocation_status_url'] !== uri
    || !statusUriAllowed(uri, options.allowLoopbackHttp === true)
  ) {
    return refuse('revocation_status_unavailable', 'The envelope status list entry is malformed.');
  }
  if (!options.statusListFetcher) {
    return refuse('revocation_status_unavailable', 'No status list fetcher is configured.');
  }
  let status: number;
  try {
    const token = await options.statusListFetcher(uri);
    status = readOacpStatus({ token, uri, idx: idx as number, jwks, issuer: options.issuer, now: new Date(now) }).status;
  } catch (err) {
    return refuse('revocation_status_unavailable', `The status list cannot be read: ${(err as Error).message}`);
  }
  if (status === OACP_TOKEN_STATUS.INVALID) return refuse('artifact_revoked', 'The artifact is revoked.');
  if (status === OACP_TOKEN_STATUS.SUSPENDED) return refuse('artifact_suspended', 'The artifact is suspended.');
  if (status !== OACP_TOKEN_STATUS.VALID) {
    return refuse('revocation_status_unavailable', `The status list holds an unknown status ${status}.`);
  }
  return { ...accepted, status: 'valid' };
}
