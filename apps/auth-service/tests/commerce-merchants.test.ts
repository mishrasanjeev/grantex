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
        readiness: { ready: boolean; production_approval_status: string; rollout_status: string };
      };
    }>();
    expect(body.data.sandbox_onboarding_state).toBe('sandbox_ready');
    expect(body.data.readiness.ready).toBe(true);
    expect(body.data.readiness.production_approval_status).toBe('not_approved');
    expect(body.data.readiness.rollout_status).toBe('rollout_not_requested');
    expect(body.data.provider_account_refs).toBeUndefined();
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
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'sandbox_ready' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_ONBOARDING', occurred_at: new Date().toISOString() }]);

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
    const body = res.json<{ data: { sandbox_onboarding_state: string; readiness: { ready: boolean } }; audit_event_id: string }>();
    expect(body.data.sandbox_onboarding_state).toBe('sandbox_ready');
    expect(body.data.readiness.ready).toBe(true);
    expect(body.audit_event_id).toBe('caud_ONBOARDING');
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
    sqlMock.mockResolvedValueOnce([onboardingRow({ sandbox_onboarding_state: 'submitted_for_review' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_TRANSITION', occurred_at: new Date().toISOString() }]);

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

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants/mch_SANDBOX/sandbox-onboarding/transition',
      headers: authHeader(),
      payload: { target_state: 'submitted_for_review' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_sandbox_onboarding_transition');
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
