import type postgres from 'postgres';
import type { Redis } from 'ioredis';

type Sql = ReturnType<typeof postgres>;

const REDIS_REVOKED_PASSPORT_KEY = 'commerce:revoked:passport';

export type RevocationCheck =
  | { revoked: false; source: 'redis' | 'postgres' }
  | { revoked: true; source: 'redis' | 'postgres'; reason?: string }
  | { revoked: false; source: 'fail_closed_unavailable'; error: string };

/**
 * Check whether a passport jti is revoked.
 *
 * Strategy:
 *   1. Redis SISMEMBER on commerce:revoked:passport (fast path).
 *   2. On Redis miss or error, fall through to Postgres lookup.
 *   3. If Postgres also unavailable → return source='fail_closed_unavailable'.
 *      The CALLER decides what to do; for payment-affecting actions, the
 *      route layer must treat this as deny (fail closed). For browse
 *      reads the route layer may degrade.
 *
 * NB: The check is a positive-existence check on a revocation row, so a
 * Redis miss is informative only when accompanied by a successful
 * Postgres confirmation. We do not assume "Redis miss = not revoked" —
 * the tombstone could simply not be cached yet.
 */
export async function checkPassportRevocation(
  sql: Sql,
  redis: Redis | null,
  jti: string,
): Promise<RevocationCheck> {
  if (redis) {
    try {
      const isMember = await redis.sismember(REDIS_REVOKED_PASSPORT_KEY, jti);
      if (isMember === 1) {
        return { revoked: true, source: 'redis' };
      }
      // Cache miss — fall through to Postgres for authoritative answer.
    } catch {
      // Redis error — fall through to Postgres; do not throw yet.
    }
  }

  try {
    const rows = await sql<Array<{ reason: string }>>`
      SELECT reason FROM commerce_passport_revocations
       WHERE jti = ${jti}
       LIMIT 1
    `;
    if (rows[0]) {
      // Warm Redis on the way out so subsequent checks hit the cache.
      if (redis) {
        try {
          await redis.sadd(REDIS_REVOKED_PASSPORT_KEY, jti);
        } catch {
          // best-effort
        }
      }
      return { revoked: true, source: 'postgres', reason: rows[0].reason };
    }
    return { revoked: false, source: 'postgres' };
  } catch (err) {
    return {
      revoked: false,
      source: 'fail_closed_unavailable',
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

/**
 * Insert a revocation row and warm the Redis cache. Idempotent on
 * repeated calls for the same jti (PK conflict ignored).
 */
export async function revokeCommercePassport(
  sql: Sql,
  redis: Redis | null,
  input: {
    jti: string;
    tenantId: string;
    reason: string;
    revokedBy: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO commerce_passport_revocations (jti, tenant_id, reason, revoked_by)
    VALUES (${input.jti}, ${input.tenantId}, ${input.reason}, ${input.revokedBy ?? null})
    ON CONFLICT (jti) DO NOTHING
  `;
  if (redis) {
    try {
      await redis.sadd(REDIS_REVOKED_PASSPORT_KEY, input.jti);
    } catch {
      // best-effort; Postgres is the source of truth.
    }
  }
}
