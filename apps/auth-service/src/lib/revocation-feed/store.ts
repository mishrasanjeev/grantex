/**
 * Reading the revocation feed and the revocation status of one credential.
 *
 * Two shapes of answer:
 *
 * - a **snapshot** of everything currently revoked or suspended and not yet
 *   expired, read from `grants` and `grant_tokens` (authoritative), for a
 *   client starting cold;
 * - the **feed** of changes since a cursor, read from
 *   `grant_revocation_events` (filled by triggers), for a client keeping up.
 *
 * The cursor only ever advances past entries older than the settle window, so
 * a transaction that inserted a lower sequence number but committed later is
 * still delivered. Entries are idempotent (a set of revoked identifiers), so
 * the re-delivery that costs is harmless.
 */
import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export type FeedAction = 'revoked' | 'suspended' | 'resumed' | 'token_revoked';

export interface FeedEntry {
  seq: number;
  action: FeedAction;
  grantId: string | null;
  jti: string | null;
  expiresAt: string | null;
  at: string;
}

export interface SnapshotPage {
  entries: FeedEntry[];
  nextPageToken: string | null;
}

export const MAX_PAGE = 1_000;

interface FeedRow {
  seq: string | number;
  developer_id: string;
  grant_id: string | null;
  jti: string | null;
  action: FeedAction;
  expires_at: Date | string | null;
  created_at: Date | string;
}

function toEntry(row: FeedRow): FeedEntry {
  return {
    seq: Number(row.seq),
    action: row.action,
    grantId: row.grant_id,
    jti: row.jti,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    at: new Date(row.created_at).toISOString(),
  };
}

let triggersPresent = false;

/**
 * Is the feed trustworthy? Both triggers must exist, or entries would be
 * missing and a client could believe a revoked grant is live. Cached once it
 * is true (a trigger is never dropped at run time).
 */
export async function feedReady(sql: Sql): Promise<boolean> {
  if (triggersPresent) return true;
  const rows = await sql<{ present: boolean }[]>`
    SELECT COUNT(*) = 2 AS present FROM pg_trigger
     WHERE tgname IN ('grant_revocation_event_trg', 'grant_token_revocation_event_trg')`;
  triggersPresent = rows[0]?.present === true;
  return triggersPresent;
}

/** For tests: forget whether the triggers were found. */
export function resetFeedReadyCache(): void {
  triggersPresent = false;
}

/** Entries after `since`, oldest first. */
export async function readSince(sql: Sql, developerId: string, since: number, limit = MAX_PAGE): Promise<FeedEntry[]> {
  const rows = await sql<FeedRow[]>`
    SELECT seq, developer_id, grant_id, jti, action, expires_at, created_at
      FROM grant_revocation_events
     WHERE developer_id = ${developerId} AND seq > ${since}
     ORDER BY seq
     LIMIT ${Math.min(limit, MAX_PAGE)}`;
  return rows.map(toEntry);
}

/**
 * How far the cursor may advance: the highest sequence number that can no
 * longer be overtaken by a transaction still in flight.
 */
export async function settledCursor(sql: Sql, developerId: string, since: number, settleSeconds: number): Promise<number> {
  const rows = await sql<{ cursor: string | null }[]>`
    SELECT MAX(seq)::text AS cursor
      FROM grant_revocation_events
     WHERE developer_id = ${developerId} AND seq > ${since}
       AND created_at < NOW() - make_interval(secs => ${settleSeconds})`;
  const value = rows[0]?.cursor;
  return value === null || value === undefined ? since : Number(value);
}

/** The newest sequence number for this developer, settled or not. */
export async function headSeq(sql: Sql, developerId: string): Promise<number> {
  const rows = await sql<{ head: string | null }[]>`
    SELECT MAX(seq)::text AS head FROM grant_revocation_events WHERE developer_id = ${developerId}`;
  const value = rows[0]?.head;
  return value === null || value === undefined ? 0 : Number(value);
}

