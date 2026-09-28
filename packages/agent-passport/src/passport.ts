// SPDX-License-Identifier: Apache-2.0
//
// The Agent Passport: an SD-JWT VC (draft-ietf-oauth-sd-jwt-vc) with
// vct urn:grantex:agent-passport:1. spec/agent-passport-1.0.md is the
// normative description; this file and the Python package implement it and
// share the vectors in spec/examples/agent-passport-vectors.json.

import { randomBytes } from 'node:crypto';
import { isObject, isSafeInt } from './base64url.ts';
import { PassportError, malformed } from './errors.ts';
import {
  ALG_FOR_KIND,
  KEY_HEADER_MEMBERS,
  KIND_FOR_ALG,
  parseJws,
  signJws,
  verifySignature,
  type SigningAlg,
} from './jws.ts';
import { hasPrivateMembers, importPublicKey, jwkThumbprint, keyKind, type Jwk } from './jwk.ts';
import { verifyKeyBinding, type KeyBindingRequirement, type KeyBindingResult } from './key-binding.ts';
import {
  SD_ALG,
  disclosureDigest,
  encodeDisclosure,
  externalCredentialHash,
  processDisclosures,
  splitSdJwt,
} from './sd-jwt.ts';

/** draft-ietf-oauth-sd-jwt-vc section 2.2.1: the typ of an SD-JWT VC (media type application/dc+sd-jwt). */
export const PASSPORT_TYP = 'dc+sd-jwt';

/** The credential type of an Agent Passport (draft-ietf-oauth-sd-jwt-vc section 2.2.2.1). */
export const PASSPORT_VCT = 'urn:grantex:agent-passport:1';

/** exp may be at most one year (365 days) after iat. */
export const MAX_PASSPORT_LIFETIME_SECONDS = 365 * 86_400;

/** The selectively disclosable claims of the profile, in issuing order. */
export const DISCLOSABLE_CLAIMS = ['provider', 'agent', 'verification', 'attestation_id'] as const;

/**
 * Top-level claims that are never disclosures: the ones draft-ietf-oauth-sd-jwt-vc
 * section 2.2.2.3 forbids, plus sub and iat, which the profile keeps in the clear.
 */
const NOT_DISCLOSABLE = new Set([
  'iss',
  'nbf',
  'exp',
  'cnf',
  'vct',
  'vct#integrity',
  'aka_vcts',
  'status',
  'sub',
  'iat',
  '_sd_alg',
]);

export interface StatusReference {
  /** Token Status List reference (draft-ietf-oauth-status-list section 6.2). */
  status_list: { uri: string; idx: number };
}

export interface ProviderClaim {
  did: string;
  legal_identifiers?: unknown[];
  name?: string;
  [member: string]: unknown;
}

export interface AgentClaim {
  software_name: string;
  software_version: string;
  cimd_uri?: string;
  categories?: string[];
  declared_limits?: Record<string, unknown>;
  [member: string]: unknown;
}

export interface VerificationClaim {
  level: string;
  types?: string[];
  performed_at?: number;
  [member: string]: unknown;
}

export interface PassportClaims {
  provider?: ProviderClaim;
  agent?: AgentClaim;
  verification?: VerificationClaim;
  attestation_id?: string;
}

export interface IssuePassportParams {
  /** The issuer's private P-256 (ES256) or Ed25519 (EdDSA) JWK; its kid, if any, goes in the header. */
  issuerKey: Jwk;
  /** The issuer's entity_id, an https URL. */
  iss: string;
  /** The agent's DID. */
  sub: string;
  /** The agent's public key, carried as cnf.jwk. */
  cnfJwk: Jwk;
  iat: number;
  exp: number;
  status: StatusReference;
  /** Each claim present becomes one disclosure. */
  claims: PassportClaims;
  vct?: string;
}

export interface IssuedDisclosure {
  salt: string;
  name: string;
  value: unknown;
  encoded: string;
  digest: string;
}

