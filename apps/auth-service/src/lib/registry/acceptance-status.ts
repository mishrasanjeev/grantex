// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's attestation-acceptance status lists.
 *
 * For every registered attestation the registry states, under its own issuer
 * identifier (`JWT_ISSUER`), whether it accepts it: VALID (accepted), INVALID
 * (withdrawn, final) or SUSPENDED, the status types of
 * draft-ietf-oauth-status-list-21 §7.1. The same entries are published two
 * ways, each built from the rows in migration 123 and never from the other:
 *
 * - a Token Status List token, draft-ietf-oauth-status-list-21 §5.1, at
 *   `GET /status/attestations/:list`, two bits per entry;
 * - Bitstring Status List credentials, W3C Bitstring Status List v1.0 §2.2,
 *   secured as VC-JWTs (W3C VC-JOSE-COSE §3.1.1), at
 *   `GET /status/attestations/:list/bitstring` (statusPurpose `revocation`,
 *   set for INVALID) and `.../bitstring/suspension` (statusPurpose
 *   `suspension`, set for SUSPENDED).
 *
 * Both are signed with the platform signing key, so the `kid` resolves from
 * `/.well-known/jwks.json`.
 *
 * Later waves use three calls: `allocateAcceptanceEntry()` when an
 * attestation is registered, which returns the `{ uri, idx }` a passport
 * carries; `setAcceptance(uri, idx, status)` when the registry's decision
 * changes; and `noteRegistryCascade()` for a change that is not an entry's,
 * such as an issuer suspension. Any of them can run inside the caller's
 * transaction, so an attestation is never recorded without its entry.
 *
 * ttl follows owner decision 9: 600 s normally, 60 s for one hour after any
 * acceptance change or suspension (the cascade window). The Token Status List
 * `ttl` claim is in seconds (§5.1); the Bitstring Status List `ttl` property
 * is in milliseconds (§2.2).
 */
import { createHash, randomInt } from 'node:crypto';
import { SignJWT } from 'jose';
import { ulid } from 'ulid';
import { getSql, queries, type TxSql } from '../../db/client.js';
import { config } from '../../config.js';
import { getKeyPair } from '../crypto.js';
import {
  ACCEPTANCE_LIST_CAPACITY,
  TOKEN_STATUS,
  encodeBitstringStatusList,
  encodeTokenStatusList,
  type StatusEntry,
} from './status-list-codec.js';

export type AcceptanceStatus = 'valid' | 'invalid' | 'suspended';
export type BitstringStatusPurpose = 'revocation' | 'suspension';

export type AcceptanceStatusErrorCode =
  /** PRD Appendix C: the entry or list is not one the registry allocated. */
  | 'attestation_not_registered'
  /** PRD Appendix C: the acceptance was withdrawn, which is final. */
  | 'attestation_not_accepted'
  | 'invalid_request'
  | 'allocation_exhausted';

export class AcceptanceStatusError extends Error {
  readonly code: AcceptanceStatusErrorCode;

  constructor(code: AcceptanceStatusErrorCode, message: string) {
    super(message);
    this.name = 'AcceptanceStatusError';
    this.code = code;
  }
}

/** Owner decision 9: ttl outside a cascade window. */
export const NORMAL_TTL_SECONDS = 600;
/** Owner decision 9: ttl inside a cascade window. */
export const CASCADE_TTL_SECONDS = 60;
/** Owner decision 9: a cascade window lasts one hour after the change. */
export const CASCADE_WINDOW_SECONDS = 3600;
/**
 * `exp - iat` of every published list. A copy replayed after the registry
 * changed its decision stops being usable within the hour; a relying party
 * that cannot fetch a fresh one fails closed (`status_stale`).
 */
export const STATUS_LIST_LIFETIME_SECONDS = 3600;
/**
 * Lists are re-signed at most this often while unchanged. `iat` is aligned to
 * it, so every instance publishes the same claims for the same version and
 * the weak ETag stays stable across instances.
 */
export const ISSUE_INTERVAL_SECONDS = 300;
/** Per-client ceiling on each public status-list route. */
export const ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE = 300;
/** Where the lists are served, under PUBLIC_BASE_URL. */
export const ACCEPTANCE_LIST_PATH = '/status/attestations';

