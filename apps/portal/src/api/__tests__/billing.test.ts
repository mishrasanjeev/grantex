import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { getSubscription, createCheckout, getPortalUrl } from '../billing';

// Mock window.location.origin for billing URLs
Object.defineProperty(window, 'location', {
  value: { origin: 'http://localhost:5173' },
  writable: true,
});

describe('billing', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getSubscription ───────────────────────────────────────────────────

  it('getSubscription sends GET /v1/billing/subscription', async () => {
    const sub = { plan: 'pro', status: 'active' };
    ok(sub);
    const result = await getSubscription();
    expect(result).toEqual(sub);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/billing/subscription', expect.objectContaining({ method: 'GET' }));
  });

  it('getSubscription throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Not authenticated');
    await expect(getSubscription()).rejects.toThrow('Not authenticated');
  });

  // ── createCheckout ────────────────────────────────────────────────────

  it('createCheckout sends POST /v1/billing/checkout with plan and URLs', async () => {
    ok({ checkoutUrl: 'https://stripe.com/checkout/123' });
    const result = await createCheckout('pro');
    expect(result).toEqual({ checkoutUrl: 'https://stripe.com/checkout/123' });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/billing/checkout');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.plan).toBe('pro');
    expect(body.successUrl).toBe('http://localhost:5173/dashboard/billing?success=true');
    expect(body.cancelUrl).toBe('http://localhost:5173/dashboard/billing');
  });

  it('createCheckout throws on error', async () => {
    err(400, 'BAD_REQUEST', 'Invalid plan');
    await expect(createCheckout('invalid')).rejects.toThrow('Invalid plan');
  });

  // ── getPortalUrl ──────────────────────────────────────────────────────

  it('getPortalUrl sends POST /v1/billing/portal with returnUrl', async () => {
    ok({ portalUrl: 'https://billing.stripe.com/portal/123' });
    const result = await getPortalUrl();
    expect(result).toEqual({ portalUrl: 'https://billing.stripe.com/portal/123' });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/billing/portal');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.returnUrl).toBe('http://localhost:5173/dashboard/billing');
  });

  it('getPortalUrl throws on error', async () => {
    err(403, 'FORBIDDEN', 'No subscription');
    await expect(getPortalUrl()).rejects.toThrow('No subscription');
  });
});
