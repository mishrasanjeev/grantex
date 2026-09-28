// SPDX-License-Identifier: Apache-2.0
/**
 * The signed registry manifest, `GET /.well-known/agent-registry.json`
 * (PRD §7 Federation and discovery): everything a relying party without
 * OpenID Federation support needs to check an Agent Passport or an
 * attestation offline, in one compact JWS the registry signs.
 *
 *   iss                      the registry's issuer identifier (JWT_ISSUER)
 *   iat, exp                 exp = iat + 1 h (PRD §9: a manifest is stale after an hour)
 *   issuers                  every accredited issuer as the public list shows it:
 *                            entity_id, trust_marks, status in effect,
 *                            status_list_base, jwks without revoked kids
 *   trust_mark_types         the urn:grantex:tm taxonomy
 *   acceptance_status_lists  the registry's acceptance lists, Token Status List
 *                            and Bitstring Status List forms
 *   endpoints                lookup URL templates (RFC 6570 level 1), the
 *                            issuer list, the status list template, the JWKS
 *
 * Phase 1 relying parties use it instead of resolving a Federation trust
 * chain. It is signed with the platform signing key, so its kid resolves
 * from /.well-known/jwks.json, and it is explicitly typed (RFC 8725 §3.11):
 * `typ` is `grantex-registry-manifest+jwt`, the media type
 * `application/grantex-registry-manifest+jwt` without its `application/`
 * prefix as RFC 7515 §4.1.9 recommends, in the way OpenID Federation 1.0 §3
 * types an Entity Statement `entity-statement+jwt` and serves it from a
 * well-known path.
 *
 * `iat` is aligned to a five-minute interval, moved later to the last change
 * the manifest reflects, so every instance publishes the same claims for the
 * same registry state and the ETag is stable across instances.
 *
 * verifyRegistryManifest is the relying party's side, and what the Python
 * verifier mirrors: exact typ, an algorithm from the platform's list, a key
 * from the registry's JWK Set by kid and nothing named in the header, the
 * signature, the members, iss against the registry the caller names (a
 * required argument, never defaulted), and freshness. Every failure is a
 * RegistryManifestError with an Appendix C code; nothing is swallowed,
 * because a manifest that cannot be verified must never read as one that
 * can.
 */
import { createHash } from 'node:crypto';
import {
  compactVerify,
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  SignJWT,
  type JSONWebKeySet,
} from 'jose';
import type postgres from 'postgres';
import { config } from '../../config.js';
import { getSql } from '../../db/client.js';
import { getKeyPair } from '../crypto.js';
import { SIGNING_ALGORITHMS } from '../signing-algorithms.js';
import { ACCEPTANCE_LIST_PATH, acceptanceListUri } from './acceptance-status.js';
import { listAllPublicIssuers, TRUST_MARK_TYPES, type PublicIssuer } from './issuers.js';

type Sql = ReturnType<typeof postgres>;

/** RFC 7515 §4.1.9, RFC 8725 §3.11. */
export const REGISTRY_MANIFEST_TYP = 'grantex-registry-manifest+jwt';
/** What the route serves; `typ` is this without `application/`. */
export const REGISTRY_MANIFEST_MEDIA_TYPE = 'application/grantex-registry-manifest+jwt';
export const REGISTRY_MANIFEST_PATH = '/.well-known/agent-registry.json';
/** exp - iat. */
export const REGISTRY_MANIFEST_LIFETIME_SECONDS = 3600;
/** PRD §9: a relying party does not rely on a manifest issued more than an hour ago. */
export const REGISTRY_MANIFEST_MAX_AGE_SECONDS = 3600;
/** iat is aligned to this, so an unchanged registry re-signs at most this often. */
export const REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS = 300;
/** Clock difference tolerated between the registry and a relying party. */
export const REGISTRY_MANIFEST_CLOCK_TOLERANCE_SECONDS = 60;
/** Per-client ceiling on the manifest route. */
export const REGISTRY_MANIFEST_RATE_LIMIT_PER_MINUTE = 60;

/** Appendix C codes a manifest refusal carries. */
export type RegistryManifestErrorCode = 'passport_invalid_signature' | 'status_stale';

