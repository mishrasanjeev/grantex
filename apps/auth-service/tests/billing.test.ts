import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import { mockStripe, mockGetStripe } from './setup.js';

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

describe('POST /v1/billing/portal (error path)', () => {
  it('returns 400 when returnUrl is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('POST /v1/billing/checkout (enterprise plan)', () => {
  it('resolves the enterprise price ID', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: authHeader(),
      payload: {
        plan: 'enterprise',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ plan: 'enterprise' }),
      }),
    );
  });
});

describe('POST /v1/billing/checkout (priceId not configured)', () => {
  it('returns 503 when price ID is null', async () => {
    seedAuth();

    // Temporarily remove the price env var so config.stripePricePro is null.
    // The config object is imported from a module and reads env vars at load time,
    // so we need to directly patch the config object.
    const { config } = await import('../src/config.js');
    const originalPricePro = config.stripePricePro;
    (config as { stripePricePro: string | null }).stripePricePro = null;

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

    // Restore
    (config as { stripePricePro: string | null }).stripePricePro = originalPricePro;

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('POST /v1/billing/checkout (stripe not configured)', () => {
  it('returns 503 when getStripe throws', async () => {
    seedAuth();

    mockGetStripe.mockImplementationOnce(() => { throw new Error('STRIPE_SECRET_KEY is not configured'); });

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

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('POST /v1/billing/portal (stripe not configured)', () => {
  it('returns 503 when getStripe throws', async () => {
    seedAuth();
    // Has a subscription with a stripe customer
    sqlMock.mockResolvedValueOnce([{ stripe_customer_id: 'cus_TEST123' }]);

    mockGetStripe.mockImplementationOnce(() => { throw new Error('STRIPE_SECRET_KEY is not configured'); });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: authHeader(),
      payload: { returnUrl: 'https://app.example.com/settings' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
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

  it('processes customer.subscription.updated event', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_TEST456',
          customer: 'cus_TEST123',
          status: 'active',
          current_period_end: 1735689600,
          items: { data: [{ price: { id: 'price_pro_123' } }] },
        },
      },
    });
    sqlMock.mockResolvedValueOnce([]); // UPDATE

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_test',
      },
      payload: JSON.stringify({ type: 'customer.subscription.updated' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('processes customer.subscription.deleted event', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_TEST456' },
      },
    });
    sqlMock.mockResolvedValueOnce([]); // UPDATE

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_test',
      },
      payload: JSON.stringify({ type: 'customer.subscription.deleted' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('processes invoice.payment_failed event', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'invoice.payment_failed',
      data: {
        object: { subscription: 'sub_TEST456' },
      },
    });
    sqlMock.mockResolvedValueOnce([]); // UPDATE

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_test',
      },
      payload: JSON.stringify({ type: 'invoice.payment_failed' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('handles checkout.session.completed with missing metadata gracefully', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_TEST123',
          subscription: 'sub_TEST456',
          metadata: {},
        },
      },
    });

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
    expect(res.json().received).toBe(true);
  });

  it('handles unknown webhook event type', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'some.unknown.event',
      data: { object: {} },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_test',
      },
      payload: JSON.stringify({ type: 'some.unknown.event' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
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
