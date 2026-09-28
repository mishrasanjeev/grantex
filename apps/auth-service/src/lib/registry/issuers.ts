// SPDX-License-Identifier: Apache-2.0
/**
 * Accredited issuers: the organisations whose Agent Passports and
 * attestations the registry accepts (Agent Trust Registry, Phase 1).
 *
 * An issuer record says who the issuer is (`entity_id`, an OpenID Federation
 * Entity Identifier), which trust marks it is accredited for, the static JWK
 * Set it signs with, where its passport status lists live, and whether it is
 * active, suspended (from a given time, which may be in the future) or
 * withdrawn. The operator writes records through the routes in
 * routes/registry-issuers.ts; everything else reads them through the lookups
 * at the end of this file:
 *
 *   getAccreditedIssuer(sql, entityId)                     the record, or null
 *   isAccreditedFor(sql, entityId, trustMarkType, at?)     accredited, or the denial code
 *   issuerVerificationKey(sql, entityId, kid)              a key that may verify, or null
 *
 * Phase 1 scope: keys are the static JWK Set recorded at accreditation;
 * resolving them through OpenID Federation is Phase 2. Every lookup fails
 * closed: an unknown issuer, an unknown trust mark or a revoked kid is a
 * refusal, and a database error propagates rather than reading as "accredited".
 *
 * The record's members are snake_case on the wire, unlike most of `/v1`,
 * because they are the registry's published vocabulary and follow OpenID
 * Federation's names (`entity_id`, `trust_marks`, `jwks`).
 */
import crypto from 'node:crypto';
import type postgres from 'postgres';
import { queries, type TxSql } from '../../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { newAccreditedIssuerId } from '../ids.js';

type Sql = ReturnType<typeof postgres>;

/** The Phase 1 trust mark taxonomy. The table's CHECK constraint lists the same five. */
export const TRUST_MARK_TYPES = [
  'urn:grantex:tm:provider.entity',
  'urn:grantex:tm:provider.ownership',
  'urn:grantex:tm:provider.screening',
  'urn:grantex:tm:agent.identity',
  'urn:grantex:tm:agent.security',
] as const;
export type TrustMarkType = (typeof TRUST_MARK_TYPES)[number];

export const ISSUER_STATUSES = ['active', 'suspended', 'withdrawn'] as const;
export type IssuerStatus = (typeof ISSUER_STATUSES)[number];

/**
 * The audit chain registry writes go on. It is not a developer's chain: no
 * tenant key reads it, and the `grantex.` actions on it are reserved.
 */
export const REGISTRY_AUDIT_CHAIN = 'grantex:registry';

export const MAX_JWKS_KEYS = 16;
export const MAX_JWKS_BYTES = 16_384;
export const MAX_URL_LENGTH = 2048;
const MAX_KID_LENGTH = 128;
const MAX_REASON_LENGTH = 500;
/** The public list is paged with page and pageSize, as the other paged /v1 lists are. */
export const DEFAULT_PUBLIC_ISSUER_PAGE_SIZE = 100;
export const MAX_PUBLIC_ISSUER_PAGE_SIZE = 500;

export type IssuerJwk = Record<string, string | string[]>;
export interface IssuerJwks { keys: IssuerJwk[] }

/** Denial codes from the registry's list that an accreditation check can answer. */
export type AccreditationDenial = 'issuer_not_accredited' | 'issuer_suspended' | 'trust_mark_missing';
export type AccreditationDecision = { accredited: true } | { accredited: false; code: AccreditationDenial };

/** A request the registry refuses: a malformed record, or one that conflicts with what is stored. */
export class IssuerRecordError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(message: string, field?: string, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'IssuerRecordError';
    this.field = field;
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknownMembers(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const member of Object.keys(body)) {
    if (!allowed.includes(member)) throw new IssuerRecordError(`${member} is not a member of this request`, member);
  }
}

// --- URLs -----------------------------------------------------------------------

/**
 * An https URL in canonical form: a host and no userinfo, query or fragment.
 * Canonical means the WHATWG parser would write it the same way (lower-case
 * host, no dot segments, no default port). A bare origin has exactly one
 * accepted spelling: without the trailing slash, or with it for a prefix
 * (which always ends in "/"). So two spellings of one URL cannot be two
 * records under UNIQUE(entity_id).
 */
