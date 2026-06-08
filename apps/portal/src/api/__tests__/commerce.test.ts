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
  getCommerceConnectorDryRun,
  getCommerceConnectorDryRunReview,
  getCommerceMerchantSchemaOrgJsonLdPreview,
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
  recordCommerceConnectorDryRunReviewDecision,
  rotateCommerceWebhookSourceSecret,
  requestCommerceConnectorDryRunReview,
  revokeCommercePassport,
  runCommerceConnectorDryRun,
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

  it('loads schema.org JSON-LD preview through the tenant-scoped merchant route', async () => {
    ok({ data: { status: 'preview_only', preview_only: true, jsonld: { '@context': 'https://schema.org', '@graph': [] } } });
    await getCommerceMerchantSchemaOrgJsonLdPreview('mch/1');
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/schemaorg-jsonld-preview',
    );
    expect(mockFetch.mock.calls[0]![1].method).toBe('GET');
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

  it('calls connector dry-run and review APIs without credential or enablement fields', async () => {
    ok({ data: { dry_run_id: 'cdry/1', status: 'passed' }, audit_events: [] }, 201);
    await runCommerceConnectorDryRun({
      merchantId: 'mch/1',
      connectorType: 'csv',
      sourceLabel: 'portal_manual_fixture',
      previewLimit: 3,
      rows: [{ product_id: 'p1', title: 'Fixture product', sku: 'SKU-1', price_amount: 1000, currency: 'INR' }],
    });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-run',
    );
    const dryRunBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(dryRunBody).toEqual({
      connector_type: 'csv',
      source_label: 'portal_manual_fixture',
      preview_limit: 3,
      rows: [{ product_id: 'p1', title: 'Fixture product', sku: 'SKU-1', price_amount: 1000, currency: 'INR' }],
    });
    const serializedDryRunBody = JSON.stringify(dryRunBody).toLowerCase();
    for (const forbidden of [
      'credential',
      'secret',
      'provider_metadata',
      'public_discovery_enabled',
      'checkout_payment_enabled',
      'live_provider_enabled',
      'live_plural_enabled',
    ]) {
      expect(serializedDryRunBody).not.toContain(forbidden);
    }

    ok({ data: { dry_run_id: 'cdry/1' } });
    await getCommerceConnectorDryRun('mch/1', 'cdry/1');
    expect(mockFetch.mock.calls[1]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-runs/cdry%2F1',
    );

    ok({ data: { review_id: 'cdrev/1' }, dry_run: { dry_run_id: 'cdry/1' }, audit_event_id: 'aud_1' });
    await requestCommerceConnectorDryRunReview('mch/1', 'cdry/1', { requestNote: 'Public-safe sandbox evidence review.' });
    expect(mockFetch.mock.calls[2]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-runs/cdry%2F1/review-request',
    );
    expect(JSON.parse(mockFetch.mock.calls[2]![1].body)).toEqual({ request_note: 'Public-safe sandbox evidence review.' });

    ok({ data: { review_id: 'cdrev/1' }, dry_run: { dry_run_id: 'cdry/1' }, audit_event_id: 'aud_1' });
    await getCommerceConnectorDryRunReview('mch/1', 'cdry/1');
    expect(mockFetch.mock.calls[3]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-runs/cdry%2F1/review',
    );

    ok({ data: { review_id: 'cdrev/1', decision: 'accepted_for_sandbox_followup' }, dry_run: { dry_run_id: 'cdry/1' }, audit_event_id: 'aud_2' });
    await recordCommerceConnectorDryRunReviewDecision('mch/1', 'cdry/1', {
      decision: 'accepted_for_sandbox_followup',
      decisionNote: 'Sandbox follow-up only.',
    });
    expect(mockFetch.mock.calls[4]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-runs/cdry%2F1/review/decision',
    );
    const decisionBody = JSON.parse(mockFetch.mock.calls[4]![1].body);
    expect(decisionBody).toEqual({
      decision: 'accepted_for_sandbox_followup',
      decision_note: 'Sandbox follow-up only.',
    });
    const serializedDecisionBody = JSON.stringify(decisionBody).toLowerCase();
    for (const forbidden of [
      'approval',
      'public_discovery_enabled',
      'checkout_payment_enabled',
      'live_provider_enabled',
      'live_plural_enabled',
    ]) {
      expect(serializedDecisionBody).not.toContain(forbidden);
    }
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
