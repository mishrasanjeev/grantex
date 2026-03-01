import type { FastifyInstance } from 'fastify';
import { registry } from '../lib/metrics.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const metrics = await registry.metrics();
    return reply
      .header('content-type', registry.contentType)
      .send(metrics);
  });
}
