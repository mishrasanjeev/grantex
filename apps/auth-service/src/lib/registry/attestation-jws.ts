// SPDX-License-Identifier: Apache-2.0
/**
 * The attestation JWS profile (spec/attestation-1.0.md): the pure checks,
 * with no database and no network. lib/registry/attestations.ts runs them in
 * order against the registry's records.
 *
 * An attestation is a compact JWS (RFC 7515 §7.1) whose protected header has
 * `typ` `grantex-attestation+jwt` (RFC 7515 §4.1.9; the media type is
 * `application/grantex-attestation+jwt`), `alg` `ES256` (RFC 7518 §3.4;
 * `EdDSA`, RFC 8037 §3.1, only when the registry turns it on) and a `kid`
 * naming a key in the issuer's recorded JWK Set. Its payload is the JSON
 * object of PRD Appendix A; every member is type-checked and a member the
 * profile does not define is refused, so an issuer cannot slip in a claim
 * the registry would silently ignore.
 *
 * The issuer's own Token Status List (draft-ietf-oauth-status-list-21) is
 * checked here too, once attestations.ts has fetched it, and so are the
 * signed requests an issuer uses to withdraw or refresh an attestation.
 *
 * Every function either returns or throws an AttestationError carrying a PRD
 * Appendix C code and a reason. `attestation_malformed` and
 * `attestation_conflict` are this profile's own, as `passport_malformed` is
 * the passport profile's: Appendix C has no code for a document that is not
 * an attestation at all, or for an issuer reusing an id.
 */
import { compactVerify, importJWK, type JWK } from 'jose';
import { TRUST_MARK_TYPES, type TrustMarkType } from './issuers.js';
import { StatusListCodecError, TOKEN_STATUS, decodeTokenStatusList } from './status-list-codec.js';

/** RFC 7515 §4.1.9: the media type without `application/`. Compared exactly. */
export const ATTESTATION_TYP = 'grantex-attestation+jwt';
/** The typ of an issuer's signed withdrawal or refresh request (spec/attestation-1.0.md §7). */
export const ATTESTATION_REQUEST_TYP = 'grantex-attestation-request+jwt';
/** draft-ietf-oauth-status-list-21 §5.1. */
export const STATUS_LIST_TYP = 'statuslist+jwt';
/** How far ahead of the registry's clock an `iat` may be. */
export const CLOCK_SKEW_SECONDS = 60;
/** How old a signed withdrawal or refresh request may be. */
export const REQUEST_MAX_AGE_SECONDS = 300;
/** How far ahead of the registry's clock a request's `iat` may be. */
export const REQUEST_CLOCK_SKEW_SECONDS = 30;
/** The largest `declared_limits` object, as JSON. */
export const MAX_DECLARED_LIMITS_BYTES = 8_192;
/** Hash rule: `sha-256:` and the base64url SHA-256 digest, 43 characters, no padding. */
export const EXTERNAL_CREDENTIAL_HASH_RE = /^sha-256:[A-Za-z0-9_-]{43}$/;

export type AttestationDenial =
  | 'attestation_malformed'
  | 'attestation_conflict'
  | 'passport_invalid_signature'
  | 'passport_revoked'
  | 'passport_expired'
  | 'attestation_not_accepted'
  | 'attestation_not_registered'
  | 'attestation_hash_mismatch'
  | 'attestation_mismatch'
  | 'issuer_not_accredited'
  | 'issuer_suspended'
  | 'trust_mark_missing'
  | 'key_not_active'
  | 'key_unproven'
  | 'audience_mismatch'
  | 'request_signature_invalid'
  | 'request_signature_stale'
  | 'status_stale';

export class AttestationError extends Error {
  readonly code: AttestationDenial;
  readonly reason: string;

  constructor(code: AttestationDenial, reason: string, message: string) {
    super(message);
    this.name = 'AttestationError';
    this.code = code;
    this.reason = reason;
  }
}