function parseHttpsUrl(value: unknown, field: string, options: { prefix?: boolean } = {}): string {
  const refuse = (why: string): never => { throw new IssuerRecordError(`${field} ${why}`, field); };
  if (typeof value !== 'string' || value.length === 0) return refuse('must be an https URL');
  if (value.length > MAX_URL_LENGTH) return refuse(`must be at most ${MAX_URL_LENGTH} characters`);
  if (/\s/.test(value)) return refuse('must not contain whitespace');
  // Checked on the raw string: the parser drops an empty `?` or `#`.
  if (value.includes('?')) return refuse('must not have a query');
  if (value.includes('#')) return refuse('must not have a fragment');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('must be an https URL');
  }
  if (url.protocol !== 'https:') return refuse('must use https');
  const authority = value.slice('https://'.length).split('/', 1)[0] ?? '';
  if (url.username !== '' || url.password !== '' || authority.includes('@')) return refuse('must not carry userinfo');
  if (url.hostname === '') return refuse('must have a host');
  // The parser always writes a bare origin with a trailing slash; a
  // non-prefix URL stores it without, so https://issuer.example/ is refused.
  const bareOrigin = url.pathname === '/';
  const canonical = bareOrigin && !options.prefix ? url.href.slice(0, -1) : url.href;
  if (value !== canonical) return refuse(`must be in canonical form (${canonical})`);
  if (options.prefix && !value.endsWith('/')) {
    // Otherwise https://issuer.example/status would also cover
    // https://issuer.example/status-elsewhere.
    return refuse('must end with "/"');
  }
  return value;
}

/** An OpenID Federation Entity Identifier (OpenID Federation 1.0, section 1.2), without userinfo. */
export function parseEntityId(value: unknown): string {
  return parseHttpsUrl(value, 'entity_id');
}

/** The https prefix every status list of this issuer's passports must sit under. */
export function parseStatusListBase(value: unknown): string {
  return parseHttpsUrl(value, 'status_list_base', { prefix: true });
}

// --- Trust marks ----------------------------------------------------------------

export function isTrustMarkType(value: unknown): value is TrustMarkType {
  return typeof value === 'string' && (TRUST_MARK_TYPES as readonly string[]).includes(value);
}

/** Trust mark type URIs, each from the taxonomy and each at most once. */
export function parseTrustMarks(value: unknown): TrustMarkType[] {
  if (!Array.isArray(value)) throw new IssuerRecordError('trust_marks must be an array of trust mark URIs', 'trust_marks');
  const seen = new Set<string>();
  for (const mark of value) {
    if (!isTrustMarkType(mark)) {
      throw new IssuerRecordError(
        `trust_marks may only contain ${TRUST_MARK_TYPES.join(', ')}; ${JSON.stringify(mark)} is not one of them`,
        'trust_marks',
      );
    }
    if (seen.has(mark)) throw new IssuerRecordError(`trust_marks lists ${mark} twice`, 'trust_marks');
    seen.add(mark);
  }
  return value as TrustMarkType[];
}

// --- JWK Set --------------------------------------------------------------------

/**
 * Members that only a private or symmetric key has: `d` for EC (RFC 7518
 * section 6.2.2) and OKP (RFC 8037 section 2), the RSA private members (RFC
 * 7518 section 6.3.2) and `k` (RFC 7518 section 6.4). A registry that stored
 * one would be publishing an issuer's signing key.
 */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const KNOWN_MEMBERS = ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use', 'key_ops'] as const;

/** A base64url value (no padding) that decodes to exactly `length` bytes. */
function isCoordinate(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value;
}

