import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_SUBSCRIPTION = {
  plan: 'pro' as const,
  status: 'active' as const,
  currentPeriodEnd: '2026-12-31T00:00:00Z',
};

describe('BillingClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('getSubscription() GETs /v1/billing/subscription', async () => {
    const mockFetch = makeFetch(200, MOCK_SUBSCRIPTION);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.billing.getSubscription();

    expect(result.plan).toBe('pro');
    expect(result.status).toBe('active');
    expect(result.currentPeriodEnd).toBe('2026-12-31T00:00:00Z');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/billing\/subscription$/);
    expect(init.method).toBe('GET');
  });

  it('createCheckout() POSTs to /v1/billing/checkout and returns checkoutUrl', async () => {
    const mockFetch = makeFetch(201, { checkoutUrl: 'https://checkout.stripe.com/test' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.billing.createCheckout({
      plan: 'pro',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
    });

    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/test');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/billing\/checkout$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['plan']).toBe('pro');
    expect(body['successUrl']).toBe('https://app.example.com/success');
  });

  it('createPortal() POSTs to /v1/billing/portal and returns portalUrl', async () => {
    const mockFetch = makeFetch(201, { portalUrl: 'https://billing.stripe.com/test' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.billing.createPortal({
      returnUrl: 'https://app.example.com/settings',
    });

    expect(result.portalUrl).toBe('https://billing.stripe.com/test');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/billing\/portal$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['returnUrl']).toBe('https://app.example.com/settings');
  });
});
