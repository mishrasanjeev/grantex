/**
 * Dynamic per-plan rate limiting.
 *
 * Developers authenticated by the standard auth plugin receive a Redis-backed
 * one-minute throughput budget based on their subscription plan: Free=100,
 * Pro=500, Enterprise=2000. skipAuth and custom-auth routes do not have
 * request.developer at this hook and retain their existing policies. This
 * limiter runs after standard auth and is additional to whichever Fastify
 * pre-auth per-IP policy is active: the 5,000/min default or a route-specific
 * override.
 */

import type { FastifyInstance } from 'fastify';
import { checkRateLimit } from '../lib/rate-limit.js';
import type { PlanName } from '../lib/plans.js';
import { isPlanName } from '../lib/plans.js';

export const PLAN_RATE_LIMITS: Record<PlanName, number> = {
  free: 100,
  pro: 500,
  enterprise: 2000,
};

export const PLAN_RATE_LIMIT_WINDOW_SECONDS = 60;

declare module 'fastify' {
  interface FastifyRequest {
    planRateLimit: number;
  }
}

export function getRateLimitForPlan(plan: string): number {
  return PLAN_RATE_LIMITS[isPlanName(plan) ? plan : 'free'];
}

export async function dynamicRateLimitPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('planRateLimit', 0);

  app.addHook('preHandler', async (request, reply) => {
    if (reply.sent || !request.developer) return;

    const plan = isPlanName(request.developer.plan)
      ? request.developer.plan
      : 'free';
    const limit = getRateLimitForPlan(plan);
    request.planRateLimit = limit;

    let result;
    try {
      result = await checkRateLimit(
        `developer:${request.developer.id}:plan`,
        limit,
        PLAN_RATE_LIMIT_WINDOW_SECONDS,
      );
    } catch (error) {
      request.log.error(
        { err: error, developerId: request.developer.id },
        'Plan rate limiter unavailable',
      );
      return reply.status(503).send({
        message: 'Authenticated rate limiting is temporarily unavailable',
        code: 'RATE_LIMIT_UNAVAILABLE',
        requestId: request.id,
      });
    }

    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetSeconds));

    if (!result.allowed) {
      reply.header('Retry-After', String(result.resetSeconds));
      return reply.status(429).send({
        message: `Plan rate limit exceeded, retry in ${result.resetSeconds} seconds`,
        code: 'RATE_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }
  });
}
