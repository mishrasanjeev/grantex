import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestApp, authHeader, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import type { CommercePolicyRules } from '../src/lib/commerce/policy.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');

const MERCHANT = 'mch_M5B';
const AGENT = 'cag_M5B';
const CART = 'ccart_M5B';
const PAYMENT_INTENT = 'cpi_M5B';
const VARIANT = 'cvar_M5B';
const CONSENT = 'crec_M5B';
const SUBJECT = 'user_M5B';
const KID = 'commerce-passport-20260512-aabbccdd';
const AGENT_TOKEN = 'grtx_agent_M5BXXXXXXXXXXXXXXXXXXXXXXXX';
const MERCHANT_TOKEN = 'grtx_sk_sandbox_M5BXXXXXXXXXXXXXXXXXXXXXXXX';
const NOW = new Date().toISOString();

const V1_TOOLS = [
  'merchant.get_profile',
  'catalog.search',
  'catalog.get_item',
  'inventory.check',
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
];

let app: FastifyInstance;
let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  app = await buildTestApp();
  const kp = await generateKeyPair('ES256');
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function agentHeader(): Record<string, string> {
  return { authorization: `Bearer ${AGENT_TOKEN}` };
}

function merchantHeader(): Record<string, string> {
  return { authorization: `Bearer ${MERCHANT_TOKEN}` };
}

function seedAgentAuth(): void {
  sqlMock.mockResolvedValueOnce([{
    id: AGENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'hash',
    tenant_status: 'active',
  }]);
}

function seedMerchantAuth(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_M5B',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
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
    id: 'cpol_M5B',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    version: 'v1',
    rules: rules(),
    status: 'active',
    ...overrides,
  };
}

function merchantProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MERCHANT,
    legal_name: 'M5B Merchant Pvt Ltd',
    display_name: 'M5B Merchant',
    category_preset: 'electronics_appliances',
    verification_status: 'verified',
    environment: 'sandbox',
    default_currency: 'INR',
    country_code: 'IN',
    default_capabilities: V1_TOOLS,
    ...overrides,
  };
}

function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cprd_M5B',
    product_id: 'TOASTER-M5B',
    merchant_id: MERCHANT,
    title: 'M5B Toaster',
    brand: 'Acme',
    image_url: null,
    category_preset: 'electronics_appliances',
    updated_at: NOW,
    variant_id: VARIANT,
    sku: 'TOASTER-M5B-WHITE',
    variant_title: 'White',
    model: 'T100',
    price_amount: 1000,
    currency: 'INR',
    availability_status: 'in_stock',
    last_synced_at: NOW,
    ...overrides,
  };
}

function catalogItemProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cprd_M5B',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    product_id: 'TOASTER-M5B',
    title: 'M5B Toaster',
    brand: 'Acme',
    description: 'A test toaster',
    image_url: null,
    category_preset: 'electronics_appliances',
    source_system: 'manual',
    manually_maintained: false,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function inventoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VARIANT,
    sku: 'TOASTER-M5B-WHITE',
    availability_status: 'in_stock',
    last_synced_at: NOW,
    ...overrides,
  };
}

function cartRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const snapshot = [{
    variant_id: VARIANT,
    sku: 'TOASTER-M5B-WHITE',
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
    created_at: NOW,
    updated_at: NOW,
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
    passport_jti: 'cpsp_M5B',
    amount: 1000,
    currency: 'INR',
    provider: 'mock',
    provider_environment: 'sandbox',
    provider_payment_id: `mock_pay_${PAYMENT_INTENT}`,
    provider_order_id: `mock_order_${PAYMENT_INTENT}`,
    checkout_url: null,
    checkout_expires_at: null,
    status: 'authorized',
    line_items_snapshot: cartRow().line_items_snapshot,
    idempotency_key_hash: 'hash_idem',
    provider_metadata: { deterministic: true },
    provider_raw_status: 'mock_authorized',
    policy_version: 'v1',
    decision_id: 'cpdec_M5B',
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    reconciled_at: null,
    last_reconciliation_attempt_at: null,
    last_reconciliation_error: null,
    last_reconciliation_retryable: null,
    created_at: NOW,
    updated_at: NOW,
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

function merchantContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

async function passport(overrides: {
  passportType?: 'browse' | 'checkout';
  scopes?: string[];
  jti?: string;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
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
    max_amount: 5000,
    currency: 'INR',
    env: 'sandbox',
    ver: '1',
  })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
    .setAudience('grantex-commerce')
    .setSubject(SUBJECT)
    .setJti(overrides.jti ?? 'cpsp_M5B')
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { jsonrpc: '2.0', id: 'm5b', method, params },
  });
}

