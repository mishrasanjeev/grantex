import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import {
  MockPaymentProvider,
  PluralPaymentProvider,
  isPaymentProviderError,
} from '../src/lib/commerce/payment-providers/index.js';
import {
  assertPaymentStatusTransition,
  canTransitionPaymentStatus,
} from '../src/lib/commerce/payment-state.js';
import {
  beginCommerceIdempotency,
  hashRequestBody,
} from '../src/lib/commerce/idempotency.js';

let app: FastifyInstance;

const MERCHANT = 'mch_PAYFOUND';
const CREDENTIAL = 'cpc_PAYFOUND';
const RAW_SECRET = 'raw-provider-secret-123';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');

beforeAll(async () => {
  app = await buildTestApp();
});

function credentialRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREDENTIAL,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    provider_key: 'mock',
    environment: 'sandbox',
    credential_ref: 'cref_TEST',
    secret_version: 1,
    status: 'pending',
    last_validated_at: null,
    last_validation_error: null,
    capabilities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    rotated_at: null,
    ...overrides,
  };
}

function createPayload(secret: string = RAW_SECRET): Record<string, unknown> {
  return {
    merchant_id: MERCHANT,
    provider_key: 'mock',
    environment: 'sandbox',
    credential_payload: {
      api_key: secret,
      merchant_ref: 'mock-merchant',
    },
  };
}

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

describe('Payment provider adapters', () => {
  it('MockPaymentProvider creates deterministic payment intents', async () => {
    const provider = new MockPaymentProvider();
    const result = await provider.createPaymentIntent({
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      agent_id: 'cag_TEST',
      payment_intent_id: 'cpi_TEST',
      cart_id: 'cart_TEST',
      passport_jti: 'cpsp_TEST',
      amount: { amount_minor_units: 1234, currency: 'INR' },
      line_items_snapshot: [],
      idempotency_key: 'idem_TEST',
      environment: 'sandbox',
      metadata: {},
    });

    expect(result).toMatchObject({
      provider_payment_id: 'mock_pay_cpi_TEST',
      provider_order_id: 'mock_order_cpi_TEST',
      status: 'created',
      raw_status: 'mock_created',
    });
  });

  it('MockPaymentProvider normalizes decline and timeout paths', async () => {
    const provider = new MockPaymentProvider();
    await expect(provider.createPaymentIntent({
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      agent_id: 'cag_TEST',
      payment_intent_id: 'cpi_DECLINE',
      cart_id: 'cart_TEST',
      passport_jti: 'cpsp_TEST',
      amount: { amount_minor_units: 1234, currency: 'INR' },
      line_items_snapshot: [],
      idempotency_key: 'idem_TEST',
      environment: 'sandbox',
      metadata: { mock_outcome: 'decline' },
    })).rejects.toSatisfy((err: unknown) =>
      isPaymentProviderError(err)
      && err.normalized.code === 'payment_declined'
      && err.normalized.retryable === false);

    await expect(provider.createPaymentIntent({
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      agent_id: 'cag_TEST',
      payment_intent_id: 'cpi_TIMEOUT',
      cart_id: 'cart_TEST',
      passport_jti: 'cpsp_TEST',
      amount: { amount_minor_units: 1234, currency: 'INR' },
      line_items_snapshot: [],
      idempotency_key: 'idem_TEST',
      environment: 'sandbox',
      metadata: { mock_outcome: 'timeout' },
    })).rejects.toSatisfy((err: unknown) =>
      isPaymentProviderError(err)
      && err.normalized.code === 'provider_timeout'
      && err.normalized.retryable === true);
  });

  it('PluralPaymentProvider reports explicit blocked configuration without raw provider errors', async () => {
    const provider = new PluralPaymentProvider();
    const validation = await provider.validateCredentials({
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      environment: 'sandbox',
      credential_ref: 'cref_TEST',
    });

    expect(validation.valid).toBe(false);
    expect(validation.error).toMatchObject({
      code: 'provider_validation_failed',
      provider_key: 'plural',
      retryable: false,
    });
    expect(validation.error.provider_error_code).toMatch(/plural_.*blocked|plural_api_contract_unconfirmed/);
    expect(validation.error.safe_metadata).toMatchObject({
      api_contract_confirmed: false,
      webhook_signature_confirmed: false,
    });
  });
});