type SigningAlg = 'ES256' | 'EdDSA';
const FOREIGN_KEY_HEADERS = ['jku', 'jwk', 'x5u', 'x5c'] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const ATTESTATION_ID = /^[A-Za-z0-9._:~-]{1,128}$/;
const DID = /^did:[a-z0-9]+:[\x21-\x7e]+$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_URL_LENGTH = 2048;
const MAX_JWS_LENGTH = 16_384;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- Compact serialization --------------------------------------------------------

export interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AttestationError('attestation_malformed', 'bad_encoding', `the ${what} is not base64url JSON`);
  }
  if (!isPlainObject(value)) {
    throw new AttestationError('attestation_malformed', 'bad_encoding', `the ${what} is not a JSON object`);
  }
  return value;
}

/**
 * RFC 7515 §7.1: three base64url segments separated by dots, a JSON object
 * header and, for this profile, a JSON object payload. The JSON
 * serialization (§7.2) is not accepted.
 */
export function parseCompactJws(compact: unknown): ParsedJws {
  if (typeof compact !== 'string' || compact.length === 0 || compact.length > MAX_JWS_LENGTH) {
    throw new AttestationError('attestation_malformed', 'not_compact_jws', `an attestation is a compact JWS of at most ${MAX_JWS_LENGTH} characters`);
  }
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || !BASE64URL.test(part))) {
    throw new AttestationError('attestation_malformed', 'not_compact_jws', 'an attestation is a compact JWS: three base64url parts');
  }
  return { header: decodeSegment(parts[0]!, 'protected header'), payload: decodeSegment(parts[1]!, 'payload') };
}

function checkAlg(alg: unknown, eddsaEnabled: boolean): SigningAlg | null {
  if (alg === 'ES256') return 'ES256';
  if (alg === 'EdDSA' && eddsaEnabled) return 'EdDSA';
  return null;
}

type HeaderFailure = 'wrong_typ' | 'alg_not_allowed' | 'kid_missing' | 'header_key_not_allowed' | 'crit_not_supported';

/** The shared header rules; returns the failure instead of throwing so each caller picks its code. */
function headerProblem(
  header: Record<string, unknown>,
  typ: string,
  eddsaEnabled: boolean,
): { failure: HeaderFailure; message: string } | { alg: SigningAlg; kid: string } {
  if (header['typ'] !== typ) return { failure: 'wrong_typ', message: `typ must be exactly ${typ}` };
  const alg = checkAlg(header['alg'], eddsaEnabled);
  if (alg === null) {
    return { failure: 'alg_not_allowed', message: eddsaEnabled ? 'alg must be ES256 or EdDSA' : 'alg must be ES256' };
  }
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 128) {
    return { failure: 'kid_missing', message: 'kid is required and names the issuer key' };
  }
  // Issuer keys come only from the registry's record (owner decision 7),
  // never from the token.
  for (const name of FOREIGN_KEY_HEADERS) {
    if (name in header) return { failure: 'header_key_not_allowed', message: `${name} must not be present` };
  }
  if ('crit' in header) return { failure: 'crit_not_supported', message: 'crit is not supported' };
  return { alg, kid };
}

/** The attestation's protected header. */
export function checkAttestationHeader(
  header: Record<string, unknown>,
  options: { eddsaEnabled: boolean },
): { alg: SigningAlg; kid: string } {
  const result = headerProblem(header, ATTESTATION_TYP, options.eddsaEnabled);
  if ('failure' in result) throw new AttestationError('attestation_malformed', result.failure, result.message);
  return result;
}

/**
 * `iss` and `type`, read before the rest of the payload: accreditation is
 * checked for them before the signature, so an unknown or suspended issuer
 * is refused as such rather than as a bad signature.
 */
