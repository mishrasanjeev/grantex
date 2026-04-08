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
export const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
  // Support sql.begin(async (tx) => { ... }) — passes sqlMock itself as the tx
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(sqlMock)),
});

export const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(0),
  subscribe: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
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
  const MockCounter = vi.fn(function (this: Record<string, unknown>) { this.inc = mockInc; this.labels = mockLabels; });
  const MockHistogram = vi.fn(function (this: Record<string, unknown>) { this.observe = mockObserve; this.startTimer = mockStartTimer; this.labels = mockLabels; });
  const MockGauge = vi.fn(function (this: Record<string, unknown>) { this.set = mockSet; this.inc = mockInc; this.dec = vi.fn(); this.labels = mockLabels; });
  const MockRegistry = vi.fn(function (this: Record<string, unknown>) {
    this.setDefaultLabels = vi.fn();
    this.metrics = vi.fn().mockResolvedValue('');
    this.contentType = 'text/plain';
    this.registerMetric = vi.fn();
  });
  return {
    Registry: MockRegistry,
    Counter: MockCounter,
    Histogram: MockHistogram,
    Gauge: MockGauge,
    collectDefaultMetrics: vi.fn(),
  };
});

// Mock Stripe — prevents real HTTP calls and avoids needing STRIPE_SECRET_KEY.
export const mockGetStripe = vi.fn().mockReturnValue(mockStripe);
vi.mock('../src/lib/stripe.js', () => ({
  getStripe: (...args: unknown[]) => mockGetStripe(...args),
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

// Mock LDAP — prevents real LDAP connections in tests
vi.mock('../src/lib/ldap.js', () => ({
  authenticateLdap: vi.fn().mockResolvedValue({
    dn: 'uid=alice,ou=people,dc=corp,dc=com',
    uid: 'alice',
    email: 'alice@corp.com',
    displayName: 'Alice Smith',
    groups: ['Engineering', 'VPN-Users'],
  }),
  testLdapConnection: vi.fn().mockResolvedValue({ success: true }),
  setLdapClient: vi.fn(),
  getLdapClient: vi.fn(),
}));

// Mock WebAuthn — prevents real crypto operations in tests
vi.mock('../src/lib/webauthn.js', () => ({
  generateRegOptions: vi.fn().mockResolvedValue({
    challenge: 'mock-challenge-base64url',
    rp: { name: 'Grantex', id: 'grantex.dev' },
    user: { id: 'dXNlcl8xMjM', name: 'user_123', displayName: '' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestation: 'direct',
  }),
  verifyRegResponse: vi.fn().mockResolvedValue({
    verified: true,
    registrationInfo: {
      fmt: 'packed',
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: {
        id: 'bW9jay1jcmVkLWlk',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialType: 'public-key',
      attestationObject: new Uint8Array([]),
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: 'https://grantex.dev',
      rpID: 'grantex.dev',
    },
  }),
  generateAuthOptions: vi.fn().mockResolvedValue({
    challenge: 'mock-auth-challenge-base64url',
    rpId: 'grantex.dev',
    allowCredentials: [],
    userVerification: 'preferred',
  }),
  verifyAuthResponse: vi.fn().mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: 'bW9jay1jcmVkLWlk',
      newCounter: 1,
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: 'https://grantex.dev',
      rpID: 'grantex.dev',
    },
  }),
}));

// Mock isoBase64URL from @simplewebauthn/server/helpers
vi.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: {
    fromBuffer: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64url')),
    toBuffer: vi.fn((str: string) => Buffer.from(str, 'base64url')),
  },
}));

// ------------------------------------------------------------------
// Reset all mocks before each test
// ------------------------------------------------------------------
beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  sqlMock.begin.mockReset();
  sqlMock.begin.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(sqlMock));
  mockRedis.get.mockReset().mockResolvedValue(null);
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.del.mockReset().mockResolvedValue(1);
  mockRedis.publish.mockReset().mockResolvedValue(0);
  mockRedis.subscribe.mockReset().mockResolvedValue(undefined);
  mockRedis.ping.mockReset().mockResolvedValue('PONG');
  mockRedis.incr.mockReset().mockResolvedValue(1);
  mockRedis.decr.mockReset().mockResolvedValue(0);
  mockRedis.expire.mockReset().mockResolvedValue(1);
  mockGetStripe.mockReset().mockReturnValue(mockStripe);
  mockStripe.checkout.sessions.create.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
  mockStripe.billingPortal.sessions.create.mockReset().mockResolvedValue({ url: 'https://billing.stripe.com/test' });
  mockStripe.webhooks.constructEvent.mockReset();
});
