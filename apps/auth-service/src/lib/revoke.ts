import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { emitEvent } from './events.js';
import { grantsRevokedTotal } from './metrics.js';
import { revokeVCsByGrantIds } from './vc.js';

export interface RevokeResult {
  revoked: boolean;
  descendantCount: number;
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

  let grant: Record<string, unknown> | undefined;
  let descendantRows: Record<string, unknown>[] = [];
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
    const rows = await tx`
      UPDATE grants
      SET status = 'revoked', revoked_at = NOW()
      WHERE id = ${grantId}
        AND developer_id = ${developerId}
        AND status = 'active'
      RETURNING id, expires_at
    `;
    grant = rows[0];
    if (!grant) return;

    // Revoke the complete tree in the same transaction as the root. The
    // developer predicate protects tenant boundaries even if bad historical
    // data contains a cross-developer parent reference.
    descendantRows = await tx`
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
  });

  if (!grant) {
    return { revoked: false, descendantCount: 0 };
  }

  // Redis is an acceleration layer; the database remains authoritative. Cache
  // outages must not turn an already-committed revocation into a failed API
  // response that cannot be retried.
  const redis = getRedis();
  const revokedRows = [grant, ...descendantRows];
  await Promise.allSettled(revokedRows.map(async (row) => {
    const expiresAt = new Date(row['expires_at'] as string);
    const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await redis.set(`revoked:grant:${row['id'] as string}`, '1', 'EX', ttlSeconds);
  }));

  // Revoke associated VCs (best-effort, non-blocking)
  const allRevokedIds = revokedRows.map(r => r['id'] as string);
  revokeVCsByGrantIds(allRevokedIds, developerId).catch(() => {});

  // Emit event (best-effort, non-blocking)
  emitEvent(developerId, 'grant.revoked', {
    grantId,
    cascade: descendantRows.length > 0,
  }).catch(() => {});

  grantsRevokedTotal.inc(1 + descendantRows.length);

  return { revoked: true, descendantCount: descendantRows.length };
}