export function readIssuerAndType(payload: Record<string, unknown>): { iss: string; type: string } {
  const iss = payload['iss'];
  const type = payload['type'];
  if (typeof iss !== 'string' || iss.length === 0 || iss.length > MAX_URL_LENGTH) {
    throw new AttestationError('attestation_malformed', 'bad_claim', 'iss must be the issuer\'s entity_id');
  }
  if (typeof type !== 'string' || type.length === 0 || type.length > 256) {
    throw new AttestationError('attestation_malformed', 'bad_claim', 'type must be a trust mark type');
  }
  return { iss, type };
}

/**
 * Verify the JWS signature with `jwk` under `alg` only. A missing key, a key
 * that cannot be imported and a signature that does not verify are all
 * `passport_invalid_signature`: none of them may read as verified.
 */
export async function verifyJwsSignature(
  compact: string,
  jwk: Record<string, unknown> | null,
  alg: SigningAlg,
  code: AttestationDenial = 'passport_invalid_signature',
): Promise<void> {
  if (jwk === null) throw new AttestationError(code, 'issuer_key_not_found', 'the issuer has no current key with this kid');
  let key: Awaited<ReturnType<typeof importJWK>>;
  try {
    key = await importJWK(jwk as JWK, alg);
  } catch {
    throw new AttestationError(code, 'issuer_key_invalid', 'the issuer key cannot verify this algorithm');
  }
  try {
    await compactVerify(compact, key, { algorithms: [alg] });
  } catch {
    throw new AttestationError(code, 'signature_mismatch', 'the signature does not verify with the issuer key');
  }
}

// --- Payload (PRD Appendix A) ---------------------------------------------------------

const PAYLOAD_MEMBERS = new Set([
  'iss', 'id', 'sub', 'type', 'iat', 'exp', 'key_thumbprint', 'external_credential_id',
  'external_credential_hash', 'level', 'declared_limits', 'status',
]);

export type SubjectKind = 'agent' | 'provider';

export interface AttestationClaims {
  iss: string;
  id: string;
  sub: string;
  type: TrustMarkType;
  subjectKind: SubjectKind;
  iat: number;
  exp: number;
  keyThumbprint: string | null;
  externalCredentialId: string;
  externalCredentialHash: string;
  level: string;
  declaredLimits: Record<string, unknown> | null;
  statusListUri: string;
  statusListIdx: number;
}