function encodeToken(kind: 'g' | 't', id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

function decodeToken(token: string | undefined): { kind: 'g' | 't'; id: string } {
  if (token === undefined || token === '') return { kind: 'g', id: '' };
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const kind = decoded.slice(0, 1);
  if ((kind !== 'g' && kind !== 't') || decoded.slice(1, 2) !== ':') {
    throw new Error('pageToken is not a revocation snapshot cursor');
  }
  return { kind, id: decoded.slice(2) };
}

/**
 * One page of everything currently revoked or suspended and still inside its
 * validity: grants first, then individually revoked tokens.
 */
export async function snapshotPage(
  sql: Sql,
  developerId: string,
  pageToken: string | undefined,
  limit = MAX_PAGE,
): Promise<SnapshotPage> {
  const size = Math.min(limit, MAX_PAGE);
  const from = decodeToken(pageToken);
  const entries: FeedEntry[] = [];

  if (from.kind === 'g') {
    const rows = await sql<Array<{ id: string; status: string; expires_at: Date | string; changed_at: Date | string }>>`
      SELECT id, status, expires_at, COALESCE(revoked_at, issued_at, NOW()) AS changed_at
        FROM grants
       WHERE developer_id = ${developerId}
         AND status IN ('revoked', 'suspended')
         AND expires_at > NOW()
         AND id > ${from.id}
       ORDER BY id
       LIMIT ${size}`;
    for (const row of rows) {
      entries.push({
        seq: 0,
        action: row.status === 'suspended' ? 'suspended' : 'revoked',
        grantId: row.id,
        jti: null,
        expiresAt: new Date(row.expires_at).toISOString(),
        at: new Date(row.changed_at).toISOString(),
      });
    }
    if (rows.length === size) {
      return { entries, nextPageToken: encodeToken('g', rows[rows.length - 1]!.id) };
    }
  }

  const remaining = size - entries.length;
  const tokenRows = await sql<Array<{ jti: string; grant_id: string; expires_at: Date | string }>>`
    SELECT gt.jti, gt.grant_id, gt.expires_at
      FROM grant_tokens gt JOIN grants g ON g.id = gt.grant_id
     WHERE g.developer_id = ${developerId}
       AND gt.is_revoked = TRUE
       AND gt.expires_at > NOW()
       AND gt.jti > ${from.kind === 't' ? from.id : ''}
     ORDER BY gt.jti
     LIMIT ${remaining}`;
  for (const row of tokenRows) {
    entries.push({
      seq: 0,
      action: 'token_revoked',
      grantId: row.grant_id,
      jti: row.jti,
      expiresAt: new Date(row.expires_at).toISOString(),
      at: new Date(row.expires_at).toISOString(),
    });
  }
  return {
    entries,
    nextPageToken: tokenRows.length === remaining && remaining > 0
      ? encodeToken('t', tokenRows[tokenRows.length - 1]!.jti)
      : null,
  };
}

export type CredentialStatus = 'active' | 'revoked' | 'suspended' | 'expired' | 'unknown';

export interface RevocationStatus {
  status: CredentialStatus;
  /** True for anything an agent must not act on, including a credential this developer does not have. */
  revoked: boolean;
  grantId: string | null;
  jti: string | null;
  expiresAt: string | null;
}

/**
 * The current status of one grant or token. Fails closed: a credential this
 * developer does not have reads as `unknown`, which callers treat as revoked.
 */
export async function revocationStatus(
  sql: Sql,
  developerId: string,
  grantId: string | null,
  jti: string | null,
): Promise<RevocationStatus> {
  if (jti !== null) {
    const rows = await sql<Array<{ grant_id: string; status: string; token_revoked: boolean; expires_at: Date | string }>>`
      SELECT gt.grant_id, g.status, gt.is_revoked AS token_revoked, LEAST(gt.expires_at, g.expires_at) AS expires_at
        FROM grant_tokens gt JOIN grants g ON g.id = gt.grant_id
       WHERE gt.jti = ${jti} AND g.developer_id = ${developerId}
         AND (${grantId}::text IS NULL OR gt.grant_id = ${grantId})`;
    const row = rows[0];
    if (!row) return { status: 'unknown', revoked: true, grantId, jti, expiresAt: null };
    const expiresAt = new Date(row.expires_at).toISOString();
    if (row.token_revoked || row.status === 'revoked') {
      return { status: 'revoked', revoked: true, grantId: row.grant_id, jti, expiresAt };
    }
    if (row.status === 'suspended') {
      return { status: 'suspended', revoked: true, grantId: row.grant_id, jti, expiresAt };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return { status: 'expired', revoked: true, grantId: row.grant_id, jti, expiresAt };
    }
    return { status: 'active', revoked: false, grantId: row.grant_id, jti, expiresAt };
  }

  const rows = await sql<Array<{ id: string; status: string; expires_at: Date | string }>>`
    SELECT id, status, expires_at FROM grants WHERE id = ${grantId} AND developer_id = ${developerId}`;
  const row = rows[0];
  if (!row) return { status: 'unknown', revoked: true, grantId, jti, expiresAt: null };
  const expiresAt = new Date(row.expires_at).toISOString();
  if (row.status === 'revoked') return { status: 'revoked', revoked: true, grantId: row.id, jti, expiresAt };
  if (row.status === 'suspended') return { status: 'suspended', revoked: true, grantId: row.id, jti, expiresAt };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { status: 'expired', revoked: true, grantId: row.id, jti, expiresAt };
  }
  return { status: 'active', revoked: false, grantId: row.id, jti, expiresAt };
}

/** Delete entries whose credential expired longer than `retentionHours` ago. */
export async function pruneFeed(sql: Sql, retentionHours: number): Promise<number> {
  const rows = await sql<{ deleted: string }[]>`
    WITH removed AS (
      DELETE FROM grant_revocation_events
       WHERE created_at < NOW() - make_interval(hours => ${retentionHours})
         AND (expires_at IS NULL OR expires_at < NOW() - make_interval(hours => ${retentionHours}))
      RETURNING seq
    )
    SELECT COUNT(*)::text AS deleted FROM removed`;
  return Number(rows[0]?.deleted ?? '0');
}
