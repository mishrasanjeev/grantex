import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { registry } from '../lib/metrics.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (config.metricsRequireAuth) {
      if (!config.metricsApiKey) {
        return reply.status(503).send({
          message: 'Metrics endpoint is not configured',
          code: 'SERVICE_UNAVAILABLE',
          requestId: request.id,
        });
      }

      const expected = Buffer.from(`Bearer ${config.metricsApiKey}`);
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return reply.status(401).send({
          message: 'Unauthorized',
          code: 'UNAUTHORIZED',
          requestId: request.id,
        });
      }
    }

    const metrics = await registry.metrics();
    return reply
      .header('content-type', registry.contentType)
      .send(metrics);
  });
}
