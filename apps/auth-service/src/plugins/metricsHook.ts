import type { FastifyInstance } from 'fastify';
import { Histogram, Registry } from 'prom-client';
import { registry } from '../lib/metrics.js';
import { config } from '../config.js';

const httpDuration = new Histogram({
  name: 'grantex_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export async function metricsHookPlugin(app: FastifyInstance): Promise<void> {
  if (!config.metricsEnabled) return;

  app.addHook('onResponse', (request, reply, done) => {
    // Skip metrics endpoint to avoid self-referential metrics
    if (request.url === '/metrics') {
      done();
      return;
    }

    const duration = reply.elapsedTime / 1000; // ms → seconds
    const route = request.routeOptions?.url ?? request.url;

    httpDuration
      .labels(request.method, route, String(reply.statusCode))
      .observe(duration);

    done();
  });
}

export { httpDuration };