/** draft-ietf-oauth-status-list-21 §4.1: two bits carry VALID, INVALID and SUSPENDED. */
const TSL_BITS = 2;
/**
 * New entries are drawn from a list until it is three quarters allocated.
 * Past that a random draw lands on a used index too often; the next list
 * takes over. At the ceiling a draw succeeds with probability 1/4, so 64
 * attempts fail together with probability below 1e-7.
 */
const ALLOCATION_ATTEMPTS = 64;
const LIST_ID_RE = /^racl_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_VALUE: Record<AcceptanceStatus, number> = {
  valid: TOKEN_STATUS.VALID,
  invalid: TOKEN_STATUS.INVALID,
  suspended: TOKEN_STATUS.SUSPENDED,
};
const CREATE_LIST_LOCK = 'grantex:registry-acceptance-lists';

// ── URIs ────────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return config.publicBaseUrl.replace(/\/+$/, '');
}

export function isAcceptanceListId(listId: string): boolean {
  return LIST_ID_RE.test(listId);
}

/** The status list URI: the Token Status List `sub` and a passport's `uri`. */
export function acceptanceListUri(listId: string): string {
  return `${baseUrl()}${ACCEPTANCE_LIST_PATH}/${listId}`;
}

/** What every one of the registry's list URIs starts with: the URI is this followed by the list id. */
export function acceptanceListUriPrefix(): string {
  return `${baseUrl()}${ACCEPTANCE_LIST_PATH}/`;
}

/** The list id in one of the registry's own list URIs, or null for any other URI. */
export function acceptanceListIdFromUri(uri: string): string | null {
  const prefix = `${baseUrl()}${ACCEPTANCE_LIST_PATH}/`;
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) return null;
  const listId = uri.slice(prefix.length);
  return isAcceptanceListId(listId) ? listId : null;
}

function bitstringCredentialId(listId: string, purpose: BitstringStatusPurpose): string {
  const base = `${acceptanceListUri(listId)}/bitstring`;
  return purpose === 'revocation' ? base : `${base}/suspension`;
}

// ── ttl ─────────────────────────────────────────────────────────────────────

/**
 * Owner decision 9. A change stamped later than `now` (clock skew between
 * instances) is inside the window: erring towards the shorter ttl only
 * costs a few extra fetches.
 */
export function acceptanceTtlSeconds(now: Date, cascadeAt: Date | null): number {
  if (cascadeAt === null) return NORMAL_TTL_SECONDS;
  return now.getTime() < cascadeAt.getTime() + CASCADE_WINDOW_SECONDS * 1000
    ? CASCADE_TTL_SECONDS
    : NORMAL_TTL_SECONDS;
}

// ── Store ───────────────────────────────────────────────────────────────────

async function inTransaction<T>(tx: TxSql | undefined, run: (tx: TxSql) => Promise<T>): Promise<T> {
  // A caller's transaction handle has no `begin`; run on it directly so the
  // entry commits or rolls back with the caller's work.
  if (tx) return run(tx);
  return await getSql().begin(async (own) => run(own as unknown as TxSql)) as T;
}

async function claimSlot(tx: TxSql): Promise<{ id: string; capacity: number } | null> {
  // The condition is repeated on the outer UPDATE so that Postgres re-checks
  // it against the row it locked: two allocations racing for the last slot
  // below the ceiling cannot both take it.
  const rows = await tx`
    UPDATE registry_acceptance_lists
    SET allocated = allocated + 1
    WHERE id = (
      SELECT id FROM registry_acceptance_lists
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
 * Allocate an entry for a newly registered attestation, VALID (accepted)
 * until `setAcceptance` says otherwise (draft-ietf-oauth-status-list-21
 * §13.3: the default value is the most common one, so an unused index
 * cannot be told from an accepted attestation).
 *
 * The index is drawn with `crypto.randomInt` (Bitstring Status List v1.0
 * §2.1: indexes SHOULD be assigned randomly). The table's primary key makes a
 * second allocation of the same index impossible however many run at once;
 * a draw that lands on a used index draws again.
 *
 * The slot counter is one row per list, and the UPDATE that claims a slot
 * holds that row's lock until the transaction ends. Inside a caller's
 * transaction, call this as late as possible so concurrent registrations
 * wait on the row only for the rest of that transaction.
 */
export async function allocateAcceptanceEntry(tx?: TxSql): Promise<{ uri: string; idx: number }> {
  return inTransaction(tx, async (sql) => {
    let list = await claimSlot(sql);
    if (!list) {
      // No list yet, or the newest is at its ceiling. Serialise creation so a
      // burst of registrations produces one new list rather than one each.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${CREATE_LIST_LOCK}, 0))`;
      list = await claimSlot(sql);
      if (!list) {
        const id = `racl_${ulid()}`;
        await sql`
          INSERT INTO registry_acceptance_lists (id, capacity, allocated)
          VALUES (${id}, ${ACCEPTANCE_LIST_CAPACITY}, 1)
        `;
        list = { id, capacity: ACCEPTANCE_LIST_CAPACITY };
      }
    }

    for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt++) {
      const idx = randomInt(list.capacity);
      const rows = await sql`
        INSERT INTO registry_acceptance_entries (list_id, idx)
        VALUES (${list.id}, ${idx})
        ON CONFLICT (list_id, idx) DO NOTHING
        RETURNING idx
      `;
      if (rows[0]) return { uri: acceptanceListUri(list.id), idx };
    }
    // Throwing rolls back the counter as well; nothing is half-allocated.
    throw new AcceptanceStatusError(
      'allocation_exhausted',
      `no free index found in list ${list.id} after ${ALLOCATION_ATTEMPTS} random draws`,
    );
  });
}

