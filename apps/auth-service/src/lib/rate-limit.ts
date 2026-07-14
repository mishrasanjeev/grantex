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
