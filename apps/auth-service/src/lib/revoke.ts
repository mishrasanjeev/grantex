import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { fireWebhooks } from './webhook.js';

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

  const rows = await sql`
    UPDATE grants
    SET status = 'revoked', revoked_at = NOW()
    WHERE id = ${grantId}
      AND developer_id = ${developerId}
      AND status = 'active'
    RETURNING id, expires_at
  `;

  const grant = rows[0];
  if (!grant) {
    return { revoked: false, descendantCount: 0 };
  }

  // Set Redis revocation key with TTL
  const redis = getRedis();
  const expiresAt = new Date(grant['expires_at'] as string);
  const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  await redis.set(`revoked:grant:${grantId}`, '1', 'EX', ttlSeconds);

  // Cascade-revoke all descendant grants via recursive CTE
  const descendantRows = await sql`
    WITH RECURSIVE descendants AS (
      SELECT id, expires_at FROM grants WHERE parent_grant_id = ${grantId} AND status = 'active'
      UNION ALL
      SELECT g.id, g.expires_at FROM grants g
      JOIN descendants d ON g.parent_grant_id = d.id WHERE g.status = 'active'
    )
    UPDATE grants SET status = 'revoked', revoked_at = NOW()
    WHERE id IN (SELECT id FROM descendants)
    RETURNING id, expires_at
  `;

  for (const row of descendantRows) {
    const descExpiresAt = new Date(row['expires_at'] as string);
    const descTtl = Math.max(1, Math.floor((descExpiresAt.getTime() - Date.now()) / 1000));
    await redis.set(`revoked:grant:${row['id'] as string}`, '1', 'EX', descTtl);
  }

  // Fire webhook event (best-effort, non-blocking)
  fireWebhooks(developerId, 'grant.revoked', {
    grantId,
    cascade: descendantRows.length > 0,
  }).catch(() => {});

  return { revoked: true, descendantCount: descendantRows.length };
}
