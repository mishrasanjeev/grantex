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

describe('CommerceClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('getProfile() reads the Commerce well-known profile', async () => {
    const mockFetch = makeFetch(200, { merchant: { merchant_id: 'mch_shopify_mgx0n6_22' } });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const profile = await grantex.commerce.getProfile({ merchantId: 'mch_shopify_mgx0n6_22' });

    expect(profile.merchant?.merchant_id).toBe('mch_shopify_mgx0n6_22');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/\.well-known\/grantex-commerce\?merchant_id=mch_shopify_mgx0n6_22$/);
    expect(init.method).toBe('GET');
  });

  it('searchCatalog() POSTs to the Commerce catalog search endpoint', async () => {
    const mockFetch = makeFetch(200, { items: [{ product_id: 'gid://shopify/Product/1' }], next_cursor: null });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.commerce.searchCatalog({
      merchant_id: 'mch_shopify_mgx0n6_22',
      query: 'shirt',
      limit: 5,
    });

    expect(result.items).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/commerce\/catalog\/search$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      merchant_id: 'mch_shopify_mgx0n6_22',
      query: 'shirt',
      limit: 5,
    });
  });

  it('createCart() sends Idempotency-Key as a header only', async () => {
    const mockFetch = makeFetch(201, { data: { cart_id: 'ccart_01' }, audit_event_id: 'caud_01' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.commerce.createCart({
      idempotencyKey: 'idem-cart-01',
      merchant_id: 'mch_shopify_mgx0n6_22',
      currency: 'INR',
      line_items: [{ variant_id: 'cvar_01', quantity: 1 }],
    });

    expect(result.data['cart_id']).toBe('ccart_01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-cart-01');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('idempotencyKey');
  });

  it('createPaymentIntent() sends Idempotency-Key and provider key', async () => {
    const mockFetch = makeFetch(201, { data: { payment_intent_id: 'cpay_01' } });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.commerce.createPaymentIntent({
      idempotencyKey: 'idem-pay-01',
      merchant_id: 'mch_shopify_mgx0n6_22',
      cart_id: 'ccart_01',
      passport_jwt: 'eyJhbGciOiJSUzI1NiJ9.test',
      amount_minor_units: 10000,
      currency: 'INR',
      provider_key: 'plural',
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/commerce\/payments\/intents$/);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-pay-01');
    expect(JSON.parse(init.body as string)).toMatchObject({ provider_key: 'plural' });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('idempotencyKey');
  });

  it('createCheckoutLink() posts to the intent checkout-link route', async () => {
    const mockFetch = makeFetch(201, { data: { payment_intent_id: 'cpay_01', checkout_url: 'https://checkout.example' } });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.commerce.createCheckoutLink('cpay_01', {
      idempotencyKey: 'idem-checkout-01',
      passport_jwt: 'eyJhbGciOiJSUzI1NiJ9.test',
      success_url: 'https://buyer.example/success',
      cancel_url: 'https://buyer.example/cancel',
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/commerce\/payments\/intents\/cpay_01\/checkout-link$/);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-checkout-01');
  });

  it('handleProviderWebhook() can send provider-specific headers', async () => {
    const mockFetch = makeFetch(401, {
      error: {
        code: 'webhook_signature_invalid',
        message: 'Webhook signature is invalid',
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 0 });
    await expect(grantex.commerce.handleProviderWebhook(
      'plural',
      { event_id: 'evt_01' },
      { headers: { 'x-plural-signature': 'bad-signature' } },
    )).rejects.toMatchObject({
      code: 'webhook_signature_invalid',
      message: 'Webhook signature is invalid',
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webhooks\/providers\/plural$/);
    expect((init.headers as Record<string, string>)['x-plural-signature']).toBe('bad-signature');
  });
});
