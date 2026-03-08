import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock tracing so we test the real implementation
vi.unmock('../src/lib/tracing.js');

// Hoist config mock
const { mockConfig, mockSdkStart, mockSdkShutdown } = vi.hoisted(() => {
  const mockConfig = {
    otelEndpoint: null as string | null,
  };
  const mockSdkStart = vi.fn();
  const mockSdkShutdown = vi.fn().mockResolvedValue(undefined);
  return { mockConfig, mockSdkStart, mockSdkShutdown };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));

// Mock all OpenTelemetry SDK modules
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: mockSdkStart,
    shutdown: mockSdkShutdown,
  })),
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/resources', () => ({
  Resource: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: vi.fn().mockReturnValue({ startActiveSpan: vi.fn() }) },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

beforeEach(() => {
  mockConfig.otelEndpoint = null;
  mockSdkStart.mockClear();
  vi.resetModules();
});

describe('initTracing', () => {
  it('returns early when otelEndpoint not set', async () => {
    mockConfig.otelEndpoint = null;

    const { initTracing } = await import('../src/lib/tracing.js');
    await initTracing();

    expect(mockSdkStart).not.toHaveBeenCalled();
  });

  it('starts SDK when otelEndpoint is set', async () => {
    mockConfig.otelEndpoint = 'http://otel-collector:4318';

    const { initTracing } = await import('../src/lib/tracing.js');
    await initTracing();

    expect(mockSdkStart).toHaveBeenCalledOnce();
  });

  it('returns early on second call (already initialized)', async () => {
    mockConfig.otelEndpoint = 'http://otel-collector:4318';

    const { initTracing } = await import('../src/lib/tracing.js');
    await initTracing();
    await initTracing();

    // Only called once despite two initTracing calls
    expect(mockSdkStart).toHaveBeenCalledTimes(1);
  });
});
