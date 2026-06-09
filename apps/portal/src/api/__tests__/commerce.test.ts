import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}

import {
  attachCommerceConnectorRemediationCorrectedDryRun,
  bulkIngestCommerceProducts,
  createCommerceConnectorDryRunRemediation,
  createCommerceWebhookSource,
  disableMerchantAgenticCommerce,
  evaluateCommercePolicy,
  getCommerceMerchant,
  getCommerceConnectorDryRun,
  getCommerceConnectorDryRunReview,
  getCommerceConnectorDryRunRemediation,
  getCommerceConnectorDryRunRemediationTimeline,
  getCommerceMerchantSchemaOrgJsonLdPreview,
  getCommerceMerchantSandboxOnboarding,
  getCommerceOpsHealth,
  getCommerceWellKnownProfile,
  listCommerceAgents,
  listCommercePolicies,
  listCommerceProducts,
  listCommerceConnectorDryRunRemediations,
  listCommerceWebhookSources,
  listCommerceProviderWebhookEvents,
  listCommerceAuditEvents,
  listCommercePassports,
  listCommercePaymentIntents,
  listCommerceProviderCredentials,
  reconcileCommercePaymentIntent,
  recordCommerceConnectorDryRunReviewDecision,
  recordCommerceConnectorDryRunRemediationTriage,
  rotateCommerceWebhookSourceSecret,
  requestCommerceConnectorDryRunReview,
  requestCommerceConnectorRemediationFollowUpReview,
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

    ok({ data: { remediation_id: 'cdrem/1' }, original_dry_run: { dry_run_id: 'cdry/1' }, original_review: { review_id: 'cdrev/1' }, audit_event_id: 'aud_3' }, 201);
    await createCommerceConnectorDryRunRemediation('mch/1', 'cdry/1', {
      publicSafeNote: 'Public-safe remediation note.',
    });
    expect(mockFetch.mock.calls[5]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/dry-runs/cdry%2F1/remediation',
    );
    const remediationBody = JSON.parse(mockFetch.mock.calls[5]![1].body);
    expect(remediationBody).toEqual({ public_safe_note: 'Public-safe remediation note.' });

    ok({ data: { remediation_id: 'cdrem/1' } });
    await getCommerceConnectorDryRunRemediation('mch/1', 'cdrem/1');
    expect(mockFetch.mock.calls[6]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1',
    );

    ok({ items: [{ remediation_id: 'cdrem/1' }], next_cursor: null, filters: {}, controls: {} });
    await listCommerceConnectorDryRunRemediations({
      merchantId: 'mch/1',
      status: 'corrected_dry_run_attached',
      triageStatus: 'ready_for_followup_review',
      originalDecision: 'needs_changes',
      hasCorrectedDryRun: true,
      hasFollowupReview: false,
      limit: 10,
    });
    expect(mockFetch.mock.calls[7]![0]).toBe(
      'http://localhost:3000/v1/commerce/connectors/remediations?merchant_id=mch%2F1&status=corrected_dry_run_attached&triage_status=ready_for_followup_review&original_decision=needs_changes&has_corrected_dry_run=true&has_followup_review=false&limit=10',
    );
    expect(mockFetch.mock.calls[7]![1]?.body).toBeUndefined();

    ok({ data: { timeline: [], controls: { sandbox_only: true } } });
    await getCommerceConnectorDryRunRemediationTimeline('mch/1', 'cdrem/1');
    expect(mockFetch.mock.calls[8]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1/timeline',
    );
    expect(mockFetch.mock.calls[8]![1]?.body).toBeUndefined();

    ok({ data: { remediation_id: 'cdrem/1', triage: { triage_status: 'waiting_on_merchant' } }, audit_event_id: 'aud_triage', controls: { sandbox_only: true } });
    await recordCommerceConnectorDryRunRemediationTriage('mch/1', 'cdrem/1', {
      triageStatus: 'waiting_on_merchant',
      assignedOperatorId: 'ops.c6sib',
      triageNote: 'Review corrected sandbox category mapping after rerun.',
      merchantFollowupSummary: 'Rerun the sandbox dry-run after fixing category mapping.',
      nextStep: 'Attach corrected sandbox evidence.',
    });
    expect(mockFetch.mock.calls[9]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1/triage',
    );
    const triageBody = JSON.parse(mockFetch.mock.calls[9]![1].body);
    expect(triageBody).toEqual({
      triage_status: 'waiting_on_merchant',
      assigned_operator_id: 'ops.c6sib',
      triage_note: 'Review corrected sandbox category mapping after rerun.',
      merchant_followup_summary: 'Rerun the sandbox dry-run after fixing category mapping.',
      next_step: 'Attach corrected sandbox evidence.',
    });
    expect(JSON.stringify(triageBody).toLowerCase()).not.toContain('credential');
    expect(JSON.stringify(triageBody).toLowerCase()).not.toContain('public_discovery_enabled');
    expect(JSON.stringify(triageBody).toLowerCase()).not.toContain('checkout_payment_enabled');
    expect(JSON.stringify(triageBody).toLowerCase()).not.toContain('live_provider_enabled');

    ok({ data: { remediation_id: 'cdrem/1' }, corrected_dry_run: { dry_run_id: 'cdry/2' }, audit_event_id: 'aud_4' });
    await attachCommerceConnectorRemediationCorrectedDryRun('mch/1', 'cdrem/1', {
      correctedDryRunId: 'cdry/2',
      publicSafeNote: 'Corrected sandbox evidence only.',
    });
    expect(mockFetch.mock.calls[10]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1/corrected-dry-run',
    );
    const correctedBody = JSON.parse(mockFetch.mock.calls[10]![1].body);
    expect(correctedBody).toEqual({
      corrected_dry_run_id: 'cdry/2',
      public_safe_note: 'Corrected sandbox evidence only.',
    });

    ok({ data: { remediation_id: 'cdrem/1' }, corrected_dry_run: { dry_run_id: 'cdry/2' }, followup_review: { review_id: 'cdrev/2' }, audit_event_id: 'aud_5' });
    await requestCommerceConnectorRemediationFollowUpReview('mch/1', 'cdrem/1', {
      requestNote: 'Follow-up sandbox evidence review.',
    });
    expect(mockFetch.mock.calls[11]![0]).toBe(
      'http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1/follow-up-review',
    );
    const followupBody = JSON.parse(mockFetch.mock.calls[11]![1].body);
    expect(followupBody).toEqual({ request_note: 'Follow-up sandbox evidence review.' });
    for (const body of [remediationBody, triageBody, correctedBody, followupBody]) {
      const serialized = JSON.stringify(body).toLowerCase();
      for (const forbidden of [
        'credential',
        'secret',
        'provider_metadata',
        'public_discovery_enabled',
        'checkout_payment_enabled',
        'live_provider_enabled',
        'live_plural_enabled',
        'production_allowlist',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('reuses the same public-safe triage request shape for duplicate-current submissions', async () => {
    const response = {
      data: {
        remediation_id: 'cdrem/1',
        triage: {
          triage_status: 'waiting_on_merchant',
          merchant_followup_summary: 'Rerun the sandbox dry-run after fixing category mapping.',
          next_step: 'Attach corrected sandbox evidence.',
          triage_audit_event_id: 'aud_triage',
        },
      },
      audit_event_id: 'aud_triage',
      controls: {
        sandbox_only: true,
        credential_entry_enabled: false,
        outbound_sync_enabled: false,
        production_connector_setup_enabled: false,
        provider_call_enabled: false,
        merchant_private_api_calls_enabled: false,
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
    };
    ok(response);
    ok(response);

    const input = {
      triageStatus: 'waiting_on_merchant' as const,
      assignedOperatorId: 'ops.c6sic',
      triageNote: 'Internal sandbox triage note remains operator-only.',
      merchantFollowupSummary: 'Rerun the sandbox dry-run after fixing category mapping.',
      nextStep: 'Attach corrected sandbox evidence.',
    };
    await recordCommerceConnectorDryRunRemediationTriage('mch/1', 'cdrem/1', input);
    await recordCommerceConnectorDryRunRemediationTriage('mch/1', 'cdrem/1', input);

    expect(mockFetch.mock.calls).toHaveLength(2);
    for (const call of mockFetch.mock.calls) {
      expect(call[0]).toBe('http://localhost:3000/v1/commerce/merchants/mch%2F1/connectors/remediations/cdrem%2F1/triage');
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({
        triage_status: 'waiting_on_merchant',
        assigned_operator_id: 'ops.c6sic',
        triage_note: 'Internal sandbox triage note remains operator-only.',
        merchant_followup_summary: 'Rerun the sandbox dry-run after fixing category mapping.',
        next_step: 'Attach corrected sandbox evidence.',
      });
      const serialized = JSON.stringify(body).toLowerCase();
      for (const forbidden of [
        'credential',
        'secret',
        'provider_metadata',
        'raw_payload',
        'public_discovery_enabled',
        'checkout_payment_enabled',
        'live_provider_enabled',
        'live_plural_enabled',
        'production_allowlist',
        'certification',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
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
