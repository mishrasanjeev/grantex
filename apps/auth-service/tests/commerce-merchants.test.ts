import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, buildTestApp } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const validBody = {
  legal_name: 'Acme Electronics Pvt Ltd',
  display_name: 'Acme Electronics',
  category_preset: 'electronics_appliances',
  default_currency: 'INR',
  country_code: 'IN',
  support_email: 'support@acme.example',
};

function onboardingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mch_SANDBOX',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    display_name: 'Acme Sandbox',
    category_preset: 'electronics_appliances',
    environment: 'sandbox',
    agentic_commerce_enabled: false,
    default_currency: 'INR',
    country_code: 'IN',
    support_email: 'support@acme.example',
    support_url: 'https://support.acme.example/help',
    public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
    agentic_commerce_requested: true,
    sandbox_onboarding_state: 'sandbox_ready',
    sandbox_onboarding_blocker: null,
    sandbox_onboarding_updated_at: new Date().toISOString(),
    provider_account_refs: {},
    ...overrides,
  };
}

function catalogReadySummary(overrides: Record<string, unknown> = {}) {
  return {
    product_count: 1,
    variant_count: 2,
    products_with_image: 1,
    products_with_public_safe_title: 1,
    products_with_public_safe_description: 1,
    products_with_category_mapping: 1,
    products_with_unsafe_text: 0,
    variants_with_sku: 2,
    variants_with_price_currency: 2,
    variants_with_warranty_summary: 2,
    variants_with_return_policy_summary: 2,
    variants_with_tax_metadata: 2,
    variants_with_fresh_inventory: 2,
    variants_with_known_availability: 2,
    variants_with_unsafe_text: 0,
    ...overrides,
  };
}

function catalogMissingSummary(overrides: Record<string, unknown> = {}) {
  return {
    product_count: 1,
    variant_count: 2,
    products_with_image: 0,
    products_with_public_safe_title: 1,
    products_with_public_safe_description: 1,
    products_with_category_mapping: 1,
    products_with_unsafe_text: 0,
    variants_with_sku: 2,
    variants_with_price_currency: 2,
    variants_with_warranty_summary: 0,
    variants_with_return_policy_summary: 0,
    variants_with_tax_metadata: 0,
    variants_with_fresh_inventory: 0,
    variants_with_known_availability: 1,
    variants_with_unsafe_text: 0,
    ...overrides,
  };
}

function catalogEmptySummary(overrides: Record<string, unknown> = {}) {
  return {
    product_count: 0,
    variant_count: 0,
    products_with_image: 0,
    products_with_public_safe_title: 0,
    products_with_public_safe_description: 0,
    products_with_category_mapping: 0,
    products_with_unsafe_text: 0,
    variants_with_sku: 0,
    variants_with_price_currency: 0,
    variants_with_warranty_summary: 0,
    variants_with_return_policy_summary: 0,
    variants_with_tax_metadata: 0,
    variants_with_fresh_inventory: 0,
    variants_with_known_availability: 0,
    variants_with_unsafe_text: 0,
    ...overrides,
  };
}

function previewSampleRows(overrides: Record<string, unknown> = {}) {
  return [
    {
      product_row_id: 'cprd_SAMPLE_1',
      title: 'Countertop induction cooktop',
      description: 'Sandbox appliance catalog item for agent preview.',
      image_url: 'https://images.example.test/cooktop.jpg',
      category_preset: 'electronics_appliances',
      sku: 'SKU-COOKTOP-1',
      variant_title: 'Black finish',
      price_amount: 129900,
      currency: 'INR',
      availability_status: 'in_stock',
      warranty_summary: 'One year limited warranty.',
      return_policy_summary: 'Returns accepted within seven days.',
      ...overrides,
    },
    {
      product_row_id: 'cprd_SAMPLE_1',
      title: 'Countertop induction cooktop',
      description: 'Sandbox appliance catalog item for agent preview.',
      image_url: 'https://images.example.test/cooktop.jpg',
      category_preset: 'electronics_appliances',
      sku: 'SKU-COOKTOP-2',
      variant_title: 'Steel finish',
      price_amount: 139900,
      currency: 'INR',
      availability_status: 'pre_order',
      warranty_summary: 'One year limited warranty.',
      return_policy_summary: 'Returns accepted within seven days.',
      ...overrides,
    },
  ];
}

function schemaOrgProductRows(overrides: Record<string, unknown> = {}) {
  return [
    {
      product_row_id: 'cprd_SCHEMA_PRODUCT_1',
      title: 'Countertop induction cooktop',
      brand: 'Acme Home',
      description: 'Sandbox appliance catalog item for agent preview.',
      image_url: 'https://images.example.test/cooktop.jpg',
      category_preset: 'electronics_appliances',
      variant_row_id: 'cvar_SCHEMA_VARIANT_1',
      price_amount: 129900,
      currency: 'INR',
      availability_status: 'in_stock',
      return_policy_summary: 'Returns accepted within seven days.',
      ...overrides,
    },
  ];
}

function ucpCapabilityCatalogSummary(overrides: Record<string, unknown> = {}) {
  return [{
    product_count: 1,
    variant_count: 2,
    variants_with_price_currency: 2,
    variants_with_known_availability: 2,
    products_with_public_safe_title: 1,
    products_with_public_safe_description: 1,
    products_with_unsafe_text: 0,
    variants_with_unsafe_text: 0,
    ...overrides,
  }];
}

function acpCheckoutEvidenceSummary(overrides: Record<string, unknown> = {}) {
  return [{
    active_policy_count: 1,
    granted_checkout_consent_count: 1,
    active_checkout_passport_count: 1,
    unrevoked_checkout_passport_count: 1,
    sandbox_cart_count: 1,
    sandbox_payment_intent_count: 1,
    ...overrides,
  }];
}

function acpCartPreviewRow(overrides: Record<string, unknown> = {}) {
  return [{
    status: 'draft',
    currency: 'INR',
    subtotal_amount: 129900,
    tax_amount: 0,
    total_amount: 129900,
    line_items_snapshot: [
      {
        variant_id: 'cvar_ACP_PRIVATE',
        sku: 'SKU-ACP-PRIVATE',
        quantity: 1,
        unit_amount: 129900,
        line_total_amount: 129900,
        currency: 'INR',
      },
    ],
    line_items_snapshot_hash: 'hash_cart_snapshot',
    passport_jti: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }];
}

function acpPaymentIntentPreviewRow(overrides: Record<string, unknown> = {}) {
  return [{
    status: 'authorized',
    amount: 129900,
    currency: 'INR',
    provider_environment: 'sandbox',
    checkout_url: 'https://mock-payments.grantex.local/checkout/private',
    provider_payment_id: 'mock_pay_PRIVATE',
    provider_order_id: 'mock_order_PRIVATE',
    provider_metadata: { provider_private: 'do-not-leak' },
    provider_raw_status: 'mock_authorized',
    policy_version: 'v1',
    decision_id: 'cpdec_PRIVATE',
    passport_jti: 'cpsp_PRIVATE',
    line_items_snapshot: [
      {
        variant_id: 'cvar_ACP_PRIVATE',
        sku: 'SKU-ACP-PRIVATE',
        quantity: 1,
        unit_amount: 129900,
        line_total_amount: 129900,
        currency: 'INR',
      },
    ],
    created_at: '2026-01-01T00:05:00Z',
    ...overrides,
  }];
}

function ap2EvidencePreviewRow(overrides: Record<string, unknown> = {}) {
  return [{
    payment_status: 'authorized',
    payment_amount: 129900,
    payment_currency: 'INR',
    provider_environment: 'sandbox',
    payment_policy_version: 'v1',
    payment_decision_id: 'cpdec_AP2_PRIVATE',
    payment_idempotency_key_hash: 'hash_payment_idempotency',
    payment_created_at: '2026-01-01T00:05:00Z',
    cart_status: 'payment_intent_created',
    cart_currency: 'INR',
    cart_total_amount: 129900,
    cart_snapshot_hash: 'hash_cart_snapshot_ap2',
    cart_idempotency_key_hash: 'hash_cart_idempotency',
    cart_line_items_snapshot: [
      {
        variant_id: 'cvar_AP2_PRIVATE',
        sku: 'SKU-AP2-PRIVATE',
        quantity: 1,
        unit_amount: 129900,
        line_total_amount: 129900,
        currency: 'INR',
      },
    ],
    passport_type: 'checkout',
    passport_environment: 'sandbox',
    passport_scopes: [
      'commerce:catalog.read',
      'commerce:inventory.read',
      'commerce:checkout.create',
      'commerce:payment.initiate',
      'commerce:payment.status.read',
    ],
    passport_max_amount: 150000,
    passport_currency: 'INR',
    passport_policy_version: 'v1',
    passport_not_before: '2026-01-01T00:00:00Z',
    passport_expires_at: '2026-01-01T00:10:00Z',
    passport_not_expired: true,
    passport_agent_auth_method: 'api_key',
    passport_revoked: false,
    consent_status: 'granted',
    consent_passport_type: 'checkout',
    consent_requested_scopes: [
      'commerce:catalog.read',
      'commerce:inventory.read',
      'commerce:checkout.create',
      'commerce:payment.initiate',
      'commerce:payment.status.read',
    ],
    consent_approved_scopes: [
      'commerce:catalog.read',
      'commerce:inventory.read',
      'commerce:checkout.create',
      'commerce:payment.initiate',
      'commerce:payment.status.read',
    ],
    consent_max_amount: 150000,
    consent_currency: 'INR',
    consent_text_version: 'checkout_v1',
    presented_payload_hash: 'hash_presented_payload',
    consent_approved_at: '2026-01-01T00:01:00Z',
    consent_agent_auth_method: 'api_key',
    policy_status: 'active',
    policy_rules: {
      amount_cap: { max_amount_minor_units: 150000, currency: 'INR' },
      emergency_disable: false,
    },
    agent_trust_status: 'trusted',
    agent_disabled_at: null,
    agent_id: 'cag_AP2_PRIVATE',
    ...overrides,
  }];
}

function ap2AuditReferenceRows(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'caud_AP2_PRIVATE',
    event_type: 'payment_intent.created',
    occurred_at: '2026-01-01T00:06:00Z',
    passport_jti: 'cpsp_AP2_PRIVATE',
    policy_version: 'v1',
    decision_id: 'cpdec_AP2_PRIVATE',
    idempotency_key_hash: 'hash_payment_idempotency',
    ...overrides,
  }];
}

function reviewRequestAudit(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'caud_REVIEW_REQUEST',
    event_type: 'merchant.sandbox_onboarding.read_only_discovery_review.requested',
    occurred_at: '2026-01-01T00:05:00Z',
    user_principal_id: 'dev_TEST',
    metadata: { request_status: 'requested' },
    ...overrides,
  }];
}

