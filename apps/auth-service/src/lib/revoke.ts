import { config } from '../config.js';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { emitEvent } from './events.js';
import { logger } from './logger.js';
import { grantsRevokedTotal } from './metrics.js';
import { revokeVCsByGrantIds } from './vc.js';
import { releaseWalletReservationsForGrants } from './prepaid-wallet.js';

export interface RevokeResult {
  revoked: boolean;
  descendantCount: number;
}

async function cacheRevokedGrants(rows: Record<string, unknown>[]): Promise<void> {
  const redis = getRedis();
  await Promise.allSettled(rows.map(async (row) => {
    const expiresAt = new Date(row['expires_at'] as string);
    const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await redis.set(`revoked:grant:${row['id'] as string}`, '1', 'EX', ttlSeconds);
  }));
}

/** What `revokeGrantInTx` revoked, for `publishGrantRevocation` after the commit. */
export interface RevokedGrantTree {
  grantId: string;
  /** The root first, then every descendant revoked with it. */
  rows: Record<string, unknown>[];
}

/**
 * Revoke an active grant and every active descendant inside the caller's
 * transaction: the grants, their wallet reservations and their credentials.
 * Returns null when the grant was not active (already revoked, suspended,
 * unknown or another developer's), and nothing is changed.
 *
 * The caller must commit and then call `publishGrantRevocation` with the
 * result; the revocation cache, the webhook and the metric belong after the
 * commit, never inside a transaction that can still roll back. Takes the
 * developer's grant lock (`hashtextextended(developer_id, 4)`); a caller that
 * also appends to the audit chain takes that lock (seed 0) afterwards, the
 * order lib/revocation/cascade.ts uses.
 */
export async function revokeGrantInTx(
  tx: TxSql,
  grantId: string,
  developerId: string,
): Promise<RevokedGrantTree | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
  const rows = await tx`
    UPDATE grants
    SET status = 'revoked', revoked_at = NOW()
    WHERE id = ${grantId}
      AND developer_id = ${developerId}
      AND status = 'active'
    RETURNING id, expires_at
  `;
  const grant = rows[0];
  if (!grant) return null;

  // Revoke the complete tree in the same transaction as the root. The
  // developer predicate protects tenant boundaries even if bad historical
  // data contains a cross-developer parent reference.
  const descendantRows = await tx`
    WITH RECURSIVE descendants AS (
      SELECT id, expires_at
      FROM grants
      WHERE parent_grant_id = ${grantId}
        AND developer_id = ${developerId}
        AND status = 'active'
      UNION
      SELECT g.id, g.expires_at
      FROM grants g
      JOIN descendants d ON g.parent_grant_id = d.id
      WHERE g.developer_id = ${developerId}
        AND g.status = 'active'
    )
    UPDATE grants SET status = 'revoked', revoked_at = NOW()
    WHERE id IN (SELECT id FROM descendants)
      AND developer_id = ${developerId}
    RETURNING id, expires_at
  `;
  const revokedIds = [grantId, ...descendantRows.map((row) => row['id'] as string)];
  await releaseWalletReservationsForGrants(tx, developerId, revokedIds);
  // In the same transaction as the grants themselves. This used to be
  // fire-and-forget after the commit, so a failure left a credential that
  // still verified against a grant that no longer existed — and nothing
  // reported it, because the promise's rejection was swallowed.
  await revokeVCsByGrantIds(revokedIds, developerId, tx);
  return { grantId, rows: [grant, ...descendantRows] };
}

/**
 * Revoke one active grant, and nothing else, inside the caller's
 * transaction: no delegated grant, wallet reservation or credential is
 * touched. Returns null when the grant was not active. The result goes to
 * `publishGrantRevocation` after the commit like `revokeGrantInTx`'s. Takes
 * the same developer grant lock, so it orders with the cascade.
 */
export async function revokeGrantRootOnlyInTx(
  tx: TxSql,
  grantId: string,
  developerId: string,
): Promise<RevokedGrantTree | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
  const rows = await tx`
    UPDATE grants
    SET status = 'revoked', revoked_at = NOW()
    WHERE id = ${grantId}
      AND developer_id = ${developerId}
      AND status = 'active'
    RETURNING id, expires_at
  `;
  const grant = rows[0];
  if (!grant) return null;
  return { grantId, rows: [grant] };
}

/**
 * The revocation a DPDP route or worker makes (a withdrawal with
 * `revokeGrant`, an erasure, an expiry): the record's grant only, as these
 * paths always did, or with DPDP_REVOCATION_CASCADE=true the full cascade of
 * `revokeGrantInTx`.
 */
export function revokeDpdpGrantInTx(
  tx: TxSql,
  grantId: string,
  developerId: string,
): Promise<RevokedGrantTree | null> {
  return config.dpdpRevocationCascade
    ? revokeGrantInTx(tx, grantId, developerId)
    : revokeGrantRootOnlyInTx(tx, grantId, developerId);
}

/**
 * What follows a committed `revokeGrantInTx`: the revocation cache, the
 * `grant.revoked` webhook and the metric.
 */
