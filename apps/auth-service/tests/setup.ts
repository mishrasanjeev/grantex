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
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
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

// Mock webhook delivery — prevents fireWebhooks from consuming SQL mock slots
// in route tests. The actual webhook routes are tested in webhooks.test.ts.
vi.mock('../src/lib/webhook.js', () => ({
  fireWebhooks: vi.fn().mockResolvedValue(undefined),
  signWebhookPayload: vi.fn().mockReturnValue('sha256=mock'),
}));

// Mock Stripe — prevents real HTTP calls and avoids needing STRIPE_SECRET_KEY.
vi.mock('../src/lib/stripe.js', () => ({
  getStripe: () => mockStripe,
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
  mockStripe.checkout.sessions.create.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
  mockStripe.billingPortal.sessions.create.mockReset().mockResolvedValue({ url: 'https://billing.stripe.com/test' });
  mockStripe.webhooks.constructEvent.mockReset();
});