export interface IssuedPassport {
  /** The SD-JWT with every disclosure, ending with '~'. */
  compact: string;
  issuerJwt: string;
  disclosures: IssuedDisclosure[];
}

export type IssuerKeyResolver = (issuer: string) => readonly Jwk[] | Promise<readonly Jwk[]>;

export interface VerifyPassportOptions {
  compact: string;
  /**
   * The issuer's public keys, from the relying party's own trust configuration
   * (the registry). Keys are never taken from the token (PRD section 13).
   */
  issuerKeys: IssuerKeyResolver;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  /** Defaults to PASSPORT_VCT. */
  expectedVct?: string;
  /** Payments rails: the cnf key must be P-256. */
  paymentsRails?: boolean;
  /** Accept EdDSA signatures (issuer JWT and KB-JWT). Off by default: ES256 is required. */
  allowEdDSA?: boolean;
  /** Leeway for exp, nbf and iat, in seconds. Defaults to 0. */
  clockSkewSeconds?: number;
  /** Require and check a KB-JWT. Without it, a presentation that carries one is refused. */
  keyBinding?: KeyBindingRequirement;
}

export interface VerifiedDisclosure {
  digest: string;
  salt: string;
  name?: string;
  value: unknown;
}

export interface VerifiedPassport {
  header: Record<string, unknown>;
  /** The issuer-signed payload as signed (digests, not claims). */
  payload: Record<string, unknown>;
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  vct: string;
  /**
   * The Token Status List reference, checked for shape only. Not resolved here:
   * the relying party resolves it and refuses a revoked or suspended passport
   * (passport_revoked) or a stale list (status_stale) before accepting.
   */
  status: StatusReference;
  cnfJwk: Jwk;
  cnfThumbprint: string;
  /** Every claim after processing the disclosures, without _sd and _sd_alg. */
  claims: Record<string, unknown> & PassportClaims;
  /** The profile's disclosable claims that were presented. */
  disclosed: PassportClaims;
  disclosures: VerifiedDisclosure[];
  externalCredentialHash: string;
  keyBinding?: KeyBindingResult;
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && value.length > 'https://'.length;
}

function isDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[a-z0-9]+:[\s\S]+/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStatusReference(value: unknown): value is StatusReference {
  if (!isObject(value) || !isObject(value.status_list)) return false;
  const { uri, idx } = value.status_list;
  // draft-ietf-oauth-status-list section 6.2: idx a non-negative integer, uri a string.
  return typeof uri === 'string' && uri !== '' && isSafeInt(idx) && idx >= 0;
}

/** Shape of the profile claims (spec/agent-passport-1.0.md section "Claims"). Extra members are allowed. */
function checkProfileClaims(claims: Record<string, unknown>): void {
  const bad = (name: string) => malformed('bad_claim', `claim ${name} does not have the profile's shape`);
  if (Object.hasOwn(claims, 'provider')) {
    const p = claims.provider;
    if (
      !isObject(p) ||
      !isDid(p.did) ||
      (p.legal_identifiers !== undefined && !Array.isArray(p.legal_identifiers)) ||
      (p.name !== undefined && typeof p.name !== 'string')
    ) {
      throw bad('provider');
    }
  }
  if (Object.hasOwn(claims, 'agent')) {
    const a = claims.agent;
    if (
      !isObject(a) ||
      typeof a.software_name !== 'string' ||
      a.software_name === '' ||
      typeof a.software_version !== 'string' ||
      a.software_version === '' ||
      (a.cimd_uri !== undefined && !isHttpsUrl(a.cimd_uri)) ||
      (a.categories !== undefined && !isStringArray(a.categories)) ||
      (a.declared_limits !== undefined && !isObject(a.declared_limits))
    ) {
      throw bad('agent');
    }
  }
  if (Object.hasOwn(claims, 'verification')) {
    const v = claims.verification;
    if (
      !isObject(v) ||
      typeof v.level !== 'string' ||
      v.level === '' ||
      (v.types !== undefined && !isStringArray(v.types)) ||
      (v.performed_at !== undefined && !isSafeInt(v.performed_at))
    ) {
      throw bad('verification');
    }
  }
  if (Object.hasOwn(claims, 'attestation_id')) {
    if (typeof claims.attestation_id !== 'string' || claims.attestation_id === '') throw bad('attestation_id');
  }
}