describe('Provider credential APIs', () => {
  it('creates encrypted provider credentials and never returns or audits raw credentials', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([credentialRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CRED_CREATE', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/provider-credentials',
      headers: authHeader(),
      payload: createPayload(),
    });

    expect(res.statusCode).toBe(201);
    const bodyText = res.body;
    expect(bodyText).not.toContain(RAW_SECRET);
    expect(bodyText).not.toContain('encrypted_secret_blob');
    expect(res.json<{ data: { id: string; credential_ref: string }; audit_event_id: string }>())
      .toMatchObject({ data: { id: CREDENTIAL, credential_ref: 'cref_TEST' }, audit_event_id: 'caud_CRED_CREATE' });

    expect(flattenedSqlCalls()).not.toContain(RAW_SECRET);
    const insertCall = sqlMock.mock.calls.find((call) => {
      const tpl = call[0] as unknown;
      return Array.isArray(tpl) && tpl.some((s) =>
        typeof s === 'string' && /INSERT INTO commerce_provider_credentials/i.test(s));
    });
    expect(insertCall).toBeDefined();
    expect(insertCall!.slice(1).some((v) => typeof v === 'string' && v.length > 32)).toBe(true);
  });

  it('lists provider credential metadata without encrypted or raw credentials', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([credentialRow()]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/provider-credentials?merchant_id=${MERCHANT}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('encrypted_secret_blob');
    expect(res.body).not.toContain(RAW_SECRET);
    expect(res.json<{ items: Array<{ id: string }> }>().items[0]?.id).toBe(CREDENTIAL);
  });

  it('patches replacement credential payload without returning or auditing raw credentials', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([credentialRow()]);
    sqlMock.mockResolvedValueOnce([credentialRow({ secret_version: 2, status: 'pending', rotated_at: new Date().toISOString() })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CRED_PATCH', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/provider-credentials/${CREDENTIAL}`,
      headers: authHeader(),
      payload: { credential_payload: { api_key: RAW_SECRET, merchant_ref: 'rotated' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(RAW_SECRET);
    expect(res.body).not.toContain('encrypted_secret_blob');
    expect(flattenedSqlCalls()).not.toContain(RAW_SECRET);
    expect(res.json<{ data: { secret_version: number; status: string } }>().data)
      .toMatchObject({ secret_version: 2, status: 'pending' });
  });

  it('validates mock credentials and stores only safe validation metadata', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([credentialRow({ encrypted_secret_blob: 'ciphertext' })]);
    sqlMock.mockResolvedValueOnce([credentialRow({
      status: 'valid',
      capabilities: ['payment_intent.create', 'checkout_link.create', 'payment_status.read'],
      last_validated_at: new Date().toISOString(),
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CRED_VALIDATE', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/provider-credentials/${CREDENTIAL}/validate`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string; validation: { valid: boolean; capabilities: string[] } } }>();
    expect(body.data.status).toBe('valid');
    expect(body.data.validation.valid).toBe(true);
    expect(body.data.validation.capabilities).toContain('payment_intent.create');
    expect(res.body).not.toContain('ciphertext');
    expect(res.body).not.toContain(RAW_SECRET);
  });

  it('validates plural credentials as explicitly blocked when API details are absent', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([credentialRow({
      provider_key: 'plural',
      encrypted_secret_blob: 'ciphertext',
    })]);
    sqlMock.mockResolvedValueOnce([credentialRow({
      provider_key: 'plural',
      status: 'invalid',
      last_validation_error: {
        code: 'provider_validation_failed',
        provider_key: 'plural',
        retryable: false,
        provider_error_code: 'plural_sandbox_blocked',
      },
      last_validated_at: new Date().toISOString(),
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PLURAL_VALIDATE', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/provider-credentials/${CREDENTIAL}/validate`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string; validation: { valid: boolean; error: { provider_error_code: string } } } }>();
    expect(body.data.status).toBe('invalid');
    expect(body.data.validation.valid).toBe(false);
    expect(body.data.validation.error.provider_error_code).toMatch(/plural_/);
  });
});

describe('Payment state machine', () => {
  it('allows only specified forward transitions', () => {
    expect(canTransitionPaymentStatus('created', 'authorized')).toBe(true);
    expect(canTransitionPaymentStatus('authorized', 'checkout_created')).toBe(true);
    expect(canTransitionPaymentStatus('checkout_created', 'payment_pending')).toBe(true);
    expect(canTransitionPaymentStatus('payment_pending', 'paid')).toBe(true);
    expect(canTransitionPaymentStatus('payment_pending', 'failed')).toBe(true);
    expect(canTransitionPaymentStatus('payment_pending', 'expired')).toBe(true);
    expect(canTransitionPaymentStatus('created', 'cancelled')).toBe(true);
    expect(canTransitionPaymentStatus('checkout_created', 'cancelled')).toBe(true);
  });

  it('rejects invalid payment state transitions', () => {
    expect(canTransitionPaymentStatus('created', 'paid')).toBe(false);
    expect(canTransitionPaymentStatus('paid', 'failed')).toBe(false);
    expect(() => assertPaymentStatusTransition('created', 'paid')).toThrow(/Invalid payment status transition/);
  });
});

describe('Commerce idempotency helper', () => {
  it('replays the original response for same key and same body', async () => {
    const body = { amount: 1000, currency: 'INR' };
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_REPLAY',
      request_body_hash: hashRequestBody(body),
      response_status: 201,
      response_body: { data: { id: 'cpi_EXISTING' } },
    }]);

    const result = await beginCommerceIdempotency(sqlMock as unknown as never, {
      tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: MERCHANT,
      endpoint: 'POST /v1/commerce/payments/intents',
      environment: 'sandbox',
      idempotencyKey: 'idem-key',
      requestBody: body,
    });

    expect(result).toEqual({
      kind: 'replay',
      recordId: 'cidm_REPLAY',
      statusCode: 201,
      responseBody: { data: { id: 'cpi_EXISTING' } },
    });
  });

  it('returns conflict for same key and different body', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cidm_CONFLICT',
      request_body_hash: hashRequestBody({ amount: 1000, currency: 'INR' }),
      response_status: 201,
      response_body: { data: { id: 'cpi_EXISTING' } },
    }]);

    const result = await beginCommerceIdempotency(sqlMock as unknown as never, {
      tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: MERCHANT,
      endpoint: 'POST /v1/commerce/payments/intents',
      environment: 'sandbox',
      idempotencyKey: 'idem-key',
      requestBody: { amount: 2000, currency: 'INR' },
    });

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.recordId).toBe('cidm_CONFLICT');
      expect(result.expectedBodyHash).not.toBe(result.actualBodyHash);
    }
  });
});