function badClaim(message: string): never {
  throw new AttestationError('attestation_malformed', 'bad_claim', message);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown, max: number): value is string {
  // No control characters: these values are logged and shown to operators.
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

/** The subject kind a trust mark type attests: `agent.*` an agent, `provider.*` a provider. */
export function subjectKindOf(type: TrustMarkType): SubjectKind {
  return type.startsWith('urn:grantex:tm:agent.') ? 'agent' : 'provider';
}

/**
 * Every member of the payload, type-checked. The format of
 * `external_credential_hash` is the hash rule's, checked later by
 * checkExternalCredentialHash with its own code; here it must be a string.
 */
export function parseAttestationPayload(payload: Record<string, unknown>): AttestationClaims {
  for (const name of Object.keys(payload)) {
    if (!PAYLOAD_MEMBERS.has(name)) {
      throw new AttestationError('attestation_malformed', 'unknown_member', `${name} is not a member of an attestation`);
    }
  }
  const { iss, id, sub, type, iat, exp, status } = payload;
  if (!isHttpsUrl(iss)) badClaim('iss must be the issuer\'s https entity_id');
  if (typeof id !== 'string' || !ATTESTATION_ID.test(id)) badClaim('id must be 1 to 128 characters from A-Z a-z 0-9 . _ : ~ -');
  if (typeof sub !== 'string' || sub.length > MAX_URL_LENGTH || !DID.test(sub)) badClaim('sub must be a DID');
  if (typeof type !== 'string' || !(TRUST_MARK_TYPES as readonly string[]).includes(type)) {
    badClaim('type must be a trust mark type of the taxonomy');
  }
  if (!isTime(iat)) badClaim('iat must be an integer number of seconds');
  if (!isTime(exp)) badClaim('exp must be an integer number of seconds');

  const kind = subjectKindOf(type as TrustMarkType);
  const thumbprint = payload['key_thumbprint'];
  if (kind === 'agent') {
    if (typeof thumbprint !== 'string' || !THUMBPRINT.test(thumbprint)) {
      badClaim('key_thumbprint is required for an agent attestation: an RFC 7638 SHA-256 thumbprint, base64url');
    }
  } else if (thumbprint !== undefined) {
    badClaim('a provider attestation has no key_thumbprint');
  }

  const credentialId = payload['external_credential_id'];
  if (!isText(credentialId, 256)) badClaim('external_credential_id must be a string of 1 to 256 characters');
  const credentialHash = payload['external_credential_hash'];
  if (typeof credentialHash !== 'string') badClaim('external_credential_hash must be a string');
  const level = payload['level'];
  if (!isText(level, 128)) badClaim('level must be a string of 1 to 128 characters');

  let declaredLimits: Record<string, unknown> | null = null;
  if ('declared_limits' in payload) {
    const limits = payload['declared_limits'];
    if (!isPlainObject(limits)) badClaim('declared_limits must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(limits)) > MAX_DECLARED_LIMITS_BYTES) {
      badClaim(`declared_limits must be at most ${MAX_DECLARED_LIMITS_BYTES} bytes`);
    }
    declaredLimits = limits;
  }

  // draft-ietf-oauth-status-list-21 §6.2: {"status_list": {"idx", "uri"}}.
  if (!isPlainObject(status) || Object.keys(status).length !== 1 || !isPlainObject(status['status_list'])) {
    badClaim('status must be {"status_list": {"uri", "idx"}}');
  }
  const reference = (status as { status_list: Record<string, unknown> }).status_list;
  if (Object.keys(reference).some((name) => name !== 'uri' && name !== 'idx')) badClaim('status_list has only uri and idx');
  if (!isHttpsUrl(reference['uri'])) badClaim('status_list.uri must be an https URL');
  const idx = reference['idx'];
  if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0) badClaim('status_list.idx must be a non-negative integer');

  return {
    iss: iss as string,
    id: id as string,
    sub: sub as string,
    type: type as TrustMarkType,
    subjectKind: kind,
    iat: iat as number,
    exp: exp as number,
    keyThumbprint: kind === 'agent' ? thumbprint as string : null,
    externalCredentialId: credentialId as string,
    externalCredentialHash: credentialHash as string,
    level: level as string,
    declaredLimits,
    statusListUri: reference['uri'] as string,
    statusListIdx: idx as number,
  };
}

/** Hash rule (spec/agent-passport-1.0.md §6): `sha-256:` and 43 base64url characters. */
export function checkExternalCredentialHash(value: string): void {
  if (!EXTERNAL_CREDENTIAL_HASH_RE.test(value)) {
    throw new AttestationError('attestation_hash_mismatch', 'hash_format',
      'external_credential_hash must be sha-256: followed by the 43-character base64url SHA-256 digest');
  }
}

/** `exp` after `iat`, `iat` not in the future (beyond the skew) and `exp` in the future. */
export function checkAttestationTimes(times: { iat: number; exp: number }, now: Date): void {
  const nowS = Math.floor(now.getTime() / 1000);
  if (times.exp <= times.iat) throw new AttestationError('passport_expired', 'exp_not_after_iat', 'exp must be after iat');
  if (times.iat > nowS + CLOCK_SKEW_SECONDS) throw new AttestationError('passport_expired', 'not_yet_valid', 'iat is in the future');
  if (times.exp <= nowS) throw new AttestationError('passport_expired', 'expired', 'the attestation has expired');
}

/**
 * Owner decision 8: the status list URI sits under the issuer's
 * status_list_base. The URI must be in its canonical form (no dot segments
 * to climb out of the base), without query or fragment, and strictly longer
 * than the base.
 */
export function statusUriUnderBase(uri: string, base: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.href !== uri || parsed.search || parsed.hash || parsed.protocol !== 'https:') return false;
  return base.endsWith('/') && uri.startsWith(base) && uri.length > base.length;
}