function rolloutProposalReadyAudit(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'caud_ROLLOUT_READY',
    event_type: 'merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready',
    occurred_at: '2026-01-01T00:10:00Z',
    user_principal_id: 'dev_OPERATOR',
    metadata: {
      operator_decision: 'rollout_proposal_ready',
      decision_reason: 'Evidence supports later planning gate.',
      remediation_items: [],
      blockers: [],
    },
    ...overrides,
  }];
}

function rolloutProposalAudit(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'caud_PROPOSAL',
    event_type: 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created',
    occurred_at: '2026-01-01T00:15:00Z',
    user_principal_id: 'dev_OPERATOR',
    metadata: {
      proposal_status: 'draft_created',
      proposal_note: 'Sandbox evidence package.',
      dry_run_result: 'not_run',
      blockers: [],
      remediation_items: [],
    },
    ...overrides,
  }];
}

function rolloutProposalDryRunPassedAudit(overrides: Record<string, unknown> = {}) {
  return rolloutProposalAudit({
    id: 'caud_PROPOSAL_DRY_RUN_PASS',
    event_type: 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed',
    occurred_at: '2026-01-01T00:20:00Z',
    metadata: {
      proposal_status: 'dry_run_passed',
      proposal_note: 'Sandbox evidence package.',
      dry_run_result: 'passed',
      blockers: [],
      remediation_items: [],
    },
    ...overrides,
  });
}

function agenticOrgHandoffRequestedAudit(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'caud_AGENTICORG_HANDOFF',
    event_type: 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested',
    occurred_at: '2026-01-01T00:25:00Z',
    user_principal_id: 'dev_OPERATOR',
    metadata: {
      handoff_status: 'sandbox_handoff_requested',
      integration_status: 'sandbox_handoff_ready',
      blockers: [],
      remediation_items: [],
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
    },
    ...overrides,
  }];
}

describe('POST /v1/commerce/merchants', () => {
  it('creates a merchant and returns 201 with audit_event_id', async () => {
    seedCommerceContext();
    // INSERT commerce_merchants RETURNING ...
    sqlMock.mockResolvedValueOnce([{
      id: 'mch_NEW',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      legal_name: validBody.legal_name,
      display_name: validBody.display_name,
      category_preset: 'electronics_appliances',
      verification_status: 'unverified',
      environment: 'sandbox',
      agentic_commerce_enabled: false,
      default_currency: 'INR',
      country_code: 'IN',
      support_email: validBody.support_email,
      support_url: null,
      public_discovery_description_draft: null,
      agentic_commerce_requested: false,
      sandbox_onboarding_state: 'draft_created',
      sandbox_onboarding_blocker: null,
      sandbox_onboarding_updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);
    // INSERT commerce_audit_events RETURNING id, occurred_at
    sqlMock.mockResolvedValueOnce([{ id: 'caud_AUDIT', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      headers: authHeader(),
      payload: validBody,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; tenant_id: string; category_preset: string }; audit_event_id: string }>();
    expect(body.data.id).toBe('mch_NEW');
    expect(body.data.tenant_id).toBe(TEST_COMMERCE_TENANT_ID);
    expect(body.data.category_preset).toBe('electronics_appliances');
    expect(body.audit_event_id).toBe('caud_AUDIT');
  });

  it('returns 422 with field-level details when required fields missing', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      headers: authHeader(),
      payload: { display_name: 'Only display' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string; details: { fields: Record<string, string> } } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.fields).toHaveProperty('legal_name');
    expect(body.error.details.fields).toHaveProperty('category_preset');
  });

  it('rejects unknown category_preset', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      headers: authHeader(),
      payload: { ...validBody, category_preset: 'fashion_lifestyle' },  // not in V1
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('category_preset');
  });

  it('rejects production/live, provider, and checkout enablement fields on create', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      headers: authHeader(),
      payload: {
        ...validBody,
        environment: 'live',
        provider_credentials: { token: 'secret' },
        agentic_commerce_enabled: true,
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('environment');
    expect(fields.unsupported_fields).toContain('provider_credentials');
    expect(fields.unsupported_fields).toContain('agentic_commerce_enabled');
  });

  it('returns 401 with the commerce envelope on missing Authorization (M2 caller refactor)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      payload: validBody,
    });
    // M2 Decision F: commerce routes opt out of the global authPlugin and
    // run their own commerce caller resolver. 401s now use the commerce
    // envelope { error: { code, message, ... } } scoped to /v1/commerce/*.
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('missing_authorization');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('GET /v1/commerce/merchants/:merchantId', () => {
  it('returns the merchant when in caller tenant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      id: 'mch_GET',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      legal_name: 'Acme Pvt Ltd',
      display_name: 'Acme',
      category_preset: 'electronics_appliances',
      verification_status: 'unverified',
      environment: 'sandbox',
      agentic_commerce_enabled: false,
      default_currency: 'INR',
      country_code: 'IN',
      support_email: null,
      disabled_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_GET',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { id: string } }>().data.id).toBe('mch_GET');
  });

  it('returns 404 with commerce envelope when merchant absent', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);  // merchant lookup empty

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_MISSING',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('merchant_not_found');
    expect(body).not.toHaveProperty('message');  // commerce envelope nests under .error
  });
});

