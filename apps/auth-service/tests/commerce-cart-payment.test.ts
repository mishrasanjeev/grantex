import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, mockRedis, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { hashRequestBody } from '../src/lib/commerce/idempotency.js';
import type { CommercePolicyRules } from '../src/lib/commerce/policy.js';

let app: FastifyInstance;
let privateKey: KeyLike;
let publicJwk: JWK;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/045_commerce_cart_payment_intents.sql');
const CHECKOUT_MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/046_commerce_checkout_links.sql');

const MERCHANT = 'mch_M4B';
const AGENT = 'cag_M4B';
const CART = 'ccart_M4B';
const PAYMENT_INTENT = 'cpi_M4B';
const VARIANT = 'cvar_M4B';
const KID = 'commerce-passport-20260512-bbccddee';
const SUBJECT = 'user_M4B';
const CONSENT = 'crec_M4B';
const AGENT_TOKEN = 'grtx_agent_M4BXXXXXXXXXXXXXXXXXXXXXXXX';

beforeAll(async () => {
  app = await buildTestApp();
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };
});

function agentHeader(): Record<string, string> {
  return { authorization: `Bearer ${AGENT_TOKEN}` };
}

function agentAuthRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'hash',
    tenant_status: 'active',
    ...overrides,
  };
}

function seedAgentAuth(): void {
  sqlMock.mockResolvedValueOnce([agentAuthRow()]);
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

function agentContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    disabled_at: null,
    ...overrides,
  };
}

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

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cpol_M4B',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    version: 'v1',
    rules: rules(),
    status: 'active',
    ...overrides,
  };
}

function variantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VARIANT,
    product_id: 'cprd_M4B',
    product_ref: 'sku-product',
    title: 'Test product',
    sku: 'SKU-M4B',
    variant_title: 'Base',
    attributes: {},
    price_amount: 1000,
    currency: 'INR',
    tax_inclusive: true,
    gst_slab: '18',
    tax_rate: null,
    hsn_code: '8517',
    availability_status: 'in_stock',
    warranty_summary: '1 year',
    return_policy_summary: '7 days',
    last_synced_at: new Date().toISOString(),
    ...overrides,
  };
}

function cartRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const snapshot = [{
    variant_id: VARIANT,
    sku: 'SKU-M4B',
    quantity: 1,
    unit_amount: 1000,
    line_total_amount: 1000,
    currency: 'INR',
  }];
  return {
    id: CART,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    passport_jti: null,
    line_items: [{ variant_id: VARIANT, quantity: 1 }],
    line_items_snapshot: snapshot,
    currency: 'INR',
    subtotal_amount: 1000,
    tax_amount: 0,
    total_amount: 1000,
    status: 'draft',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    line_items_snapshot_hash: 'hash_snapshot',
    idempotency_key_hash: 'hash_idem',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function paymentIntentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_INTENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    cart_id: CART,
    passport_jti: 'cpsp_M4B',
    amount: 1000,
    currency: 'INR',
    provider: 'mock',
    provider_environment: 'sandbox',
    provider_payment_id: `mock_pay_${PAYMENT_INTENT}`,
    provider_order_id: `mock_order_${PAYMENT_INTENT}`,
    checkout_url: null,
    checkout_expires_at: null,
    status: 'created',
    line_items_snapshot: cartRow().line_items_snapshot,
    idempotency_key_hash: 'hash_idem',
    provider_metadata: { deterministic: true },
    provider_raw_status: 'mock_created',
    policy_version: 'v1',
    decision_id: 'cpdec_M4B',
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function cartPayload(): Record<string, unknown> {
  return {
    merchant_id: MERCHANT,
    currency: 'INR',
    line_items: [{ variant_id: VARIANT, quantity: 1 }],
  };
}

async function checkoutPayload(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    success_url: 'https://merchant.example/success',
    cancel_url: 'https://merchant.example/cancel',
    passport_jwt: await passport(),
    ...overrides,
  };
}

