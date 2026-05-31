import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}

import {
  bulkIngestCommerceProducts,
  createCommerceWebhookSource,
  disableMerchantAgenticCommerce,
  evaluateCommercePolicy,
  getCommerceMerchant,
  getCommerceMerchantSandboxOnboarding,
  getCommerceOpsHealth,
  getCommerceWellKnownProfile,
  listCommerceAgents,
  listCommercePolicies,
  listCommerceProducts,
  listCommerceWebhookSources,
  listCommerceProviderWebhookEvents,
  listCommerceAuditEvents,
  listCommercePassports,
  listCommercePaymentIntents,
  listCommerceProviderCredentials,
  reconcileCommercePaymentIntent,
  rotateCommerceWebhookSourceSecret,
  revokeCommercePassport,
  transitionCommerceMerchantSandboxOnboarding,
  updateCommerceAgent,
  updateCommerceMerchant,
  updateCommerceMerchantSandboxOnboarding,
  updateCommerceProduct,
  updateCommerceWebhookSource,
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

    ok({ data: { id: 'mch/1' }, audit_event_id: 'aud_1' });
    await updateCommerceMerchant('mch/1', { display_name: 'Store' });
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:3000/v1/commerce/merchants/mch%2F1');
    expect(mockFetch.mock.calls[1]![1].method).toBe('PATCH');
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toEqual({ display_name: 'Store' });

    ok({ data: { merchant_id: 'mch/1', agentic_commerce_enabled: false, disabled: true }, audit_event_id: 'aud_1' });
    await disableMerchantAgenticCommerce('mch/1', 'dashboard_emergency_disable');
    const [url, opts] = mockFetch.mock.calls[2]!;
    expect(url).toBe('http://localhost:3000/v1/commerce/merchants/mch%2F1/disable-agentic-commerce');
    expect(JSON.parse(opts.body)).toEqual({ reason: 'dashboard_emergency_disable' });
  });

  it('calls sandbox onboarding APIs without checkout or provider credential material', async () => {
    ok({ data: { merchant_id: 'mch/1', readiness: { ready: false } } });
    await getCommerceMerchantSandboxOnboarding('mch/1');
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/sandbox-onboarding',
    );

    ok({ data: { merchant_id: 'mch/1' }, audit_event_id: 'aud_1' });
    await updateCommerceMerchantSandboxOnboarding('mch/1', {
      display_name: 'Store',
      public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
      agentic_commerce_requested: true,
    });
    expect(mockFetch.mock.calls[1]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/sandbox-onboarding',
    );
    expect(mockFetch.mock.calls[1]![1].method).toBe('PUT');
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toEqual({
      display_name: 'Store',
      public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
      agentic_commerce_requested: true,
    });
    expect(mockFetch.mock.calls[1]![1].body).not.toContain('agentic_commerce_enabled');
    expect(mockFetch.mock.calls[1]![1].body).not.toContain('provider_credentials');

    ok({ data: { merchant_id: 'mch/1', sandbox_onboarding_state: 'submitted_for_review' }, audit_event_id: 'aud_2' });
    await transitionCommerceMerchantSandboxOnboarding('mch/1', { targetState: 'submitted_for_review' });
    expect(mockFetch.mock.calls[2]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/sandbox-onboarding/transition',
    );
    expect(JSON.parse(mockFetch.mock.calls[2]![1].body)).toEqual({ target_state: 'submitted_for_review' });
  });

  it('calls agent and product control-plane endpoints', async () => {
    ok({ items: [], next_cursor: null });
    await listCommerceAgents({ merchantId: 'mch_1', trustStatus: 'trusted', limit: 10 });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/agents?merchant_id=mch_1&trust_status=trusted&limit=10',
    );

    ok({ data: { id: 'cag/1' }, audit_event_id: 'aud_1' });
    await updateCommerceAgent('cag/1', { trust_status: 'trusted' });
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:3000/v1/commerce/agents/cag%2F1');
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toEqual({ trust_status: 'trusted' });

    ok({ items: [], next_cursor: null });
    await listCommerceProducts({ merchantId: 'mch_1', status: 'active', query: 'toaster', limit: 25 });
    expect(mockFetch.mock.calls[2]![0]).toBe(
      'http://localhost:3000/v1/commerce/catalog/products?merchant_id=mch_1&status=active&query=toaster&limit=25',
    );

    ok({ data: { id: 'cprd/1' }, audit_event_id: 'aud_2' });
    await updateCommerceProduct('cprd/1', { title: 'Updated' }, 'mch_1');
    expect(mockFetch.mock.calls[3]![0]).toBe(
      'http://localhost:3000/v1/commerce/catalog/products/cprd%2F1?merchant_id=mch_1',
    );

    ok({ dry_run: true, summary: { total: 1 }, rows: [] });
    await bulkIngestCommerceProducts({
      merchantId: 'mch_1',
      dryRun: true,
      products: [{ product_id: 'p1', title: 'P1', category_preset: 'electronics_appliances', variants: [{ sku: 's1', price_amount: 1000 }] }],
    });
    expect(mockFetch.mock.calls[4]![0]).toBe('http://localhost:3000/v1/commerce/catalog/products/bulk');
    expect(JSON.parse(mockFetch.mock.calls[4]![1].body).dry_run).toBe(true);
  });

  it('calls webhook source and policy endpoints without secret-like list output assumptions', async () => {
    ok({ items: [] });
    await listCommerceWebhookSources({ merchantId: 'mch_1', status: 'active' });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/webhook-sources?merchant_id=mch_1&status=active',
    );

    ok({ data: { source_key: 'erp_sync', webhook_secret: 'returned-once' }, audit_event_id: 'aud_1' });
    await createCommerceWebhookSource({ merchantId: 'mch_1', sourceKey: 'erp_sync', displayName: 'ERP Sync' });
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toEqual({
      merchant_id: 'mch_1',
      source_key: 'erp_sync',
      display_name: 'ERP Sync',
    });

    ok({ data: { source_key: 'erp_sync' }, audit_event_id: 'aud_2' });
    await updateCommerceWebhookSource('erp_sync', { merchantId: 'mch_1', displayName: 'ERP v2', status: 'disabled' });
    expect(mockFetch.mock.calls[2]![0]).toBe(
      'http://localhost:3000/v1/commerce/webhook-sources/erp_sync?merchant_id=mch_1',
    );

    ok({ data: { source_key: 'erp_sync', webhook_secret: 'rotated-once' }, audit_event_id: 'aud_3' });
    await rotateCommerceWebhookSourceSecret('erp_sync', 'mch_1');
    expect(mockFetch.mock.calls[3]![0]).toBe(
      'http://localhost:3000/v1/commerce/webhook-sources/erp_sync/rotate-secret',
    );

    ok({ items: [], next_cursor: null });
    await listCommercePolicies({ merchantId: 'mch_1', status: 'active' });
    expect(mockFetch.mock.calls[4]![0]).toBe(
      'http://localhost:3000/v1/commerce/policies?merchant_id=mch_1&status=active',
    );

    ok({ data: { decision: 'deny', reason: 'passport_malformed' } });
    await evaluateCommercePolicy({
      merchantId: 'mch_1',
      agentId: 'cag_1',
      actionScope: 'commerce:payment.initiate',
      passportJwt: 'redacted-simulator-passport-proof',
      amountMinorUnits: 1000,
      currency: 'INR',
      environment: 'sandbox',
    });
    expect(mockFetch.mock.calls[5]![0]).toBe('http://localhost:3000/v1/commerce/policies/evaluate');
    expect(JSON.parse(mockFetch.mock.calls[5]![1].body)).toMatchObject({
      merchant_id: 'mch_1',
      agent_id: 'cag_1',
      passport_jwt: 'redacted-simulator-passport-proof',
      action_scope: 'commerce:payment.initiate',
    });
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