export class RegistryManifestError extends Error {
  constructor(readonly code: RegistryManifestErrorCode, message: string) {
    super(message);
    this.name = 'RegistryManifestError';
  }
}

export interface AcceptanceStatusListForms {
  /** draft-ietf-oauth-status-list-21 §5.1; the `uri` a registry acceptance reference carries. */
  token_status_list: string;
  /** W3C Bitstring Status List v1.0 §2.2, one credential per statusPurpose. */
  bitstring_status_list: { revocation: string; suspension: string };
}

export interface RegistryManifestEndpoints {
  agent_by_did: string;
  agent_by_key_thumbprint: string;
  agent_by_credential: string;
  issuers: string;
  acceptance_status_list: string;
  jwks_uri: string;
}

export interface RegistryManifestClaims {
  iss: string;
  iat: number;
  exp: number;
  issuers: PublicIssuer[];
  trust_mark_types: string[];
  acceptance_status_lists: AcceptanceStatusListForms[];
  endpoints: RegistryManifestEndpoints;
}

/** What a manifest states, read from the store. */
export interface RegistryManifestContent {
  issuers: PublicIssuer[];
  acceptanceListIds: string[];
  /** The latest change the content reflects, or null for none. */
  lastChange: Date | null;
}

export interface SignedRegistryManifest {
  token: string;
  /** Weak ETag over the protected header and claims (RFC 9110 §8.8.1, §8.8.3). */
  etag: string;
  claims: RegistryManifestClaims;
}

function baseUrl(): string {
  return config.publicBaseUrl.replace(/\/+$/, '');
}

/** URL templates are RFC 6570 level 1 (§1.2): simple `{var}` expansion, percent-encoding reserved characters. */
export function registryEndpoints(): RegistryManifestEndpoints {
  const base = baseUrl();
  return {
    agent_by_did: `${base}/v1/registry/agents/{agent_did}`,
    agent_by_key_thumbprint: `${base}/v1/registry/agents?key_thumbprint={key_thumbprint}`,
    agent_by_credential: `${base}/v1/registry/agents?issuer={issuer}&external_credential_id={external_credential_id}&hash={hash}`,
    issuers: `${base}/v1/registry/issuers`,
    acceptance_status_list: `${base}${ACCEPTANCE_LIST_PATH}/{list}`,
    jwks_uri: `${base}/.well-known/jwks.json`,
  };
}

function acceptanceForms(listId: string): AcceptanceStatusListForms {
  const uri = acceptanceListUri(listId);
  return {
    token_status_list: uri,
    bitstring_status_list: { revocation: `${uri}/bitstring`, suspension: `${uri}/bitstring/suspension` },
  };
}

/**
 * The start of the current issue interval, moved later to the last change
 * the manifest reflects when that is not in the future: `iat` never
 * precedes what the manifest states and is never later than `now`.
 */
function issuedAt(lastChange: Date | null, now: Date): number {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let iat = nowSeconds - (nowSeconds % REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS);
  if (lastChange !== null) {
    const changed = Math.floor(lastChange.getTime() / 1000);
    if (changed <= nowSeconds && changed > iat) iat = changed;
  }
  return iat;
}

const MAX_CACHED = 8;
const signedCache = new Map<string, SignedRegistryManifest>();

/** Forget cached signatures (tests). */
export function resetRegistryManifestCache(): void {
  signedCache.clear();
}

/**
 * Sign the manifest for `content` at `now`. The same content in the same
 * interval under the same key gives the same bytes: the signature is
 * cached by its signing input, so an algorithm with randomised signatures
 * (ES256) does not change the ETag on every read.
 */
