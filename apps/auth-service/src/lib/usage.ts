/**
 * Usage metering — Redis-based real-time counters with periodic PostgreSQL rollup.
 */

import { getRedis } from '../redis/client.js';
import { config } from '../config.js';

export type UsageMetric = 'token_exchanges' | 'authorizations' | 'verifications';

function redisKey(developerId: string, metric: UsageMetric, date: string): string {
  return `usage:${developerId}:${metric}:${date}`;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Increment a usage counter for a developer.
 * Uses Redis INCR for atomicity and TTL for auto-cleanup.
 */
export async function incrementUsage(
  developerId: string,
  metric: UsageMetric,
): Promise<void> {
  if (!config.usageMeteringEnabled) return;

  try {
    const redis = getRedis();
    const date = todayString();
    const key = redisKey(developerId, metric, date);
    await redis.incr(key);
    // Set TTL of 48 hours on the key (enough for rollup to process)
    await redis.expire(key, 172800);
  } catch {
    // Best-effort — don't fail the request if Redis is unavailable
  }
}

/**
 * Get current usage counter for a developer/metric/date.
 */
export async function getUsageCount(
  developerId: string,
  metric: UsageMetric,
  date?: string,
): Promise<number> {
  const redis = getRedis();
  const key = redisKey(developerId, metric, date ?? todayString());
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Get all usage counters for a developer for a specific date.
 */
export async function getDailyUsage(
  developerId: string,
  date?: string,
): Promise<Record<UsageMetric, number>> {
  const d = date ?? todayString();
  const [exchanges, authorizations, verifications] = await Promise.all([
    getUsageCount(developerId, 'token_exchanges', d),
    getUsageCount(developerId, 'authorizations', d),
    getUsageCount(developerId, 'verifications', d),
  ]);

  return {
    token_exchanges: exchanges,
    authorizations: authorizations,
    verifications: verifications,
  };
}
