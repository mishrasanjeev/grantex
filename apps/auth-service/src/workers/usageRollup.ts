/**
 * Usage rollup worker — periodically persists Redis usage counters to PostgreSQL.
 *
 * Runs every hour. Reads Redis keys matching `usage:*:{date}` and upserts
 * aggregated counts into the usage_daily table.
 */

import type postgres from 'postgres';
import type { Redis } from 'ioredis';

interface UsageCounters {
  token_exchanges: number;
  authorizations: number;
  verifications: number;
}

/**
 * Roll up usage counters for a specific developer + date.
 */
async function rollupDeveloper(
  sql: ReturnType<typeof postgres>,
  redis: Redis,
  developerId: string,
  date: string,
  usageDailyId: string,
): Promise<void> {
  const metrics = ['token_exchanges', 'authorizations', 'verifications'] as const;
  const counters: UsageCounters = { token_exchanges: 0, authorizations: 0, verifications: 0 };

  for (const metric of metrics) {
    const key = `usage:${developerId}:${metric}:${date}`;
    const val = await redis.get(key);
    counters[metric] = val ? parseInt(val, 10) : 0;
  }

  const total = counters.token_exchanges + counters.authorizations + counters.verifications;
  if (total === 0) return;

  await sql`
    INSERT INTO usage_daily (id, developer_id, date, token_exchanges, authorizations, verifications, total_requests)
    VALUES (
      ${usageDailyId}, ${developerId}, ${date},
      ${counters.token_exchanges}, ${counters.authorizations}, ${counters.verifications}, ${total}
    )
    ON CONFLICT (developer_id, date) DO UPDATE SET
      token_exchanges = ${counters.token_exchanges},
      authorizations = ${counters.authorizations},
      verifications = ${counters.verifications},
      total_requests = ${total},
      updated_at = NOW()
  `;
}

/**
 * Process rollup for all developers with usage data.
 */
export async function processUsageRollup(
  sql: ReturnType<typeof postgres>,
  redis: Redis,
  newUsageDailyId: () => string,
): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);

  // Get all developers with active usage
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM developers
  `;

  let count = 0;
  for (const row of rows) {
    try {
      await rollupDeveloper(sql, redis, row.id, date, newUsageDailyId());
      count++;
    } catch {
      // Best-effort per developer
    }
  }

  return count;
}

/**
 * Start the rollup worker as a periodic interval.
 * Returns a cleanup function.
 */
export function startUsageRollupWorker(
  sql: ReturnType<typeof postgres>,
  redis: Redis,
  newUsageDailyId: () => string,
  intervalMs = 3600_000, // 1 hour
): () => void {
  const timer = setInterval(async () => {
    try {
      await processUsageRollup(sql, redis, newUsageDailyId);
    } catch {
      // Log but don't crash
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
