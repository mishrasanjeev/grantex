import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { skipAuth: true } }, async (_request, reply) => {
    const checks: string[] = [];

    try {
      const sql = getSql();
      await sql`SELECT 1`;
    } catch {
      checks.push('db');
    }

    try {
      const redis = getRedis();
      await redis.get('health:ping');
    } catch {
      checks.push('redis');
    }

    if (checks.length > 0) {
      return reply.status(503).send({ status: 'degraded', failing: checks });
    }

    return reply.send({ status: 'ok' });
  });
}