describe('M4A payment foundation migration', () => {
  it('adds provider credential and idempotency tables without provider-specific columns', () => {
    const migration = readFileSync(
      join(TEST_DIR, '../src/db/migrations/044_commerce_payment_foundations.sql'),
      'utf8',
    );
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_provider_credentials/);
    expect(migration).toMatch(/encrypted_secret_blob/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS commerce_idempotency_records/);
    expect(migration).toMatch(/uq_commerce_idempotency_scope/);

    const uncommented = migration
      .split(/\r?\n/)
      .map((line) => line.replace(/--[^\r\n]*/, ''))
      .join('\n')
      .toLowerCase();
    expect(uncommented).not.toMatch(/plural_/);
  });
});

describe('M4A OpenAPI provider credential contract', () => {
  function pathBlock(path: string): string {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const start = content.indexOf(`  ${path}:`);
    expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
    const after = content.slice(start);
    const next = after.slice(1).search(/\n {2}\/[A-Za-z0-9{]/);
    return next === -1 ? after : after.slice(0, next + 1);
  }

  it('marks provider credential routes implemented with safe metadata schemas', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    expect(content).toMatch(/ProviderCredential:\s*\n[\s\S]*Raw credential payloads and encrypted[\s\S]*never returned/);
    expect(content).toMatch(/CreateProviderCredentialRequest:\s*\n[\s\S]*credential_payload:/);
    expect(content).not.toMatch(/encrypted_secret_blob:\s*\{/);

    for (const route of [
      '/v1/commerce/provider-credentials',
      '/v1/commerce/provider-credentials/{credential_id}',
      '/v1/commerce/provider-credentials/{credential_id}/validate',
    ]) {
      const block = pathBlock(route);
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M4A/);
    }
  });
});
