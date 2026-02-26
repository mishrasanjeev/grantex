import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import { mockStripe } from './setup.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /v1/billing/subscription', () => {
  it('returns free plan when no subscription row exists', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // no subscription

    const res = await app.inject({
      method: 'GET',
      url: '/v1/billing/subscription',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ plan: string; status: string; currentPeriodEnd: null }>();
    expect(body.plan).toBe('free');
    expect(body.status).toBe('active');
    expect(body.currentPeriodEnd).toBeNull();
  });

  it('returns subscription details when a row exists', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      { plan: 'pro', status: 'active', current_period_end: '2026-12-31T00:00:00.000Z' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/billing/subscription',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ plan: string; status: string; currentPeriodEnd: string }>();
    expect(body.plan).toBe('pro');
    expect(body.status).toBe('active');
    expect(body.currentPeriodEnd).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('POST /v1/billing/checkout', () => {
  it('returns a checkout URL for the pro plan', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: authHeader(),
      payload: {
        plan: 'pro',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ checkoutUrl: string }>();
    expect(body.checkoutUrl).toBe('https://checkout.stripe.com/test');
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledOnce();
  });

  it('returns 400 for an invalid plan name', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: authHeader(),
      payload: { plan: 'ultimate', successUrl: 'https://x.com', cancelUrl: 'https://x.com' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when successUrl is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: authHeader(),
      payload: { plan: 'pro', cancelUrl: 'https://x.com' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/billing/portal', () => {
  it('returns a portal URL for a developer with a Stripe customer', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ stripe_customer_id: 'cus_TEST123' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: authHeader(),
      payload: { returnUrl: 'https://app.example.com/settings' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ portalUrl: string }>();
    expect(body.portalUrl).toBe('https://billing.stripe.com/test');
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_TEST123' }),
    );
  });

  it('returns 400 when no Stripe customer exists yet', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // no subscription row

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: authHeader(),
      payload: { returnUrl: 'https://app.example.com/settings' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/billing/webhook', () => {
  const MOCK_SESSION = {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_TEST123',
        subscription: 'sub_TEST456',
        metadata: { developerId: 'dev_TEST', plan: 'pro' },
      },
    },
  };

  it('processes checkout.session.completed and upserts subscription', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue(MOCK_SESSION);
    sqlMock.mockResolvedValueOnce([]); // UPSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_test',
      },
      payload: JSON.stringify({ type: 'checkout.session.completed' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>().received).toBe(true);
    expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledOnce();
  });

  it('returns 400 when Stripe signature is invalid', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'bad_sig',
      },
      payload: JSON.stringify({ type: 'checkout.session.completed' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
  });
});
