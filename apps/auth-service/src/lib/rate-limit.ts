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
 * Fixed-window counter in Redis: one key per (identifier, window), TTL set
 * on first increment so expired keys self-clean.
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

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  // Reset is the time until the current window ends; derived from the window
  // index rather than a second Redis TTL call, so this stays to one round-trip.
  const resetSeconds = Math.max(1, (windowIndex + 1) * windowSeconds - nowSeconds);

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetSeconds,
  };
}