function parseIssuerKey(value: unknown, index: number): IssuerJwk {
  const where = `jwks.keys[${index}]`;
  const refuse = (why: string): never => { throw new IssuerRecordError(`${where} ${why}`, 'jwks'); };
  if (!isPlainObject(value)) return refuse('must be a JSON object');
  for (const member of PRIVATE_MEMBERS) {
    if (member in value) return refuse(`carries private key material (${member}); register public keys only`);
  }
  for (const member of Object.keys(value)) {
    if (!(KNOWN_MEMBERS as readonly string[]).includes(member)) return refuse(`has an unsupported member ${member}`);
  }
  const { kty, crv, x, y, kid, alg, use } = value;
  const keyOps = value['key_ops'];
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KID_LENGTH || !/^[\x21-\x7e]+$/.test(kid)) {
    return refuse(`needs a kid of 1 to ${MAX_KID_LENGTH} printable characters`);
  }

  let expectedAlg: string;
  if (kty === 'EC') {
    // ES256 is ECDSA using P-256 and SHA-256 (RFC 7518 section 3.4); each
    // coordinate is the full 32-byte size for the curve (section 6.2.1.2-3).
    if (crv !== 'P-256') return refuse('must be an EC key on P-256 (ES256) or an OKP key on Ed25519 (EdDSA)');
    if (!isCoordinate(x, 32) || !isCoordinate(y, 32)) return refuse('must have 32-byte base64url x and y coordinates');
    expectedAlg = 'ES256';
  } else if (kty === 'OKP') {
    // RFC 8037 section 2 (key type OKP) and section 3.1 (alg EdDSA, Ed25519).
    if (crv !== 'Ed25519') return refuse('must be an EC key on P-256 (ES256) or an OKP key on Ed25519 (EdDSA)');
    if (!isCoordinate(x, 32)) return refuse('must have a 32-byte base64url x');
    if (y !== undefined) return refuse('must not have y');
    expectedAlg = 'EdDSA';
  } else {
    return refuse('must be an EC key on P-256 (ES256) or an OKP key on Ed25519 (EdDSA)');
  }
  if (alg !== undefined && alg !== expectedAlg) return refuse(`has alg ${String(alg)}; a ${String(crv)} key is ${expectedAlg}`);
  // RFC 7517 sections 4.2 and 4.3: a verification key, and not both members.
  if (use !== undefined && use !== 'sig') return refuse('must have use "sig"');
  if (keyOps !== undefined) {
    if (use !== undefined) return refuse('must not have both use and key_ops (RFC 7517 section 4.3)');
    if (!Array.isArray(keyOps) || keyOps.length !== 1 || keyOps[0] !== 'verify') return refuse('must have key_ops ["verify"]');
  }

  const key: IssuerJwk = { kty, crv, x: x as string };
  if (kty === 'EC') key['y'] = y as string;
  try {
    // The parser checks that the point is on the curve.
    crypto.createPublicKey({ key: key as crypto.webcrypto.JsonWebKey, format: 'jwk' });
  } catch {
    return refuse('is not a valid public key for its curve');
  }
  key['kid'] = kid;
  key['alg'] = expectedAlg;
  if (use !== undefined) key['use'] = 'sig';
  if (keyOps !== undefined) key['key_ops'] = ['verify'];
  return key;
}

/**
 * A JWK Set (RFC 7517 section 5) of public signing keys: EC P-256 for ES256
 * or OKP Ed25519 for EdDSA, no private members, a kid on every key and no
 * kid twice, at most MAX_JWKS_KEYS keys in MAX_JWKS_BYTES. The stored keys
 * carry only the members listed in KNOWN_MEMBERS, with `alg` filled in.
 */
export function parseIssuerJwks(value: unknown): IssuerJwks {
  if (!isPlainObject(value)) throw new IssuerRecordError('jwks must be a JWK Set: {"keys": [...]}', 'jwks');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JWKS_BYTES) {
    throw new IssuerRecordError(`jwks must be at most ${MAX_JWKS_BYTES} bytes`, 'jwks');
  }
  for (const member of Object.keys(value)) {
    if (member !== 'keys') throw new IssuerRecordError(`jwks has an unsupported member ${member}`, 'jwks');
  }
  const keys = value['keys'];
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
    throw new IssuerRecordError(`jwks.keys must hold 1 to ${MAX_JWKS_KEYS} keys`, 'jwks');
  }
  const parsed = keys.map((key, index) => parseIssuerKey(key, index));
  const kids = parsed.map((key) => key['kid'] as string);
  // RFC 7517 section 4.5 only says SHOULD; a verifier picking a key by kid
  // needs exactly one, so here it is a MUST.
  if (new Set(kids).size !== kids.length) throw new IssuerRecordError('jwks kids must be unique', 'jwks');
  return { keys: parsed };
}