export async function signRegistryManifest(content: RegistryManifestContent, now: Date = new Date()): Promise<SignedRegistryManifest> {
  const iat = issuedAt(content.lastChange, now);
  const claims: RegistryManifestClaims = {
    iss: config.jwtIssuer,
    iat,
    exp: iat + REGISTRY_MANIFEST_LIFETIME_SECONDS,
    issuers: content.issuers,
    trust_mark_types: [...TRUST_MARK_TYPES],
    acceptance_status_lists: content.acceptanceListIds.map(acceptanceForms),
    endpoints: registryEndpoints(),
  };
  const { privateKey, kid, alg } = getKeyPair();
  const header = { alg, kid, typ: REGISTRY_MANIFEST_TYP };
  const cacheKey = createHash('sha256').update(JSON.stringify([header, claims])).digest('base64url');
  const cached = signedCache.get(cacheKey);
  if (cached) return cached;

  const token = await new SignJWT(claims as unknown as Record<string, unknown>).setProtectedHeader(header).sign(privateKey);
  const signingInput = token.slice(0, token.lastIndexOf('.'));
  const signed: SignedRegistryManifest = {
    token,
    etag: `W/"${createHash('sha256').update(signingInput).digest('base64url').slice(0, 32)}"`,
    claims,
  };
  if (signedCache.size >= MAX_CACHED) {
    const oldest = signedCache.keys().next().value;
    if (oldest !== undefined) signedCache.delete(oldest);
  }
  signedCache.set(cacheKey, signed);
  return signed;
}

/**
 * Read what the manifest states: every accredited issuer (paged, however
 * many there are) and every acceptance list. A store that cannot be read
 * throws; there is no fallback to an older manifest.
 */
export async function loadRegistryManifestContent(sql: Sql, now: Date): Promise<RegistryManifestContent> {
  const { issuers, lastChange: issuerChange } = await listAllPublicIssuers(sql, now);
  const lists = await sql`SELECT id, created_at FROM registry_acceptance_lists ORDER BY created_at, id`;
  let lastChange = issuerChange;
  for (const list of lists) {
    const created = list['created_at'] instanceof Date ? list['created_at'] : new Date(String(list['created_at']));
    if (lastChange === null || created > lastChange) lastChange = created;
  }
  return { issuers, acceptanceListIds: lists.map((list) => list['id'] as string), lastChange };
}

/** The manifest as the route serves it now. */
export async function buildRegistryManifest(options: { sql?: Sql; now?: Date } = {}): Promise<SignedRegistryManifest> {
  const now = options.now ?? new Date();
  const content = await loadRegistryManifestContent(options.sql ?? getSql(), now);
  return signRegistryManifest(content, now);
}

// ── Verification ─────────────────────────────────────────────────────────────

/** Header parameters that would name a key other than one of the registry's (RFC 7515 §4.1.2 to §4.1.6). */
const FOREIGN_KEY_HEADERS = ['jku', 'jwk', 'x5u', 'x5c'] as const;

