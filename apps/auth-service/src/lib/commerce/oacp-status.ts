// SPDX-License-Identifier: Apache-2.0
/**
 * The OACP Token Status List (draft-ietf-oauth-status-list-21): every issued
 * OACP artifact has an entry, and its envelope names it as
 * `status.status_list = {idx, uri}` (§6.2) with `revocation_status_url` the
 * same https `uri`.
 *
 * Entries are two bits (§4.1): 0 VALID, 1 INVALID (revoked, final), 2
 * SUSPENDED (§7.1). Lists are served at `GET /status/oacp/:list` as
 * `application/statuslist+jwt` (§5.1, §8.2), signed with the platform signing
 * key exactly as the registry acceptance lists are
 * (lib/registry/acceptance-status.ts), so the `kid` resolves from
 * /.well-known/jwks.json.
 *
 * `ttl` is 30 s, the OACP revocation-visibility target
 * (`OACP_REVOCATION_SLA_TARGETS_SECONDS.grantex_revocation_visible`); a
 * relying party re-fetches at least that often, and a copy is unusable an
 * hour after `iat`.
 */
import { createHash, randomInt } from 'node:crypto';
import { SignJWT } from 'jose';
import { getSql, queries, type TxSql } from '../../db/client.js';
import { config } from '../../config.js';
import { getKeyPair } from '../crypto.js';
import { TOKEN_STATUS, encodeTokenStatusList, type StatusEntry } from '../registry/status-list-codec.js';
import { newOacpStatusListId } from './ids.js';
import { isOacpStatusUriAllowed } from './oacp-jws.js';

export type OacpArtifactStatus = 'valid' | 'invalid' | 'suspended';

/** Where the lists are served, under PUBLIC_BASE_URL. */
export const OACP_STATUS_LIST_PATH = '/status/oacp';
/** Entries per list; a multiple of 8 (draft-ietf-oauth-status-list-21 §13.4). */
export const OACP_STATUS_LIST_CAPACITY = 131_072;
/** `ttl` claim, seconds. */
export const OACP_STATUS_LIST_TTL_SECONDS = 30;
/** `exp - iat` of every published list. */
export const OACP_STATUS_LIST_LIFETIME_SECONDS = 3600;
/** Per-client ceiling on the public route. */
export const OACP_STATUS_RATE_LIMIT_PER_MINUTE = 300;
export const OACP_STATUS_LIST_MEDIA_TYPE = 'application/statuslist+jwt';

const TSL_BITS = 2;
const ALLOCATION_ATTEMPTS = 64;
const LIST_ID_RE = /^oacpl_[0-9A-HJKMNP-TV-Z]{26}$/;
const CREATE_LIST_LOCK = 'grantex:oacp-status-lists';
const STATUS_VALUE: Record<OacpArtifactStatus, number> = {
  valid: TOKEN_STATUS.VALID,
  invalid: TOKEN_STATUS.INVALID,
  suspended: TOKEN_STATUS.SUSPENDED,
};

export class OacpStatusError extends Error {
  readonly code: 'status_entry_unknown' | 'status_final' | 'allocation_exhausted' | 'invalid_request';

  constructor(code: OacpStatusError['code'], message: string) {
    super(message);
    this.name = 'OacpStatusError';
    this.code = code;
  }
}

function baseUrl(): string {
  return config.publicBaseUrl.replace(/\/+$/, '');
}

export function isOacpStatusListId(listId: string): boolean {
  return LIST_ID_RE.test(listId);
}

/** The list URI: the token's `sub` and the envelope's `status.status_list.uri`. */
export function oacpStatusListUri(listId: string): string {
  return `${baseUrl()}${OACP_STATUS_LIST_PATH}/${listId}`;
}

/** The list id in one of this service's own OACP list URIs, else null. */
export function oacpStatusListIdFromUri(uri: string): string | null {
  const prefix = `${baseUrl()}${OACP_STATUS_LIST_PATH}/`;
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) return null;
  const listId = uri.slice(prefix.length);
  return isOacpStatusListId(listId) ? listId : null;
}

/**
 * The envelope must carry an https status URI (OACP JWS profile §4), so a
 * service whose PUBLIC_BASE_URL is not https refuses to issue (local
 * development may allow http on a loopback host: OACP_ALLOW_LOOPBACK_HTTP).
 */
