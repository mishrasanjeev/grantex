import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}

import {
  disableMerchantAgenticCommerce,
  getCommerceMerchant,
  getCommerceOpsHealth,
  getCommerceWellKnownProfile,
  listCommerceProviderWebhookEvents,
  listCommerceAuditEvents,
  listCommercePassports,
  listCommercePaymentIntents,
  listCommerceProviderCredentials,
  reconcileCommercePaymentIntent,
  revokeCommercePassport,
  validateCommerceProviderCredential,
} from '../commerce';

describe('commerce api', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('lists payment intents with filters', async () => {
    ok({ items: [], next_cursor: null });
    await listCommercePaymentIntents({ merchantId: 'mch_1', status: 'payment_pending', limit: 25 });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/payments/intents?merchant_id=mch_1&status=payment_pending&limit=25',
    );
  });

  it('reconciles a payment intent with an encoded id', async () => {
    ok({ data: { id: 'pi/1' }, reconciliation: {} });
    await reconcileCommercePaymentIntent('pi/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/commerce/payments/intents/pi%2F1/reconcile');
    expect(mockFetch.mock.calls[0]![1].method).toBe('POST');
  });

  it('lists audit events with safe filters', async () => {
    ok({ items: [], next_cursor: null });
    await listCommerceAuditEvents({ merchantId: 'mch_1', eventType: 'payment_intent.created', passportJti: 'cpsp_1' });
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/v1/commerce/audit/events?');
    expect(url).toContain('merchant_id=mch_1');
    expect(url).toContain('event_type=payment_intent.created');
    expect(url).toContain('passport_jti=cpsp_1');
  });

  it('lists and revokes commerce passports without raw token material', async () => {
    ok({ items: [], next_cursor: null });
    await listCommercePassports();
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/commerce/passports');

    ok({ data: { jti: 'cpsp_1', revoked: true, reason: 'operator' }, audit_event_id: 'aud_1' });
    await revokeCommercePassport({ jti: 'cpsp_1', reason: 'operator' });
    const [, opts] = mockFetch.mock.calls[1]!;
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ jti: 'cpsp_1', reason: 'operator' });
    expect(opts.body).not.toContain('passport_jwt');
  });

  it('loads merchant settings and emergency-disables agentic commerce', async () => {
    ok({ data: { id: 'mch/1' } });
    await getCommerceMerchant('mch/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/commerce/merchants/mch%2F1');

    ok({ data: { merchant_id: 'mch/1', agentic_commerce_enabled: false, disabled: true }, audit_event_id: 'aud_1' });
    await disableMerchantAgenticCommerce('mch/1', 'dashboard_emergency_disable');
    const [url, opts] = mockFetch.mock.calls[1]!;
    expect(url).toBe('http://localhost:3000/v1/commerce/merchants/mch%2F1/disable-agentic-commerce');
    expect(JSON.parse(opts.body)).toEqual({ reason: 'dashboard_emergency_disable' });
  });

  it('lists and validates provider credential metadata without secrets', async () => {
    ok({ items: [], next_cursor: null });
    await listCommerceProviderCredentials({ merchantId: 'mch_1', providerKey: 'mock', environment: 'sandbox' });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/provider-credentials?merchant_id=mch_1&provider_key=mock&environment=sandbox',
    );

    ok({ data: { id: 'cred/1' }, audit_event_id: 'aud_1' });
    await validateCommerceProviderCredential('cred/1');
    expect(mockFetch.mock.calls[1]![0]).toBe(
      'http://localhost:3000/v1/commerce/provider-credentials/cred%2F1/validate',
    );
  });

  it('loads commerce ops health and well-known profile', async () => {
    ok({ status: 'degraded' });
    await getCommerceOpsHealth({ merchantId: 'mch_1', environment: 'sandbox' });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/ops/health?merchant_id=mch_1&environment=sandbox',
    );

    ok({ version: '1.0.0' });
    await getCommerceWellKnownProfile('mch_1');
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:3000/.well-known/grantex-commerce?merchant_id=mch_1');
  });

  it('lists provider webhook events with safe metadata filters', async () => {
    ok({ items: [], next_cursor: null, replay_available: false, replay_blocker: 'blocked' });
    await listCommerceProviderWebhookEvents({
      merchantId: 'mch_1',
      providerKey: 'mock',
      processingStatus: 'failed',
      limit: 25,
    });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/ops/provider-webhook-events?merchant_id=mch_1&provider_key=mock&processing_status=failed&limit=25',
    );
  });
});
