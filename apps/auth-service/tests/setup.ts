/**
 * Vitest setupFile — runs before every test file in the same worker context.
 * vi.mock() calls here ARE hoisted, so the mocks apply to all imports.
 */
import { vi, beforeEach } from 'vitest';

// ------------------------------------------------------------------
// Mock objects — defined before the vi.mock factories reference them.
// The factories use arrow functions, so the variables are captured
// by binding (not by value) and are always resolved at call time.
// ------------------------------------------------------------------
export const sqlMock = vi.fn().mockResolvedValue([]);

export const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(0),
  subscribe: vi.fn().mockResolvedValue(undefined),
  incr: vi.fn().mockResolvedValue(1),
  decr: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  options: { host: 'localhost', port: 6379 },
};

export const mockStripe = {
  checkout: {
    sessions: { create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }) },
  },
  billingPortal: {
    sessions: { create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/test' }) },
  },
  webhooks: { constructEvent: vi.fn() },
};

// ------------------------------------------------------------------
// Module mocks — hoisted by Vitest to top of this file
// ------------------------------------------------------------------
vi.mock('../src/db/client.js', () => ({
  getSql: () => sqlMock,
  closeSql: vi.fn(),
}));

vi.mock('../src/redis/client.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
}));

// Mock ioredis constructor — prevents real Redis connections in event streaming tests
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(0),
  }));
  return { default: MockRedis };
});

// Mock event bus — prevents emitEvent from consuming SQL mock slots / Redis
// in route tests. Event bus is tested separately in events.test.ts.
vi.mock('../src/lib/events.js', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock webhook delivery — keeps signWebhookPayload and enqueueWebhookDeliveries
// available for webhook-specific tests.
vi.mock('../src/lib/webhook.js', () => ({
  enqueueWebhookDeliveries: vi.fn().mockResolvedValue(undefined),
  signWebhookPayload: vi.fn().mockReturnValue('sha256=mock'),
}));

// Mock OpenTelemetry — prevent real tracing in tests
vi.mock('@opentelemetry/api', () => {
  const mockSpan = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  const mockTracer = {
    startActiveSpan: vi.fn((_name: string, fn: (span: unknown) => unknown) => fn(mockSpan)),
  };
  return {
    trace: { getTracer: vi.fn().mockReturnValue(mockTracer) },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
});

vi.mock('../src/lib/tracing.js', () => ({
  initTracing: vi.fn().mockResolvedValue(undefined),
  getTracer: vi.fn(),
  withSpan: vi.fn((_name: string, _attrs: Record<string, unknown>, fn: (span: unknown) => unknown) => fn({})),
}));

// Mock prom-client — prevents real metric registration in tests
vi.mock('prom-client', () => {
  const mockObserve = vi.fn();
  const mockInc = vi.fn();
  const mockSet = vi.fn();
  const mockStartTimer = vi.fn().mockReturnValue(vi.fn());
  const mockLabels = vi.fn().mockReturnValue({ observe: mockObserve, inc: mockInc });
  const MockCounter = vi.fn().mockImplementation(() => ({ inc: mockInc, labels: mockLabels }));
  const MockHistogram = vi.fn().mockImplementation(() => ({ observe: mockObserve, startTimer: mockStartTimer, labels: mockLabels }));
  const MockGauge = vi.fn().mockImplementation(() => ({ set: mockSet, inc: mockInc, dec: vi.fn(), labels: mockLabels }));
  const MockRegistry = vi.fn().mockImplementation(() => ({
    setDefaultLabels: vi.fn(),
    metrics: vi.fn().mockResolvedValue(''),
    contentType: 'text/plain',
    registerMetric: vi.fn(),
  }));
  return {
    Registry: MockRegistry,
    Counter: MockCounter,
    Histogram: MockHistogram,
    Gauge: MockGauge,
    collectDefaultMetrics: vi.fn(),
  };
});

// Mock Stripe — prevents real HTTP calls and avoids needing STRIPE_SECRET_KEY.
vi.mock('../src/lib/stripe.js', () => ({
  getStripe: () => mockStripe,
}));

// Mock email — prevents real Resend API calls
vi.mock('../src/lib/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  verificationEmailHtml: vi.fn().mockReturnValue('<p>Verify</p>'),
}));

// Mock domain DNS verification — prevents real DNS lookups
vi.mock('../src/lib/domains.js', () => ({
  verifyDomainDns: vi.fn().mockResolvedValue(false),
}));

// ------------------------------------------------------------------
// Reset all mocks before each test
// ------------------------------------------------------------------
beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.del.mockReset().mockResolvedValue(1);
  mockRedis.publish.mockReset().mockResolvedValue(0);
  mockRedis.subscribe.mockReset().mockResolvedValue(undefined);
  mockRedis.incr.mockReset().mockResolvedValue(1);
  mockRedis.decr.mockReset().mockResolvedValue(0);
  mockRedis.expire.mockReset().mockResolvedValue(1);
  mockStripe.checkout.sessions.create.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
  mockStripe.billingPortal.sessions.create.mockReset().mockResolvedValue({ url: 'https://billing.stripe.com/test' });
  mockStripe.webhooks.constructEvent.mockReset();
});
