import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, mockRedis, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import {
  evaluateCommercePolicyRules,
  validateCommercePolicyRules,
  type CommercePolicyRules,
} from '../src/lib/commerce/policy.js';

let app: FastifyInstance;
let privateKey: KeyLike;
let publicJwk: JWK;

const MERCHANT = 'mch_POLICY';
const AGENT = 'cag_POLICY';
const KID = 'commerce-passport-20260512-aabbccdd';
const SUBJECT = 'user_POLICY';
const CONSENT = 'crec_POLICY';
const POLICY_ID = 'cpol_POLICY';

beforeAll(async () => {
  app = await buildTestApp();
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };
});

function rules(overrides: Partial<CommercePolicyRules> = {}): CommercePolicyRules {
  return {
    amount_cap: { max_amount_minor_units: 5000, currency: 'INR' },
    scope_allowlist: [
      'commerce:catalog.read',
      'commerce:inventory.read',
      'commerce:checkout.create',
      'commerce:payment.initiate',
      'commerce:payment.status.read',
    ],
    emergency_disable: false,
    checkout_passport_max_ttl_seconds: 600,
    browse_passport_max_ttl_seconds: 3600,
    stale_price_max_age_seconds: 86400,
    allow_unknown_inventory_checkout: false,
    ...overrides,
  };
}