// --- The agent key an attestation names -------------------------------------------------

export interface AttestedKeyState {
  status: string;
  possessionProvedAt: Date | null;
  validFrom: Date;
  validTo: Date | null;
}

export type AttestedKeyEvaluation = { usable: true } | { usable: false; denial: 'key_unproven' | 'key_not_active' };

/**
 * Possession before attestation. The key must be in the agent's history,
 * active or pending, with its possession proven; a rotated key counts only
 * inside its overlap. Not in the history, or never proven: key_unproven.
 * Compromised, rotated past its overlap, outside its validity, or a status
 * this code does not know: key_not_active.
 */
export function evaluateAttestationKey(key: AttestedKeyState | null, at: Date): AttestedKeyEvaluation {
  if (key === null) return { usable: false, denial: 'key_unproven' };
  const t = at.getTime();
  if (key.status === 'compromised') return { usable: false, denial: 'key_not_active' };
  if (key.status === 'rotated') {
    if (key.validTo === null || t >= key.validTo.getTime()) return { usable: false, denial: 'key_not_active' };
  } else if (key.status !== 'active' && key.status !== 'pending') {
    return { usable: false, denial: 'key_not_active' };
  }
  if (key.possessionProvedAt === null) return { usable: false, denial: 'key_unproven' };
  if (t < key.validFrom.getTime()) return { usable: false, denial: 'key_not_active' };
  if (key.validTo !== null && t >= key.validTo.getTime()) return { usable: false, denial: 'key_not_active' };
  return { usable: true };
}

// --- The issuer's Token Status List -----------------------------------------------------

/**
 * The longest the registry relies on one read of an issuer's status list,
 * whatever its `exp` and `ttl` allow: one day. A list with an `exp` a year
 * away is still reread daily, so a revocation reaches the computed level
 * within a day at worst, and within the list's `ttl` when it has one.
 */
export const ISSUER_STATUS_MAX_FRESHNESS_SECONDS = 86_400;

export interface StatusListRead {
  /** The entry's status value (§7.1). */
  value: number;
  /**
   * Until when this read may be relied on: the earliest of the token's `exp`
   * (§5.1), the time of reading plus its `ttl` (§5.1, §13.7) and the time of
   * reading plus ISSUER_STATUS_MAX_FRESHNESS_SECONDS. After it, the recorded
   * status no longer counts (lib/registry/trust-level.ts).
   */
  freshUntil: Date;
}

export interface StatusListCheck {
  /** The status list URI from the attestation: the token's `sub` must equal it (§8.3). */
  uri: string;
  idx: number;
  now: Date;
  /** The issuer's current key for `kid`, from the registry's record only; null when there is none. */
  resolveKey: (kid: string) => Promise<Record<string, unknown> | null>;
  eddsaEnabled: boolean;
}

function stale(reason: string, message: string): never {
  throw new AttestationError('status_stale', reason, message);
}

/**
 * draft-ietf-oauth-status-list-21 §8.3, for one entry of an issuer's list:
 * the token is a `statuslist+jwt` (§5.1) signed by a current key of the same
 * issuer, its `sub` equals the URI, it is fresh by `exp` or, without `exp`,
 * by `iat` + `ttl` (§13.7), and it has an entry at `idx`. Returns the entry,
 * whatever its value, and how long the read stays fresh.
 *
 * Anything that prevents reading the entry is `status_stale`: an unknown
 * status is a refusal, never a pass.
 */
export async function readStatusListEntry(token: string, check: StatusListCheck): Promise<StatusListRead> {
  const { idx, ...rest } = check;
  const read = await readStatusListEntries(token, { ...rest, idxs: [idx] });
  const value = read.values.get(idx);
  if (value === undefined || value === null) stale('index_out_of_range', `the status list has no entry ${idx}`);
  return { value, freshUntil: read.freshUntil };
}