// --- Requests -------------------------------------------------------------------

export interface NewIssuerInput {
  entityId: string;
  did: string | null;
  jwks: IssuerJwks;
  trustMarks: TrustMarkType[];
  statusListBase: string;
  eventsEndpoint: string | null;
  dataResidency: string | null;
  accreditationEvidenceRef: string;
}

const ACCREDITATION_MEMBERS = [
  'entity_id', 'did', 'jwks', 'trust_marks', 'status_list_base', 'events_endpoint', 'data_residency',
  'accreditation_evidence_ref',
] as const;

function parseDid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 512 || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value)) {
    throw new IssuerRecordError('did must be a DID (did:<method>:<id>)', 'did');
  }
  return value;
}

function parseDataResidency(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value)) {
    throw new IssuerRecordError('data_residency must be a short region label such as "EU"', 'data_residency');
  }
  return value;
}

/**
 * A reference into the operator's own accreditation records: a case number
 * or document id, never the evidence. The narrow alphabet (no spaces, no
 * JSON) is what keeps a pasted document out of this column.
 */
function parseEvidenceRef(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new IssuerRecordError(
      'accreditation_evidence_ref must be an opaque reference of 1 to 256 characters (letters, digits, . _ : / -), not the evidence itself',
      'accreditation_evidence_ref',
    );
  }
  return value;
}

export function parseAccreditationRequest(body: unknown): NewIssuerInput {
  if (!isPlainObject(body)) throw new IssuerRecordError('body must be a JSON object');
  refuseUnknownMembers(body, ACCREDITATION_MEMBERS);
  return {
    entityId: parseEntityId(body['entity_id']),
    did: parseDid(body['did']),
    jwks: parseIssuerJwks(body['jwks']),
    trustMarks: parseTrustMarks(body['trust_marks']),
    statusListBase: parseStatusListBase(body['status_list_base']),
    eventsEndpoint: body['events_endpoint'] === undefined || body['events_endpoint'] === null
      ? null
      : parseHttpsUrl(body['events_endpoint'], 'events_endpoint'),
    dataResidency: parseDataResidency(body['data_residency']),
    accreditationEvidenceRef: parseEvidenceRef(body['accreditation_evidence_ref']),
  };
}

export interface IssuerPatch {
  /** `effectiveFrom` is set for a suspension and null otherwise. */
  status?: { status: IssuerStatus; effectiveFrom: Date | null };
  trustMarks?: TrustMarkType[];
  jwks?: IssuerJwks;
  revokeKids?: string[];
  reason: string;
}