function invalid(message: string): RegistryManifestError {
  return new RegistryManifestError('passport_invalid_signature', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkClaims(payload: unknown): RegistryManifestClaims {
  if (!isObject(payload)) throw invalid('manifest payload is not a JSON object');
  const { iss, iat, exp, issuers, trust_mark_types: types, acceptance_status_lists: lists, endpoints } = payload;
  if (typeof iss !== 'string' || iss.length === 0) throw invalid('manifest iss is missing');
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw invalid('manifest iat and exp must be integers');
  if (!Array.isArray(issuers) || !Array.isArray(types) || !Array.isArray(lists) || !isObject(endpoints)) {
    throw invalid('manifest is missing issuers, trust_mark_types, acceptance_status_lists or endpoints');
  }
  for (const issuer of issuers) {
    if (!isObject(issuer) || typeof issuer['entity_id'] !== 'string' || typeof issuer['status'] !== 'string'
        || !Array.isArray(issuer['trust_marks']) || typeof issuer['status_list_base'] !== 'string'
        || !isObject(issuer['jwks']) || !Array.isArray((issuer['jwks'] as Record<string, unknown>)['keys'])) {
      throw invalid('manifest carries a malformed issuer');
    }
  }
  return payload as unknown as RegistryManifestClaims;
}

/**
 * Verify a registry manifest with the registry's JWK Set (from its
 * /.well-known/jwks.json) at `now`, as issued by `options.issuer` (the
 * registry the relying party trusts; required), and return its claims.
 *
 * Refusals: `passport_invalid_signature` for anything that makes the
 * manifest untrustworthy (not a compact JWS, another typ, an algorithm the
 * platform does not sign with, a key named in the header, no key in the set
 * for its kid, a signature that does not verify, missing members, no
 * expected issuer or no valid `now` given, another issuer than
 * `options.issuer`); `status_stale` for one that is not fresh (at or after exp, issued more than an hour ago, a lifetime over an hour,
 * or issued in the future beyond the clock tolerance). A relying party that
 * holds no manifest passing this check cannot establish that an issuer is
 * accredited and refuses what depends on it.
 */
export async function verifyRegistryManifest(
  jws: string,
  registryJwks: JSONWebKeySet | { keys: readonly Record<string, unknown>[] },
  now: Date,
  options: { issuer: string },
): Promise<RegistryManifestClaims> {
  // The expected issuer is required, not defaulted: the spec makes the iss
  // check mandatory, and a helper that skipped it when left out would be
  // copied that way. Refused before anything else is read.
  const expectedIssuer = (options as { issuer?: unknown } | undefined)?.issuer;
  if (typeof expectedIssuer !== 'string' || expectedIssuer.length === 0) {
    throw invalid('the registry issuer the relying party trusts is required');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw invalid('now must be a valid Date');
  if (typeof jws !== 'string' || jws.split('.').length !== 3) throw invalid('manifest is not a compact JWS (RFC 7515 §7.1)');
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(jws) as Record<string, unknown>;
  } catch {
    throw invalid('manifest protected header cannot be decoded');
  }
  // Exact string: stricter than RFC 7515 §4.1.9, under which the prefixed
  // form is equivalent; one value has one spelling.
  if (header['typ'] !== REGISTRY_MANIFEST_TYP) throw invalid(`manifest typ must be ${REGISTRY_MANIFEST_TYP}`);
  if (typeof header['alg'] !== 'string' || !(SIGNING_ALGORITHMS as readonly string[]).includes(header['alg'])) {
    throw invalid(`manifest alg must be one of ${SIGNING_ALGORITHMS.join(', ')}`);
  }
  for (const name of FOREIGN_KEY_HEADERS) {
    if (name in header) throw invalid(`manifest must not carry a ${name} header; it verifies with the registry's JWK Set only`);
  }
  if ('crit' in header) throw invalid('manifest must not carry crit');
  if (typeof header['kid'] !== 'string' || header['kid'].length === 0) throw invalid('manifest has no kid');

  let payload: unknown;
  try {
    const keySet = createLocalJWKSet(registryJwks as JSONWebKeySet);
    // RFC 8725 §3.1: the algorithm list is the caller's, never the token's.
    const verified = await compactVerify(jws, keySet, { algorithms: [...SIGNING_ALGORITHMS] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload)) as unknown;
  } catch (err) {
    if (err instanceof errors.JWKSNoMatchingKey) throw invalid('no key in the registry JWK Set matches the manifest kid');
    if (err instanceof errors.JWSSignatureVerificationFailed) throw invalid('manifest signature does not verify');
    if (err instanceof errors.JOSEError) throw invalid(`manifest rejected: ${err.message}`);
    if (err instanceof SyntaxError) throw invalid('manifest payload is not JSON');
    // Anything else is still a refusal: the manifest was not verified.
    throw invalid('manifest could not be verified');
  }

  const claims = checkClaims(payload);
  if (claims.iss !== expectedIssuer) throw invalid('manifest iss is not the expected registry');

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp - claims.iat > REGISTRY_MANIFEST_MAX_AGE_SECONDS || claims.exp <= claims.iat) {
    throw new RegistryManifestError('status_stale', 'manifest lifetime is not within one hour');
  }
  if (claims.iat > nowSeconds + REGISTRY_MANIFEST_CLOCK_TOLERANCE_SECONDS) {
    throw new RegistryManifestError('status_stale', 'manifest iat is in the future');
  }
  if (nowSeconds >= claims.exp) throw new RegistryManifestError('status_stale', 'manifest has expired');
  if (nowSeconds - claims.iat > REGISTRY_MANIFEST_MAX_AGE_SECONDS) {
    throw new RegistryManifestError('status_stale', 'manifest is more than an hour old');
  }
  return claims;
}