export interface StatusListEntriesCheck extends Omit<StatusListCheck, 'idx'> {
  idxs: readonly number[];
}

export interface StatusListEntriesRead {
  /** Each asked index's value (§7.1), or null when the list has no such entry. */
  values: Map<number, number | null>;
  /** As StatusListRead.freshUntil: one bound for every entry of the one token. */
  freshUntil: Date;
  /**
   * The issuer key (kid) the list was verified with. Reconciliation checks
   * again, when it records the read, that the key is still in force.
   */
  kid: string;
}

/**
 * readStatusListEntry for several entries of one token, so one fetch of a
 * list serves every attestation that points into it (status reconciliation,
 * status-reconciliation.ts). The token is checked once, exactly as for one
 * entry; an index past the end of the list is null for that index alone,
 * and the caller treats it as a failed read of that entry.
 */
export async function readStatusListEntries(token: string, check: StatusListEntriesCheck): Promise<StatusListEntriesRead> {
  let parsed: ParsedJws;
  try {
    parsed = parseCompactJws(token);
  } catch {
    stale('malformed', 'the issuer\'s status list is not a compact JWS');
  }
  const header = headerProblem(parsed.header, STATUS_LIST_TYP, check.eddsaEnabled);
  if ('failure' in header) stale(header.failure, `status list: ${header.message}`);
  // The same issuer key set as the attestation, from the registry's record.
  const key = await check.resolveKey(header.kid);
  try {
    await verifyJwsSignature(token, key, header.alg, 'status_stale');
  } catch (err) {
    if (err instanceof AttestationError) stale('signature', `status list: ${err.message}`);
    throw err;
  }

  const claims = parsed.payload;
  if (claims['sub'] !== check.uri) stale('sub_mismatch', 'the status list\'s sub is not the URI the attestation names');
  const nowS = Math.floor(check.now.getTime() / 1000);
  const { iat, exp, ttl } = claims;
  if (!isTime(iat)) stale('bad_claim', 'status list iat must be an integer');
  if (exp !== undefined && !isTime(exp)) stale('bad_claim', 'status list exp must be an integer');
  if (ttl !== undefined && (!isTime(ttl) || ttl === 0)) stale('bad_claim', 'status list ttl must be a positive integer');
  if ((iat as number) > nowS + CLOCK_SKEW_SECONDS) stale('not_yet_valid', 'status list iat is in the future');
  if (exp !== undefined) {
    if (nowS >= (exp as number)) stale('expired', 'the status list has expired');
  } else if (ttl !== undefined) {
    if (nowS >= (iat as number) + (ttl as number)) stale('expired', 'the status list is older than its ttl');
  } else {
    stale('no_freshness', 'the status list has neither exp nor ttl, so its freshness cannot be established');
  }

  const statusList = claims['status_list'];
  if (!isPlainObject(statusList)) stale('bad_claim', 'status list has no status_list object');
  const values = new Map<number, number | null>();
  try {
    const decoded = decodeTokenStatusList(statusList as { bits: number; lst: string });
    for (const idx of check.idxs) values.set(idx, idx >= 0 && idx < decoded.size ? decoded.statusAt(idx) : null);
  } catch (err) {
    if (err instanceof StatusListCodecError) stale('bad_claim', `status list: ${err.message}`);
    throw err;
  }
  const bounds = [nowS + ISSUER_STATUS_MAX_FRESHNESS_SECONDS];
  if (exp !== undefined) bounds.push(exp as number);
  if (ttl !== undefined) bounds.push(nowS + (ttl as number));
  return { values, freshUntil: new Date(Math.min(...bounds) * 1000), kid: header.kid };
}

/**
 * readStatusListEntry, requiring the entry to be VALID (§7.1): an entry that
 * is not is `passport_revoked`, with reason `invalid` or `suspended`.
 */