export function assertOacpStatusBaseUsable(): void {
  if (!isOacpStatusUriAllowed(oacpStatusListUri('oacpl_00000000000000000000000000'))) {
    throw new Error('OACP issuance requires an https PUBLIC_BASE_URL for its status lists');
  }
}

async function claimSlot(tx: TxSql): Promise<{ id: string; capacity: number } | null> {
  const rows = await tx`
    UPDATE oacp_status_lists
    SET allocated = allocated + 1
    WHERE id = (
      SELECT id FROM oacp_status_lists
      WHERE allocated * 4 < capacity * 3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
      AND allocated * 4 < capacity * 3
    RETURNING id, capacity
  `;
  const row = rows[0];
  return row ? { id: row['id'] as string, capacity: Number(row['capacity']) } : null;
}

/**
 * Allocate a VALID entry for `artifactId` inside the caller's transaction, so
 * an artifact row is never written without its entry (or the reverse).
 * Indexes are drawn at random (draft-ietf-oauth-status-list-21 §13.3 herd
 * privacy); the primary key makes a second allocation of one index impossible.
 */
export async function allocateOacpStatusEntry(tx: TxSql, artifactId: string): Promise<{ uri: string; idx: number }> {
  let list = await claimSlot(tx);
  if (!list) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${CREATE_LIST_LOCK}, 0))`;
    list = await claimSlot(tx);
    if (!list) {
      const id = newOacpStatusListId();
      await tx`
        INSERT INTO oacp_status_lists (id, capacity, allocated)
        VALUES (${id}, ${OACP_STATUS_LIST_CAPACITY}, 1)
      `;
      list = { id, capacity: OACP_STATUS_LIST_CAPACITY };
    }
  }
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt++) {
    const idx = randomInt(list.capacity);
    const rows = await tx`
      INSERT INTO oacp_status_entries (list_id, idx, artifact_id)
      VALUES (${list.id}, ${idx}, ${artifactId})
      ON CONFLICT (list_id, idx) DO NOTHING
      RETURNING idx
    `;
    if (rows[0]) return { uri: oacpStatusListUri(list.id), idx };
  }
  throw new OacpStatusError('allocation_exhausted', `no free index in OACP status list ${list.id}`);
}

/**
 * Set an entry's status. INVALID is final: reinstating or suspending a
 * revoked artifact is refused. Setting the status an entry already has is a
 * no-op that does not bump the list version.
 */
export async function setOacpStatus(tx: TxSql, uri: string, idx: number, status: OacpArtifactStatus): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(STATUS_VALUE, status) || !Number.isInteger(idx) || idx < 0) {
    throw new OacpStatusError('invalid_request', 'unknown status or index');
  }
  const listId = oacpStatusListIdFromUri(uri);
  if (!listId) throw new OacpStatusError('status_entry_unknown', 'not one of this service\'s OACP status lists');
  const [row] = await tx`
    SELECT status FROM oacp_status_entries WHERE list_id = ${listId} AND idx = ${idx} FOR UPDATE
  `;
  if (!row) throw new OacpStatusError('status_entry_unknown', `entry ${idx} of ${listId} was never allocated`);
  const current = Number(row['status']);
  const next = STATUS_VALUE[status];
  if (current === next) return;
  if (current === TOKEN_STATUS.INVALID) {
    throw new OacpStatusError('status_final', `entry ${idx} of ${listId} is revoked; that is final`);
  }
  await tx`
    UPDATE oacp_status_entries SET status = ${next}, updated_at = NOW()
    WHERE list_id = ${listId} AND idx = ${idx}
  `;
  await tx`
    UPDATE oacp_status_lists SET version = version + 1, updated_at = NOW() WHERE id = ${listId}
  `;
}

/** The current status value of one entry, or null when it does not exist. */
export async function readOacpStatus(uri: string, idx: number, tx?: TxSql): Promise<number | null> {
  const listId = oacpStatusListIdFromUri(uri);
  if (!listId || !Number.isInteger(idx) || idx < 0) return null;
  const sql = tx ?? queries(getSql());
  const [row] = await sql`SELECT status FROM oacp_status_entries WHERE list_id = ${listId} AND idx = ${idx}`;
  return row ? Number(row['status']) : null;
}

export interface OacpStatusSnapshot {
  listId: string;
  uri: string;
  capacity: number;
  version: number;
  updatedAt: Date;
  /** Every entry that is not VALID. */
  entries: readonly StatusEntry[];
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('OACP status list has an unreadable timestamp');
  return date;
}

/**
 * A list as it stands, read in one statement so entries and version agree.
 * Null when the list does not exist; a store that cannot be read throws, and
 * the caller must not fall back to an older copy.
 */
export async function loadOacpStatusSnapshot(listId: string, tx?: TxSql): Promise<OacpStatusSnapshot | null> {
  if (!isOacpStatusListId(listId)) return null;
  const sql = tx ?? queries(getSql());
  const rows = await sql`
    SELECT l.capacity, l.version, l.updated_at, e.idx, e.status
    FROM oacp_status_lists l
    LEFT JOIN oacp_status_entries e ON e.list_id = l.id AND e.status <> 0
    WHERE l.id = ${listId}
  `;
  const first = rows[0];
  if (!first) return null;
  const capacity = Number(first['capacity']);
  const entries: StatusEntry[] = [];
  for (const row of rows) {
    if (row['idx'] === null || row['idx'] === undefined) continue;
    const idx = Number(row['idx']);
    const status = Number(row['status']);
    if (!Number.isInteger(idx) || idx < 0 || idx >= capacity
        || (status !== TOKEN_STATUS.INVALID && status !== TOKEN_STATUS.SUSPENDED)) {
      throw new Error(`OACP status list ${listId} holds an invalid entry`);
    }
    entries.push({ idx, status });
  }
  return {
    listId,
    uri: oacpStatusListUri(listId),
    capacity,
    version: Number(first['version']),
    updatedAt: asDate(first['updated_at']),
    entries,
  };
}

export interface SignedOacpStatusList {
  token: string;
  etag: string;
  ttlSeconds: number;
  iat: number;
  exp: number;
}

const signedCache = new Map<string, { key: string; signed: SignedOacpStatusList }>();
const MAX_CACHED_LISTS = 256;

/** Forget signed lists (tests). */
export function resetOacpStatusCache(): void {
  signedCache.clear();
}

/**
 * The Token Status List token (draft-ietf-oauth-status-list-21 §5.1): typ
 * `statuslist+jwt`; `iss` the issuer; `sub` the list URI; `iat`, `exp`,
 * `ttl`; `status_list` with `bits` 2 and `lst`. `iat` is aligned to the ttl
 * and never earlier than the last change, so every instance signs the same
 * claims for the same version.
 */
export async function signOacpStatusList(snapshot: OacpStatusSnapshot, now: Date = new Date()): Promise<SignedOacpStatusList> {
  const { privateKey, kid, alg } = getKeyPair();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let iat = nowSeconds - (nowSeconds % OACP_STATUS_LIST_TTL_SECONDS);
  const changed = Math.floor(snapshot.updatedAt.getTime() / 1000);
  if (changed <= nowSeconds && changed > iat) iat = changed;
  const exp = iat + OACP_STATUS_LIST_LIFETIME_SECONDS;
  const cacheKey = `${snapshot.version}|${iat}|${alg}|${kid}`;
  const cached = signedCache.get(snapshot.listId);
  if (cached && cached.key === cacheKey) return cached.signed;

  const token = await new SignJWT({
    iss: config.jwtIssuer,
    sub: snapshot.uri,
    iat,
    exp,
    ttl: OACP_STATUS_LIST_TTL_SECONDS,
    status_list: {
      bits: TSL_BITS,
      lst: encodeTokenStatusList(snapshot.entries, { bits: TSL_BITS, size: snapshot.capacity }),
    },
  })
    .setProtectedHeader({ alg, kid, typ: 'statuslist+jwt' })
    .sign(privateKey);
  const signed: SignedOacpStatusList = {
    token,
    etag: `W/"${createHash('sha256').update(token.slice(0, token.lastIndexOf('.'))).digest('base64url').slice(0, 32)}"`,
    ttlSeconds: OACP_STATUS_LIST_TTL_SECONDS,
    iat,
    exp,
  };
  signedCache.delete(snapshot.listId);
  if (signedCache.size >= MAX_CACHED_LISTS) {
    const oldest = signedCache.keys().next().value;
    if (oldest !== undefined) signedCache.delete(oldest);
  }
  signedCache.set(snapshot.listId, { key: cacheKey, signed });
  return signed;
}