/** cnf (RFC 7800 section 3.2): a public P-256 or Ed25519 JWK. */
function checkCnf(cnf: unknown, paymentsRails: boolean): Jwk {
  if (!isObject(cnf) || !isObject(cnf.jwk)) throw malformed('cnf_missing', 'cnf.jwk is required');
  const jwk = cnf.jwk;
  if (hasPrivateMembers(jwk)) throw malformed('cnf_private_key', 'cnf.jwk carries private key members');
  const kind = keyKind(jwk);
  if (kind === null || importPublicKey(jwk) === null) {
    throw malformed('cnf_unsupported_key', 'cnf.jwk must be a P-256 or Ed25519 public key');
  }
  if (paymentsRails && kind !== 'P-256') {
    throw new PassportError('passport_not_accepted', 'cnf_not_p256', 'payments rails require a P-256 cnf key');
  }
  return jwk as Jwk;
}

function checkLifetime(iat: number, exp: number): void {
  if (exp <= iat) throw malformed('bad_claim', 'exp must be after iat');
  if (exp - iat > MAX_PASSPORT_LIFETIME_SECONDS) {
    throw new PassportError('passport_not_accepted', 'lifetime_exceeds_one_year', 'exp is more than one year after iat');
  }
}

function newSalt(): string {
  // RFC 9901 section 9.3: at least 128 bits of randomness per salt.
  return randomBytes(16).toString('base64url');
}

/** Issue an Agent Passport. For the mock issuer and tests; accredited issuers run their own issuance. */
export function issuePassport(params: IssuePassportParams): IssuedPassport {
  const kind = keyKind(params.issuerKey);
  if (kind === null || typeof params.issuerKey.d !== 'string') {
    throw malformed('bad_key', 'the issuer key must be a private P-256 or Ed25519 JWK');
  }
  if (!isHttpsUrl(params.iss)) throw malformed('bad_claim', 'iss must be the issuer entity_id, an https URL');
  if (!isDid(params.sub)) throw malformed('bad_claim', 'sub must be the agent DID');
  if (!isSafeInt(params.iat) || !isSafeInt(params.exp)) throw malformed('bad_claim', 'iat and exp are integers');
  checkLifetime(params.iat, params.exp);
  if (!isStatusReference(params.status)) throw malformed('bad_claim', 'status must be a Token Status List reference');
  const cnfJwk = checkCnf({ jwk: params.cnfJwk }, false);

  const disclosures: IssuedDisclosure[] = [];
  for (const [name, value] of Object.entries(params.claims)) {
    // An absent claim: null and undefined are both skipped, as the Python package skips None.
    if (value === undefined || value === null) continue;
    if (NOT_DISCLOSABLE.has(name) || name === '_sd' || name === '...') {
      throw malformed('disclosure_name_not_allowed', `claim ${name} cannot be selectively disclosed`);
    }
    const salt = newSalt();
    const encoded = encodeDisclosure(salt, name, value);
    disclosures.push({ salt, name, value, encoded, digest: disclosureDigest(encoded) });
  }

  const header: Record<string, unknown> = { alg: ALG_FOR_KIND[kind], typ: PASSPORT_TYP };
  if (typeof params.issuerKey.kid === 'string') header.kid = params.issuerKey.kid;
  const payload: Record<string, unknown> = {
    iss: params.iss,
    sub: params.sub,
    iat: params.iat,
    exp: params.exp,
    vct: params.vct ?? PASSPORT_VCT,
    cnf: { jwk: cnfJwk },
    status: params.status,
    // RFC 9901 section 4.2.4.1: sorted digests do not reveal the claims' original order.
    _sd: disclosures.map((d) => d.digest).sort(),
    _sd_alg: SD_ALG,
  };
  const issuerJwt = signJws(header, payload, params.issuerKey);
  return {
    compact: `${issuerJwt}~${disclosures.map((d) => `${d.encoded}~`).join('')}`,
    issuerJwt,
    disclosures,
  };
}

