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