export async function publishGrantRevocation(
  developerId: string,
  tree: RevokedGrantTree | null,
): Promise<RevokeResult> {
  if (!tree) return { revoked: false, descendantCount: 0 };
  const descendantCount = tree.rows.length - 1;

  // Redis is an acceleration layer; the database remains authoritative. Cache
  // outages must not turn an already-committed revocation into a failed API
  // response that cannot be retried.
  await cacheRevokedGrants(tree.rows);

  // Emit event (best-effort, non-blocking)
  emitEvent(developerId, 'grant.revoked', {
    grantId: tree.grantId,
    cascade: descendantCount > 0,
  }).catch(() => {});

  grantsRevokedTotal.inc(tree.rows.length);

  return { revoked: true, descendantCount };
}

/**
 * Revoke a grant and cascade-revoke all descendant grants.
 * Sets Redis revocation keys and fires webhook events.
 */
export async function revokeGrantCascade(
  grantId: string,
  developerId: string,
): Promise<RevokeResult> {
  const sql = getSql();
  let tree: RevokedGrantTree | null = null;
  await sql.begin(async (_tx) => {
    tree = await revokeGrantInTx(_tx as unknown as TxSql, grantId, developerId);
  });
  return publishGrantRevocation(developerId, tree);
}

/** Revoke an agent's live grants and descendants inside the caller's transaction. */
export async function revokeAgentGrantsInTx(
  tx: TxSql,
  agentId: string,
  developerId: string,
  requireRevokePolicy: boolean,
): Promise<Record<string, unknown>[]> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
  if (requireRevokePolicy) {
    const policy = await tx`
      SELECT irregularity_response_mode FROM developers
      WHERE id = ${developerId} FOR SHARE
    `;
    if (policy[0]?.['irregularity_response_mode'] !== 'revoke_agent_grants') return [];
  }
  // Irregularity auto-revocation also uses this helper and was active-only before lifecycle states.
  const includeSuspended = config.agentLifecycleStatesEnabled;
  const revocableStatuses = includeSuspended ? ['active', 'suspended'] : ['active'];
  const revokedRows = await tx`
    WITH RECURSIVE affected (id) AS (
      SELECT id FROM grants
      WHERE agent_id = ${agentId}
        AND developer_id = ${developerId}
        AND status = ANY(${revocableStatuses})
        AND expires_at > NOW()
      UNION
      SELECT child.id FROM grants child
      JOIN affected parent ON child.parent_grant_id = parent.id
      WHERE child.developer_id = ${developerId}
        AND child.status = ANY(${revocableStatuses})
    )
    UPDATE grants SET status = 'revoked', revoked_at = NOW()
    WHERE id IN (SELECT id FROM affected)
      AND developer_id = ${developerId}
      AND status = ANY(${revocableStatuses})
    RETURNING id, expires_at, parent_grant_id
  `;
  if (revokedRows.length === 0) return [];
  const ids = revokedRows.map((row) => row['id'] as string);
  await releaseWalletReservationsForGrants(tx, developerId, ids);
  await revokeVCsByGrantIds(ids, developerId, tx);
  if (includeSuspended) {
    await tx`DELETE FROM grant_suspensions WHERE developer_id = ${developerId} AND grant_id = ANY(${ids})`;
  }
  return revokedRows;
}

/** Publish the cache and metric only after the transaction commits. */
export async function publishAgentGrantRevocations(rows: Record<string, unknown>[]): Promise<string[]> {
  if (rows.length === 0) return [];
  await cacheRevokedGrants(rows);
  grantsRevokedTotal.inc(rows.length);
  return rows.map((row) => row['id'] as string);
}

/** Notify lifecycle revocations after the committed grant sweep. */
export async function publishLifecycleGrantRevocations(
  developerId: string,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  const ids = await publishAgentGrantRevocations(rows);
  if (ids.length === 0) return ids;
  const revokedIds = new Set(rows.map((row) => row['id'] as string));
  const parentsWithRevokedChildren = new Set(rows
    .map((row) => row['parent_grant_id'])
    .filter((id): id is string => typeof id === 'string' && revokedIds.has(id)));
  const publications = await Promise.allSettled(rows.map((row) =>
    emitEvent(developerId, 'grant.revoked', {
      grantId: row['id'] as string,
      cascade: parentsWithRevokedChildren.has(row['id'] as string),
    }),
  ));
  const failed = publications.filter((result) => result.status === 'rejected').length;
  if (failed > 0) {
    logger.warn({ developerId, failed }, 'lifecycle grant revocation publication failed after commit');
  }
  return ids;
}

/** Revoke every live grant for an agent and its descendants as one atomic operation. */
export async function revokeAgentGrantsCascade(
  agentId: string,
  developerId: string,
  requireRevokePolicy: boolean,
): Promise<string[]> {
  const sql = getSql();
  const revokedRows = await sql.begin(async (_tx) => revokeAgentGrantsInTx(
    _tx as unknown as TxSql, agentId, developerId, requireRevokePolicy,
  ));
  return publishAgentGrantRevocations(revokedRows);
}
