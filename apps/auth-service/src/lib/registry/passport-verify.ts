// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Passport verification (spec/agent-passport-1.0.md §1 to §4, §6, §7):
 * a copy of the verification half of packages/agent-passport, which the
 * service cannot depend on because its image is built from apps/auth-service
 * alone (as lib/decisions/canonical.ts copies packages/sdk-ts). Issuance and
 * the Key Binding JWT are left out: the registry refuses any KB-JWT at
 * consent time (spec/passport-binding.md §3). tests/passport-verify-vectors.test.ts
 * holds this copy to the shared vectors both libraries pass.
 *
 * Standards: RFC 9901 (SD-JWT) §4 (format), §4.2 (disclosures and digests),
 * §7.1 (processing); draft-ietf-oauth-sd-jwt-vc-19 §2.2.1 (typ dc+sd-jwt),
 * §2.2.2.3 (claims never disclosed); RFC 7515 §7.1 (compact JWS); RFC 7518
 * §3.4 (ES256, R || S); RFC 8037 §3.1 (EdDSA); RFC 7638 §3 (thumbprint);
 * RFC 7800 §3.2 (cnf.jwk).
 *
 * Every refusal is a PassportVerifyError with the profile's code and reason
 * (spec/agent-passport-1.0.md §9). Nothing is returned unless every rule
 * holds; status is not resolved here (the caller does it, §4 step 8).
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export type PassportVerifyCode =
  | 'passport_malformed'
  | 'passport_not_accepted'
  | 'passport_invalid_signature'
  | 'passport_expired';

export class PassportVerifyError extends Error {
  readonly code: PassportVerifyCode;
  readonly reason: string;

  constructor(code: PassportVerifyCode, reason: string, message: string) {
    super(message);
    this.name = 'PassportVerifyError';
    this.code = code;
    this.reason = reason;
  }
}

function malformed(reason: string, message: string): PassportVerifyError {
  return new PassportVerifyError('passport_malformed', reason, message);
}

export interface PassportJwk {
  kty: string;
  [member: string]: unknown;
}

/** draft-ietf-oauth-sd-jwt-vc-19 §2.2.1. */
export const PASSPORT_TYP = 'dc+sd-jwt';
/** spec/agent-passport-1.0.md §2. */
export const PASSPORT_VCT = 'urn:grantex:agent-passport:1';
export const MAX_PASSPORT_LIFETIME_SECONDS = 365 * 86_400;
const SD_ALG = 'sha-256';
const DISCLOSABLE_CLAIMS = ['provider', 'agent', 'verification', 'attestation_id'] as const;
const NOT_DISCLOSABLE = new Set([
  'iss', 'nbf', 'exp', 'cnf', 'vct', 'vct#integrity', 'aka_vcts', 'status', 'sub', 'iat', '_sd_alg',
]);
/** RFC 7515 §4.1.2 to §4.1.6: a token that names or carries a key is refused. */
const KEY_HEADER_MEMBERS = ['jku', 'jwk', 'x5u', 'x5c'] as const;

// ── base64url (RFC 4648 §5, no padding) ─────────────────────────────────────

const ALPHABET = /^[A-Za-z0-9_-]*$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function b64urlDecode(text: string): Buffer | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  // Non-canonical encodings (padding bits set) are refused.
  return bytes.toString('base64url') === text ? bytes : null;
}