function checkNumberOption(name: string, value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    // A NaN or negative time would make every comparison below pass: refuse the call instead.
    throw new TypeError(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

async function resolveIssuerKeys(resolver: IssuerKeyResolver, iss: string): Promise<readonly unknown[]> {
  let keys: unknown;
  try {
    keys = await resolver(iss);
  } catch (cause) {
    // Fail closed: without the issuer's keys nothing can be verified. The cause is kept.
    throw new PassportError(
      'passport_invalid_signature',
      'issuer_key_resolution_failed',
      'the issuer key resolver failed',
      { cause },
    );
  }
  if (!Array.isArray(keys)) {
    throw new PassportError(
      'passport_invalid_signature',
      'issuer_key_resolution_failed',
      'the issuer key resolver must return an array of JWKs',
    );
  }
  return keys;
}

/**
 * Verify an Agent Passport (or a presentation of one) and return its claims.
 * Every failure throws a PassportError; nothing is returned unless every rule
 * of the profile holds. Revocation is not checked: the caller resolves
 * `status` before accepting (spec/agent-passport-1.0.md section 4).
 */
export async function verifyPassport(options: VerifyPassportOptions): Promise<VerifiedPassport> {
  const now = checkNumberOption('now', options.now ?? Math.floor(Date.now() / 1000), 0);
  const skew = checkNumberOption('clockSkewSeconds', options.clockSkewSeconds ?? 0, 0);
  if (options.keyBinding?.maxAgeSeconds !== undefined) {
    checkNumberOption('keyBinding.maxAgeSeconds', options.keyBinding.maxAgeSeconds, 0);
  }
  const expectedVct = options.expectedVct ?? PASSPORT_VCT;
  const allowEdDSA = options.allowEdDSA === true;

  const { issuerJwt, disclosures, kbJwt } = splitSdJwt(options.compact);
  const jws = parseJws(issuerJwt);
  if (jws === null) throw malformed('bad_encoding', 'the issuer-signed JWT is not a compact JWS');
  const { header, payload } = jws;

  // Header: typ (SD-JWT VC section 2.2.1), alg, no key in the token, no crit.
  if (header.typ !== PASSPORT_TYP) throw malformed('wrong_typ', `typ must be ${PASSPORT_TYP}`);
  const alg = header.alg;
  if (alg !== 'ES256' && alg !== 'EdDSA') throw malformed('alg_not_allowed', 'alg must be ES256 (or EdDSA)');
  if (alg === 'EdDSA' && !allowEdDSA) {
    throw new PassportError('passport_not_accepted', 'eddsa_not_enabled', 'EdDSA is not enabled (allowEdDSA)');
  }
  if (KEY_HEADER_MEMBERS.some((m) => Object.hasOwn(header, m))) {
    // PRD section 13: issuer keys come only from the injected resolver; never fetch or trust a key the token names.
    throw malformed('header_key_not_allowed', 'the header names a key; issuer keys come only from the resolver');
  }
  // RFC 7515 section 4.1.11: no extension is understood here, so crit cannot be honoured.
  if (Object.hasOwn(header, 'crit')) throw malformed('crit_not_supported', 'crit is not supported');
  if (header.kid !== undefined && typeof header.kid !== 'string') throw malformed('bad_encoding', 'kid is a string');

  // The issuer identifies which keys to use; the signature is checked before any other claim is read.
  if (!isHttpsUrl(payload.iss)) throw malformed('bad_claim', 'iss must be the issuer entity_id, an https URL');
  const iss = payload.iss;
  const keys = await resolveIssuerKeys(options.issuerKeys, iss);
  const matching = keys.filter(
    (k): k is Record<string, unknown> =>
      isObject(k) && (header.kid === undefined || k.kid === header.kid) && (k.alg === undefined || k.alg === alg),
  );
  if (matching.some(hasPrivateMembers)) {
    // A private key from the resolver is a misconfiguration: refuse rather than use it.
    throw new PassportError('passport_invalid_signature', 'issuer_key_invalid', 'the resolver returned a private key');
  }
  const candidates = matching.filter((k) => keyKind(k) === KIND_FOR_ALG[alg as SigningAlg]);
  if (candidates.length === 0) {
    throw new PassportError('passport_invalid_signature', 'issuer_key_not_found', 'no issuer key for this passport');
  }
  if (candidates.some((k) => importPublicKey(k) === null)) {
    // Right type and length but not a point on the curve: a broken trust configuration.
    throw new PassportError('passport_invalid_signature', 'issuer_key_invalid', 'the resolver returned an unusable key');
  }
  if (!candidates.some((key) => verifySignature(alg, key, jws))) {
    throw new PassportError('passport_invalid_signature', 'signature_mismatch', 'the issuer signature does not verify');
  }

  // Registered claims.
  if (typeof payload.vct !== 'string') throw malformed('bad_claim', 'vct is required');
  if (payload.vct !== expectedVct) {
    throw new PassportError('passport_not_accepted', 'wrong_vct', `vct must be ${expectedVct}`);
  }
  if (!isDid(payload.sub)) throw malformed('bad_claim', 'sub must be the agent DID');
  if (!isSafeInt(payload.iat) || !isSafeInt(payload.exp)) throw malformed('bad_claim', 'iat and exp are integers');
  if (payload.nbf !== undefined && !isSafeInt(payload.nbf)) throw malformed('bad_claim', 'nbf is an integer');
  if (!isStatusReference(payload.status)) throw malformed('bad_claim', 'status must be a Token Status List reference');
  if (payload._sd_alg !== undefined && payload._sd_alg !== SD_ALG) {
    throw malformed('sd_alg_not_supported', `_sd_alg must be ${SD_ALG}`);
  }
  const { iat, exp } = payload;
  checkLifetime(iat, exp);
  if (iat > now + skew || (isSafeInt(payload.nbf) && payload.nbf > now + skew)) {
    throw new PassportError('passport_expired', 'not_yet_valid', 'the passport is not valid yet');
  }
  if (now >= exp + skew) throw new PassportError('passport_expired', 'expired', 'the passport has expired');

  const cnfJwk = checkCnf(payload.cnf, options.paymentsRails === true);

  const processed = processDisclosures(payload, disclosures, NOT_DISCLOSABLE);
  checkProfileClaims(processed.claims);

  let keyBinding: KeyBindingResult | undefined;
  if (options.keyBinding === undefined) {
    if (kbJwt !== '') {
      throw malformed('unexpected_key_binding', 'the presentation has a KB-JWT but no key binding was requested');
    }
  } else {
    keyBinding = verifyKeyBinding({
      compact: options.compact,
      kbJwt,
      cnfJwk,
      requirement: options.keyBinding,
      now,
      clockSkewSeconds: skew,
      allowEdDSA,
    });
  }

  const disclosed: PassportClaims = {};
  for (const name of DISCLOSABLE_CLAIMS) {
    if (Object.hasOwn(processed.claims, name)) (disclosed as Record<string, unknown>)[name] = processed.claims[name];
  }
  const result: VerifiedPassport = {
    header,
    payload,
    iss,
    sub: payload.sub,
    iat,
    exp,
    vct: payload.vct,
    status: payload.status,
    cnfJwk,
    cnfThumbprint: jwkThumbprint(cnfJwk),
    claims: processed.claims as Record<string, unknown> & PassportClaims,
    disclosed,
    disclosures: processed.disclosures.map((d) => ({
      digest: d.digest,
      salt: d.salt,
      ...(d.name === undefined ? {} : { name: d.name }),
      value: d.value,
    })),
    externalCredentialHash: externalCredentialHash(options.compact),
  };
  if (keyBinding !== undefined) result.keyBinding = keyBinding;
  return result;
}