describe('sandbox onboarding foundation', () => {
  it('returns sandbox onboarding state and readiness without provider references', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        sandbox_onboarding_state: string;
        production_approval_status?: string;
        provider_account_refs?: unknown;
        readiness: {
          ready: boolean;
          production_approval_status: string;
          rollout_status: string;
          score_percent: number;
          category_readiness: { status: string; score_percent: number; required_passed: boolean };
          catalog_readiness: { status: string; score_percent: number; required_passed: boolean; product_count: number; variant_count: number };
        };
        agent_facing_preview: {
          preview_status: string;
          preview_blockers: string[];
          sandbox_only: boolean;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          merchant: { merchant_reference: string; display_name: string; public_discovery_description_draft: string };
          sample_products: Array<{ sample_reference: string; title: string; variants: Array<{ sku: string }> }>;
          allowed_preview_capabilities: string[];
          blocked_capabilities: string[];
        };
        read_only_discovery_review: {
          status: string;
          eligible: boolean;
          request_is_approval: boolean;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          production_allowlist_written: boolean;
          blockers: string[];
        };
      };
    }>();
    expect(body.data.sandbox_onboarding_state).toBe('sandbox_ready');
    expect(body.data.readiness.ready).toBe(true);
    expect(body.data.readiness.score_percent).toBe(100);
    expect(body.data.readiness.category_readiness).toMatchObject({
      status: 'pass',
      score_percent: 100,
      required_passed: true,
    });
    expect(body.data.readiness.catalog_readiness).toMatchObject({
      status: 'pass',
      score_percent: 100,
      required_passed: true,
      product_count: 1,
      variant_count: 2,
    });
    expect(body.data.readiness.production_approval_status).toBe('not_approved');
    expect(body.data.readiness.rollout_status).toBe('rollout_not_requested');
    expect(body.data.provider_account_refs).toBeUndefined();
    expect(body.data.agent_facing_preview).toMatchObject({
      preview_status: 'ready',
      preview_blockers: [],
      sandbox_only: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      merchant: {
        merchant_reference: 'mch_SANDBOX',
        display_name: 'Acme Sandbox',
        public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
      },
    });
    expect(body.data.agent_facing_preview.allowed_preview_capabilities).toEqual([
      'read_only_profile_preview',
      'read_only_catalog_preview',
      'readiness_review_preview',
    ]);
    expect(body.data.agent_facing_preview.blocked_capabilities).toContain('public_discovery');
    expect(body.data.agent_facing_preview.blocked_capabilities).toContain('checkout_payment_creation');
    expect(body.data.agent_facing_preview.sample_products).toHaveLength(1);
    expect(body.data.agent_facing_preview.sample_products[0]!.variants).toHaveLength(2);
    expect(body.data.read_only_discovery_review).toMatchObject({
      status: 'eligible',
      eligible: true,
      request_is_approval: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
      blockers: [],
    });
    const previewJson = JSON.stringify(body.data.agent_facing_preview);
    expect(previewJson).not.toContain('provider_account_refs');
    expect(previewJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY');
    expect(previewJson).not.toContain('agentic_commerce_enabled');
  });

  it('blocks the agent-facing preview when existing public description text is unsafe', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      public_discovery_description_draft: 'Production ready live payment checkout is approved.',
    })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const preview = res.json<{
      data: {
        agent_facing_preview: {
          preview_status: string;
          preview_blockers: string[];
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          merchant: { public_discovery_description_draft: string | null };
        };
      };
    }>().data.agent_facing_preview;
    expect(preview.preview_status).toBe('blocked');
    expect(preview.preview_blockers).toContain('public_discovery_description_unsafe_or_missing');
    expect(preview.merchant.public_discovery_description_draft).toBeNull();
    expect(preview.public_discovery_enabled).toBe(false);
    expect(preview.checkout_payment_enabled).toBe(false);
  });

  it('caps agent-facing preview product samples and keeps sample text public-safe', async () => {
    seedCommerceContext();
    const productRows = [1, 2, 3, 4].map((i) => ({
      product_row_id: `cprd_SAMPLE_${i}`,
      title: `Sandbox appliance ${i}`,
      description: `Public-safe appliance preview item ${i}.`,
      image_url: `https://images.example.test/appliance-${i}.jpg`,
      category_preset: 'electronics_appliances',
      sku: `SKU-APPLIANCE-${i}`,
      variant_title: `Variant ${i}`,
      price_amount: 100000 + i,
      currency: 'INR',
      availability_status: 'in_stock',
      warranty_summary: 'One year limited warranty.',
      return_policy_summary: 'Returns accepted within seven days.',
    }));
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary({
      product_count: 4,
      variant_count: 4,
      products_with_image: 4,
      products_with_public_safe_title: 4,
      products_with_public_safe_description: 4,
      products_with_category_mapping: 4,
      variants_with_sku: 4,
      variants_with_price_currency: 4,
      variants_with_warranty_summary: 4,
      variants_with_return_policy_summary: 4,
      variants_with_tax_metadata: 4,
      variants_with_fresh_inventory: 4,
      variants_with_known_availability: 4,
    })]);
    sqlMock.mockResolvedValueOnce(productRows);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const preview = res.json<{
      data: {
        agent_facing_preview: {
          sample_products: Array<{ sample_reference: string; title: string; variants: Array<{ sku: string }> }>;
        };
      };
    }>().data.agent_facing_preview;
    expect(preview.sample_products).toHaveLength(3);
    expect(preview.sample_products.map((product) => product.sample_reference)).toEqual([
      'catalog_sample_1',
      'catalog_sample_2',
      'catalog_sample_3',
    ]);
    expect(JSON.stringify(preview.sample_products)).not.toMatch(/secret|token|provider|checkout|payment|production|live|allowlist/i);
  });

  it('returns 404 for sandbox onboarding when tenant-scoped lookup is empty', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_OTHER_TENANT/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    const allTplStrings = sqlMock.mock.calls.flatMap((c) => {
      const tpl = c[0] as unknown;
      return Array.isArray(tpl) ? tpl.filter((s): s is string => typeof s === 'string') : [];
    });
    expect(allTplStrings.some((s) => s.includes('tenant_id'))).toBe(true);
  });

  it('updates safe sandbox profile fields, derives sandbox_ready, and writes audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      public_discovery_description_draft: null,
      sandbox_onboarding_state: 'draft_created',
    })]);
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'draft_created' })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_ONBOARDING', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
      payload: {
        display_name: 'Acme Sandbox',
        category_preset: 'electronics_appliances',
        country_code: 'IN',
        default_currency: 'INR',
        support_email: 'support@acme.example',
        support_url: 'https://support.acme.example/help',
        public_discovery_description_draft: 'Sandbox catalog profile for test appliances.',
        agentic_commerce_requested: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        sandbox_onboarding_state: string;
        readiness: {
          ready: boolean;
          category_readiness: { status: string; score_percent: number };
          catalog_readiness: { status: string; required_passed: boolean };
        };
      };
      audit_event_id: string;
    }>();
    expect(body.data.sandbox_onboarding_state).toBe('sandbox_ready');
    expect(body.data.readiness.ready).toBe(true);
    expect(body.data.readiness.category_readiness).toMatchObject({ status: 'pass', score_percent: 100 });
    expect(body.data.readiness.catalog_readiness).toMatchObject({ status: 'pass', required_passed: true });
    expect(body.audit_event_id).toBe('caud_ONBOARDING');
  });

  it('rejects submitted_for_review profile updates that would fail required readiness', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'submitted_for_review',
      support_email: null,
      support_url: null,
    })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
      payload: {
        support_email: null,
        support_url: null,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; details: { category_readiness_status: string } } }>().error)
      .toMatchObject({
        code: 'invalid_sandbox_onboarding_update',
        details: { category_readiness_status: 'fail' },
      });
  });

  it('reports recommended electronics catalog remediation without blocking required sandbox review fields', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogMissingSummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const items = res.json<{
      data: {
        readiness: {
          ready: boolean;
          category_readiness: {
            status: string;
            score_percent: number;
            items: Array<{ key: string; severity: string; status: string; remediation: string }>;
          };
        };
      };
    }>().data.readiness.category_readiness.items;
    expect(res.json<{ data: { readiness: { ready: boolean; category_readiness: { status: string } } } }>()
      .data.readiness).toMatchObject({ ready: true, category_readiness: { status: 'pass' } });
    for (const key of ['warranty_summary', 'return_policy_summary', 'tax_gst_metadata', 'inventory_freshness']) {
      const item = items.find((candidate) => candidate.key === key);
      expect(item).toBeDefined();
      expect(item).toMatchObject({ severity: 'recommended', status: 'fail' });
      expect(item?.remediation.length).toBeGreaterThan(10);
    }
  });

  it('fails required catalog readiness when no products are present', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogEmptySummary()]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const readiness = res.json<{
      data: {
        readiness: {
          ready: boolean;
          catalog_readiness: {
            status: string;
            required_passed: boolean;
            product_count: number;
            variant_count: number;
            items: Array<{ key: string; severity: string; status: string; remediation: string }>;
          };
        };
      };
    }>().data.readiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.catalog_readiness).toMatchObject({
      status: 'fail',
      required_passed: false,
      product_count: 0,
      variant_count: 0,
    });
    expect(readiness.catalog_readiness.items.find((item) => item.key === 'catalog_products_present'))
      .toMatchObject({ severity: 'required', status: 'fail' });
  });

  it('reports remediation for missing catalog fields without enabling production paths', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary({
      products_with_image: 0,
      products_with_public_safe_title: 0,
      products_with_public_safe_description: 0,
      products_with_category_mapping: 0,
      variants_with_sku: 1,
      variants_with_price_currency: 1,
    })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const catalog = res.json<{
      data: {
        readiness: {
          ready: boolean;
          catalog_readiness: {
            status: string;
            items: Array<{ key: string; severity: string; status: string; count?: number; total?: number; remediation: string }>;
          };
        };
      };
    }>().data.readiness.catalog_readiness;
    expect(catalog.status).toBe('fail');
    const expected = [
      'products_public_safe_title',
      'products_public_safe_description',
      'products_category_mapping',
      'variants_sku_present',
      'variants_price_currency_present',
      'products_image_media',
    ];
    for (const key of expected) {
      const item = catalog.items.find((candidate) => candidate.key === key);
      expect(item).toBeDefined();
      expect(item?.status).toBe('fail');
      expect(item?.remediation.length).toBeGreaterThan(10);
    }
  });

  it('blocks catalog readiness when unsafe product or variant text is detected', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow()]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary({ products_with_unsafe_text: 1 })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const catalog = res.json<{
      data: { readiness: { ready: boolean; catalog_readiness: { status: string; blocker_count: number; items: Array<{ key: string; status: string }> } } };
    }>().data.readiness.catalog_readiness;
    expect(catalog).toMatchObject({ status: 'blocked', blocker_count: 1 });
    expect(catalog.items.find((item) => item.key === 'no_unsafe_catalog_text'))
      .toMatchObject({ status: 'blocked' });
  });

  it('fails required category readiness when category preset is missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ category_preset: null })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const readiness = res.json<{
      data: {
        readiness: {
          ready: boolean;
          category_readiness: { status: string; required_passed: boolean; items: Array<{ key: string; status: string }> };
        };
      };
    }>().data.readiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.category_readiness).toMatchObject({ status: 'fail', required_passed: false });
    expect(readiness.category_readiness.items.find((item) => item.key === 'category_preset_recognized'))
      .toMatchObject({ status: 'fail' });
  });

  it('fails closed when an existing merchant row has an unsupported category preset', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ category_preset: 'fashion_lifestyle' })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const category = res.json<{
      data: { readiness: { ready: boolean; category_readiness: { status: string; summary: string; items: Array<{ key: string; status: string; remediation: string }> } } };
    }>().data.readiness.category_readiness;
    expect(category.status).toBe('blocked');
    expect(category.items.find((item) => item.key === 'category_preset_recognized'))
      .toMatchObject({ status: 'blocked' });
    expect(category.summary).toContain('blocked');
  });

  it('rejects unsafe sandbox onboarding fields that would imply production or checkout enablement', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding',
      headers: authHeader(),
      payload: {
        environment: 'live',
        agentic_commerce_enabled: true,
        public_discovery_description_draft: 'Production ready live payment checkout is approved.',
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('environment');
    expect(fields.unsupported_fields).toContain('agentic_commerce_enabled');
    expect(fields.public_discovery_description_draft).toContain('public-safe text');
  });

  it('transitions a ready sandbox workspace to submitted_for_review with audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_TRANSITION', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/transition',
      headers: authHeader(),
      payload: { target_state: 'submitted_for_review' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sandbox_onboarding_state: string; readiness: { production_approval_status: string } }; audit_event_id: string }>();
    expect(body.data.sandbox_onboarding_state).toBe('submitted_for_review');
    expect(body.data.readiness.production_approval_status).toBe('not_approved');
    expect(body.audit_event_id).toBe('caud_TRANSITION');
  });

  it('requests read-only discovery review without enabling production controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_READONLY_REVIEW', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review-request',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        sandbox_onboarding_state: string;
        read_only_discovery_review: {
          status: string;
          eligible: boolean;
          requested_at: string | null;
          request_is_approval: boolean;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          production_allowlist_written: boolean;
        };
        agent_facing_preview: {
          preview_status: string;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
        };
      };
      audit_event_id: string;
    }>();
    expect(body.data.sandbox_onboarding_state).toBe('submitted_for_review');
    expect(body.data.read_only_discovery_review).toMatchObject({
      status: 'requested',
      eligible: true,
      request_is_approval: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
    });
    expect(body.data.read_only_discovery_review.requested_at).not.toBeNull();
    expect(body.data.agent_facing_preview).toMatchObject({
      preview_status: 'ready',
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
    });
    expect(body.audit_event_id).toBe('caud_READONLY_REVIEW');
    const allArgs = JSON.stringify(sqlMock.mock.calls);
    expect(allArgs).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
    expect(allArgs).not.toContain('agentic_commerce_enabled = true');
  });

  it('blocks read-only discovery review request when prerequisites are missing and writes audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      public_discovery_description_draft: null,
      sandbox_onboarding_state: 'sandbox_ready',
    })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_READONLY_BLOCKED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review-request',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          audit_event_id: string;
          read_only_discovery_review: {
            status: string;
            eligible: boolean;
            blockers: string[];
            remediation: string[];
          };
        };
      };
    }>().error;
    expect(error.code).toBe('read_only_discovery_review_blocked');
    expect(error.details.audit_event_id).toBe('caud_READONLY_BLOCKED');
    expect(error.details.read_only_discovery_review.status).toBe('blocked');
    expect(error.details.read_only_discovery_review.eligible).toBe(false);
    expect(error.details.read_only_discovery_review.blockers).toContain('preview_public_discovery_description_unsafe_or_missing');
    expect(error.details.read_only_discovery_review.remediation.length).toBeGreaterThan(0);
    const allTplStrings = sqlMock.mock.calls.flatMap((c) => {
      const tpl = c[0] as unknown;
      return Array.isArray(tpl) ? tpl.filter((s): s is string => typeof s === 'string') : [];
    });
    expect(allTplStrings.some((s) => s.includes('UPDATE commerce_merchants'))).toBe(false);
  });

  it('rejects private or production-candidate fields on read-only discovery review request', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review-request',
      headers: authHeader(),
      payload: {
        production_allowlist_candidate: 'mch_SYNTHETIC',
        provider_credentials: 'secret',
      },
    });

    expect(res.statusCode).toBe(400);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('production_allowlist_candidate');
    expect(fields.unsupported_fields).toContain('provider_credentials');
  });

  it('blocks read-only discovery review request for live merchants', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_READONLY_LIVE_BLOCKED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_LIVE/sandbox-onboarding/read-only-discovery-review-request',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: { audit_event_id: string; read_only_discovery_review: { blockers: string[] } };
      };
    }>().error;
    expect(error.code).toBe('read_only_discovery_review_blocked');
    expect(error.details.audit_event_id).toBe('caud_READONLY_LIVE_BLOCKED');
    expect(error.details.read_only_discovery_review.blockers).toContain('merchant_not_sandbox');
  });

  it('returns 404 for cross-tenant read-only discovery review request lookup misses', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_OTHER_TENANT/sandbox-onboarding/read-only-discovery-review-request',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('lists pending operator read-only discovery review requests with readiness evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/read-only-discovery-review-requests',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{
        merchant_id: string;
        review_request_status: string;
        requested_at: string | null;
        request_actor: string | null;
        production_approval_status: string;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
      }>;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      merchant_id: 'mch_SANDBOX',
      review_request_status: 'requested',
      requested_at: '2026-01-01T00:05:00.000Z',
      request_actor: 'dev_TEST',
      production_approval_status: 'not_approved',
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
    });
  });

  it('omits submitted operator review rows without C6D request audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/read-only-discovery-review-requests',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('reads one operator review request without exposing production controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        review_request_status: string;
        readiness_summary: { overall_status: string; catalog_status: string };
        agent_facing_preview_status: string;
        operator_decision_is_approval: boolean;
        rollout_proposal_ready_is_launch: boolean;
      };
    }>();
    expect(body.data.review_request_status).toBe('requested');
    expect(body.data.readiness_summary).toMatchObject({ overall_status: 'pass', catalog_status: 'pass' });
    expect(body.data.agent_facing_preview_status).toBe('ready');
    expect(body.data.operator_decision_is_approval).toBe(false);
    expect(body.data.rollout_proposal_ready_is_launch).toBe(false);
  });

  it('returns 404 when an operator review read lacks C6D request audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('read_only_discovery_review_not_found');
  });

  it('records changes_requested with remediation and audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'blocked',
      sandbox_onboarding_blocker: 'Improve catalog summaries.',
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CHANGES_REQUESTED', occurred_at: '2026-01-01T00:10:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'changes_requested',
        reason: 'Improve catalog summaries.',
        remediation_items: ['Add more product grounding.'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        review_request_status: string;
        operator_decision: string;
        decision_reason: string;
        remediation_items: string[];
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
      };
      audit_event_id: string;
    }>();
    expect(body.audit_event_id).toBe('caud_CHANGES_REQUESTED');
    expect(body.data).toMatchObject({
      review_request_status: 'changes_requested',
      operator_decision: 'changes_requested',
      decision_reason: 'Improve catalog summaries.',
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
    });
    expect(body.data.remediation_items).toEqual(['Add more product grounding.']);
    expect(JSON.stringify(sqlMock.mock.calls)).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('records rejected without enabling production controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'not_approved',
      sandbox_onboarding_blocker: 'Public-safe fields need more work.',
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REJECTED', occurred_at: '2026-01-01T00:10:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'rejected',
        reason: 'Public-safe fields need more work.',
        remediation_items: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { review_request_status: string; operator_decision: string; production_approval_status: string } }>();
    expect(body.data.review_request_status).toBe('rejected');
    expect(body.data.operator_decision).toBe('rejected');
    expect(body.data.production_approval_status).toBe('not_approved');
  });

  it('records rollout_proposal_ready without enabling discovery, checkout, or live provider controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_ROLLOUT_PROPOSAL', occurred_at: '2026-01-01T00:10:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'rollout_proposal_ready',
        reason: 'Evidence supports later planning gate.',
        remediation_items: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        review_request_status: string;
        operator_decision: string;
        operator_decision_is_approval: boolean;
        rollout_proposal_ready_is_launch: boolean;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        production_allowlist_written: boolean;
      };
    }>();
    expect(body.data).toMatchObject({
      review_request_status: 'rollout_proposal_ready',
      operator_decision: 'rollout_proposal_ready',
      operator_decision_is_approval: false,
      rollout_proposal_ready_is_launch: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
    });
    const allArgs = JSON.stringify(sqlMock.mock.calls);
    expect(allArgs).not.toContain('agentic_commerce_enabled = true');
  });

  it('blocks rollout_proposal_ready when prerequisites are stale', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'submitted_for_review',
      public_discovery_description_draft: null,
    })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'rollout_proposal_ready',
        reason: 'Evidence supports later planning gate.',
        remediation_items: [],
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; details: { public_discovery_enabled: boolean; blockers: string[] } } }>();
    expect(body.error.code).toBe('read_only_discovery_review_prerequisites_blocked');
    expect(body.error.details.public_discovery_enabled).toBe(false);
    expect(body.error.details.blockers).toContain('preview_public_discovery_description_unsafe_or_missing');
  });

  it('rejects unsafe private operator decision text', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'changes_requested',
        reason: 'secret token should not be stored',
        remediation_items: ['Add more product grounding.'],
      },
    });

    expect(res.statusCode).toBe(400);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.reason).toContain('public-safe text');
  });

  it('blocks operator decisions for live merchants and missing requests', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live', sandbox_onboarding_state: 'submitted_for_review' })]);

    const liveRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_LIVE/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'rejected',
        reason: 'Public-safe fields need more work.',
        remediation_items: [],
      },
    });

    expect(liveRes.statusCode).toBe(409);
    expect(liveRes.json<{ error: { code: string } }>().error.code).toBe('sandbox_onboarding_live_merchant_blocked');

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    const missingRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: authHeader(),
      payload: {
        decision: 'rejected',
        reason: 'Public-safe fields need more work.',
        remediation_items: [],
      },
    });
    expect(missingRes.statusCode).toBe(409);
    expect(missingRes.json<{ error: { code: string } }>().error.code).toBe('read_only_discovery_review_not_requested');
  });

  it('denies CommerceAgent callers on operator review decision endpoint', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/read-only-discovery-review/decision',
      headers: { authorization: 'Bearer grtx_agent_C6EXXXXXXXXXXXXXXXXXXXXXXXX' },
      payload: {
        decision: 'rejected',
        reason: 'Public-safe fields need more work.',
        remediation_items: [],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('creates a rollout proposal after rollout_proposal_ready without enabling production controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PROPOSAL_CREATED', occurred_at: '2026-01-01T00:15:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal',
      headers: authHeader(),
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        proposal_status: string;
        dry_run_result: string;
        operator_review: { operator_decision: string };
        evidence_checklist: Array<{ key: string; status: string }>;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        production_allowlist_written: boolean;
      };
      audit_event_id: string;
    }>();
    expect(body.audit_event_id).toBe('caud_PROPOSAL_CREATED');
    expect(body.data).toMatchObject({
      proposal_status: 'draft_created',
      dry_run_result: 'not_run',
      operator_review: { operator_decision: 'rollout_proposal_ready' },
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
    });
    expect(body.data.evidence_checklist.every((item) => item.status === 'pass')).toBe(true);
    const allArgs = JSON.stringify(sqlMock.mock.calls);
    expect(allArgs).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
    expect(allArgs).not.toContain('agentic_commerce_enabled = true');
  });

  it('blocks rollout proposal creation without C6E rollout_proposal_ready evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal',
      headers: authHeader(),
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; details: { public_discovery_enabled: boolean } } }>().error)
      .toMatchObject({
        code: 'read_only_discovery_rollout_proposal_not_ready',
        details: { public_discovery_enabled: false },
      });
  });

  it('blocks rollout proposal creation without C6D request audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal',
      headers: authHeader(),
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; details: { blockers: string[]; public_discovery_enabled: boolean } } }>().error)
      .toMatchObject({
        code: 'read_only_discovery_rollout_proposal_blocked',
        details: {
          blockers: ['read_only_discovery_review_request_evidence_missing'],
          public_discovery_enabled: false,
        },
      });
  });

  it('returns 404 for missing rollout proposal merchants and blocks live merchants', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);
    const missingRes = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_OTHER_TENANT/read-only-discovery-rollout-proposal',
      headers: authHeader(),
    });
    expect(missingRes.statusCode).toBe(404);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live', sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    const liveRes = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/read-only-discovery-rollout-proposal',
      headers: authHeader(),
    });
    expect(liveRes.statusCode).toBe(409);
    expect(liveRes.json<{ error: { code: string } }>().error.code)
      .toBe('read_only_discovery_rollout_proposal_live_merchant_blocked');
  });

  it('records rollout proposal dry-run pass and blocked audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_DRY_RUN_PASS', occurred_at: '2026-01-01T00:20:00Z' }]);

    const passRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal/dry-run',
      headers: authHeader(),
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(passRes.statusCode).toBe(200);
    expect(passRes.json<{ data: { proposal_status: string; dry_run_result: string; public_discovery_enabled: boolean } }>().data)
      .toMatchObject({
        proposal_status: 'dry_run_passed',
        dry_run_result: 'passed',
        public_discovery_enabled: false,
      });

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'submitted_for_review',
      public_discovery_description_draft: null,
    })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_DRY_RUN_BLOCKED', occurred_at: '2026-01-01T00:21:00Z' }]);

    const blockedRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal/dry-run',
      headers: authHeader(),
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(blockedRes.statusCode).toBe(200);
    const blocked = blockedRes.json<{ data: { proposal_status: string; dry_run_result: string; blockers: string[]; checkout_payment_enabled: boolean } }>().data;
    expect(blocked.proposal_status).toBe('dry_run_blocked');
    expect(blocked.dry_run_result).toBe('blocked');
    expect(blocked.blockers).toContain('sandbox_readiness_not_passed');
    expect(blocked.checkout_payment_enabled).toBe(false);
  });

  it('withdraws rollout proposals and rejects unsafe proposal notes', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PROPOSAL_WITHDRAWN', occurred_at: '2026-01-01T00:25:00Z' }]);

    const withdrawRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal/withdraw',
      headers: authHeader(),
      payload: { reason: 'Pause this proposal.' },
    });
    expect(withdrawRes.statusCode).toBe(200);
    expect(withdrawRes.json<{ data: { proposal_status: string; public_discovery_enabled: boolean } }>().data)
      .toMatchObject({ proposal_status: 'withdrawn', public_discovery_enabled: false });

    seedCommerceContext();
    const unsafeRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal',
      headers: authHeader(),
      payload: { proposal_note: 'secret token should not be stored' },
    });
    expect(unsafeRes.statusCode).toBe(400);
    expect(unsafeRes.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields.proposal_note)
      .toContain('public-safe text');
  });

  it('denies CommerceAgent callers on rollout proposal endpoints', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/read-only-discovery-rollout-proposal',
      headers: { authorization: 'Bearer grtx_agent_C6FXXXXXXXXXXXXXXXXXXXXXXX' },
      payload: { proposal_note: 'Sandbox evidence package.' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('returns an operator AgenticOrg buyer discovery preview from C6F dry-run evidence without enabling production controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalDryRunPassedAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        integration_status: string;
        sample_products: unknown[];
        allowed_buyer_agent_capabilities: string[];
        blocked_buyer_agent_capabilities: string[];
        agenticorg_public_discovery_enabled: boolean;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        production_allowlist_written: boolean;
      };
    }>();
    expect(body.data).toMatchObject({
      integration_status: 'sandbox_handoff_ready',
      agenticorg_public_discovery_enabled: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
    });
    expect(body.data.sample_products).toHaveLength(1);
    expect(body.data.allowed_buyer_agent_capabilities).toEqual([
      'read_only_profile_discovery_preview',
      'read_only_catalog_discovery_preview',
      'buyer_agent_readiness_context',
    ]);
    expect(body.data.blocked_buyer_agent_capabilities).toContain('direct_merchant_system_access');
    const previewJson = JSON.stringify(body.data);
    expect(previewJson).not.toContain('legal_name');
    expect(previewJson).not.toContain('provider_account_refs');
    expect(previewJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('records AgenticOrg buyer discovery handoff request audit after C6F dry run passes', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalDryRunPassedAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_AGENTICORG_HANDOFF_CREATED', occurred_at: '2026-01-01T00:25:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-handoff-request',
      headers: authHeader(),
      payload: { handoff_note: 'Sandbox buyer-agent handoff evidence.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        integration_status: string;
        handoff_requested_at: string | null;
        audit_event_id: string;
        agenticorg_public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
      };
      audit_event_id: string;
    }>();
    expect(body.audit_event_id).toBe('caud_AGENTICORG_HANDOFF_CREATED');
    expect(body.data.integration_status).toBe('sandbox_handoff_requested');
    expect(body.data.handoff_requested_at).toBe('2026-01-01T00:25:00.000Z');
    expect(body.data.audit_event_id).toBe('caud_AGENTICORG_HANDOFF_CREATED');
    expect(body.data.agenticorg_public_discovery_enabled).toBe(false);
    expect(body.data.checkout_payment_enabled).toBe(false);

    const auditPayload = JSON.stringify(sqlMock.mock.calls);
    expect(auditPayload).toContain('agenticorg_buyer_discovery_handoff.requested');
    expect(auditPayload).not.toContain('agentic_commerce_enabled = true');
  });

  it('blocks AgenticOrg handoff when C6F dry-run evidence has not passed and writes blocked audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_AGENTICORG_HANDOFF_BLOCKED', occurred_at: '2026-01-01T00:26:00Z' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-handoff-request',
      headers: authHeader(),
      payload: { handoff_note: 'Sandbox buyer-agent handoff evidence.' },
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          audit_event_id: string;
          agenticorg_buyer_discovery_preview: {
            integration_status: string;
            blockers: string[];
            public_discovery_enabled: boolean;
          };
        };
      };
    }>().error;
    expect(error.code).toBe('agenticorg_buyer_discovery_handoff_blocked');
    expect(error.details.audit_event_id).toBe('caud_AGENTICORG_HANDOFF_BLOCKED');
    expect(error.details.agenticorg_buyer_discovery_preview.integration_status).toBe('blocked');
    expect(error.details.agenticorg_buyer_discovery_preview.blockers).toContain('rollout_proposal_dry_run_not_passed');
    expect(error.details.agenticorg_buyer_discovery_preview.public_discovery_enabled).toBe(false);
  });

  it('allows CommerceAgent preview reads only after operator AgenticOrg handoff request', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalDryRunPassedAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce([]);

    const blockedRes = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-preview',
      headers: { authorization: 'Bearer grtx_agent_C6GXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(blockedRes.statusCode).toBe(409);
    expect(blockedRes.json<{ error: { code: string; details: { public_discovery_enabled: boolean } } }>().error)
      .toMatchObject({
        code: 'agenticorg_buyer_discovery_handoff_not_available',
        details: { public_discovery_enabled: false },
      });

    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalDryRunPassedAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce(agenticOrgHandoffRequestedAudit());

    const okRes = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-preview',
      headers: { authorization: 'Bearer grtx_agent_C6GXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(okRes.statusCode).toBe(200);
    const ok = okRes.json<{ data: { integration_status: string; sample_products: unknown[]; checkout_payment_enabled: boolean } }>().data;
    expect(ok.integration_status).toBe('sandbox_handoff_requested');
    expect(ok.sample_products).toHaveLength(1);
    expect(ok.checkout_payment_enabled).toBe(false);
  });

  it('denies CommerceAgent handoff writes, rejects unsafe handoff notes, and withdraws requested handoff', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);
    const agentWriteRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-handoff-request',
      headers: { authorization: 'Bearer grtx_agent_C6GXXXXXXXXXXXXXXXXXXXXXXX' },
      payload: { handoff_note: 'Sandbox buyer-agent handoff evidence.' },
    });
    expect(agentWriteRes.statusCode).toBe(403);
    expect(agentWriteRes.json<{ error: { code: string } }>().error.code).toBe('operator_required');

    seedCommerceContext();
    const unsafeRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-handoff-request',
      headers: authHeader(),
      payload: { handoff_note: 'production ready live payment provider token' },
    });
    expect(unsafeRes.statusCode).toBe(400);
    expect(unsafeRes.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields.handoff_note)
      .toContain('public-safe text');

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(reviewRequestAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalReadyAudit());
    sqlMock.mockResolvedValueOnce(rolloutProposalDryRunPassedAudit());
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);
    sqlMock.mockResolvedValueOnce(previewSampleRows());
    sqlMock.mockResolvedValueOnce(agenticOrgHandoffRequestedAudit());
    sqlMock.mockResolvedValueOnce([{ id: 'caud_AGENTICORG_HANDOFF_WITHDRAWN', occurred_at: '2026-01-01T00:30:00Z' }]);

    const withdrawRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/agenticorg-buyer-discovery-handoff-withdraw',
      headers: authHeader(),
      payload: { reason: 'Pause sandbox handoff.' },
    });
    expect(withdrawRes.statusCode).toBe(200);
    expect(withdrawRes.json<{ data: { integration_status: string; public_discovery_enabled: boolean } }>().data)
      .toMatchObject({
        integration_status: 'sandbox_handoff_withdrawn',
        public_discovery_enabled: false,
      });
  });

  it('returns a public-safe schema.org JSON-LD preview without enabling publication or payments', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(schemaOrgProductRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/schemaorg-jsonld-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        status: string;
        preview_only: boolean;
        publication_status: string;
        schemaorg_publication_enabled: boolean;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        production_allowlist_written: boolean;
        certification_claims: string[];
        included_types: string[];
        omitted_types: string[];
        jsonld: {
          '@context': string;
          '@graph': Array<{
            '@type': string;
            name: string;
            brand?: { '@type': string; name: string };
            offers?: Array<{
              '@type': string;
              price: string;
              priceCurrency: string;
              availability?: string;
              hasMerchantReturnPolicy?: { '@type': string; description: string; applicableCountry?: string };
            }>;
          }>;
        };
      };
    }>();

    expect(body.data).toMatchObject({
      status: 'preview_only',
      preview_only: true,
      publication_status: 'not_published',
      schemaorg_publication_enabled: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
      certification_claims: [],
    });
    expect(body.data.included_types).toEqual(['Product', 'Offer', 'MerchantReturnPolicy']);
    expect(body.data.omitted_types).toContain('OfferShippingDetails');
    expect(body.data.jsonld['@context']).toBe('https://schema.org');
    expect(body.data.jsonld['@graph']).toHaveLength(1);
    expect(body.data.jsonld['@graph'][0]).toMatchObject({
      '@type': 'Product',
      name: 'Countertop induction cooktop',
      brand: { '@type': 'Brand', name: 'Acme Home' },
    });
    expect(body.data.jsonld['@graph'][0]?.offers?.[0]).toMatchObject({
      '@type': 'Offer',
      price: '1299.00',
      priceCurrency: 'INR',
      availability: 'https://schema.org/InStock',
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        description: 'Returns accepted within seven days.',
        applicableCountry: 'IN',
      },
    });
    const responseJson = JSON.stringify(body.data);
    expect(responseJson).not.toContain('cten_TESTTENANT');
    expect(responseJson).not.toContain('mch_SANDBOX');
    expect(responseJson).not.toContain('cprd_SCHEMA_PRODUCT_1');
    expect(responseJson).not.toContain('cvar_SCHEMA_VARIANT_1');
    expect(responseJson).not.toContain('provider_account_refs');
    expect(responseJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('redacts unsafe schema.org preview fields and records the omission without leaking private values', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(schemaOrgProductRows({
      brand: 'production provider token brand',
      description: 'secret token should not be public',
      image_url: 'https://user:pass@images.example.test/cooktop.jpg',
      return_policy_summary: 'approved live payment return policy',
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/schemaorg-jsonld-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        blockers: string[];
        evidence_summary: { omitted_unsafe_field_count: number; return_policy_count: number };
        jsonld: { '@graph': Array<{ brand?: unknown; description?: string; image?: string; offers?: Array<{ hasMerchantReturnPolicy?: unknown }> }> };
      };
    }>().data;
    expect(data.blockers).toContain('schemaorg_unsafe_fields_omitted');
    expect(data.evidence_summary.omitted_unsafe_field_count).toBeGreaterThanOrEqual(4);
    expect(data.evidence_summary.return_policy_count).toBe(0);
    expect(data.jsonld['@graph'][0]?.brand).toBeUndefined();
    expect(data.jsonld['@graph'][0]?.description).toBeUndefined();
    expect(data.jsonld['@graph'][0]?.image).toBeUndefined();
    expect(data.jsonld['@graph'][0]?.offers?.[0]?.hasMerchantReturnPolicy).toBeUndefined();
    const responseJson = JSON.stringify(data);
    expect(responseJson).not.toContain('secret token');
    expect(responseJson).not.toContain('production provider token');
    expect(responseJson).not.toContain('approved live payment');
    expect(responseJson).not.toContain('user:pass');
  });

  it('returns a blocked schema.org preview when catalog evidence is missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/schemaorg-jsonld-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        status: string;
        blockers: string[];
        jsonld: { '@graph': unknown[] };
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
      };
    }>().data;
    expect(data.status).toBe('blocked');
    expect(data.blockers).toContain('schemaorg_product_evidence_missing');
    expect(data.blockers).toContain('schemaorg_offer_evidence_missing');
    expect(data.jsonld['@graph']).toEqual([]);
    expect(data.public_discovery_enabled).toBe(false);
    expect(data.checkout_payment_enabled).toBe(false);
  });

  it('blocks schema.org JSON-LD preview for live merchants without enabling public discovery', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/schemaorg-jsonld-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          preview_only: boolean;
          schemaorg_publication_enabled: boolean;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          production_allowlist_written: boolean;
          blockers: string[];
        };
      };
    }>().error;
    expect(error).toMatchObject({
      code: 'schemaorg_jsonld_preview_live_merchant_blocked',
      details: {
        preview_only: true,
        schemaorg_publication_enabled: false,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        production_allowlist_written: false,
      },
    });
    expect(error.details.blockers).toContain('merchant_not_sandbox');
  });

  it('denies CommerceAgent callers on schema.org JSON-LD preview', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/schemaorg-jsonld-preview',
      headers: { authorization: 'Bearer grtx_agent_C6JXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('returns a Grantex-owned UCP-style capability profile preview without publishing certified capabilities', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(ucpCapabilityCatalogSummary());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ucp-capability-profile-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        status: string;
        namespace: string;
        profile_style: string;
        preview_only: boolean;
        ucp_publication_enabled: boolean;
        ucp_certification_claim: string;
        certified_ucp_namespace_published: boolean;
        external_ucp_namespace_used: boolean;
        certified_capabilities_published: boolean;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        production_allowlist_written: boolean;
        services: Array<{ id: string; namespace: string; capability_ids: string[] }>;
        capabilities: Array<{ id: string; status: string; category: string; maps_to_grantex_tool: string | null; blockers: string[] }>;
        transports: Array<{ id: string; endpoint_template: string; public_route_enabled: boolean; runtime_enabled_by_preview: boolean }>;
        controls: { public_discovery_route_enabled: boolean; commerce_v1_runtime_enabled_by_preview: boolean; ucp_certification_claim: string };
        evidence_summary: { product_count: number; variant_count: number; read_only_capability_count: number; blocked_capability_count: number };
        certification_claims: string[];
      };
    }>();

    expect(body.data).toMatchObject({
      status: 'preview_only',
      namespace: 'dev.grantex.commerce.discovery.preview',
      profile_style: 'ucp_style_preview',
      preview_only: true,
      ucp_publication_enabled: false,
      ucp_certification_claim: 'none',
      certified_ucp_namespace_published: false,
      external_ucp_namespace_used: false,
      certified_capabilities_published: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
      certification_claims: [],
    });
    expect(body.data.services).toHaveLength(1);
    expect(body.data.services[0]?.namespace).toBe('dev.grantex.commerce.discovery.preview');
    expect(body.data.capabilities.some((capability) => capability.id.endsWith('.merchant_profile.read'))).toBe(true);
    expect(body.data.capabilities.some((capability) => capability.id.endsWith('.catalog.search'))).toBe(true);
    expect(body.data.capabilities.some((capability) => capability.id.endsWith('.inventory.availability.read'))).toBe(true);
    expect(body.data.capabilities.find((capability) => capability.maps_to_grantex_tool === 'checkout.create')?.status)
      .toBe('blocked');
    expect(body.data.capabilities.find((capability) => capability.maps_to_grantex_tool === 'payment.create_intent')?.blockers)
      .toContain('runtime_execution_not_enabled_by_preview');
    expect(body.data.transports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint_template: '/v1/commerce',
        public_route_enabled: false,
        runtime_enabled_by_preview: false,
      }),
      expect.objectContaining({
        endpoint_template: '/mcp',
        public_route_enabled: false,
        runtime_enabled_by_preview: false,
      }),
    ]));
    expect(body.data.controls).toMatchObject({
      public_discovery_route_enabled: false,
      commerce_v1_runtime_enabled_by_preview: false,
      ucp_certification_claim: 'none',
    });
    expect(body.data.evidence_summary).toMatchObject({
      product_count: 1,
      variant_count: 2,
      read_only_capability_count: 4,
    });
    expect(body.data.evidence_summary.blocked_capability_count).toBeGreaterThan(0);
    const responseJson = JSON.stringify(body.data);
    expect(responseJson).not.toContain('dev.ucp');
    expect(responseJson).not.toContain('cten_TESTTENANT');
    expect(responseJson).not.toContain('mch_SANDBOX');
    expect(responseJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('returns blocked UCP-style capability preview when catalog evidence is missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(ucpCapabilityCatalogSummary({
      product_count: 0,
      variant_count: 0,
      variants_with_price_currency: 0,
      variants_with_known_availability: 0,
      products_with_public_safe_title: 0,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ucp-capability-profile-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        status: string;
        blockers: string[];
        capabilities: Array<{ id: string; status: string; blockers: string[] }>;
        public_discovery_enabled: boolean;
        checkout_payment_enabled: boolean;
      };
    }>().data;
    expect(data.status).toBe('blocked');
    expect(data.blockers).toContain('catalog_capability_evidence_missing');
    expect(data.blockers).toContain('price_or_availability_evidence_missing');
    expect(data.capabilities.find((capability) => capability.id.endsWith('.catalog.search'))?.status).toBe('blocked');
    expect(data.capabilities.find((capability) => capability.id.endsWith('.catalog.search'))?.blockers)
      .toContain('catalog_capability_evidence_missing');
    expect(data.public_discovery_enabled).toBe(false);
    expect(data.checkout_payment_enabled).toBe(false);
  });

  it('blocks UCP-style catalog capabilities when any active product lacks public-safe evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(ucpCapabilityCatalogSummary({
      product_count: 2,
      variant_count: 2,
      variants_with_price_currency: 2,
      variants_with_known_availability: 2,
      products_with_public_safe_title: 1,
      products_with_public_safe_description: 2,
      products_with_unsafe_text: 1,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ucp-capability-profile-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        status: string;
        blockers: string[];
        capabilities: Array<{ id: string; status: string; blockers: string[] }>;
        evidence_summary: { product_count: number; products_with_public_safe_title: number };
      };
    }>().data;
    expect(data.status).toBe('blocked');
    expect(data.blockers).toContain('catalog_capability_evidence_missing');
    expect(data.capabilities.find((capability) => capability.id.endsWith('.catalog.search'))).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining(['catalog_capability_evidence_missing']),
    });
    expect(data.evidence_summary).toMatchObject({
      product_count: 2,
      products_with_public_safe_title: 1,
    });
  });

  it('blocks UCP-style inventory capability when availability evidence is unknown', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(ucpCapabilityCatalogSummary({
      variants_with_known_availability: 0,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ucp-capability-profile-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        blockers: string[];
        capabilities: Array<{ id: string; status: string; blockers: string[] }>;
        evidence_summary: { variants_with_known_availability: number };
      };
    }>().data;
    expect(data.blockers).toContain('price_or_availability_evidence_missing');
    expect(data.capabilities.find((capability) => capability.id.endsWith('.catalog.search'))?.status)
      .toBe('preview_available');
    expect(data.capabilities.find((capability) => capability.id.endsWith('.inventory.availability.read')))
      .toMatchObject({
        status: 'blocked',
        blockers: expect.arrayContaining(['price_or_availability_evidence_missing']),
      });
    expect(data.evidence_summary.variants_with_known_availability).toBe(0);
  });

  it('blocks UCP-style capability preview for live merchants without enabling public discovery', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/ucp-capability-profile-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          preview_only: boolean;
          ucp_publication_enabled: boolean;
          ucp_certification_claim: string;
          certified_ucp_namespace_published: boolean;
          external_ucp_namespace_used: boolean;
          public_discovery_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          production_allowlist_written: boolean;
          blockers: string[];
        };
      };
    }>().error;
    expect(error).toMatchObject({
      code: 'ucp_capability_profile_preview_live_merchant_blocked',
      details: {
        preview_only: true,
        ucp_publication_enabled: false,
        ucp_certification_claim: 'none',
        certified_ucp_namespace_published: false,
        external_ucp_namespace_used: false,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        production_allowlist_written: false,
      },
    });
    expect(error.details.blockers).toContain('merchant_not_sandbox');
  });

  it('denies CommerceAgent callers on UCP-style capability profile preview', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ucp-capability-profile-preview',
      headers: { authorization: 'Bearer grtx_agent_C6KXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('returns ACP-style cart and checkout shape preview without enabling payment creation', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(acpCheckoutEvidenceSummary());
    sqlMock.mockResolvedValueOnce(acpCartPreviewRow());
    sqlMock.mockResolvedValueOnce(acpPaymentIntentPreviewRow());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/acp-checkout-shape-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        status: string;
        profile_style: string;
        preview_only: boolean;
        acp_publication_enabled: boolean;
        acp_certification_claim: string;
        acp_certified_capabilities_published: boolean;
        public_checkout_enabled: boolean;
        checkout_payment_enabled: boolean;
        payment_intent_creation_enabled: boolean;
        checkout_link_creation_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        provider_credentials_exposed: boolean;
        production_allowlist_written: boolean;
        certification_claims: string[];
        cart_shape: {
          status: string;
          operations: { create_cart: { enabled_by_preview: boolean; requires_checkout_passport: boolean } };
          field_mappings: Array<{ acp_field: string; status: string; blockers: string[] }>;
          latest_cart_summary: { present: boolean; line_item_count: number; total_amount_minor_units: number; snapshot_hash_present: boolean; passport_bound: boolean };
        };
        checkout_shape: {
          status: string;
          operations: {
            create_payment_intent: { enabled_by_preview: boolean; provider_call_enabled: boolean; requires_checkout_passport: boolean; requires_granted_consent: boolean; requires_active_policy: boolean };
            create_checkout_link: { enabled_by_preview: boolean; provider_call_enabled: boolean };
          };
          field_mappings: Array<{ acp_field: string; status: string; blockers: string[] }>;
          latest_payment_intent_summary: {
            present: boolean;
            amount_minor_units: number;
            provider_environment: string;
            checkout_url_exposed: boolean;
            provider_payment_reference_exposed: boolean;
            provider_metadata_exposed: boolean;
            provider_raw_status_exposed: boolean;
            passport_reference_exposed: boolean;
          };
        };
        unsupported_fields: Array<{ acp_field: string; blocker: string }>;
        controls: {
          public_checkout_enabled: boolean;
          payment_intent_creation_enabled_by_preview: boolean;
          checkout_link_creation_enabled_by_preview: boolean;
          provider_call_enabled_by_preview: boolean;
          live_payment_enabled_by_preview: boolean;
          live_plural_enabled_by_preview: boolean;
          acp_certification_claim: string;
        };
        evidence_summary: { active_policy_count: number; granted_checkout_consent_count: number; active_checkout_passport_count: number; sandbox_cart_count: number; sandbox_payment_intent_count: number; payment_enabled: boolean; provider_called: boolean };
        blocked_capabilities: string[];
      };
    }>();

    expect(body.data).toMatchObject({
      status: 'preview_only',
      profile_style: 'acp_style_checkout_shape_preview',
      preview_only: true,
      acp_publication_enabled: false,
      acp_certification_claim: 'none',
      acp_certified_capabilities_published: false,
      public_checkout_enabled: false,
      checkout_payment_enabled: false,
      payment_intent_creation_enabled: false,
      checkout_link_creation_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      provider_credentials_exposed: false,
      production_allowlist_written: false,
      certification_claims: [],
    });
    expect(body.data.cart_shape).toMatchObject({
      status: 'preview_available',
      latest_cart_summary: {
        present: true,
        line_item_count: 1,
        total_amount_minor_units: 129900,
        snapshot_hash_present: true,
        passport_bound: false,
      },
    });
    expect(body.data.cart_shape.operations.create_cart).toMatchObject({
      enabled_by_preview: false,
      requires_checkout_passport: false,
    });
    expect(body.data.checkout_shape.status).toBe('preview_available');
    expect(body.data.checkout_shape.operations.create_payment_intent).toMatchObject({
      enabled_by_preview: false,
      provider_call_enabled: false,
      requires_checkout_passport: true,
      requires_granted_consent: true,
      requires_active_policy: true,
    });
    expect(body.data.checkout_shape.operations.create_checkout_link).toMatchObject({
      enabled_by_preview: false,
      provider_call_enabled: false,
    });
    expect(body.data.checkout_shape.latest_payment_intent_summary).toMatchObject({
      present: true,
      amount_minor_units: 129900,
      provider_environment: 'sandbox',
      checkout_url_exposed: false,
      provider_payment_reference_exposed: false,
      provider_metadata_exposed: false,
      provider_raw_status_exposed: false,
      passport_reference_exposed: false,
    });
    expect(body.data.checkout_shape.field_mappings.find((mapping) => mapping.acp_field === 'acp.checkout.provider_checkout_url'))
      .toMatchObject({ status: 'unsupported', blockers: ['public_checkout_not_enabled_by_preview'] });
    expect(body.data.unsupported_fields.map((field) => field.blocker)).toEqual(expect.arrayContaining([
      'public_checkout_not_enabled_by_preview',
      'provider_references_not_exposed',
      'live_provider_not_enabled_by_preview',
      'live_plural_not_enabled_by_preview',
    ]));
    expect(body.data.controls).toMatchObject({
      public_checkout_enabled: false,
      payment_intent_creation_enabled_by_preview: false,
      checkout_link_creation_enabled_by_preview: false,
      provider_call_enabled_by_preview: false,
      live_payment_enabled_by_preview: false,
      live_plural_enabled_by_preview: false,
      acp_certification_claim: 'none',
    });
    expect(body.data.evidence_summary).toMatchObject({
      active_policy_count: 1,
      granted_checkout_consent_count: 1,
      active_checkout_passport_count: 1,
      sandbox_cart_count: 1,
      sandbox_payment_intent_count: 1,
      payment_enabled: false,
      provider_called: false,
    });
    expect(body.data.blocked_capabilities).toContain('checkout_payment_creation');
    expect(body.data.blocked_capabilities).toContain('provider_runtime_call');
    const responseJson = JSON.stringify(body.data);
    expect(responseJson).not.toContain('mch_SANDBOX');
    expect(responseJson).not.toContain('cten_TESTTENANT');
    expect(responseJson).not.toContain('ccart_');
    expect(responseJson).not.toContain('cpi_');
    expect(responseJson).not.toContain('cpsp_PRIVATE');
    expect(responseJson).not.toContain('mock_pay_PRIVATE');
    expect(responseJson).not.toContain('mock_order_PRIVATE');
    expect(responseJson).not.toContain('https://mock-payments');
    expect(responseJson).not.toContain('provider_private');
    expect(responseJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('blocks ACP-style checkout shape preview when consent, passport, or policy evidence is missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce(acpCheckoutEvidenceSummary({
      active_policy_count: 0,
      granted_checkout_consent_count: 0,
      active_checkout_passport_count: 0,
      unrevoked_checkout_passport_count: 0,
    }));
    sqlMock.mockResolvedValueOnce(acpCartPreviewRow());
    sqlMock.mockResolvedValueOnce(acpPaymentIntentPreviewRow({ policy_version: null, decision_id: null }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/acp-checkout-shape-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        status: string;
        blockers: string[];
        checkout_shape: { status: string; field_mappings: Array<{ acp_field: string; status: string; blockers: string[] }> };
        checkout_payment_enabled: boolean;
        payment_intent_creation_enabled: boolean;
        checkout_link_creation_enabled: boolean;
        evidence_summary: { active_policy_count: number; granted_checkout_consent_count: number; active_checkout_passport_count: number; payment_enabled: boolean };
      };
    }>().data;
    expect(data.status).toBe('blocked');
    expect(data.blockers).toContain('active_policy_evidence_missing');
    expect(data.blockers).toContain('granted_checkout_consent_evidence_missing');
    expect(data.blockers).toContain('checkout_passport_evidence_missing');
    expect(data.checkout_shape.status).toBe('blocked');
    expect(data.checkout_shape.field_mappings.find((mapping) => mapping.acp_field === 'acp.checkout.consent')?.blockers)
      .toContain('granted_checkout_consent_evidence_missing');
    expect(data.checkout_shape.field_mappings.find((mapping) => mapping.acp_field === 'acp.checkout.passport')?.blockers)
      .toContain('checkout_passport_evidence_missing');
    expect(data.checkout_shape.field_mappings.find((mapping) => mapping.acp_field === 'acp.checkout.policy_decision')?.blockers)
      .toContain('active_policy_evidence_missing');
    expect(data.checkout_payment_enabled).toBe(false);
    expect(data.payment_intent_creation_enabled).toBe(false);
    expect(data.checkout_link_creation_enabled).toBe(false);
    expect(data.evidence_summary).toMatchObject({
      active_policy_count: 0,
      granted_checkout_consent_count: 0,
      active_checkout_passport_count: 0,
      payment_enabled: false,
    });
  });

  it('blocks ACP-style checkout shape preview for live merchants without enabling checkout or payments', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/acp-checkout-shape-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          preview_only: boolean;
          acp_publication_enabled: boolean;
          acp_certification_claim: string;
          acp_certified_capabilities_published: boolean;
          public_checkout_enabled: boolean;
          checkout_payment_enabled: boolean;
          payment_intent_creation_enabled: boolean;
          checkout_link_creation_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          provider_credentials_exposed: boolean;
          production_allowlist_written: boolean;
          blockers: string[];
        };
      };
    }>().error;
    expect(error).toMatchObject({
      code: 'acp_checkout_shape_preview_live_merchant_blocked',
      details: {
        preview_only: true,
        acp_publication_enabled: false,
        acp_certification_claim: 'none',
        acp_certified_capabilities_published: false,
        public_checkout_enabled: false,
        checkout_payment_enabled: false,
        payment_intent_creation_enabled: false,
        checkout_link_creation_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        provider_credentials_exposed: false,
        production_allowlist_written: false,
      },
    });
    expect(error.details.blockers).toContain('merchant_not_sandbox');
  });

  it('denies CommerceAgent callers on ACP-style checkout shape preview', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/acp-checkout-shape-preview',
      headers: { authorization: 'Bearer grtx_agent_C6LXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('returns unsigned AP2-style evidence preview without creating a signed mandate', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      sandbox_onboarding_state: 'submitted_for_review',
      agentic_commerce_enabled: true,
    })]);
    sqlMock.mockResolvedValueOnce(ap2EvidencePreviewRow());
    sqlMock.mockResolvedValueOnce(ap2AuditReferenceRows());

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ap2-evidence-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        status: string;
        profile_style: string;
        preview_only: boolean;
        ap2_certification_claim: string;
        ap2_publication_enabled: boolean;
        ap2_signed_mandate_created: boolean;
        signed_production_mandate_created: boolean;
        signature_status: string;
        signing_key_used: boolean;
        payment_network_submission_enabled: boolean;
        checkout_payment_enabled: boolean;
        live_provider_enabled: boolean;
        live_plural_enabled: boolean;
        provider_credentials_exposed: boolean;
        production_allowlist_written: boolean;
        certification_claims: string[];
        evidence_package: { signed: boolean; evidence_hash: string; signing_key_reference: null; production_mandate_reference: null; includes: string[] };
        commerce_passport_evidence: {
          present: boolean;
          passport_type: string;
          environment: string;
          scope_count: number;
          required_checkout_scopes_present: boolean;
          max_amount_minor_units: number;
          currency: string;
          not_expired: boolean;
          revoked: boolean;
          passport_jti_exposed: boolean;
          raw_passport_jwt_exposed: boolean;
        };
        consent_evidence: {
          present: boolean;
          status: string;
          approved_required_checkout_scopes_present: boolean;
          max_amount_minor_units: number;
          currency: string;
          consent_text_version: string;
          presented_payload_hash_present: boolean;
          consent_record_id_exposed: boolean;
          user_principal_exposed: boolean;
        };
        policy_evidence: {
          present: boolean;
          active_policy_present: boolean;
          decision_reference_present: boolean;
          decision_reference_hash: string;
          amount_cap_minor_units: number;
          amount_cap_currency: string;
          raw_policy_rules_exposed: boolean;
        };
        cart_evidence: {
          present: boolean;
          snapshot_hash: string;
          total_amount_minor_units: number;
          idempotency_key_hash_present: boolean;
          raw_line_items_exposed: boolean;
          cart_id_exposed: boolean;
        };
        amount_evidence: {
          payment_amount_minor_units: number;
          payment_currency: string;
          amount_cap_minor_units: number;
          amount_cap_currency: string;
          amount_cap_source: string;
          within_amount_cap: boolean;
        };
        agent_identity_evidence: {
          present: boolean;
          agent_reference_hash: string;
          trust_status: string;
          disabled: boolean;
          auth_method: string;
          agent_id_exposed: boolean;
          agent_api_key_exposed: boolean;
        };
        audit_evidence: {
          present: boolean;
          audit_reference_hash: string;
          event_type: string;
          policy_version_present: boolean;
          decision_reference_present: boolean;
          idempotency_key_hash_present: boolean;
          audit_event_id_exposed: boolean;
        };
        replay_idempotency_evidence: {
          idempotency_supported: boolean;
          cart_idempotency_key_hash_present: boolean;
          payment_intent_idempotency_key_hash_present: boolean;
          audit_idempotency_key_hash_present: boolean;
          raw_idempotency_key_exposed: boolean;
        };
        payment_intent_evidence: {
          present: boolean;
          status: string;
          provider_environment: string;
          provider_reference_exposed: boolean;
          checkout_url_exposed: boolean;
          provider_metadata_exposed: boolean;
          provider_raw_status_exposed: boolean;
        };
        controls: {
          deterministic_unsigned_preview: boolean;
          signing_enabled_by_preview: boolean;
          ap2_certification_claim: string;
          payment_network_submission_enabled: boolean;
          checkout_payment_creation_enabled_by_preview: boolean;
          provider_call_enabled_by_preview: boolean;
          live_payment_enabled_by_preview: boolean;
          live_plural_enabled_by_preview: boolean;
        };
        evidence_summary: {
          complete_required_evidence: boolean;
          passport_present: boolean;
          consent_granted: boolean;
          active_policy_present: boolean;
          policy_decision_present: boolean;
          cart_hash_present: boolean;
          amount_cap_present: boolean;
          agent_identity_present: boolean;
          audit_reference_present: boolean;
          idempotency_evidence_present: boolean;
          unsigned_preview: boolean;
          payment_enabled: boolean;
          provider_called: boolean;
        };
        blockers: string[];
      };
    }>();

    expect(body.data).toMatchObject({
      status: 'preview_only',
      profile_style: 'ap2_style_evidence_preview',
      preview_only: true,
      ap2_certification_claim: 'none',
      ap2_publication_enabled: false,
      ap2_signed_mandate_created: false,
      signed_production_mandate_created: false,
      signature_status: 'unsigned_preview',
      signing_key_used: false,
      payment_network_submission_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      provider_credentials_exposed: false,
      production_allowlist_written: false,
      certification_claims: [],
    });
    expect(body.data.evidence_package).toMatchObject({
      signed: false,
      signing_key_reference: null,
      production_mandate_reference: null,
    });
    expect(body.data.evidence_package.evidence_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.evidence_package.includes).toEqual(expect.arrayContaining([
      'commerce_passport',
      'consent_record',
      'policy_decision',
      'cart_hash',
      'amount_cap',
      'merchant_state',
      'agent_identity',
      'audit_reference',
      'idempotency_replay',
    ]));
    expect(body.data.commerce_passport_evidence).toMatchObject({
      present: true,
      passport_type: 'checkout',
      environment: 'sandbox',
      scope_count: 5,
      required_checkout_scopes_present: true,
      max_amount_minor_units: 150000,
      currency: 'INR',
      not_expired: true,
      revoked: false,
      passport_jti_exposed: false,
      raw_passport_jwt_exposed: false,
    });
    expect(body.data.consent_evidence).toMatchObject({
      present: true,
      status: 'granted',
      approved_required_checkout_scopes_present: true,
      max_amount_minor_units: 150000,
      currency: 'INR',
      consent_text_version: 'checkout_v1',
      presented_payload_hash_present: true,
      consent_record_id_exposed: false,
      user_principal_exposed: false,
    });
    expect(body.data.policy_evidence).toMatchObject({
      present: true,
      active_policy_present: true,
      decision_reference_present: true,
      amount_cap_minor_units: 150000,
      amount_cap_currency: 'INR',
      raw_policy_rules_exposed: false,
    });
    expect(body.data.policy_evidence.decision_reference_hash).toMatch(/^decision_[a-f0-9]{24}$/);
    expect(body.data.cart_evidence).toMatchObject({
      present: true,
      snapshot_hash: 'hash_cart_snapshot_ap2',
      total_amount_minor_units: 129900,
      idempotency_key_hash_present: true,
      raw_line_items_exposed: false,
      cart_id_exposed: false,
    });
    expect(body.data.amount_evidence).toMatchObject({
      payment_amount_minor_units: 129900,
      payment_currency: 'INR',
      amount_cap_minor_units: 150000,
      amount_cap_currency: 'INR',
      amount_cap_source: 'passport',
      within_amount_cap: true,
    });
    expect(body.data.agent_identity_evidence).toMatchObject({
      present: true,
      trust_status: 'trusted',
      disabled: false,
      auth_method: 'api_key',
      agent_id_exposed: false,
      agent_api_key_exposed: false,
    });
    expect(body.data.agent_identity_evidence.agent_reference_hash).toMatch(/^agent_[a-f0-9]{24}$/);
    expect(body.data.audit_evidence).toMatchObject({
      present: true,
      event_type: 'payment_intent.created',
      policy_version_present: true,
      decision_reference_present: true,
      idempotency_key_hash_present: true,
      audit_event_id_exposed: false,
    });
    expect(body.data.audit_evidence.audit_reference_hash).toMatch(/^audit_[a-f0-9]{24}$/);
    expect(body.data.replay_idempotency_evidence).toMatchObject({
      idempotency_supported: true,
      cart_idempotency_key_hash_present: true,
      payment_intent_idempotency_key_hash_present: true,
      audit_idempotency_key_hash_present: true,
      raw_idempotency_key_exposed: false,
    });
    expect(body.data.payment_intent_evidence).toMatchObject({
      present: true,
      status: 'authorized',
      provider_environment: 'sandbox',
      provider_reference_exposed: false,
      checkout_url_exposed: false,
      provider_metadata_exposed: false,
      provider_raw_status_exposed: false,
    });
    expect(body.data.controls).toMatchObject({
      deterministic_unsigned_preview: true,
      signing_enabled_by_preview: false,
      ap2_certification_claim: 'none',
      payment_network_submission_enabled: false,
      checkout_payment_creation_enabled_by_preview: false,
      provider_call_enabled_by_preview: false,
      live_payment_enabled_by_preview: false,
      live_plural_enabled_by_preview: false,
    });
    expect(body.data.evidence_summary).toMatchObject({
      complete_required_evidence: true,
      passport_present: true,
      consent_granted: true,
      active_policy_present: true,
      policy_decision_present: true,
      cart_hash_present: true,
      amount_cap_present: true,
      agent_identity_present: true,
      audit_reference_present: true,
      idempotency_evidence_present: true,
      unsigned_preview: true,
      payment_enabled: false,
      provider_called: false,
    });
    expect(body.data.blockers).toContain('unsigned_preview_only');
    expect(body.data.blockers).toContain('ap2_certification_not_claimed');
    const responseJson = JSON.stringify(body.data);
    expect(responseJson).not.toContain('mch_SANDBOX');
    expect(responseJson).not.toContain('cten_TESTTENANT');
    expect(responseJson).not.toContain('cag_AP2_PRIVATE');
    expect(responseJson).not.toContain('cpsp_AP2_PRIVATE');
    expect(responseJson).not.toContain('crec_');
    expect(responseJson).not.toContain('caud_AP2_PRIVATE');
    expect(responseJson).not.toContain('cpdec_AP2_PRIVATE');
    expect(responseJson).not.toContain('cvar_AP2_PRIVATE');
    expect(responseJson).not.toContain('SKU-AP2-PRIVATE');
    expect(responseJson).not.toContain('mock_pay');
    expect(responseJson).not.toContain('mock_order');
    expect(responseJson).not.toContain('checkout/private');
    expect(responseJson).not.toContain('provider_private');
    expect(responseJson).not.toContain('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST');
  });

  it('blocks AP2-style evidence preview when required evidence is missing', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ap2-evidence-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        status: string;
        blockers: string[];
        evidence_summary: {
          complete_required_evidence: boolean;
          passport_present: boolean;
          consent_granted: boolean;
          active_policy_present: boolean;
          audit_reference_present: boolean;
          idempotency_evidence_present: boolean;
          payment_enabled: boolean;
        };
        commerce_passport_evidence: { present: boolean };
        consent_evidence: { present: boolean };
        controls: { signing_enabled_by_preview: boolean; payment_network_submission_enabled: boolean };
      };
    }>().data;

    expect(data.status).toBe('blocked');
    expect(data.blockers).toContain('commerce_passport_evidence_missing');
    expect(data.blockers).toContain('consent_evidence_missing');
    expect(data.blockers).toContain('policy_decision_evidence_missing');
    expect(data.blockers).toContain('cart_hash_evidence_missing');
    expect(data.blockers).toContain('amount_cap_evidence_missing');
    expect(data.blockers).toContain('agent_identity_evidence_missing');
    expect(data.blockers).toContain('audit_reference_evidence_missing');
    expect(data.blockers).toContain('idempotency_evidence_missing');
    expect(data.evidence_summary).toMatchObject({
      complete_required_evidence: false,
      passport_present: false,
      consent_granted: false,
      active_policy_present: false,
      audit_reference_present: false,
      idempotency_evidence_present: false,
      payment_enabled: false,
    });
    expect(data.commerce_passport_evidence.present).toBe(false);
    expect(data.consent_evidence.present).toBe(false);
    expect(data.controls).toMatchObject({
      signing_enabled_by_preview: false,
      payment_network_submission_enabled: false,
    });
  });

  it('blocks AP2-style evidence preview for live merchants without creating mandates', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/ap2-evidence-preview',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{
      error: {
        code: string;
        details: {
          preview_only: boolean;
          ap2_certification_claim: string;
          ap2_publication_enabled: boolean;
          ap2_signed_mandate_created: boolean;
          signed_production_mandate_created: boolean;
          signature_status: string;
          signing_key_used: boolean;
          payment_network_submission_enabled: boolean;
          checkout_payment_enabled: boolean;
          live_provider_enabled: boolean;
          live_plural_enabled: boolean;
          provider_credentials_exposed: boolean;
          production_allowlist_written: boolean;
          blockers: string[];
        };
      };
    }>().error;
    expect(error).toMatchObject({
      code: 'ap2_evidence_preview_live_merchant_blocked',
      details: {
        preview_only: true,
        ap2_certification_claim: 'none',
        ap2_publication_enabled: false,
        ap2_signed_mandate_created: false,
        signed_production_mandate_created: false,
        signature_status: 'unsigned_preview',
        signing_key_used: false,
        payment_network_submission_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        provider_credentials_exposed: false,
        production_allowlist_written: false,
      },
    });
    expect(error.details.blockers).toContain('merchant_not_sandbox');
  });

  it('denies CommerceAgent callers on AP2-style evidence preview', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cag_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      trust_status: 'trusted',
      public_key_jwk: null,
      api_key_hash: 'hash',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_SANDBOX/ap2-evidence-preview',
      headers: { authorization: 'Bearer grtx_agent_C6MXXXXXXXXXXXXXXXXXXXXXXX' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('blocks submit transition when readiness checks fail', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      public_discovery_description_draft: null,
      sandbox_onboarding_state: 'sandbox_ready',
    })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/transition',
      headers: authHeader(),
      payload: { target_state: 'submitted_for_review' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_sandbox_onboarding_transition');
  });

  it('blocks submit transition when required category readiness fails', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({
      support_email: null,
      support_url: null,
      sandbox_onboarding_state: 'sandbox_ready',
    })]);
    sqlMock.mockResolvedValueOnce([catalogReadySummary()]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/transition',
      headers: authHeader(),
      payload: { target_state: 'submitted_for_review' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; message: string } }>().error.code)
      .toBe('invalid_sandbox_onboarding_transition');
  });

  it('blocks submit transition when required catalog readiness fails', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    sqlMock.mockResolvedValueOnce([catalogEmptySummary()]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/transition',
      headers: authHeader(),
      payload: { target_state: 'submitted_for_review' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; message: string } }>().error.code)
      .toBe('invalid_sandbox_onboarding_transition');
  });

  it('blocks sandbox onboarding for live merchants', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([onboardingRow({ environment: 'live' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_LIVE/sandbox-onboarding',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('sandbox_onboarding_live_merchant_blocked');
  });
});