function b64urlJson(text: string): { value: unknown } | undefined {
  const bytes = b64urlDecode(text);
  if (bytes === null) return undefined;
  try {
    return { value: JSON.parse(UTF8.decode(bytes)) as unknown };
  } catch {
    // Not UTF-8 or not JSON: the caller refuses the input with its own reason.
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

// ── Keys (RFC 7638 §3, RFC 8037 §2) ─────────────────────────────────────────

const REQUIRED_MEMBERS: Record<string, readonly string[]> = {
  EC: ['crv', 'kty', 'x', 'y'],
  OKP: ['crv', 'kty', 'x'],
  RSA: ['e', 'kty', 'n'],
  oct: ['k', 'kty'],
};
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const PLAIN_MEMBER = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** RFC 7638 JWK SHA-256 thumbprint over the required members only. */
export function jwkThumbprint(jwk: PassportJwk): string {
  if (!isObject(jwk) || typeof jwk.kty !== 'string' || !Object.hasOwn(REQUIRED_MEMBERS, jwk.kty)) {
    throw malformed('bad_key', 'JWK has no supported kty');
  }
  const parts: string[] = [];
  for (const member of REQUIRED_MEMBERS[jwk.kty] as readonly string[]) {
    const value = jwk[member];
    if (typeof value !== 'string' || !PLAIN_MEMBER.test(value)) {
      throw malformed('bad_key', `JWK member ${member} is missing or not a plain string`);
    }
    parts.push(`${JSON.stringify(member)}:${JSON.stringify(value)}`);
  }
  return createHash('sha256').update(`{${parts.join(',')}}`, 'utf8').digest('base64url');
}

/** The key rule (spec/agent-passport-1.0.md §7): equal thumbprints. */
export function keysEqual(a: PassportJwk, b: PassportJwk): boolean {
  return jwkThumbprint(a) === jwkThumbprint(b);
}

function hasPrivateMembers(jwk: Record<string, unknown>): boolean {
  return PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member));
}

type KeyKind = 'P-256' | 'Ed25519';
type SigningAlg = 'ES256' | 'EdDSA';
const KIND_FOR_ALG: Record<SigningAlg, KeyKind> = { ES256: 'P-256', EdDSA: 'Ed25519' };

function keyKind(jwk: unknown): KeyKind | null {
  if (!isObject(jwk)) return null;
  const x = typeof jwk['x'] === 'string' ? b64urlDecode(jwk['x']) : null;
  if (jwk['kty'] === 'EC' && jwk['crv'] === 'P-256') {
    const y = typeof jwk['y'] === 'string' ? b64urlDecode(jwk['y']) : null;
    return x?.length === 32 && y?.length === 32 ? 'P-256' : null;
  }
  if (jwk['kty'] === 'OKP' && jwk['crv'] === 'Ed25519') return x?.length === 32 ? 'Ed25519' : null;
  return null;
}

function importPublicKey(jwk: Record<string, unknown>): KeyObject | null {
  const kind = keyKind(jwk);
  if (kind === null) return null;
  const publicJwk = kind === 'P-256'
    ? { kty: 'EC', crv: 'P-256', x: jwk['x'] as string, y: jwk['y'] as string }
    : { kty: 'OKP', crv: 'Ed25519', x: jwk['x'] as string };
  try {
    return createPublicKey({ key: publicJwk, format: 'jwk' });
  } catch {
    // A point that is not on the curve: the caller refuses the key.
    return null;
  }
}

// ── Compact JWS (RFC 7515 §7.1) ─────────────────────────────────────────────

interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function parseJws(jws: string): ParsedJws | null {
  const segments = jws.split('.');
  if (segments.length !== 3) return null;
  const [h, p, s] = segments as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  const signature = b64urlDecode(s);
  if (!header || !payload || signature === null) return null;
  if (!isObject(header.value) || !isObject(payload.value)) return null;
  return { header: header.value, payload: payload.value, signingInput: `${h}.${p}`, signature };
}

function verifySignature(alg: SigningAlg, jwk: Record<string, unknown>, jws: ParsedJws): boolean {
  if (hasPrivateMembers(jwk) || keyKind(jwk) !== KIND_FOR_ALG[alg]) return false;
  const key = importPublicKey(jwk);
  if (key === null) return false;
  // RFC 7518 §3.4 (R || S) and RFC 8032: 64 octets either way.
  if (jws.signature.length !== 64) return false;
  const data = Buffer.from(jws.signingInput, 'ascii');
  return alg === 'ES256'
    ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, jws.signature)
    : verify(null, data, key, jws.signature);
}

// ── SD-JWT (RFC 9901) ───────────────────────────────────────────────────────

interface SplitSdJwt { issuerJwt: string; disclosures: string[]; kbJwt: string }

