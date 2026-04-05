import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';

const HEALTH_CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Health check timed out')), ms),
    ),
  ]);
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { skipAuth: true } }, async (_request, reply) => {
    let database: 'ok' | 'error' = 'ok';
    let redis: 'ok' | 'error' = 'ok';

    try {
      const sql = getSql();
      await withTimeout(sql`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);
    } catch {
      database = 'error';
    }

    try {
      const redisClient = getRedis();
      await withTimeout(redisClient.ping(), HEALTH_CHECK_TIMEOUT_MS);
    } catch {
      redis = 'error';
    }

    const status = database === 'ok' && redis === 'ok' ? 'healthy' : 'degraded';
    const statusCode = status === 'healthy' ? 200 : 503;

    return reply.status(statusCode).send({ status, database, redis });
  });
}