const PATCH_MEMBERS = ['status', 'effective_from', 'trust_marks', 'jwks', 'revoke_kids', 'reason'] as const;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIssuerPatch(body: unknown, now: Date = new Date()): IssuerPatch {
  if (!isPlainObject(body)) throw new IssuerRecordError('body must be a JSON object');
  refuseUnknownMembers(body, PATCH_MEMBERS);
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new IssuerRecordError(`reason is required (at most ${MAX_REASON_LENGTH} characters)`, 'reason');
  }
  const patch: IssuerPatch = { reason };

  const status = body['status'];
  const effectiveFrom = body['effective_from'];
  if (status !== undefined) {
    if (typeof status !== 'string' || !(ISSUER_STATUSES as readonly string[]).includes(status)) {
      throw new IssuerRecordError(`status must be one of ${ISSUER_STATUSES.join(', ')}`, 'status');
    }
    if (status === 'suspended') {
      let from = now;
      if (effectiveFrom !== undefined) {
        if (typeof effectiveFrom !== 'string' || !RFC3339.test(effectiveFrom) || Number.isNaN(Date.parse(effectiveFrom))) {
          throw new IssuerRecordError('effective_from must be an RFC 3339 date-time', 'effective_from');
        }
        from = new Date(effectiveFrom);
      }
      patch.status = { status, effectiveFrom: from };
    } else {
      if (effectiveFrom !== undefined) {
        throw new IssuerRecordError('effective_from applies only to status "suspended"', 'effective_from');
      }
      patch.status = { status: status as IssuerStatus, effectiveFrom: null };
    }
  } else if (effectiveFrom !== undefined) {
    throw new IssuerRecordError('effective_from applies only to status "suspended"', 'effective_from');
  }

  if (body['trust_marks'] !== undefined) patch.trustMarks = parseTrustMarks(body['trust_marks']);

  if (body['revoke_kids'] !== undefined) {
    const kids = body['revoke_kids'];
    if (!Array.isArray(kids) || kids.length === 0 || kids.length > MAX_JWKS_KEYS
        || kids.some((kid) => typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KID_LENGTH)
        || new Set(kids).size !== kids.length) {
      throw new IssuerRecordError(`revoke_kids must list 1 to ${MAX_JWKS_KEYS} distinct kids`, 'revoke_kids');
    }
    patch.revokeKids = kids as string[];
  }

  if (body['jwks'] !== undefined) {
    const jwks = parseIssuerJwks(body['jwks']);
    const revoking = new Set(patch.revokeKids ?? []);
    const clash = jwks.keys.find((key) => revoking.has(key['kid'] as string));
    if (clash) throw new IssuerRecordError(`jwks carries kid ${String(clash['kid'])}, which this request revokes`, 'jwks');
    patch.jwks = jwks;
  }

  if (!patch.status && !patch.trustMarks && !patch.jwks && !patch.revokeKids) {
    throw new IssuerRecordError('nothing to change: give status, trust_marks, jwks or revoke_kids');
  }
  return patch;
}

// --- Records --------------------------------------------------------------------

export interface RevokedKey { kid: string; revokedAt: Date }

export interface IssuerRecord {
  id: string;
  entityId: string;
  did: string | null;
  jwks: IssuerJwks;
  trustMarks: TrustMarkType[];
  status: IssuerStatus;
  suspendedEffectiveFrom: Date | null;
  statusListBase: string;
  eventsEndpoint: string | null;
  dataResidency: string | null;
  accreditedAt: Date;
  accreditationEvidenceRef: string;
  createdAt: Date;
  updatedAt: Date;
  revokedKeys: RevokedKey[];
}

/**
 * What the status is at `at`. A suspension is in force from its effective
 * time; before that the issuer is still active. A suspension with no time
 * (which the table does not allow) reads as in force.
 */
export function effectiveIssuerStatus(
  record: { status: IssuerStatus; suspendedEffectiveFrom: Date | null },
  at: Date,
): IssuerStatus {
  if (record.status !== 'suspended') return record.status;
  if (record.suspendedEffectiveFrom !== null && at.getTime() < record.suspendedEffectiveFrom.getTime()) return 'active';
  return 'suspended';
}

export interface PublicIssuerInput {
  entityId: string;
  trustMarks: readonly string[];
  status: IssuerStatus;
  suspendedEffectiveFrom: Date | null;
  statusListBase: string;
  jwks: IssuerJwks;
  revokedKids: readonly string[];
}

export interface PublicIssuer {
  entity_id: string;
  trust_marks: string[];
  status: IssuerStatus;
  status_list_base: string;
  jwks: IssuerJwks;
}

/**
 * The minimised public record: who, which marks, whether it is in force now,
 * where its status lists live and the keys that may still verify. A revoked
 * kid is left out, and a withdrawn issuer publishes no keys at all.
 */
export function toPublicIssuer(input: PublicIssuerInput, at: Date): PublicIssuer {
  const status = effectiveIssuerStatus(input, at);
  const revoked = new Set(input.revokedKids);
  return {
    entity_id: input.entityId,
    trust_marks: [...input.trustMarks],
    status,
    status_list_base: input.statusListBase,
    jwks: { keys: status === 'withdrawn' ? [] : input.jwks.keys.filter((key) => !revoked.has(key['kid'] as string)) },
  };
}

