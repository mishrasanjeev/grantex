import { getRedis } from '../redis/client.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Post-auth rate limit keyed on an identifier the caller controls — typically
 * a developer id resolved by the auth plugin. The fastify/rate-limit plugin
 * registered in server.ts runs `onRequest` (before auth), so it cannot see
 * the authenticated developer and has to key on IP. Call this from a route
 * handler once `request.developer` is known to apply a per-developer cap.
 *
 * Fixed-window counter in Redis: one key per (identifier, window). INCR and
 * EXPIREAT execute in one transaction so a partial connection failure cannot
 * leave a counter without a TTL.
 */
export async function checkRateLimit(
  identifier: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSeconds / windowSeconds);
  const key = `ratelimit:${identifier}:${windowIndex}`;

  const windowEndSeconds = (windowIndex + 1) * windowSeconds;
  const transaction = redis.multi();
  transaction.incr(key);
  transaction.expireat(key, windowEndSeconds);
  const results = await transaction.exec();

  const increment = results?.[0];
  const expiry = results?.[1];
  if (!increment || !expiry) {
    throw new Error('Rate limit transaction did not return both results');
  }
  if (increment[0]) throw increment[0];
  if (expiry[0]) throw expiry[0];

  const count = Number(increment[1]);
  if (!Number.isFinite(count)) {
    throw new Error('Rate limit transaction returned an invalid count');
  }

  const resetSeconds = Math.max(1, windowEndSeconds - nowSeconds);

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetSeconds,
  };
}

/**
 * The most counters `checkLocalRateLimit` holds at once. A hard cap, enforced
 * before a counter is added; see the function for what happens at it.
 */
export const LOCAL_COUNTER_CAPACITY = 10_000;

/**
 * Counters in least-recently-used order: every call moves its key to the end,
 * so the first key is the one idle longest. Deleting it is O(1).
 */
const localCounters = new Map<string, { windowEndSeconds: number; count: number }>();
/** No counter kept by the last sweep expires before this; 0 means none has run. */
let nextSweepAtSeconds = 0;
let sweepCount = 0;

/**
 * The same fixed-window count as `checkRateLimit`, held in this process.
 *
 * Only for a caller that must not fail closed when Redis is unreachable — a
 * revocation — but must not become unbounded either. The count is per
 * instance, so across N instances the ceiling is N times `max`: looser than
 * the shared counter, never absent. Identifiers are authenticated developer
 * ids, so the map holds at most one entry per developer seen in a window.
 *
 * Memory is bounded by LOCAL_COUNTER_CAPACITY at O(1) amortised cost per call.
 * When a new key arrives at the cap, expired counters are swept, but at most
 * once until the earliest counter kept by the previous sweep expires (once
 * per window), never a full scan per call. If the map is still full, the
 * least recently used counter is evicted and the new key is tracked. The
 * call is never refused because the map is full: the limiter holds no
 * authority (Postgres does), and a revocation must stay available, so it
 * fails open for the key that loses its counter — that developer starts
 * again from one — rather than for the caller. Refusing to track the new key
 * instead would leave every developer first seen at the cap uncounted, while
 * eviction keeps counting the ones actively calling.
 */
export function checkLocalRateLimit(
  identifier: string,
  max: number,
  windowSeconds: number,
): RateLimitResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowEndSeconds = (Math.floor(nowSeconds / windowSeconds) + 1) * windowSeconds;
  const key = `${identifier}:${windowSeconds}`;

  const current = localCounters.get(key);
  const count = current && current.windowEndSeconds === windowEndSeconds ? current.count + 1 : 1;
  if (current) {
    localCounters.delete(key);
  } else if (localCounters.size >= LOCAL_COUNTER_CAPACITY) {
    if (nowSeconds >= nextSweepAtSeconds) sweepExpiredCounters(nowSeconds, windowEndSeconds);
    if (localCounters.size >= LOCAL_COUNTER_CAPACITY) {
      const oldest = localCounters.keys().next().value;
      if (oldest !== undefined) localCounters.delete(oldest);
    }
  }
  localCounters.set(key, { windowEndSeconds, count });

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetSeconds: Math.max(1, windowEndSeconds - nowSeconds),
  };
}

/** `insertingEndSeconds`: the window end of the counter about to be added, which is kept too. */
function sweepExpiredCounters(nowSeconds: number, insertingEndSeconds: number): void {
  sweepCount += 1;
  let earliestKeptEnd = insertingEndSeconds;
  for (const [staleKey, counter] of localCounters) {
    if (counter.windowEndSeconds <= nowSeconds) localCounters.delete(staleKey);
    else earliestKeptEnd = Math.min(earliestKeptEnd, counter.windowEndSeconds);
  }
  nextSweepAtSeconds = earliestKeptEnd;
}

/** Forget every in-process counter. Tests only. */
export function resetLocalRateLimits(): void {
  localCounters.clear();
  nextSweepAtSeconds = 0;
  sweepCount = 0;
}

/** How many counters are held and how many sweeps have run. Tests only. */
export function localRateLimitState(): { size: number; sweeps: number } {
  return { size: localCounters.size, sweeps: sweepCount };
}
