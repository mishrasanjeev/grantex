import { trace, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';
import { config } from '../config.js';
import { logger } from './logger.js';

let _initialized = false;

/**
 * Initialize OpenTelemetry tracing. Only activates if OTEL_EXPORTER_OTLP_ENDPOINT
 * is set — zero overhead otherwise. Must be called before any other imports to
 * ensure auto-instrumentation hooks all modules.
 */
export async function initTracing(): Promise<void> {
  if (!config.otelEndpoint || _initialized) return;
  _initialized = true;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { Resource } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: 'grantex-auth-service',
    [ATTR_SERVICE_VERSION]: '2.1.0',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${config.otelEndpoint}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    sdk.shutdown().catch((err) => logger.error(err, 'OpenTelemetry SDK shutdown error'));
  });
}

/**
 * Get a tracer for creating custom spans.
 */
export function getTracer(name = 'grantex-auth-service'): Tracer {
  return trace.getTracer(name);
}

/**
 * Wrap an async function in a custom span with attributes.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | string[]>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