/**
 * Record the registry's decision on one attestation.
 *
 * INVALID is final (Bitstring Status List v1.0 §2.1: revocation "is not
 * reversible"): an attempt to reinstate or suspend a withdrawn attestation
 * is refused with `attestation_not_accepted`, never silently applied. A URI
 * that is not one of the registry's lists, or an index never allocated, is
 * refused with `attestation_not_registered`. Setting the status an entry
 * already has changes nothing and does not open a cascade window.
 */
export async function setAcceptance(
  uri: string,
  idx: number,
  status: AcceptanceStatus,
  tx?: TxSql,
): Promise<{ version: number }> {
  if (!Object.prototype.hasOwnProperty.call(STATUS_VALUE, status)) {
    throw new AcceptanceStatusError('invalid_request', `unknown acceptance status ${String(status)}`);
  }
  if (!Number.isInteger(idx) || idx < 0) {
    throw new AcceptanceStatusError('invalid_request', `index ${idx} is not a non-negative integer`);
  }
  const listId = acceptanceListIdFromUri(uri);
  if (!listId) {
    throw new AcceptanceStatusError('attestation_not_registered', 'not one of the registry\'s acceptance lists');
  }
  const next = STATUS_VALUE[status];

  return inTransaction(tx, async (sql) => {
    const rows = await sql`
      SELECT status FROM registry_acceptance_entries
      WHERE list_id = ${listId} AND idx = ${idx}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new AcceptanceStatusError('attestation_not_registered', `entry ${idx} of ${listId} was never allocated`);
    }
    const current = Number(row['status']);
    if (current === next) {
      const [list] = await sql`SELECT version FROM registry_acceptance_lists WHERE id = ${listId}`;
      return { version: Number(list!['version']) };
    }
    if (current === TOKEN_STATUS.INVALID) {
      throw new AcceptanceStatusError('attestation_not_accepted', `entry ${idx} of ${listId} was withdrawn; that is final`);
    }
    await sql`
      UPDATE registry_acceptance_entries
      SET status = ${next}, updated_at = NOW()
      WHERE list_id = ${listId} AND idx = ${idx}
    `;
    const [list] = await sql`
      UPDATE registry_acceptance_lists
      SET version = version + 1, updated_at = NOW(), cascade_at = NOW()
      WHERE id = ${listId}
      RETURNING version
    `;
    return { version: Number(list!['version']) };
  });
}

/**
 * Open the cascade window on every list without changing an entry, for a
 * registry change relying parties must see quickly that is not an entry's
 * own, such as an accredited issuer's suspension.
 */
export async function noteRegistryCascade(tx?: TxSql): Promise<void> {
  const sql = tx ?? queries(getSql());
  await sql`UPDATE registry_acceptance_lists SET cascade_at = NOW()`;
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export interface AcceptanceSnapshot {
  listId: string;
  uri: string;
  capacity: number;
  version: number;
  /** When an entry's status last changed. */
  updatedAt: Date;
  /** Start of the latest cascade window on any of the registry's lists. */
  cascadeAt: Date | null;
  /** Every entry that is not VALID. */
  entries: readonly StatusEntry[];
}

interface CachedEntries {
  version: number;
  updatedAt: Date;
  entries: readonly StatusEntry[];
}

const MAX_CACHED_LISTS = 256;
const entryCache = new Map<string, CachedEntries>();
const signedCache = new Map<string, { key: string; signed: SignedStatusList }>();

/** Forget cached entries and signed lists (tests). */
export function resetAcceptanceStatusCache(): void {
  entryCache.clear();
  signedCache.clear();
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  if (cache.size >= MAX_CACHED_LISTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('registry acceptance list has an unreadable timestamp');
  return date;
}

/**
 * Read a list as it stands. Null only when the list does not exist; a store
 * that cannot be read throws, and the caller must not fall back to an older
 * copy (an attestation withdrawn since would read as accepted).
 *
 * The entries of a version are read once and kept: a version is immutable,
 * because every change bumps it. They are read in one statement together
 * with the version they belong to, so a change committing in between cannot
 * pair new entries with an old version.
 */
export async function loadAcceptanceSnapshot(listId: string, tx?: TxSql): Promise<AcceptanceSnapshot | null> {
  if (!isAcceptanceListId(listId)) return null;
  const sql = tx ?? queries(getSql());
  const rows = await sql`
    SELECT id, capacity, version, updated_at,
           (SELECT MAX(cascade_at) FROM registry_acceptance_lists) AS cascade_at
    FROM registry_acceptance_lists
    WHERE id = ${listId}
  `;
  const row = rows[0];
  if (!row) return null;
  const capacity = Number(row['capacity']);
  const version = Number(row['version']);
  let cascadeAt = row['cascade_at'] === null || row['cascade_at'] === undefined ? null : asDate(row['cascade_at']);

  let cached = entryCache.get(listId);
  if (!cached || cached.version !== version) {
    const entryRows = await sql`
      WITH list AS (
        SELECT version, updated_at,
               (SELECT MAX(cascade_at) FROM registry_acceptance_lists) AS cascade_at
        FROM registry_acceptance_lists WHERE id = ${listId}
      )
      SELECT list.version, list.updated_at, list.cascade_at, e.idx, e.status
      FROM list
      LEFT JOIN registry_acceptance_entries e
        ON e.list_id = ${listId} AND e.status <> 0
    `;
    const first = entryRows[0];
    if (!first) return null;
    const entries: StatusEntry[] = [];
    for (const entry of entryRows) {
      if (entry['idx'] === null || entry['idx'] === undefined) continue;
      const idx = Number(entry['idx']);
      const status = Number(entry['status']);
      // A row the schema should have refused: fail rather than publish a
      // list that says something the registry never decided.
      if (!Number.isInteger(idx) || idx < 0 || idx >= capacity
          || (status !== TOKEN_STATUS.INVALID && status !== TOKEN_STATUS.SUSPENDED)) {
        throw new Error(`registry acceptance list ${listId} holds an invalid entry`);
      }
      entries.push({ idx, status });
    }
    cached = { version: Number(first['version']), updatedAt: asDate(first['updated_at']), entries };
    remember(entryCache, listId, cached);
    // A change that committed between the two reads is in these entries; its
    // cascade window must be too, or the new content goes out with the long ttl.
    if (first['cascade_at'] !== null && first['cascade_at'] !== undefined) {
      const latest = asDate(first['cascade_at']);
      if (cascadeAt === null || latest > cascadeAt) cascadeAt = latest;
    }
  }

  return {
    listId,
    uri: acceptanceListUri(listId),
    capacity,
    version: cached.version,
    updatedAt: cached.updatedAt,
    cascadeAt,
    entries: cached.entries,
  };
}

// ── Published outputs ───────────────────────────────────────────────────────

export interface SignedStatusList {
  /** JWS compact serialization. */
  token: string;
  /** Weak ETag over the protected header and claims. */
  etag: string;
  ttlSeconds: number;
  iat: number;
  exp: number;
  claims: Record<string, unknown>;
}

/**
 * `iat` for a list signed at `now`: the start of the current issue interval,
 * moved later to the last change it reflects and to the last ttl switch, so
 * it never precedes what the list states. Never later than `now`.
 */
function issuedAt(snapshot: AcceptanceSnapshot, now: Date): number {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let iat = nowSeconds - (nowSeconds % ISSUE_INTERVAL_SECONDS);
  const candidates = [Math.floor(snapshot.updatedAt.getTime() / 1000)];
  if (snapshot.cascadeAt) {
    const start = Math.floor(snapshot.cascadeAt.getTime() / 1000);
    candidates.push(start, start + CASCADE_WINDOW_SECONDS);
  }
  for (const candidate of candidates) {
    if (candidate <= nowSeconds && candidate > iat) iat = candidate;
  }
  return iat;
}

function weakEtag(signingInput: string): string {
  return `W/"${createHash('sha256').update(signingInput).digest('base64url').slice(0, 32)}"`;
}

async function sign(
  cacheKey: string,
  snapshot: AcceptanceSnapshot,
  now: Date,
  typ: string,
  extraHeader: Record<string, string>,
  build: (times: { iat: number; exp: number; ttlSeconds: number }) => Record<string, unknown>,
): Promise<SignedStatusList> {
  const { privateKey, kid, alg } = getKeyPair();
  const ttlSeconds = acceptanceTtlSeconds(now, snapshot.cascadeAt);
  const iat = issuedAt(snapshot, now);
  const exp = iat + STATUS_LIST_LIFETIME_SECONDS;
  const key = `${snapshot.version}|${ttlSeconds}|${iat}|${alg}|${kid}`;
  const cached = signedCache.get(cacheKey);
  if (cached && cached.key === key) return cached.signed;

  const claims = build({ iat, exp, ttlSeconds });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg, kid, typ, ...extraHeader })
    .sign(privateKey);
  const signed: SignedStatusList = {
    token,
    etag: weakEtag(token.slice(0, token.lastIndexOf('.'))),
    ttlSeconds,
    iat,
    exp,
    claims,
  };
  remember(signedCache, cacheKey, { key, signed });
  return signed;
}

/**
 * The Token Status List token (draft-ietf-oauth-status-list-21 §5.1): typ
 * `statuslist+jwt`; `sub` the list URI; `iat`, `exp`, `ttl` (seconds); and
 * `status_list` with `bits` 2 and `lst` (§4.2). `iss` is the registry.
 */
export async function signTokenStatusList(snapshot: AcceptanceSnapshot, now: Date = new Date()): Promise<SignedStatusList> {
  return sign(`tsl:${snapshot.listId}`, snapshot, now, 'statuslist+jwt', {}, ({ iat, exp, ttlSeconds }) => ({
    iss: config.jwtIssuer,
    sub: snapshot.uri,
    iat,
    exp,
    ttl: ttlSeconds,
    status_list: {
      bits: TSL_BITS,
      lst: encodeTokenStatusList(snapshot.entries, { bits: TSL_BITS, size: snapshot.capacity }),
    },
  }));
}

/**
 * A BitstringStatusListCredential (W3C Bitstring Status List v1.0 §2.2) for
 * one purpose, secured as a VC-JWT (W3C VC-JOSE-COSE §3.1.1: the credential
 * is the claims set, typ `vc+jwt`, cty `vc`, no `vc` claim). `iat` and `exp`
 * are the signature's; `validFrom` and `validUntil` say the same of the list.
 * `ttl` is in milliseconds (§2.2) and matches Cache-Control.
 */
export async function signBitstringStatusListCredential(
  snapshot: AcceptanceSnapshot,
  purpose: BitstringStatusPurpose,
  now: Date = new Date(),
): Promise<SignedStatusList> {
  const wanted = purpose === 'revocation' ? TOKEN_STATUS.INVALID : TOKEN_STATUS.SUSPENDED;
  const id = bitstringCredentialId(snapshot.listId, purpose);
  return sign(`bsl:${purpose}:${snapshot.listId}`, snapshot, now, 'vc+jwt', { cty: 'vc' }, ({ iat, exp, ttlSeconds }) => ({
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: config.jwtIssuer,
    validFrom: new Date(iat * 1000).toISOString(),
    validUntil: new Date(exp * 1000).toISOString(),
    credentialSubject: {
      id: `${id}#list`,
      type: 'BitstringStatusList',
      statusPurpose: purpose,
      encodedList: encodeBitstringStatusList(
        snapshot.entries.filter((entry) => entry.status === wanted).map((entry) => entry.idx),
        snapshot.capacity,
      ),
      ttl: ttlSeconds * 1000,
    },
    iat,
    exp,
  }));
}
