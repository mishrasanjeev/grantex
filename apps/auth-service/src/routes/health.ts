import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';

const HEALTH_CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Health check timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { skipAuth: true } }, async (_request, reply) => {
    // Probe dependencies concurrently so two stalled dependencies still
    // produce a readiness response within one timeout window, not two.
    const [database, redis] = await Promise.all([
      (async (): Promise<'ok' | 'error'> => {
        try {
          const sql = getSql();
          await withTimeout(sql`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);
          return 'ok';
        } catch {
          return 'error';
        }
      })(),
      (async (): Promise<'ok' | 'error'> => {
        try {
          const redisClient = getRedis();
          await withTimeout(redisClient.ping(), HEALTH_CHECK_TIMEOUT_MS);
          return 'ok';
        } catch {
          return 'error';
        }
      })(),
    ]);

    const status = database === 'ok' && redis === 'ok' ? 'healthy' : 'degraded';
    const statusCode = status === 'healthy' ? 200 : 503;

    return reply.status(statusCode).send({ status, database, redis });
  });
}