/** RFC 9901 §4: <Issuer-signed JWT>~<Disclosure>~...~<optional KB-JWT>. */
function splitSdJwt(compact: string): SplitSdJwt {
  if (typeof compact !== 'string') throw malformed('not_sd_jwt', 'an SD-JWT is a string');
  const parts = compact.split('~');
  if (parts.length < 2) throw malformed('not_sd_jwt', 'an SD-JWT has at least one tilde');
  const disclosures = parts.slice(1, -1);
  if (parts[0] === '' || disclosures.some((d) => d === '')) {
    throw malformed('not_sd_jwt', 'an SD-JWT has no empty elements before the last tilde');
  }
  return { issuerJwt: parts[0] as string, disclosures, kbJwt: parts[parts.length - 1] as string };
}

function sha256b64url(ascii: string): string {
  return createHash('sha256').update(ascii, 'ascii').digest('base64url');
}

const JWS_SEGMENTS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The hash rule (spec/agent-passport-1.0.md §6): `sha-256:` and the base64url
 * SHA-256 of the issuer-signed JWT, the part before the first `~`.
 */
export function externalCredentialHash(compact: string): string {
  const end = typeof compact === 'string' ? compact.indexOf('~') : -1;
  if (end < 0) throw malformed('not_sd_jwt', 'the hash rule takes an SD-JWT (issuer-signed JWT followed by ~)');
  const issuerJwt = compact.slice(0, end);
  if (!JWS_SEGMENTS.test(issuerJwt)) throw malformed('not_sd_jwt', 'the issuer-signed JWT is not a compact JWS');
  return `${SD_ALG}:${sha256b64url(issuerJwt)}`;
}

interface DecodedDisclosure { digest: string; name?: string; value: unknown }

function decodeDisclosure(encoded: string): DecodedDisclosure {
  const array = b64urlJson(encoded)?.value;
  if (!Array.isArray(array) || (array.length !== 2 && array.length !== 3) || typeof array[0] !== 'string') {
    throw malformed('disclosure_malformed', 'a disclosure is base64url JSON [salt, name, value] or [salt, value]');
  }
  // RFC 9901 §4.2.3: the digest is over the US-ASCII bytes of the encoded disclosure.
  const digest = sha256b64url(encoded);
  if (array.length === 2) return { digest, value: array[1] };
  if (typeof array[1] !== 'string') throw malformed('disclosure_malformed', 'a disclosure claim name is a string');
  return { digest, name: array[1], value: array[2] };
}

/** An own property, so a claim named __proto__ is a claim and not the object's prototype. */
function setClaim(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/** RFC 9901 §7.1 steps 3 to 5. */
function processDisclosures(payload: Record<string, unknown>, encodedDisclosures: readonly string[]): Record<string, unknown> {
  const seenEncoded = new Set<string>();
  for (const encoded of encodedDisclosures) {
    if (seenEncoded.has(encoded)) throw malformed('duplicate_disclosure', 'a disclosure appears more than once');
    seenEncoded.add(encoded);
  }
  const decoded = encodedDisclosures.map(decodeDisclosure);
  const byDigest = new Map(decoded.map((d) => [d.digest, d]));
  const seenDigests = new Set<string>();
  const used = new Set<string>();

  const takeDigest = (digest: unknown): DecodedDisclosure | undefined => {
    if (typeof digest !== 'string') throw malformed('bad_claim', 'a digest is a string');
    if (seenDigests.has(digest)) throw malformed('duplicate_digest', 'a digest appears more than once');
    seenDigests.add(digest);
    const disclosure = byDigest.get(digest);
    if (disclosure !== undefined) used.add(digest);
    return disclosure;
  };

  const processValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return processArray(value);
    if (isObject(value)) return processObject(value, false);
    return value;
  };

  const processArray = (array: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const element of array) {
      if (isObject(element) && Object.keys(element).length === 1 && Object.hasOwn(element, '...')) {
        const disclosure = takeDigest(element['...']);
        if (disclosure === undefined) continue;
        if (disclosure.name !== undefined) {
          throw malformed('disclosure_malformed', 'an array element digest refers to an object property disclosure');
        }
        out.push(processValue(disclosure.value));
      } else {
        out.push(processValue(element));
      }
    }
    return out;
  };

  const processObject = (object: Record<string, unknown>, topLevel: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(object)) {
      if (name === '_sd' || (topLevel && name === '_sd_alg')) continue;
      setClaim(out, name, processValue(value));
    }
    if (!Object.hasOwn(object, '_sd')) return out;
    const sd = object['_sd'];
    if (!Array.isArray(sd)) throw malformed('bad_claim', '_sd is an array of digests');
    for (const digest of sd) {
      const disclosure = takeDigest(digest);
      if (disclosure === undefined) continue; // a decoy, or a claim the holder withheld
      if (disclosure.name === undefined) {
        throw malformed('disclosure_malformed', 'an _sd digest refers to an array element disclosure');
      }
      const name = disclosure.name;
      if (name === '_sd' || name === '...' || (topLevel && NOT_DISCLOSABLE.has(name))) {
        throw malformed('disclosure_name_not_allowed', `claim ${name} cannot be selectively disclosed`);
      }
      if (Object.hasOwn(object, name) || Object.hasOwn(out, name)) {
        throw malformed('claim_name_conflict', `claim ${name} is both in the clear and disclosed`);
      }
      setClaim(out, name, processValue(disclosure.value));
    }
    return out;
  };

  const claims = processObject(payload, true);
  for (const d of decoded) {
    if (!used.has(d.digest)) throw malformed('disclosure_not_referenced', 'a disclosure is not referenced by any digest');
  }
  return claims;
}