function merchant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MERCHANT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    environment: 'sandbox',
    default_currency: 'INR',
    agentic_commerce_enabled: true,
    disabled_at: null,
    tenant_status: 'active',
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    disabled_at: null,
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POLICY_ID,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    version: 'v1',
    rules: rules(),
    status: 'active',
    created_by: 'dev_TEST',
    activated_by: 'dev_TEST',
    activated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function passport(overrides: {
  passportType?: 'browse' | 'checkout';
  tenantId?: string;
  merchantId?: string;
  agentId?: string;
  scopes?: string[];
  maxAmount?: number | null;
  currency?: string | null;
  environment?: 'sandbox' | 'live';
  iat?: number;
  exp?: number;
  jti?: string;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = overrides.iat ?? now;
  const exp = overrides.exp ?? now + 300;
  const payload: Record<string, unknown> = {
    passport_type: overrides.passportType ?? 'checkout',
    tenant_id: overrides.tenantId ?? TEST_COMMERCE_TENANT_ID,
    merchant_id: overrides.merchantId ?? MERCHANT,
    agent_id: overrides.agentId ?? AGENT,
    consent_record_id: CONSENT,
    scopes: overrides.scopes ?? [
      'commerce:catalog.read',
      'commerce:inventory.read',
      'commerce:checkout.create',
      'commerce:payment.initiate',
      'commerce:payment.status.read',
    ],
    env: overrides.environment ?? 'sandbox',
    ver: '1',
  };
  if (overrides.maxAmount !== null) payload['max_amount'] = overrides.maxAmount ?? 5000;
  if (overrides.currency !== null) payload['currency'] = overrides.currency ?? 'INR';
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
    .setAudience('grantex-commerce')
    .setSubject(SUBJECT)
    .setJti(overrides.jti ?? 'cpsp_POLICY')
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

function primeEvaluateBase(opts: {
  merchantRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown> | null;
  policyRow?: Record<string, unknown>;
  revocationRows?: Record<string, unknown>[] | null;
  auditId?: string;
} = {}): void {
  seedCommerceContext();
  sqlMock.mockResolvedValueOnce([opts.merchantRow ?? merchant()]);
  sqlMock.mockResolvedValueOnce(opts.agentRow === null ? [] : [opts.agentRow ?? agent()]);
  sqlMock.mockResolvedValueOnce([opts.policyRow ?? policy()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  if (opts.revocationRows !== null) {
    sqlMock.mockResolvedValueOnce(opts.revocationRows ?? []);
  }
  if (opts.auditId) {
    sqlMock.mockResolvedValueOnce([{ id: opts.auditId, occurred_at: new Date().toISOString() }]);
  }
}

function primeEvaluatePrePassportDeny(opts: {
  merchantRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown> | null;
  policyRow?: Record<string, unknown>;
  auditId: string;
}): void {
  seedCommerceContext();
  sqlMock.mockResolvedValueOnce([opts.merchantRow ?? merchant()]);
  sqlMock.mockResolvedValueOnce(opts.agentRow === null ? [] : [opts.agentRow ?? agent()]);
  sqlMock.mockResolvedValueOnce([opts.policyRow ?? policy()]);
  sqlMock.mockResolvedValueOnce([{ id: opts.auditId, occurred_at: new Date().toISOString() }]);
}

async function evaluate(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/commerce/policies/evaluate',
    headers: authHeader(),
    payload: {
      merchant_id: MERCHANT,
      agent_id: AGENT,
      passport_jwt: await passport(),
      action_scope: 'commerce:payment.initiate',
      amount_minor_units: 1000,
      currency: 'INR',
      ...payload,
    },
  });
}

describe('CommercePolicy rules validation', () => {
  it('rejects invalid schema values with field-level details', () => {
    const result = validateCommercePolicyRules({
      amount_cap: { max_amount_minor_units: -1, currency: 'inr' },
      scope_allowlist: [],
      emergency_disable: 'no',
      checkout_passport_max_ttl_seconds: 601,
      browse_passport_max_ttl_seconds: 0,
      stale_price_max_age_seconds: -1,
      allow_unknown_inventory_checkout: 'false',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors).toHaveProperty('rules.amount_cap.max_amount_minor_units');
      expect(result.fieldErrors).toHaveProperty('rules.amount_cap.currency');
      expect(result.fieldErrors).toHaveProperty('rules.scope_allowlist');
      expect(result.fieldErrors).toHaveProperty('rules.emergency_disable');
    }
  });

  it('rejects unknown top-level and nested rule keys', () => {
    const result = validateCommercePolicyRules({
      ...rules(),
      category_allowlist: ['electronics'],
      amount_cap: { ...rules().amount_cap, daily_cap: 1000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors['rules.category_allowlist']).toMatch(/unknown/);
      expect(result.fieldErrors['rules.amount_cap.daily_cap']).toMatch(/unknown/);
    }
  });
});

describe('CommercePolicy create/list/read/activation APIs', () => {
  it('creates a draft policy and emits policy.created', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([policy({ status: 'draft', activated_by: null, activated_at: null })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_POLICY_CREATED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/policies',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, rules: rules() },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { status: string }; audit_event_id: string }>().data.status).toBe('draft');
    expect(sqlMock.mock.calls.flat()).toContain('policy.created');
  });

  it('lists and reads policy records', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([policy()]);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/commerce/policies?merchant_id=${MERCHANT}`,
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([policy()]);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/commerce/policies/${POLICY_ID}`,
      headers: authHeader(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: { id: string } }>().data.id).toBe(POLICY_ID);
  });

  it('activates a draft policy and emits policy.activated', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      ...policy({ status: 'draft', activated_by: null, activated_at: null }),
      default_currency: 'INR',
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([policy({ status: 'active' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_POLICY_ACTIVATED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/policies/${POLICY_ID}/activate`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string }; audit_event_id: string }>().data.status).toBe('active');
    expect(sqlMock.mock.calls.flat()).toContain('policy.activated');
  });

  it('rejects activation of an already-active policy as immutable', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ ...policy({ status: 'active' }), default_currency: 'INR' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/policies/${POLICY_ID}/activate`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('active_policy_immutable');
  });
});

describe('Commerce policy rule evaluation', () => {
  it('allows an amount within the cap', () => {
    const result = evaluateCommercePolicyRules(rules(), {
      actionScope: 'commerce:payment.initiate',
      amountMinorUnits: 1000,
      currency: 'INR',
      passportScopes: ['commerce:payment.initiate'],
      passportMaxAmount: 5000,
      passportCurrency: 'INR',
    });
    expect(result).toEqual({ decision: 'allow', reason: 'policy_allowed' });
  });

  it('denies an amount above the cap', () => {
    const result = evaluateCommercePolicyRules(rules(), {
      actionScope: 'commerce:payment.initiate',
      amountMinorUnits: 5001,
      currency: 'INR',
      passportScopes: ['commerce:payment.initiate'],
      passportMaxAmount: 10000,
      passportCurrency: 'INR',
    });
    expect(result).toEqual({ decision: 'deny', reason: 'amount_cap_exceeded' });
  });

  it('denies currency mismatch and scope allowlist violations', () => {
    expect(evaluateCommercePolicyRules(rules(), {
      actionScope: 'commerce:payment.initiate',
      amountMinorUnits: 1000,
      currency: 'USD',
      passportScopes: ['commerce:payment.initiate'],
      passportMaxAmount: 5000,
      passportCurrency: 'USD',
    }).reason).toBe('currency_mismatch');

    expect(evaluateCommercePolicyRules(rules({ scope_allowlist: ['commerce:catalog.read'] }), {
      actionScope: 'commerce:payment.initiate',
      amountMinorUnits: 1000,
      currency: 'INR',
      passportScopes: ['commerce:payment.initiate'],
      passportMaxAmount: 5000,
      passportCurrency: 'INR',
    }).reason).toBe('scope_not_allowed');
  });
});

describe('POST /v1/commerce/policies/evaluate', () => {
  it('returns allow with policy version and decision reference and does not emit policy.evaluated', async () => {
    const token = await passport({ passportType: 'checkout' });
    primeEvaluateBase();
    const res = await evaluate({ passport_jwt: token });
    const body = res.json<{ data: { decision: string; policy_version: string; decision_id: string }; audit_event_id?: string }>();
    expect(res.statusCode).toBe(200);
    expect(body.data.decision).toBe('allow');
    expect(body.data.policy_version).toBe('v1');
    expect(body.data.decision_id).toMatch(/^cpdec_/);
    expect(body.audit_event_id).toBeUndefined();
    expect(sqlMock.mock.calls.flat()).not.toContain('policy.evaluated');
  });

  it('denies browse passports for payment intent evaluation even with matching scope and emits policy.evaluated', async () => {
    const token = await passport({
      passportType: 'browse',
      scopes: ['commerce:payment.initiate'],
      maxAmount: 5000,
      currency: 'INR',
    });
    primeEvaluateBase({ auditId: 'caud_BROWSE_PAYMENT' });
    const res = await evaluate({ passport_jwt: token });
    const body = res.json<{ data: { decision: string; reason: string }; audit_event_id: string }>();
    expect(body.data).toMatchObject({ decision: 'deny', reason: 'checkout_passport_required' });
    expect(body.audit_event_id).toBe('caud_BROWSE_PAYMENT');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('denies browse passports for checkout evaluation even with matching scope and emits policy.evaluated', async () => {
    const token = await passport({
      passportType: 'browse',
      scopes: ['commerce:checkout.create'],
      maxAmount: 5000,
      currency: 'INR',
    });
    primeEvaluateBase({ auditId: 'caud_BROWSE_CHECKOUT' });
    const res = await evaluate({
      passport_jwt: token,
      action_scope: 'commerce:checkout.create',
    });
    const body = res.json<{ data: { decision: string; reason: string }; audit_event_id: string }>();
    expect(body.data).toMatchObject({ decision: 'deny', reason: 'checkout_passport_required' });
    expect(body.audit_event_id).toBe('caud_BROWSE_CHECKOUT');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('allows checkout passports for valid payment-affecting evaluation', async () => {
    const token = await passport({ passportType: 'checkout' });
    primeEvaluateBase();
    const res = await evaluate({ passport_jwt: token });
    expect(res.json<{ data: { decision: string; reason: string } }>().data)
      .toMatchObject({ decision: 'allow', reason: 'policy_allowed' });
    expect(sqlMock.mock.calls.flat()).not.toContain('policy.evaluated');
  });

  it('denies checkout passports above the policy checkout TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await passport({ passportType: 'checkout', iat: now, exp: now + 300 });
    primeEvaluateBase({
      policyRow: policy({ rules: rules({ checkout_passport_max_ttl_seconds: 120 }) }),
      auditId: 'caud_CHECKOUT_TTL',
    });
    const res = await evaluate({ passport_jwt: token });
    expect(res.json<{ data: { reason: string } }>().data.reason)
      .toBe('checkout_passport_ttl_exceeded');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('denies browse passports above the policy browse TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await passport({
      passportType: 'browse',
      scopes: ['commerce:catalog.read'],
      maxAmount: null,
      currency: null,
      iat: now,
      exp: now + 300,
    });
    primeEvaluateBase({
      policyRow: policy({ rules: rules({ browse_passport_max_ttl_seconds: 120 }) }),
      auditId: 'caud_BROWSE_TTL',
    });
    const res = await evaluate({
      passport_jwt: token,
      action_scope: 'commerce:catalog.read',
      amount_minor_units: undefined,
      currency: undefined,
    });
    expect(res.json<{ data: { reason: string } }>().data.reason)
      .toBe('browse_passport_ttl_exceeded');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('denies amount cap violations and emits policy.evaluated', async () => {
    const token = await passport({ maxAmount: 10000 });
    primeEvaluateBase({ auditId: 'caud_POLICY_DENY' });
    const res = await evaluate({ passport_jwt: token, amount_minor_units: 5001 });
    const body = res.json<{ data: { decision: string; reason: string }; audit_event_id: string }>();
    expect(body.data).toMatchObject({ decision: 'deny', reason: 'amount_cap_exceeded' });
    expect(body.audit_event_id).toBe('caud_POLICY_DENY');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('requires user consent when the passport amount is too low and emits policy.evaluated', async () => {
    const token = await passport({ maxAmount: 500 });
    primeEvaluateBase({ auditId: 'caud_POLICY_CONSENT' });
    const res = await evaluate({ passport_jwt: token, amount_minor_units: 1000 });
    const body = res.json<{ data: { decision: string; reason: string }; audit_event_id: string }>();
    expect(body.data).toMatchObject({
      decision: 'requires_user_consent',
      reason: 'passport_amount_exceeded',
    });
    expect(body.audit_event_id).toBe('caud_POLICY_CONSENT');
    expect(sqlMock.mock.calls.flat()).toContain('policy.evaluated');
  });

  it('denies policy currency mismatch', async () => {
    const token = await passport({ currency: 'USD' });
    primeEvaluateBase({ auditId: 'caud_POLICY_CURRENCY' });
    const res = await evaluate({ passport_jwt: token, currency: 'USD' });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('currency_mismatch');
  });

  it('denies scope allowlist violations', async () => {
    const token = await passport();
    primeEvaluateBase({
      policyRow: policy({ rules: rules({ scope_allowlist: ['commerce:catalog.read'] }) }),
      auditId: 'caud_POLICY_SCOPE',
    });
    const res = await evaluate({ passport_jwt: token });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('scope_not_allowed');
  });

  it('blocks immediately when emergency disable endpoint turns off agentic commerce', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      id: MERCHANT,
      tenant_id: TEST_COMMERCE_TENANT_ID,
      agentic_commerce_enabled: false,
      updated_at: new Date().toISOString(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_DISABLE', occurred_at: new Date().toISOString() }]);
    const disable = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/disable-agentic-commerce`,
      headers: authHeader(),
      payload: { reason: 'test' },
    });
    expect(disable.statusCode).toBe(200);

    const token = await passport();
    primeEvaluatePrePassportDeny({
      merchantRow: merchant({ agentic_commerce_enabled: false }),
      auditId: 'caud_EMERGENCY_BLOCK',
    });
    const res = await evaluate({ passport_jwt: token });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('emergency_disabled');
  });

  it('denies merchant mismatch and tenant mismatch passports', async () => {
    primeEvaluateBase({ revocationRows: null, auditId: 'caud_MERCHANT_MISMATCH' });
    const merchantMismatch = await evaluate({ passport_jwt: await passport({ merchantId: 'mch_OTHER' }) });
    expect(merchantMismatch.json<{ data: { reason: string } }>().data.reason).toBe('merchant_mismatch');

    primeEvaluateBase({ revocationRows: null, auditId: 'caud_TENANT_MISMATCH' });
    const tenantMismatch = await evaluate({ passport_jwt: await passport({ tenantId: 'cten_OTHER' }) });
    expect(tenantMismatch.json<{ data: { reason: string } }>().data.reason).toBe('tenant_mismatch');
  });

  it.each([
    ['disabled agent', agent({ disabled_at: new Date().toISOString(), trust_status: 'trusted' }), 'agent_disabled'],
    ['untrusted agent', agent({ trust_status: 'suspended' }), 'agent_not_trusted'],
  ])('denies %s before passport verification', async (_label, agentRow, reason) => {
    primeEvaluatePrePassportDeny({ agentRow, auditId: `caud_${reason}` });
    const res = await evaluate({ passport_jwt: await passport() });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe(reason);
  });

  it('denies expired passports', async () => {
    const now = Math.floor(Date.now() / 1000);
    primeEvaluateBase({ revocationRows: null, auditId: 'caud_EXPIRED' });
    const res = await evaluate({ passport_jwt: await passport({ iat: now - 300, exp: now - 60 }) });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('passport_expired');
  });

  it('denies revoked passports', async () => {
    mockRedis.sismember.mockResolvedValueOnce(1);
    primeEvaluateBase({ revocationRows: null, auditId: 'caud_REVOKED' });
    const res = await evaluate({ passport_jwt: await passport() });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('passport_revoked');
  });

  it('denies sandbox/live environment mismatch', async () => {
    primeEvaluateBase({ auditId: 'caud_ENV' });
    const res = await evaluate({ passport_jwt: await passport({ environment: 'live' }) });
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('environment_mismatch');
  });
});

describe('M3 policy migration and OpenAPI contract', () => {
  it('adds CommercePolicy persistence and active immutability DDL', () => {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations/043_commerce_policies.sql'),
      'utf8',
    );
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_policies/);
    expect(migration).toMatch(/uq_commerce_policies_one_active/);
    expect(migration).toMatch(/commerce_policies_prevent_active_mutation/);
    expect(migration).toMatch(/active commerce policies are immutable/);
  });

  it('marks M3 policy routes as implemented in OpenAPI', () => {
    const yaml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../docs/api/grantex-commerce-v1.openapi.yaml'),
      'utf8',
    );
    for (const path of [
      '/v1/commerce/policies',
      '/v1/commerce/policies/{policy_id}',
      '/v1/commerce/policies/{policy_id}/activate',
      '/v1/commerce/policies/evaluate',
      '/v1/commerce/merchants/{merchant_id}/disable-agentic-commerce',
    ]) {
      expect(yaml).toContain(path);
    }
    expect(yaml).toMatch(/operationId:\s+createCommercePolicy[\s\S]*?x-implemented:\s+true/);
    expect(yaml).toMatch(/operationId:\s+activateCommercePolicy[\s\S]*?x-implemented:\s+true/);
    expect(yaml).toMatch(/operationId:\s+evaluateCommercePolicy[\s\S]*?x-implemented:\s+true/);
    expect(yaml).toMatch(/operationId:\s+disableMerchantAgenticCommerce[\s\S]*?x-implemented:\s+true/);
  });
});