async function callTool(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  return rpc('tools/call', { name, arguments: args }, headers);
}

function resultText(res: { json: <T = unknown>() => T }): string {
  const body = res.json<{
    result: { content: Array<{ text: string }> };
  }>();
  return body.result.content[0]?.text ?? '';
}

function resultJson<T = Record<string, unknown>>(res: { json: <U = unknown>() => U }): T {
  return JSON.parse(resultText(res)) as T;
}

function expectToolError(res: { json: <T = unknown>() => T }, code: string): void {
  const body = res.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
  expect(body.result.isError).toBe(true);
  expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toMatchObject({ error: { code } });
}

function primePaymentSuccess(): void {
  seedAgentAuth();
  sqlMock.mockResolvedValueOnce([merchantContext()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([cartRow()]);
  sqlMock.mockResolvedValueOnce([policy()]);
  sqlMock.mockResolvedValueOnce([agentContext()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized', provider_raw_status: 'mock_authorized' })]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([{ id: 'caud_PAYMENT_CREATED', occurred_at: NOW }]);
  sqlMock.mockResolvedValueOnce([{ id: 'caud_PAYMENT_METER', occurred_at: NOW }]);
  sqlMock.mockResolvedValueOnce([]);
}

function primePaymentDeny(policyRow: Record<string, unknown>, revocationRows: Record<string, unknown>[] = []): void {
  seedAgentAuth();
  sqlMock.mockResolvedValueOnce([merchantContext()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([cartRow()]);
  sqlMock.mockResolvedValueOnce([policyRow]);
  sqlMock.mockResolvedValueOnce([agentContext()]);
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
  sqlMock.mockResolvedValueOnce(revocationRows);
  sqlMock.mockResolvedValueOnce([{ id: 'caud_POLICY_DENY', occurred_at: NOW }]);
}

describe('POST /mcp JSON-RPC protocol', () => {
  it('initialize and tools/list expose exactly the V1 commerce tools with schemas', async () => {
    const init = await rpc('initialize');
    expect(init.statusCode).toBe(200);
    expect(init.json<{ result: { serverInfo: { name: string }; capabilities: unknown } }>().result.serverInfo.name)
      .toBe('grantex-commerce');

    const listed = await rpc('tools/list');
    expect(listed.statusCode).toBe(200);
    const tools = listed.json<{ result: { tools: Array<{ name: string; inputSchema: unknown }> } }>().result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(V1_TOOLS);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('does not expose MCP capabilities when Commerce V1 is disabled', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', 'false');

    const listed = await rpc('tools/list');

    expect(listed.statusCode).toBe(503);
    const body = listed.json<{ error: { data: { error: { code: string; retryable: boolean } } } }>();
    expect(body.error.data.error.code).toBe('commerce_disabled');
    expect(body.error.data.error.retryable).toBe(false);
  });

  it('rejects tool arguments outside the advertised input schema', async () => {
    const res = await callTool('catalog.search', {
      merchant_id: MERCHANT,
      unexpected: true,
    }, merchantHeader());

    expectToolError(res, 'validation_failed');
    const body = resultJson<{ error: { details: { fields: Record<string, string> } } }>(res);
    expect(body.error.details.fields).toMatchObject({ arguments: 'unknown argument(s): unexpected' });
  });
});

describe('commerce MCP read tools', () => {
  it('merchant.get_profile requires commerce caller auth and stays tenant scoped', async () => {
    const missing = await callTool('merchant.get_profile', { merchant_id: MERCHANT });
    expectToolError(missing, 'missing_authorization');

    seedMerchantAuth();
    sqlMock.mockResolvedValueOnce([merchantProfile()]);
    const ok = await callTool('merchant.get_profile', {}, merchantHeader());
    expect(ok.statusCode).toBe(200);
    expect(resultJson<{ data: { merchant_id: string } }>(ok).data.merchant_id).toBe(MERCHANT);
    expect(sqlMock.mock.calls.flat()).toContain(TEST_COMMERCE_TENANT_ID);
  });

  it('catalog.search enforces auth/scope and returns helper-backed search results', async () => {
    seedAgentAuth();
    const scoped = await callTool('catalog.search', { merchant_id: MERCHANT }, agentHeader());
    expectToolError(scoped, 'passport_required');

    seedMerchantAuth();
    sqlMock.mockResolvedValueOnce([catalogRow()]);
    const ok = await callTool('catalog.search', { merchant_id: MERCHANT, query: 'toaster', limit: 5 }, merchantHeader());
    expect(resultJson<{ items: Array<{ product_id: string }> }>(ok).items[0]?.product_id).toBe('TOASTER-M5B');
  });

  it('catalog.get_item enforces auth/scope and reads item detail', async () => {
    seedAgentAuth();
    const scoped = await callTool('catalog.get_item', { merchant_id: MERCHANT, product_id: 'TOASTER-M5B' }, agentHeader());
    expectToolError(scoped, 'passport_required');

    seedMerchantAuth();
    sqlMock.mockResolvedValueOnce([catalogItemProduct()]);
    sqlMock.mockResolvedValueOnce([]);
    const ok = await callTool('catalog.get_item', { merchant_id: MERCHANT, product_id: 'TOASTER-M5B' }, merchantHeader());
    expect(resultJson<{ data: { product_id: string; variants: unknown[] } }>(ok).data)
      .toMatchObject({ product_id: 'TOASTER-M5B', variants: [] });
  });

  it('inventory.check enforces auth/scope and returns availability freshness', async () => {
    seedAgentAuth();
    const scoped = await callTool('inventory.check', { merchant_id: MERCHANT, variant_ids: [VARIANT] }, agentHeader());
    expectToolError(scoped, 'passport_required');

    seedMerchantAuth();
    sqlMock.mockResolvedValueOnce([inventoryRow()]);
    const ok = await callTool('inventory.check', { merchant_id: MERCHANT, variant_ids: [VARIANT] }, merchantHeader());
    expect(resultJson<{ items: Array<{ variant_id: string; stale: boolean }> }>(ok).items[0])
      .toMatchObject({ variant_id: VARIANT, stale: false });
  });
});

describe('commerce MCP cart and payment tools', () => {
  it('cart.create requires registered agent behavior through the REST path', async () => {
    seedMerchantAuth();
    const denied = await callTool('cart.create', {
      merchant_id: MERCHANT,
      currency: 'INR',
      idempotency_key: 'mcp-cart-denied',
      line_items: [{ variant_id: VARIANT, quantity: 1 }],
    }, merchantHeader());
    expectToolError(denied, 'agent_required');
  });

  it('payment.create_intent requires checkout passport and policy allow', async () => {
    primePaymentSuccess();
    const ok = await callTool('payment.create_intent', {
      merchant_id: MERCHANT,
      cart_id: CART,
      passport_jwt: await passport(),
      amount_minor_units: 1000,
      currency: 'INR',
      provider_key: 'mock',
      idempotency_key: 'mcp-pay-ok',
    }, agentHeader());
    expect(resultJson<{ data: { payment_intent_id: string; status: string }; decision_id: string }>(ok))
      .toMatchObject({ data: { payment_intent_id: PAYMENT_INTENT, status: 'authorized' } });
  });

  it('revocation blocks MCP payment.create_intent fail-closed', async () => {
    primePaymentDeny(policy(), [{ reason: 'user_revoked' }]);
    const denied = await callTool('payment.create_intent', {
      merchant_id: MERCHANT,
      cart_id: CART,
      passport_jwt: await passport({ jti: 'cpsp_REVOKED' }),
      amount_minor_units: 1000,
      currency: 'INR',
      provider_key: 'mock',
      idempotency_key: 'mcp-pay-revoked',
    }, agentHeader());
    expectToolError(denied, 'passport_revoked');
  });

  it('emergency disable blocks MCP payment.create_intent', async () => {
    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([merchantContext()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([cartRow()]);
    sqlMock.mockResolvedValueOnce([policy({ rules: rules({ emergency_disable: true }) })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_POLICY_DENY', occurred_at: NOW }]);
    const denied = await callTool('payment.create_intent', {
      merchant_id: MERCHANT,
      cart_id: CART,
      passport_jwt: await passport(),
      amount_minor_units: 1000,
      currency: 'INR',
      provider_key: 'mock',
      idempotency_key: 'mcp-pay-emergency',
    }, agentHeader());
    expectToolError(denied, 'emergency_disabled');
  });

  it('checkout.create requires checkout passport and policy allow', async () => {
    const missing = await callTool('checkout.create', {
      payment_intent_id: PAYMENT_INTENT,
      success_url: 'https://merchant.example/success',
      cancel_url: 'https://merchant.example/cancel',
      idempotency_key: 'mcp-checkout-missing-passport',
    }, agentHeader());
    expectToolError(missing, 'validation_failed');

    seedAgentAuth();
    const base = paymentIntentRow({ status: 'authorized' });
    sqlMock.mockResolvedValueOnce([base]);
    sqlMock.mockResolvedValueOnce([policy()]);
    sqlMock.mockResolvedValueOnce([{ public_key_jwk: publicJwk, retired_at: null }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([agentContext()]);
    sqlMock.mockResolvedValueOnce([]);
    const checkoutCreated = {
      ...base,
      status: 'checkout_created',
      checkout_url: `https://mock-payments.grantex.local/checkout/${PAYMENT_INTENT}`,
      checkout_expires_at: new Date(Date.now() + 900_000).toISOString(),
      provider_raw_status: 'mock_checkout_created',
    };
    sqlMock.mockResolvedValueOnce([checkoutCreated]);
    sqlMock.mockResolvedValueOnce([{ ...checkoutCreated, status: 'payment_pending' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CHECKOUT_CREATED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([]);

    const ok = await callTool('checkout.create', {
      payment_intent_id: PAYMENT_INTENT,
      passport_jwt: await passport({ scopes: ['commerce:checkout.create'] }),
      success_url: 'https://merchant.example/success',
      cancel_url: 'https://merchant.example/cancel',
      idempotency_key: 'mcp-checkout-ok',
    }, agentHeader());
    expect(resultJson<{ data: { payment_intent_id: string; status: string; checkout_url: string } }>(ok).data)
      .toMatchObject({ payment_intent_id: PAYMENT_INTENT, status: 'payment_pending' });
  });

  it('payment.get_status works for merchant, requires agent scope, and denies operator callers', async () => {
    seedMerchantAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'payment_pending' })]);
    const merchantOk = await callTool('payment.get_status', { payment_intent_id: PAYMENT_INTENT }, merchantHeader());
    expect(resultJson<{ data: { status: string } }>(merchantOk).data.status).toBe('payment_pending');

    seedAgentAuth();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'payment_pending' })]);
    const agentDenied = await callTool('payment.get_status', { payment_intent_id: PAYMENT_INTENT }, agentHeader());
    expectToolError(agentDenied, 'passport_required');

    seedCommerceContext();
    const operatorDenied = await callTool('payment.get_status', { payment_intent_id: PAYMENT_INTENT }, authHeader());
    expectToolError(operatorDenied, 'caller_not_authorized');
  });
});

describe('M5B OpenAPI contract', () => {
  it('marks /mcp implemented for JSON-RPC tool calls', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const start = content.indexOf('/mcp:');
    expect(start).toBeGreaterThan(-1);
    const block = content.slice(start, content.indexOf('\n  /', start + 6));
    expect(block).toMatch(/operationId:\s*commerceMcpJsonRpc/);
    expect(block).toMatch(/x-implemented:\s*true/);
    expect(block).toContain('tools/call');
  });
});