export async function verifyStatusListToken(token: string, check: StatusListCheck): Promise<{ freshUntil: Date }> {
  const { value, freshUntil } = await readStatusListEntry(token, check);
  if (value === TOKEN_STATUS.VALID) return { freshUntil };
  if (value === TOKEN_STATUS.INVALID) throw new AttestationError('passport_revoked', 'invalid', 'the issuer has revoked this attestation');
  if (value === TOKEN_STATUS.SUSPENDED) throw new AttestationError('passport_revoked', 'suspended', 'the issuer has suspended this attestation');
  throw new AttestationError('passport_revoked', 'not_valid', `the issuer's status for this attestation is 0x${value.toString(16)}, not VALID`);
}

// --- Signed withdrawal and refresh requests (spec/attestation-1.0.md §7) --------------------

const REQUEST_MEMBERS = new Set(['iss', 'aud', 'id', 'action', 'iat', 'nonce']);
export type AttestationRequestAction = 'withdraw' | 'refresh';

export interface RequestCheck {
  action: AttestationRequestAction;
  /** This registry's identifier (JWT_ISSUER). */
  audience: string;
  now: Date;
  resolveKey: (iss: string, kid: string) => Promise<Record<string, unknown> | null>;
  eddsaEnabled: boolean;
}

export interface VerifiedRequest {
  iss: string;
  id: string;
  nonce: string;
  iat: number;
}

function invalidRequest(reason: string, message: string): never {
  throw new AttestationError('request_signature_invalid', reason, message);
}

/**
 * An issuer's signed request to withdraw or refresh one of its attestations.
 * Single use is the caller's: it records the nonce in the same transaction
 * as the change.
 */
export async function verifyAttestationRequest(compact: string, check: RequestCheck): Promise<VerifiedRequest> {
  let parsed: ParsedJws;
  try {
    parsed = parseCompactJws(compact);
  } catch {
    invalidRequest('malformed', 'the request is not a compact JWS');
  }
  const header = headerProblem(parsed.header, ATTESTATION_REQUEST_TYP, check.eddsaEnabled);
  if ('failure' in header) invalidRequest(header.failure, `request: ${header.message}`);
  const claims = parsed.payload;
  for (const name of Object.keys(claims)) {
    if (!REQUEST_MEMBERS.has(name)) invalidRequest('unknown_member', `${name} is not a member of a request`);
  }
  const { iss, aud, id, action, iat, nonce } = claims;
  if (!isHttpsUrl(iss)) invalidRequest('bad_claim', 'iss must be the issuer\'s entity_id');
  if (typeof aud !== 'string') invalidRequest('bad_claim', 'aud must be the registry\'s identifier');
  if (typeof id !== 'string' || !ATTESTATION_ID.test(id)) invalidRequest('bad_claim', 'id must be the attestation\'s id');
  if (action !== 'withdraw' && action !== 'refresh') invalidRequest('bad_claim', 'action must be withdraw or refresh');
  if (!isTime(iat)) invalidRequest('bad_claim', 'iat must be an integer');
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) invalidRequest('bad_claim', 'nonce must be 16 to 128 base64url characters');

  const key = await check.resolveKey(iss as string, header.kid);
  try {
    await verifyJwsSignature(compact, key, header.alg, 'request_signature_invalid');
  } catch (err) {
    if (err instanceof AttestationError) invalidRequest('signature', `request: ${err.message}`);
    throw err;
  }
  if (aud !== check.audience) throw new AttestationError('audience_mismatch', 'audience_mismatch', 'the request is for another registry');
  if (action !== check.action) invalidRequest('wrong_action', `the request is for ${String(action)}, not ${check.action}`);
  const nowS = Math.floor(check.now.getTime() / 1000);
  if ((iat as number) > nowS + REQUEST_CLOCK_SKEW_SECONDS || nowS - (iat as number) > REQUEST_MAX_AGE_SECONDS) {
    throw new AttestationError('request_signature_stale', 'stale', `a request must be at most ${REQUEST_MAX_AGE_SECONDS} seconds old`);
  }
  return { iss: iss as string, id: id as string, nonce: nonce as string, iat: iat as number };
}
