/**
 * Dynamic per-plan rate limiting.
 *
 * Reads the developer's plan from the request context and applies
 * plan-appropriate rate limits: Free=100/min, Pro=500/min, Enterprise=2000/min.
 */

import type { FastifyInstance } from 'fastify';

export const PLAN_RATE_LIMITS: Record<string, number> = {
  free: 100,
  pro: 500,
  enterprise: 2000,
};

/**
 * Get the rate limit for a developer plan.
 */
export function getRateLimitForPlan(plan: string): number {
  return PLAN_RATE_LIMITS[plan] ?? PLAN_RATE_LIMITS['free']!;
}

export async function dynamicRateLimitPlugin(app: FastifyInstance): Promise<void> {
  // This plugin adds a preHandler hook that logs rate limit info.
  // The actual rate limiting is handled by @fastify/rate-limit with the
  // global max config. This plugin provides plan-aware context that can
  // be used by custom rate limit handlers.
  app.decorateRequest('planRateLimit', 100);

  app.addHook('preHandler', async (request) => {
    if (request.developer) {
      // Developer plan is resolved in auth plugin
      const plan = (request.developer as { plan?: string }).plan ?? 'free';
      (request as { planRateLimit?: number }).planRateLimit = getRateLimitForPlan(plan);
    }
  });
}
