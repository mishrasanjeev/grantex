/**
 * Dynamic per-developer rate limiting.
 *
 * Developers authenticated by the standard auth plugin receive a Redis-backed
 * one-minute throughput budget. Which budget a request draws on depends on
 * the route's `config.rateLimitClass`:
 *
 * - none (every ordinary route): the subscription plan, Free=100, Pro=500,
 *   Enterprise=2000. Fails closed with 503 when the counter cannot be read.
 * - `containment`: revoking a grant, a token, a passport or a consent bundle,
 *   and the emergency stop. A bucket of its own, the same size on every plan,
 *   so ending an incident never waits out a quota that ordinary traffic used
 *   up. When Redis cannot be reached, or does not answer within
 *   CONTAINMENT_LIMITER_TIMEOUT_MS, it fails open to an in-process count of
 *   the same size: see the handler below.
 * - `status`: the revocation feed and the revocation status reads an SDK
 *   polls to learn that a grant stopped. Kept apart from the plan so that
 *   revocation checks do not compete with the tenant's other calls, sized for
 *   polling, and failing closed like the plan bucket: an SDK that cannot read
 *   the feed denies rather than trusting what it already knows.
 *
 * RATE_LIMIT_ROUTE_CLASSES_ENABLED=false (default true) ignores the class and
 * puts every route back in the plan bucket, as before the classes existed.
 *
 * skipAuth and custom-auth routes do not have request.developer at this hook
 * and retain their existing policies. This limiter runs after standard auth
 * and is additional to whichever Fastify pre-auth per-IP policy is active:
 * the 5,000/min default or a route-specific override.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { checkLocalRateLimit, checkRateLimit, type RateLimitResult } from '../lib/rate-limit.js';
import { rateLimitDecisionsTotal } from '../lib/metrics.js';
import type { PlanName } from '../lib/plans.js';
import { isPlanName } from '../lib/plans.js';

export type RateLimitClass = 'containment' | 'status';
type Bucket = 'plan' | RateLimitClass;

export const PLAN_RATE_LIMITS: Record<PlanName, number> = {
  free: 100,
  pro: 500,
  enterprise: 2000,
};

/**
 * Containment calls per developer per window, on every plan. The Enterprise
 * plan's budget, so no tenant revokes more slowly than it could when
 * revocations shared its plan, and a free-plan tenant can revoke a few
 * hundred grants one at a time without waiting. Still a ceiling: every
 * revocation takes the developer's revocation lock and writes.
 */
export const CONTAINMENT_RATE_LIMIT = 2_000;

/**
 * Feed and status reads per developer per window, on every plan: several SDK
 * instances each polling at the per-address ceiling of
 * `GET /v1/revocations/status` (1,200/min), which still applies per address.
 */
export const STATUS_RATE_LIMIT = 6_000;

/** Every bucket counts in the same one-minute window. */
export const PLAN_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * How long a containment call waits for the shared counter before counting
 * in-process instead. An unreachable Redis does not refuse a command: the
 * client queues and retries it, and against a stopped Redis the counter took
 * over a minute to fail. A revocation must not wait that long to commit.
 */
export const CONTAINMENT_LIMITER_TIMEOUT_MS = 500;

const BUCKET_LABEL: Record<Bucket, string> = {
  plan: 'Plan',
  containment: 'Containment',
  status: 'Revocation status',
};

declare module 'fastify' {
  interface FastifyRequest {
    planRateLimit: number;
  }

  interface FastifyContextConfig {
    /** The per-developer bucket this route draws on; omitted means the plan. */
    rateLimitClass?: RateLimitClass;
  }
}

export function getRateLimitForPlan(plan: string): number {
  return PLAN_RATE_LIMITS[isPlanName(plan) ? plan : 'free'];
}

/** Read at request time, like the other flags, so tests can stub it. */
export function rateLimitRouteClassesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['RATE_LIMIT_ROUTE_CLASSES_ENABLED'] !== 'false';
}

/** Reject if `promise` has not settled within `ms`; its own later outcome is ignored. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`rate limiter did not answer within ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function bucketFor(request: FastifyRequest): Bucket {
  if (!rateLimitRouteClassesEnabled()) return 'plan';
  const rateClass = request.routeOptions.config.rateLimitClass;
  return rateClass === 'containment' || rateClass === 'status' ? rateClass : 'plan';
}

export async function dynamicRateLimitPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('planRateLimit', 0);

  app.addHook('preHandler', async (request, reply) => {
    if (reply.sent || !request.developer) return;

    const plan = isPlanName(request.developer.plan)
      ? request.developer.plan
      : 'free';
    request.planRateLimit = getRateLimitForPlan(plan);

    const bucket = bucketFor(request);
    const limit = bucket === 'containment'
      ? CONTAINMENT_RATE_LIMIT
      : bucket === 'status' ? STATUS_RATE_LIMIT : request.planRateLimit;
    const identifier = `developer:${request.developer.id}:${bucket}`;

    let result: RateLimitResult;
    let local = false;
    try {
      const counted = checkRateLimit(identifier, limit, PLAN_RATE_LIMIT_WINDOW_SECONDS);
      result = await (bucket === 'containment' ? within(counted, CONTAINMENT_LIMITER_TIMEOUT_MS) : counted);
    } catch (error) {
      if (bucket !== 'containment') {
        // Fail closed: without the shared counter there is no budget to
        // enforce, and the handler must not run unmetered.
        request.log.error(
          { err: error, developerId: request.developer.id, bucket },
          `${BUCKET_LABEL[bucket]} rate limiter unavailable`,
        );
        rateLimitDecisionsTotal.inc({ bucket, outcome: 'unavailable' });
        return reply.status(503).send({
          message: 'Authenticated rate limiting is temporarily unavailable',
          code: 'RATE_LIMIT_UNAVAILABLE',
          requestId: request.id,
        });
      }
      // Fail open, counted in this process. Refusing — or holding — a
      // revocation because the limiter's cache is down or slow would keep an
      // incident running through an outage of a component that holds no
      // authority: the revocation itself is written to Postgres, which is
      // authoritative (see lib/revoke.ts). The in-process count keeps the
      // same ceiling per instance, so an outage does not make the endpoint
      // unbounded. Logged, not swallowed.
      request.log.warn(
        { err: error, developerId: request.developer.id, bucket },
        'Containment rate limiter unavailable; counting this instance only',
      );
      result = checkLocalRateLimit(identifier, limit, PLAN_RATE_LIMIT_WINDOW_SECONDS);
      local = true;
    }

    rateLimitDecisionsTotal.inc({
      bucket,
      outcome: `${local ? 'local_' : ''}${result.allowed ? 'allowed' : 'limited'}`,
    });

    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetSeconds));

    if (!result.allowed) {
      reply.header('Retry-After', String(result.resetSeconds));
      return reply.status(429).send({
        message: `${BUCKET_LABEL[bucket]} rate limit exceeded, retry in ${result.resetSeconds} seconds`,
        code: 'RATE_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }
  });
}
