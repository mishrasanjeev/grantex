import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real implementation
vi.unmock('../src/lib/stripe.js');

// Hoist mock config
const { mockConfig, MockStripe } = vi.hoisted(() => {
  const mockConfig = {
    stripeSecretKey: null as string | null,
  };
  const MockStripe = vi.fn(function (this: Record<string, unknown>) {
    this.checkout = { sessions: { create: vi.fn() } };
  });
  return { mockConfig, MockStripe };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));
vi.mock('stripe', () => ({ default: MockStripe }));

// We must re-import getStripe in each test to reset the singleton.
// But since module-level state persists, we use dynamic import + resetModules.

beforeEach(() => {
  mockConfig.stripeSecretKey = null;
  MockStripe.mockClear();
  vi.resetModules();
});

describe('getStripe', () => {
  it('throws when STRIPE_SECRET_KEY not set', async () => {
    mockConfig.stripeSecretKey = null;

    const { getStripe } = await import('../src/lib/stripe.js');
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not configured');
  });

  it('returns Stripe instance when configured', async () => {
    mockConfig.stripeSecretKey = 'sk_test_12345';

    const { getStripe } = await import('../src/lib/stripe.js');
    const stripe = getStripe();

    expect(stripe).toBeDefined();
    expect(MockStripe).toHaveBeenCalledWith('sk_test_12345', {
      apiVersion: '2026-02-25.clover',
    });
  });

  it('returns same instance on subsequent calls (singleton)', async () => {
    mockConfig.stripeSecretKey = 'sk_test_12345';

    const { getStripe } = await import('../src/lib/stripe.js');
    const first = getStripe();
    const second = getStripe();

    expect(first).toBe(second);
    expect(MockStripe).toHaveBeenCalledTimes(1);
  });
});