async function passport(overrides: {
  passportType?: 'browse' | 'checkout';
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
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
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
    .setJti(overrides.jti ?? 'cpsp_M4B')
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

async function paymentPayload(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    merchant_id: MERCHANT,
    cart_id: CART,
    passport_jwt: await passport(),
    amount_minor_units: 1000,
    currency: 'INR',
    provider_key: 'mock',
    ...overrides,
  };
}

function primePaymentBase(opts: {
  paymentRow?: Record<string, unknown>;
  merchantRow?: Record<string, unknown>;
  cart?: Record<string, unknown>;
  policyRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown>;
  revocationRows?: Record<string, unknown>[];
  auditIds?: string[];
} = {}): void {
  seedAgentAuth();
  sqlMock.mockResolvedValueOnce([opts.merchantRow ?? merchant()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([opts.cart ?? cartRow()]);
  sqlMock.mockResolvedValueOnce([opts.policyRow ?? policy()]);
  sqlMock.mockResolvedValueOnce([opts.agentRow ?? agentContext()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  sqlMock.mockResolvedValueOnce(opts.revocationRows ?? []);
  sqlMock.mockResolvedValueOnce([opts.paymentRow ?? paymentIntentRow()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([{ id: opts.auditIds?.[0] ?? 'caud_PAYMENT_CREATED', occurred_at: new Date().toISOString() }]);
  sqlMock.mockResolvedValueOnce([{ id: opts.auditIds?.[1] ?? 'caud_PAYMENT_METER', occurred_at: new Date().toISOString() }]);
  sqlMock.mockResolvedValueOnce([]);
}

function primePaymentDenyBase(opts: {
  merchantRow?: Record<string, unknown>;
  cart?: Record<string, unknown>;
  policyRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown>;
  revocationRows?: Record<string, unknown>[];
  auditId?: string;
} = {}): void {
  seedAgentAuth();
  sqlMock.mockResolvedValueOnce([opts.merchantRow ?? merchant()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([opts.cart ?? cartRow()]);
  sqlMock.mockResolvedValueOnce([opts.policyRow ?? policy()]);
  sqlMock.mockResolvedValueOnce([opts.agentRow ?? agentContext()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  sqlMock.mockResolvedValueOnce(opts.revocationRows ?? []);
  sqlMock.mockResolvedValueOnce([{ id: opts.auditId ?? 'caud_POLICY_DENY', occurred_at: new Date().toISOString() }]);
}

function primeCheckoutBase(opts: {
  paymentRow?: Record<string, unknown>;
  policyRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown>;
  revocationRows?: Record<string, unknown>[];
  updatedRow?: Record<string, unknown>;
  auditId?: string;
} = {}): void {
  seedAgentAuth();
  const base = opts.paymentRow ?? paymentIntentRow({ status: 'authorized' });
  sqlMock.mockResolvedValueOnce([base]);
  primeCheckoutSecurity(opts);
  sqlMock.mockResolvedValueOnce([]);
  const checkoutCreated = {
    ...base,
    status: 'checkout_created',
    checkout_url: `https://mock-payments.grantex.local/checkout/${PAYMENT_INTENT}`,
    checkout_expires_at: new Date(Date.now() + 900_000).toISOString(),
    provider_raw_status: 'mock_checkout_created',
    provider_metadata: { deterministic: true },
  };
  sqlMock.mockResolvedValueOnce([checkoutCreated]);
  sqlMock.mockResolvedValueOnce([opts.updatedRow ?? {
    ...checkoutCreated,
    status: 'payment_pending',
    provider_metadata: { deterministic: true, checkout_link_state: 'payment_pending' },
  }]);
  sqlMock.mockResolvedValueOnce([{ id: opts.auditId ?? 'caud_CHECKOUT_LINK_CREATED', occurred_at: new Date().toISOString() }]);
  sqlMock.mockResolvedValueOnce([]);
}

function primeCheckoutSecurity(opts: {
  policyRow?: Record<string, unknown>;
  agentRow?: Record<string, unknown>;
  revocationRows?: Record<string, unknown>[];
} = {}): void {
  sqlMock.mockResolvedValueOnce([opts.policyRow ?? policy()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  sqlMock.mockResolvedValueOnce(opts.revocationRows ?? []);
  sqlMock.mockResolvedValueOnce([opts.agentRow ?? agentContext()]);
}

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

describe('Commerce cart APIs', () => {
  it('creates and reads an immutable cart draft', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([variantRow()]);
    sqlMock.mockResolvedValueOnce([cartRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CART_CREATED', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([]);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: { ...agentHeader(), 'idempotency-key': 'cart-key-1' },
      payload: cartPayload(),
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: { cart_id: string; status: string; total_amount: number } }>().data)
      .toMatchObject({ cart_id: CART, status: 'draft', total_amount: 1000 });
    expect(flattenedSqlCalls()).toContain('cart.created');

    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([cartRow()]);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/commerce/carts/${CART}`,
      headers: agentHeader(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: { id: string } }>().data.id).toBe(CART);
  });

  it('requires Idempotency-Key for cart creation', async () => {
    seedAgentAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: agentHeader(),
      payload: cartPayload(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');
  });

  it('replays cart creation for the same idempotency key and body', async () => {
    const payload = cartPayload();
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_CART',
      request_body_hash: hashRequestBody(payload),
      response_status: 201,
      response_body: { data: { cart_id: CART, status: 'draft' }, audit_event_id: 'caud_CART_CREATED' },
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: { ...agentHeader(), 'idempotency-key': 'cart-key-replay' },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { cart_id: string } }>().data.cart_id).toBe(CART);
  });

  it('rejects cart idempotency conflicts and audits them', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_CART_CONFLICT',
      request_body_hash: hashRequestBody({ ...cartPayload(), currency: 'USD' }),
      response_status: 201,
      response_body: { data: { cart_id: 'ccart_OLD' } },
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CART_IDEMPOTENCY_CONFLICT', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: { ...agentHeader(), 'idempotency-key': 'cart-key-conflict' },
      payload: cartPayload(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id?: string } }>().error)
      .toMatchObject({ code: 'idempotency_conflict', audit_event_id: 'caud_CART_IDEMPOTENCY_CONFLICT' });
    expect(flattenedSqlCalls()).toContain('idempotency.conflict');
  });

  it('requires registered CommerceAgent auth for cart creation', async () => {
    seedCommerceContext();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: { ...authHeader(), 'idempotency-key': 'cart-key-operator' },
      payload: cartPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_required');
  });
});

describe('Commerce payment intent APIs', () => {
  it('creates a payment intent through the mock provider and writes action + meter audits', async () => {
    primePaymentBase();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-1' },
      payload: await paymentPayload(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { payment_intent_id: string; status: string; provider_payment_id: string }; audit_event_id: string; meter_event_id: string }>();
    expect(body.data).toMatchObject({
      payment_intent_id: PAYMENT_INTENT,
      status: 'created',
      provider_payment_id: `mock_pay_${PAYMENT_INTENT}`,
    });
    expect(body.audit_event_id).toBe('caud_PAYMENT_CREATED');
    expect(body.meter_event_id).toBe('caud_PAYMENT_METER');
    expect(flattenedSqlCalls()).toContain('payment_intent.created');
    expect(flattenedSqlCalls()).toContain('meter.payment_intent_created');
  });

  it('requires Idempotency-Key for payment intent creation', async () => {
    seedAgentAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: agentHeader(),
      payload: await paymentPayload(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');
  });

  it('replays and conflicts payment intent idempotency correctly', async () => {
    const payload = await paymentPayload();
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_PAY',
      request_body_hash: hashRequestBody(payload),
      response_status: 201,
      response_body: { data: { payment_intent_id: PAYMENT_INTENT }, audit_event_id: 'caud_PAYMENT_CREATED' },
    }]);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-replay' },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<{ data: { payment_intent_id: string } }>().data.payment_intent_id).toBe(PAYMENT_INTENT);

    const conflictPayload = await paymentPayload();
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_PAY_CONFLICT',
      request_body_hash: hashRequestBody({ ...conflictPayload, amount_minor_units: 2000 }),
      response_status: 201,
      response_body: { data: { payment_intent_id: 'cpi_OLD' } },
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PAY_IDEMPOTENCY_CONFLICT', occurred_at: new Date().toISOString() }]);

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-conflict' },
      payload: conflictPayload,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string; audit_event_id?: string } }>().error)
      .toMatchObject({ code: 'idempotency_conflict', audit_event_id: 'caud_PAY_IDEMPOTENCY_CONFLICT' });
  });

  it('requires a valid checkout passport and rejects browse passports', async () => {
    const browse = await passport({
      passportType: 'browse',
      scopes: ['commerce:payment.initiate'],
      maxAmount: 5000,
      currency: 'INR',
    });
    primePaymentDenyBase({ auditId: 'caud_BROWSE_DENY' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-browse' },
      payload: await paymentPayload({ passport_jwt: browse }),
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; audit_event_id?: string } }>();
    expect(body.error.code).toBe('checkout_passport_required');
    expect(body.error.audit_event_id).toBeDefined();
    expect(flattenedSqlCalls()).toContain('policy.evaluated');
  });

  it('blocks revoked and expired passports fail-closed', async () => {
    mockRedis.sismember.mockResolvedValueOnce(1);
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([cartRow()]);
    sqlMock.mockResolvedValueOnce([policy()]);
    sqlMock.mockResolvedValueOnce([agentContext()]);
    sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REVOKED_DENY', occurred_at: new Date().toISOString() }]);

    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-revoked' },
      payload: await paymentPayload(),
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json<{ error: { code: string } }>().error.code).toBe('passport_revoked');

    const now = Math.floor(Date.now() / 1000);
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([cartRow()]);
    sqlMock.mockResolvedValueOnce([policy()]);
    sqlMock.mockResolvedValueOnce([agentContext()]);
    sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_EXPIRED_DENY', occurred_at: new Date().toISOString() }]);

    const expired = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-expired' },
      payload: await paymentPayload({ passport_jwt: await passport({ iat: now - 600, exp: now - 120 }) }),
    });
    expect(expired.statusCode).toBe(403);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe('passport_expired');
  });

  it('blocks emergency-disabled merchants and amount-cap policy denials', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([cartRow()]);
    sqlMock.mockResolvedValueOnce([policy({ rules: rules({ emergency_disable: true }) })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_EMERGENCY_DENY', occurred_at: new Date().toISOString() }]);
    const emergency = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-emergency' },
      payload: await paymentPayload(),
    });
    expect(emergency.statusCode).toBe(403);
    expect(emergency.json<{ error: { code: string } }>().error.code).toBe('emergency_disabled');

    primePaymentDenyBase({
      policyRow: policy({ rules: rules({ amount_cap: { max_amount_minor_units: 500, currency: 'INR' } }) }),
      auditId: 'caud_AMOUNT_CAP_DENY',
    });
    const cap = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-cap' },
      payload: await paymentPayload(),
    });
    expect(cap.statusCode).toBe(403);
    expect(cap.json<{ error: { code: string } }>().error.code).toBe('amount_cap_exceeded');
  });

  it('rejects invalid providers and keeps the configured provider blocked', async () => {
    seedAgentAuth();
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-invalid-provider' },
      payload: await paymentPayload({ provider_key: 'unknown' }),
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ error: { details?: { fields?: Record<string, string> } } }>().error.details?.fields)
      .toHaveProperty('provider_key');

    primePaymentBase();
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents',
      headers: { ...agentHeader(), 'idempotency-key': 'pay-key-blocked-provider' },
      payload: await paymentPayload({ provider_key: 'plural' }),
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json<{ error: { code: string; details?: { provider_error_code?: string } } }>().error)
      .toMatchObject({ code: 'provider_validation_failed' });
  });

  it('lists and reads payment intents through tenant-scoped queries', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/commerce/payments/intents?merchant_id=${MERCHANT}`,
      headers: agentHeader(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: Array<{ id: string }> }>().items[0]?.id).toBe(PAYMENT_INTENT);

    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}`,
      headers: agentHeader(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: { id: string; status: string } }>().data)
      .toMatchObject({ id: PAYMENT_INTENT, status: 'created' });
    expect(flattenedSqlCalls()).toContain('tenant_id');
    expect(flattenedSqlCalls()).toContain(TEST_COMMERCE_TENANT_ID);
  });
});

describe('Commerce checkout link API', () => {
  it('creates a checkout link through MockPaymentProvider and audits checkout_link.created', async () => {
    primeCheckoutBase();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-1' },
      payload: await checkoutPayload(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { status: string; checkout_url: string; checkout_expires_at: string }; audit_event_id: string }>();
    expect(body.data.status).toBe('payment_pending');
    expect(body.data.checkout_url).toContain(`/${PAYMENT_INTENT}`);
    expect(body.data.checkout_expires_at).toBeTruthy();
    expect(body.audit_event_id).toBe('caud_CHECKOUT_LINK_CREATED');
    expect(flattenedSqlCalls()).toContain('checkout_link.created');
    expect(flattenedSqlCalls()).toContain('checkout_expires_at');
    expect(flattenedSqlCalls()).toContain('checkout_created');
    expect(flattenedSqlCalls()).toContain('payment_pending');
  });

  it('requires Idempotency-Key for checkout link creation', async () => {
    seedAgentAuth();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: agentHeader(),
      payload: await checkoutPayload(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');
  });

  it('replays checkout link creation for the same idempotency key and body', async () => {
    const payload = await checkoutPayload();
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized' })]);
    primeCheckoutSecurity();
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_CHECKOUT',
      request_body_hash: hashRequestBody(payload),
      response_status: 201,
      response_body: {
        data: {
          payment_intent_id: PAYMENT_INTENT,
          status: 'payment_pending',
          checkout_url: 'https://mock-payments.grantex.local/checkout/replay',
        },
        audit_event_id: 'caud_CHECKOUT_LINK_CREATED',
      },
    }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-replay' },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { payment_intent_id: string; status: string } }>().data)
      .toMatchObject({ payment_intent_id: PAYMENT_INTENT, status: 'payment_pending' });
  });

  it('rejects checkout link idempotency conflicts and audits them', async () => {
    const payload = await checkoutPayload();
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized' })]);
    primeCheckoutSecurity();
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_CHECKOUT_CONFLICT',
      request_body_hash: hashRequestBody({ ...payload, cancel_url: 'https://merchant.example/other-cancel' }),
      response_status: 201,
      response_body: { data: { payment_intent_id: PAYMENT_INTENT } },
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CHECKOUT_IDEMPOTENCY_CONFLICT', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-conflict' },
      payload,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id?: string } }>().error)
      .toMatchObject({ code: 'idempotency_conflict', audit_event_id: 'caud_CHECKOUT_IDEMPOTENCY_CONFLICT' });
    expect(flattenedSqlCalls()).toContain('idempotency.conflict');
  });

  it('rejects invalid success_url and cancel_url', async () => {
    seedAgentAuth();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-bad-url' },
      payload: await checkoutPayload({
        success_url: 'http://evil.example/success',
        cancel_url: 'not-a-url',
      }),
    });
    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details?: { fields?: Record<string, string> } } }>().error.details?.fields;
    expect(fields).toHaveProperty('success_url');
    expect(fields).toHaveProperty('cancel_url');
  });

  it('returns 404 for missing or cross-tenant payment intents', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/payments/intents/cpi_CROSS_TENANT/checkout-link',
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-missing' },
      payload: await checkoutPayload(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('payment_intent_not_found');
  });

  it('rejects and audits invalid checkout link status transitions', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'created' })]);
    primeCheckoutSecurity();
    sqlMock.mockResolvedValueOnce([{ id: 'caud_INVALID_CHECKOUT_TRANSITION', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-invalid-status' },
      payload: await checkoutPayload(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id?: string } }>().error)
      .toMatchObject({ code: 'invalid_payment_status_transition', audit_event_id: 'caud_INVALID_CHECKOUT_TRANSITION' });
    expect(flattenedSqlCalls()).toContain('protected_action.denied');
  });

  it('returns explicit safe provider error while configured provider remains blocked', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized', provider: 'plural' })]);
    primeCheckoutSecurity();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/checkout-link`,
      headers: { ...agentHeader(), 'idempotency-key': 'checkout-key-blocked-provider' },
      payload: await checkoutPayload(),
    });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string; details?: { provider_error_code?: string; safe_metadata?: Record<string, unknown> } } }>();
    expect(body.error.code).toBe('provider_validation_failed');
    expect(body.error.details?.provider_error_code).toMatch(/plural_/);
    expect(body.error.details?.safe_metadata).toMatchObject({
      api_contract_confirmed: false,
      webhook_signature_confirmed: false,
    });
  });
});

describe('M4B migration and OpenAPI contract', () => {
  it('adds cart and payment intent tables without provider-specific columns', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_carts/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_payment_intents/);
    expect(migration).toMatch(/idx_commerce_carts_tenant_merchant_created/);
    expect(migration).toMatch(/idx_payment_intents_tenant_merchant_created/);
    expect(migration).toMatch(/uq_payment_intents_provider_payment/);

    const uncommented = migration
      .split(/\r?\n/)
      .map((line) => line.replace(/--[^\r\n]*/, ''))
      .join('\n')
      .toLowerCase();
    expect(uncommented).not.toMatch(/plural_/);
  });

  it('marks cart and payment intent routes implemented in OpenAPI', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    for (const route of [
      '/v1/commerce/carts',
      '/v1/commerce/carts/{cart_id}',
      '/v1/commerce/payments/intents',
      '/v1/commerce/payments/intents/{id}',
    ]) {
      const start = content.indexOf(`  ${route}:`);
      expect(start, `OpenAPI must declare ${route}`).toBeGreaterThan(-1);
      const after = content.slice(start);
      const next = after.slice(1).search(/\n {2}\/[A-Za-z0-9{]/);
      const block = next === -1 ? after : after.slice(0, next + 1);
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M4B/);
    }
    expect(content).toMatch(/CommerceCart:/);
    expect(content).toMatch(/CommercePaymentIntent:/);
  });
});

describe('M4C checkout link migration and OpenAPI contract', () => {
  it('adds checkout link expiry persistence', () => {
    const migration = readFileSync(CHECKOUT_MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/ALTER TABLE commerce_payment_intents/);
    expect(migration).toMatch(/checkout_expires_at/);
    expect(migration).toMatch(/idx_payment_intents_checkout_expires/);
  });

  it('marks checkout-link route implemented in OpenAPI', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const route = '/v1/commerce/payments/intents/{id}/checkout-link';
    const start = content.indexOf(`  ${route}:`);
    expect(start, `OpenAPI must declare ${route}`).toBeGreaterThan(-1);
    const after = content.slice(start);
    const next = after.slice(1).search(/\n {2}\/[A-Za-z0-9{]/);
    const block = next === -1 ? after : after.slice(0, next + 1);
    expect(block).toMatch(/x-implemented:\s*true/);
    expect(block).toMatch(/x-milestone:\s*M4C/);
    expect(block).toMatch(/CreateCheckoutLinkRequest/);
    expect(content).toMatch(/checkout_expires_at:/);
  });
});