/** The operator's view: the whole record, including what the public list leaves out. */
export function toOperatorIssuer(record: IssuerRecord) {
  return {
    id: record.id,
    entity_id: record.entityId,
    did: record.did,
    jwks: record.jwks,
    trust_marks: record.trustMarks,
    status: record.status,
    suspended_effective_from: record.suspendedEffectiveFrom?.toISOString() ?? null,
    status_list_base: record.statusListBase,
    events_endpoint: record.eventsEndpoint,
    data_residency: record.dataResidency,
    accredited_at: record.accreditedAt.toISOString(),
    accreditation_evidence_ref: record.accreditationEvidenceRef,
    revoked_keys: record.revokedKeys.map((key) => ({ kid: key.kid, revoked_at: key.revokedAt.toISOString() })),
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toJwks(value: unknown): IssuerJwks {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  // A stored set that is not a set is corruption: refuse it rather than
  // treat it as "no keys" and carry on.
  if (!isPlainObject(parsed) || !Array.isArray(parsed['keys'])) {
    throw new Error('accredited issuer row has a malformed jwks column');
  }
  return parsed as unknown as IssuerJwks;
}

function toRecord(row: Record<string, unknown>): IssuerRecord {
  const revoked = typeof row['revoked_keys'] === 'string'
    ? JSON.parse(row['revoked_keys']) as unknown
    : row['revoked_keys'];
  return {
    id: row['id'] as string,
    entityId: row['entity_id'] as string,
    did: (row['did'] as string | null) ?? null,
    jwks: toJwks(row['jwks']),
    trustMarks: (row['trust_marks'] as TrustMarkType[]) ?? [],
    status: row['status'] as IssuerStatus,
    suspendedEffectiveFrom: row['suspended_effective_from'] ? toDate(row['suspended_effective_from']) : null,
    statusListBase: row['status_list_base'] as string,
    eventsEndpoint: (row['events_endpoint'] as string | null) ?? null,
    dataResidency: (row['data_residency'] as string | null) ?? null,
    accreditedAt: toDate(row['accredited_at']),
    accreditationEvidenceRef: row['accreditation_evidence_ref'] as string,
    createdAt: toDate(row['created_at']),
    updatedAt: toDate(row['updated_at']),
    revokedKeys: (Array.isArray(revoked) ? revoked as Array<{ kid: string; revoked_at: string }> : [])
      .map((key) => ({ kid: key.kid, revokedAt: toDate(key.revoked_at) })),
  };
}

async function selectIssuer(sql: TxSql, by: { id: string } | { entityId: string }, forUpdate = false) {
  const rows = 'id' in by
    ? (forUpdate
      ? await sql`SELECT * FROM accredited_issuers WHERE id = ${by.id} FOR UPDATE`
      : await sql`SELECT * FROM accredited_issuers WHERE id = ${by.id}`)
    : await sql`SELECT * FROM accredited_issuers WHERE entity_id = ${by.entityId}`;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const revoked = await sql`
    SELECT kid, revoked_at FROM accredited_issuer_revoked_keys
    WHERE issuer_id = ${row['id'] as string} ORDER BY revoked_at, kid`;
  return toRecord({ ...row, revoked_keys: [...revoked] });
}

// --- Writes ---------------------------------------------------------------------

function kidsOf(jwks: IssuerJwks): string[] {
  return jwks.keys.map((key) => key['kid'] as string);
}

/**
 * Accredit an issuer and audit it, in one transaction. Refuses a second
 * record for the same entity_id with 409 ISSUER_EXISTS.
 */
export async function createAccreditedIssuer(
  sql: Sql,
  input: NewIssuerInput,
  requestedBy: string,
): Promise<IssuerRecord> {
  return sql.begin(async (tx) => {
    // The registry chain's lock also serialises registry writes.
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    const id = newAccreditedIssuerId();
    const inserted = await tx`
      INSERT INTO accredited_issuers (
        id, entity_id, did, jwks, trust_marks, status, status_list_base, events_endpoint, data_residency,
        accreditation_evidence_ref
      ) VALUES (
        ${id}, ${input.entityId}, ${input.did}, ${tx.json(input.jwks as unknown as postgres.JSONValue)},
        ${input.trustMarks}, 'active', ${input.statusListBase}, ${input.eventsEndpoint}, ${input.dataResidency},
        ${input.accreditationEvidenceRef}
      )
      ON CONFLICT (entity_id) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) {
      throw new IssuerRecordError(`${input.entityId} is already in the registry`, 'entity_id', 409, 'ISSUER_EXISTS');
    }
    await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [{
      action: 'grantex.registry.issuer_accredited',
      metadata: {
        issuerId: id,
        entityId: input.entityId,
        trustMarks: input.trustMarks,
        kids: kidsOf(input.jwks),
        statusListBase: input.statusListBase,
        requestedBy,
      },
    }]);
    const record = await selectIssuer(tx, { id });
    if (!record) throw new Error('accredited issuer vanished inside its own transaction');
    return record;
  }) as Promise<IssuerRecord>;
}

/**
 * Apply an operator's change to one issuer and audit it, in one transaction.
 * Null when there is no such issuer. A replacement JWK Set that carries a
 * kid revoked now or before is refused with 409 KID_REVOKED: a revoked key
 * does not come back under its old name.
 */
export async function updateAccreditedIssuer(
  sql: Sql,
  id: string,
  patch: IssuerPatch,
  requestedBy: string,
): Promise<IssuerRecord | null> {
  return sql.begin(async (tx) => {
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    const current = await selectIssuer(tx, { id }, true);
    if (!current) return null;

    const revokedKids = new Set([...current.revokedKeys.map((key) => key.kid), ...(patch.revokeKids ?? [])]);
    if (patch.jwks) {
      const back = kidsOf(patch.jwks).find((kid) => revokedKids.has(kid));
      if (back !== undefined) {
        throw new IssuerRecordError(`kid ${back} has been revoked and cannot be registered again`, 'jwks', 409, 'KID_REVOKED');
      }
    }

    const status = patch.status?.status ?? current.status;
    const suspendedFrom = patch.status ? patch.status.effectiveFrom : current.suspendedEffectiveFrom;
    const trustMarks = patch.trustMarks ?? current.trustMarks;
    const jwks = patch.jwks ?? current.jwks;
    await tx`
      UPDATE accredited_issuers
      SET status = ${status},
          suspended_effective_from = ${suspendedFrom},
          trust_marks = ${trustMarks},
          jwks = ${tx.json(jwks as unknown as postgres.JSONValue)},
          updated_at = NOW()
      WHERE id = ${id}`;
    for (const kid of patch.revokeKids ?? []) {
      // Revoking a kid twice keeps the first revocation time.
      await tx`
        INSERT INTO accredited_issuer_revoked_keys (issuer_id, kid, reason)
        VALUES (${id}, ${kid}, ${patch.reason})
        ON CONFLICT (issuer_id, kid) DO NOTHING`;
    }

    const changes: Record<string, unknown> = {};
    if (patch.status) {
      changes['status'] = patch.status.status;
      if (patch.status.effectiveFrom) changes['effectiveFrom'] = patch.status.effectiveFrom.toISOString();
    }
    if (patch.trustMarks) changes['trustMarks'] = patch.trustMarks;
    if (patch.jwks) changes['kids'] = kidsOf(patch.jwks);
    if (patch.revokeKids) changes['revokedKids'] = patch.revokeKids;
    await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [{
      action: 'grantex.registry.issuer_updated',
      metadata: { issuerId: id, entityId: current.entityId, reason: patch.reason, changes, requestedBy },
    }]);
    return selectIssuer(tx, { id });
  }) as Promise<IssuerRecord | null>;
}

// --- Reads ----------------------------------------------------------------------

export interface PublicIssuerPage {
  issuers: PublicIssuer[];
  /** How many issuers the registry lists in all, so a full page is never taken for the whole list. */
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One page of the issuers, minimised for the public list, ordered by
 * entity_id (unique, so pages neither overlap nor skip). `page` is from 1 and
 * `pageSize` at most MAX_PUBLIC_ISSUER_PAGE_SIZE; the route validates both.
 *
 * The count and the page come from one statement, so from one snapshot: the
 * total always describes the rows it was read with. Past the last page the
 * lateral join still yields the one row carrying the count, with no issuer.
 */
export async function listPublicIssuers(
  sql: Sql,
  paging: { page: number; pageSize: number } = { page: 1, pageSize: DEFAULT_PUBLIC_ISSUER_PAGE_SIZE },
  at: Date = new Date(),
): Promise<PublicIssuerPage> {
  const { page, pageSize } = paging;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize)
    || pageSize < 1 || pageSize > MAX_PUBLIC_ISSUER_PAGE_SIZE || !Number.isSafeInteger((page - 1) * pageSize)) {
    throw new RangeError(`page must be >= 1 and pageSize between 1 and ${MAX_PUBLIC_ISSUER_PAGE_SIZE}`);
  }
  const rows = await sql`
    WITH counted AS (SELECT count(*)::int AS total FROM accredited_issuers)
    SELECT c.total, p.*
    FROM counted c
    LEFT JOIN LATERAL (
      SELECT i.entity_id, i.trust_marks, i.status, i.suspended_effective_from, i.status_list_base, i.jwks,
             ARRAY(SELECT r.kid FROM accredited_issuer_revoked_keys r WHERE r.issuer_id = i.id) AS revoked_kids
      FROM accredited_issuers i
      ORDER BY i.entity_id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    ) p ON true
    ORDER BY p.entity_id`;
  const total = Number(rows[0]?.['total']);
  // Fail loudly rather than answer a page whose total is unknown: a relying
  // party pages until it has `total` issuers, and a wrong total would make it
  // stop early and treat a listed issuer as unknown.
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('accredited issuer count missing from the page query');
  const issuers = rows.filter((row) => row['entity_id'] != null).map((row) => toPublicIssuer({
    entityId: row['entity_id'] as string,
    trustMarks: (row['trust_marks'] as string[]) ?? [],
    status: row['status'] as IssuerStatus,
    suspendedEffectiveFrom: row['suspended_effective_from'] ? toDate(row['suspended_effective_from']) : null,
    statusListBase: row['status_list_base'] as string,
    jwks: toJwks(row['jwks']),
    revokedKids: (row['revoked_kids'] as string[]) ?? [],
  }, at));
  return { issuers, total, page, pageSize };
}

/** The issuer's record, whatever its status, or null when the registry does not know it. */
export async function getAccreditedIssuer(sql: Sql, entityId: string): Promise<IssuerRecord | null> {
  if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > MAX_URL_LENGTH) return null;
  return selectIssuer(queries(sql), { entityId });
}

/**
 * Whether `entityId` is accredited for `trustMarkType` at `at` (now by
 * default). Unknown or withdrawn: issuer_not_accredited. Suspended at `at`:
 * issuer_suspended. Not accredited for that mark, or a mark outside the
 * taxonomy: trust_mark_missing. A database error propagates.
 */
export async function isAccreditedFor(
  sql: Sql,
  entityId: string,
  trustMarkType: string,
  at: Date = new Date(),
): Promise<AccreditationDecision> {
  const record = await getAccreditedIssuer(sql, entityId);
  if (!record) return { accredited: false, code: 'issuer_not_accredited' };
  const status = effectiveIssuerStatus(record, at);
  if (status === 'withdrawn') return { accredited: false, code: 'issuer_not_accredited' };
  if (status === 'suspended') return { accredited: false, code: 'issuer_suspended' };
  if (!isTrustMarkType(trustMarkType) || !record.trustMarks.includes(trustMarkType)) {
    return { accredited: false, code: 'trust_mark_missing' };
  }
  return { accredited: true };
}

/**
 * The public key `kid` of `entityId`, or null when the issuer is unknown or
 * withdrawn, the kid is revoked, or the set has no such kid. It does not
 * check suspension: whether the issuer may be relied on is isAccreditedFor's
 * question, and callers ask both.
 */
export async function issuerVerificationKey(sql: Sql, entityId: string, kid: string): Promise<IssuerJwk | null> {
  const record = await getAccreditedIssuer(sql, entityId);
  if (!record || record.status === 'withdrawn') return null;
  if (record.revokedKeys.some((key) => key.kid === kid)) return null;
  return record.jwks.keys.find((key) => key['kid'] === kid) ?? null;
}