// ── The profile (spec/agent-passport-1.0.md §2, §4) ─────────────────────────

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && value.length > 'https://'.length;
}

// DID Core §3.1 syntax, with no path, query or fragment (a DID, not a DID
// URL). The same expression as packages/agent-passport; a test holds the two
// together.
const DID = /^did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/;

export function isPassportDid(value: unknown): value is string {
  return typeof value === 'string' && DID.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export interface PassportStatusReference {
  status_list: { uri: string; idx: number };
}

function isStatusReference(value: unknown): value is PassportStatusReference {
  if (!isObject(value) || !isObject(value['status_list'])) return false;
  const { uri, idx } = value['status_list'];
  return typeof uri === 'string' && uri !== '' && isSafeInt(idx) && idx >= 0;
}

function checkProfileClaims(claims: Record<string, unknown>): void {
  const bad = (name: string) => malformed('bad_claim', `claim ${name} does not have the profile's shape`);
  if (Object.hasOwn(claims, 'provider')) {
    const p = claims['provider'];
    if (!isObject(p) || !isPassportDid(p['did'])
        || (p['legal_identifiers'] !== undefined && !Array.isArray(p['legal_identifiers']))
        || (p['name'] !== undefined && typeof p['name'] !== 'string')) {
      throw bad('provider');
    }
  }
  if (Object.hasOwn(claims, 'agent')) {
    const a = claims['agent'];
    if (!isObject(a)
        || typeof a['software_name'] !== 'string' || a['software_name'] === ''
        || typeof a['software_version'] !== 'string' || a['software_version'] === ''
        || (a['cimd_uri'] !== undefined && !isHttpsUrl(a['cimd_uri']))
        || (a['categories'] !== undefined && !isStringArray(a['categories']))
        || (a['declared_limits'] !== undefined && !isObject(a['declared_limits']))) {
      throw bad('agent');
    }
  }
  if (Object.hasOwn(claims, 'verification')) {
    const v = claims['verification'];
    if (!isObject(v) || typeof v['level'] !== 'string' || v['level'] === ''
        || (v['types'] !== undefined && !isStringArray(v['types']))
        || (v['performed_at'] !== undefined && !isSafeInt(v['performed_at']))) {
      throw bad('verification');
    }
  }
  if (Object.hasOwn(claims, 'attestation_id')) {
    if (typeof claims['attestation_id'] !== 'string' || claims['attestation_id'] === '') throw bad('attestation_id');
  }
}

/** RFC 7800 §3.2: a public P-256 or Ed25519 JWK. */
function checkCnf(cnf: unknown, paymentsRails: boolean): PassportJwk {
  if (!isObject(cnf) || !isObject(cnf['jwk'])) throw malformed('cnf_missing', 'cnf.jwk is required');
  const jwk = cnf['jwk'];
  if (hasPrivateMembers(jwk)) throw malformed('cnf_private_key', 'cnf.jwk carries private key members');
  const kind = keyKind(jwk);
  if (kind === null || importPublicKey(jwk) === null) {
    throw malformed('cnf_unsupported_key', 'cnf.jwk must be a P-256 or Ed25519 public key');
  }
  if (paymentsRails && kind !== 'P-256') {
    throw new PassportVerifyError('passport_not_accepted', 'cnf_not_p256', 'payments rails require a P-256 cnf key');
  }
  return jwk as PassportJwk;
}

function checkLifetime(iat: number, exp: number): void {
  if (exp <= iat) throw malformed('bad_claim', 'exp must be after iat');
  if (exp - iat > MAX_PASSPORT_LIFETIME_SECONDS) {
    throw new PassportVerifyError('passport_not_accepted', 'lifetime_exceeds_one_year', 'exp is more than one year after iat');
  }
}

/** Resolves the issuer's public keys from the registry's record, never from the token. */
export type PassportIssuerKeys = (iss: string, kid: string | undefined) => Promise<readonly unknown[]>;

export interface VerifyPassportOptions {
  compact: string;
  issuerKeys: PassportIssuerKeys;
  /** Seconds since the epoch. */
  now: number;
  allowEdDSA?: boolean;
  paymentsRails?: boolean;
  clockSkewSeconds?: number;
}

export interface PassportDisclosed {
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  attestation_id?: string;
}

export interface VerifiedPassportPresentation {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  status: PassportStatusReference;
  cnfJwk: PassportJwk;
  cnfThumbprint: string;
  disclosed: PassportDisclosed;
  externalCredentialHash: string;
}

/**
 * The issuer named by an SD-JWT, read without verifying anything, or null.
 * Used only to ask the registry whether that issuer is accredited before the
 * signature is checked; nothing read here is trusted.
 */
export function unverifiedPassportIssuer(compact: unknown): string | null {
  if (typeof compact !== 'string') return null;
  const end = compact.indexOf('~');
  if (end <= 0) return null;
  const jws = parseJws(compact.slice(0, end));
  return jws !== null && isHttpsUrl(jws.payload['iss']) ? jws.payload['iss'] : null;
}

/**
 * Verify an Agent Passport presentation without key binding
 * (spec/agent-passport-1.0.md §4 steps 1 to 7). A presentation that carries
 * a KB-JWT is refused (`unexpected_key_binding`).
 */
export async function verifyPassportPresentation(options: VerifyPassportOptions): Promise<VerifiedPassportPresentation> {
  const now = options.now;
  const skew = options.clockSkewSeconds ?? 0;
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(skew) || skew < 0) {
    // A NaN or negative time would make every comparison below pass.
    throw new TypeError('now and clockSkewSeconds must be finite non-negative numbers');
  }
  const allowEdDSA = options.allowEdDSA === true;

  const { issuerJwt, disclosures, kbJwt } = splitSdJwt(options.compact);
  const jws = parseJws(issuerJwt);
  if (jws === null) throw malformed('bad_encoding', 'the issuer-signed JWT is not a compact JWS');
  const { header, payload } = jws;

  if (header['typ'] !== PASSPORT_TYP) throw malformed('wrong_typ', `typ must be ${PASSPORT_TYP}`);
  const alg = header['alg'];
  if (alg !== 'ES256' && alg !== 'EdDSA') throw malformed('alg_not_allowed', 'alg must be ES256 (or EdDSA)');
  if (alg === 'EdDSA' && !allowEdDSA) {
    throw new PassportVerifyError('passport_not_accepted', 'eddsa_not_enabled', 'EdDSA is not enabled');
  }
  if (KEY_HEADER_MEMBERS.some((m) => Object.hasOwn(header, m))) {
    // Owner decision 7: issuer keys come only from the registry's record.
    throw malformed('header_key_not_allowed', 'the header names a key; issuer keys come only from the registry');
  }
  // RFC 7515 §4.1.11: no extension is understood here, so crit cannot be honoured.
  if (Object.hasOwn(header, 'crit')) throw malformed('crit_not_supported', 'crit is not supported');
  if (header['kid'] !== undefined && typeof header['kid'] !== 'string') throw malformed('bad_encoding', 'kid is a string');
  const kid = header['kid'] as string | undefined;

  if (!isHttpsUrl(payload['iss'])) throw malformed('bad_claim', 'iss must be the issuer entity_id, an https URL');
  const iss = payload['iss'];
  // A resolver failure (the registry cannot be read) propagates: nothing is
  // verified without the issuer's keys, and it is not the passport's fault.
  const keys = await options.issuerKeys(iss, kid);
  if (!Array.isArray(keys)) {
    throw new PassportVerifyError('passport_invalid_signature', 'issuer_key_resolution_failed', 'the issuer keys are not a list');
  }
  const matching = keys.filter((k): k is Record<string, unknown> =>
    isObject(k) && (kid === undefined || k['kid'] === kid) && (k['alg'] === undefined || k['alg'] === alg));
  if (matching.some(hasPrivateMembers)) {
    throw new PassportVerifyError('passport_invalid_signature', 'issuer_key_invalid', 'the registry holds a private issuer key');
  }
  const candidates = matching.filter((k) => keyKind(k) === KIND_FOR_ALG[alg]);
  if (candidates.length === 0) {
    throw new PassportVerifyError('passport_invalid_signature', 'issuer_key_not_found', 'no issuer key for this passport');
  }
  if (candidates.some((k) => importPublicKey(k) === null)) {
    throw new PassportVerifyError('passport_invalid_signature', 'issuer_key_invalid', 'the registry holds an unusable issuer key');
  }
  if (!candidates.some((key) => verifySignature(alg, key, jws))) {
    throw new PassportVerifyError('passport_invalid_signature', 'signature_mismatch', 'the issuer signature does not verify');
  }

  if (typeof payload['vct'] !== 'string') throw malformed('bad_claim', 'vct is required');
  if (payload['vct'] !== PASSPORT_VCT) {
    throw new PassportVerifyError('passport_not_accepted', 'wrong_vct', `vct must be ${PASSPORT_VCT}`);
  }
  if (!isPassportDid(payload['sub'])) throw malformed('bad_claim', 'sub must be the agent DID');
  if (!isSafeInt(payload['iat']) || !isSafeInt(payload['exp'])) throw malformed('bad_claim', 'iat and exp are integers');
  if (payload['nbf'] !== undefined && !isSafeInt(payload['nbf'])) throw malformed('bad_claim', 'nbf is an integer');
  if (!isStatusReference(payload['status'])) throw malformed('bad_claim', 'status must be a Token Status List reference');
  if (payload['_sd_alg'] !== undefined && payload['_sd_alg'] !== SD_ALG) {
    throw malformed('sd_alg_not_supported', `_sd_alg must be ${SD_ALG}`);
  }
  const iat = payload['iat'];
  const exp = payload['exp'];
  checkLifetime(iat, exp);
  const nbf = payload['nbf'];
  if (iat > now + skew || (isSafeInt(nbf) && nbf > now + skew)) {
    throw new PassportVerifyError('passport_expired', 'not_yet_valid', 'the passport is not valid yet');
  }
  if (now >= exp + skew) throw new PassportVerifyError('passport_expired', 'expired', 'the passport has expired');

  const cnfJwk = checkCnf(payload['cnf'], options.paymentsRails === true);
  const claims = processDisclosures(payload, disclosures);
  checkProfileClaims(claims);

  if (kbJwt !== '') {
    throw malformed('unexpected_key_binding', 'the presentation has a KB-JWT; consent takes none');
  }

  const disclosed: PassportDisclosed = {};
  for (const name of DISCLOSABLE_CLAIMS) {
    if (Object.hasOwn(claims, name)) (disclosed as Record<string, unknown>)[name] = claims[name];
  }
  return {
    iss,
    sub: payload['sub'],
    iat,
    exp,
    status: payload['status'],
    cnfJwk,
    cnfThumbprint: jwkThumbprint(cnfJwk),
    disclosed,
    externalCredentialHash: externalCredentialHash(options.compact),
  };
}
