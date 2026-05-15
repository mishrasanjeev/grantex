import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { encrypt } from '../src/lib/vault-crypto.js';
import { sha256hex } from '../src/lib/hash.js';
import { stableJson } from '../src/lib/commerce/idempotency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapiPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const migrationPath = join(__dirname, '../src/db/migrations/049_commerce_merchant_webhooks.sql');
const MERCHANT = 'mch_M12C';
const SOURCE = 'erp_sync';
const PRODUCT = 'cprd_M12C';
const VARIANT = 'cvar_M12C';
const NOW = new Date().toISOString();
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'm12cccccccccccccccccccccccccccc'].join('_');
const AGENT_TOKEN = ['grtx', 'agent', 'M12CXXXXXXXXXXXXXXXXXXXXXXXX'].join('_');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function bearer(token: string): Record<string, string> {
  return { authorization: ['Bearer', token].join(' ') };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_M12C',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
}

function seedAgentCaller(agentId = 'cag_M12C'): void {
  sqlMock.mockResolvedValueOnce([{
    id: agentId,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'sha256:test',
    tenant_status: 'active',
  }]);
}

function sourceMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    source_key: SOURCE,
    display_name: 'ERP Sync',
    status: 'active',
    secret_last_rotated_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function sourceRow(signingKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...sourceMetadata(),
    secret_hash: sha256hex(signingKey),
    encrypted_secret: encrypt(signingKey),
    ...overrides,
  };
}

function merchantWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt_M12C_VALID',
    event_type: 'catalog.product.updated',
    occurred_at: NOW,
    product: {
      product_id: 'TOASTER-M12C',
      title: 'Webhook Toaster',
      brand: 'Acme',
      category_preset: 'electronics_appliances',
      variants: [{
        sku: 'TOASTER-M12C-WHITE',
        variant_title: 'White',
        price_amount: 275000,
        currency: 'INR',
        tax_inclusive: true,
        gst_slab: '18',
        tax_rate: 0.18,
        hsn_code: '8516',
        availability_status: 'in_stock',
        warranty_summary: '1 year',
        return_policy_summary: '7 day replacement',
      }],
    },
    ...overrides,
  };
}

function runtimeSigningKey(): string {
  return randomBytes(32).toString('base64url');
}

function signedHeaders(
  payload: Record<string, unknown>,
  signingKey: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const rawBody = stableJson(payload);
  const signature = createHmac('sha256', signingKey)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return {
    'x-grantex-merchant-timestamp': String(timestamp),
    'x-grantex-merchant-signature': `v1=${signature}`,
  };
}

function sqlText(): string {
  return sqlMock.mock.calls
    .map((call) => {
      const tpl = call[0] as unknown;
      return Array.isArray(tpl) ? tpl.join(' ') : '';
    })
    .join('\n');
}

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

function countSql(pattern: RegExp): number {
  return sqlText().split('\n').filter((text) => pattern.test(text)).length;
}

function pathBlock(path: string): string {
  const content = readFileSync(openapiPath, 'utf8');
  const start = content.indexOf(`  ${path}:`);
  expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
  const after = content.slice(start + path.length + 3);
  const next = after.search(/\n {2}\/[A-Za-z0-9{.]/);
  return next === -1 ? after : after.slice(0, next);
}

describe('M12C webhook source management APIs', () => {
  it('creates a source with one-time secret and safe metadata', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([sourceMetadata()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_SOURCE_CREATED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhook-sources',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, source_key: SOURCE, display_name: 'ERP Sync' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string }>();
    expect(body.data.source_key).toBe(SOURCE);
    expect(typeof body.data.webhook_secret).toBe('string');
    expect(body.data.secret_hash).toBeUndefined();
    expect(body.data.encrypted_secret).toBeUndefined();
    expect(body.audit_event_id).toBe('caud_WEBHOOK_SOURCE_CREATED');
    expect(flattenedSqlCalls()).toContain('webhook_source.created');
    expect(flattenedSqlCalls()).not.toContain(body.data.webhook_secret as string);
  });

  it('lists webhook source metadata without secret-bearing fields for a merchant caller', async () => {
    seedMerchantCaller();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([sourceMetadata()]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/webhook-sources',
      headers: bearer(MERCHANT_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    const item = res.json<{ items: Array<Record<string, unknown>> }>().items[0]!;
    expect(item.source_key).toBe(SOURCE);
    expect(item.webhook_secret).toBeUndefined();
    expect(item.secret_hash).toBeUndefined();
    expect(item.encrypted_secret).toBeUndefined();
  });

  it('patches display_name/status and audits changed fields only', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([sourceMetadata({ display_name: 'ERP Sync v2', status: 'disabled' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_SOURCE_UPDATED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/webhook-sources/${SOURCE}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: { display_name: 'ERP Sync v2', status: 'disabled' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown>; audit_event_id: string }>().audit_event_id)
      .toBe('caud_WEBHOOK_SOURCE_UPDATED');
    expect(flattenedSqlCalls()).toContain('webhook_source.updated');
    expect(flattenedSqlCalls()).toContain('changed_fields');
  });

  it('rejects immutable and sensitive source patch fields', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/webhook-sources/${SOURCE}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        source_key: SOURCE,
        secret: 'redacted',
        secret_hash: 'redacted',
        created_at: NOW,
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('merchant_id');
    expect(fields.unsupported_fields).toContain('source_key');
    expect(fields.unsupported_fields).toContain('secret');
    expect(fields.unsupported_fields).toContain('secret_hash');
    expect(fields.unsupported_fields).toContain('created_at');
  });

  it('rotates a source secret once and never exposes previous material', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([sourceMetadata({ secret_last_rotated_at: NOW })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_SOURCE_ROTATED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/webhook-sources/${SOURCE}/rotate-secret`,
      headers: authHeader(),
      payload: { merchant_id: MERCHANT },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string }>();
    expect(typeof body.data.webhook_secret).toBe('string');
    expect(body.data.secret_hash).toBeUndefined();
    expect(body.data.encrypted_secret).toBeUndefined();
    expect(body.audit_event_id).toBe('caud_WEBHOOK_SOURCE_ROTATED');
    expect(flattenedSqlCalls()).toContain('webhook_source.secret_rotated');
    expect(flattenedSqlCalls()).not.toContain(body.data.webhook_secret as string);
  });

  it('denies CommerceAgent callers and blocks duplicate/cross-tenant sources', async () => {
    seedAgentCaller();
    const agentRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhook-sources',
      headers: bearer(AGENT_TOKEN),
      payload: { merchant_id: MERCHANT, source_key: SOURCE, display_name: 'ERP Sync' },
    });
    expect(agentRes.statusCode).toBe(403);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([{ source_key: SOURCE }]);
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhook-sources',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, source_key: SOURCE, display_name: 'ERP Sync' },
    });
    expect(duplicateRes.statusCode).toBe(409);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);
    const missingMerchantRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhook-sources',
      headers: authHeader(),
      payload: { merchant_id: 'mch_OTHER', source_key: SOURCE, display_name: 'ERP Sync' },
    });
    expect(missingMerchantRes.statusCode).toBe(404);
  });
});

describe('M12C signed inbound merchant webhook', () => {
  it('valid signed catalog.product.updated upserts product and variants with audit', async () => {
    const signingKey = runtimeSigningKey();
    const payload = merchantWebhookPayload();
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_M12C_VALID' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_MERCHANT_WEBHOOK_RECEIVED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT }]);
    sqlMock.mockResolvedValueOnce([{ id: VARIANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CATALOG_UPDATED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(payload, signingKey),
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown>; received_audit_event_id: string; audit_event_id: string }>();
    expect(body.data.status).toBe('processed');
    expect(body.data.product_id).toBe('TOASTER-M12C');
    expect(body.received_audit_event_id).toBe('caud_MERCHANT_WEBHOOK_RECEIVED');
    expect(body.audit_event_id).toBe('caud_CATALOG_UPDATED');
    expect(sqlText()).toMatch(/INSERT INTO commerce_products/i);
    expect(sqlText()).toMatch(/INSERT INTO commerce_product_variants/i);
    expect(flattenedSqlCalls()).toContain('merchant_webhook.received');
    expect(flattenedSqlCalls()).toContain('catalog.product.updated');
    expect(flattenedSqlCalls()).not.toContain(signingKey);
  });

  it('rejects unsigned invalid and stale signed webhooks without catalog mutation', async () => {
    const signingKey = runtimeSigningKey();
    const payload = merchantWebhookPayload({ event_id: 'evt_M12C_UNSIGNED' });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_UNSIGNED' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_SIGNATURE_MISSING', occurred_at: NOW }]);

    const unsignedRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      payload,
    });
    expect(unsignedRes.statusCode).toBe(401);
    expect(flattenedSqlCalls()).toContain('merchant_webhook.signature_failed');
    expect(countSql(/INSERT INTO commerce_products/i)).toBe(0);

    const badKey = runtimeSigningKey();
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_BAD_SIGNATURE' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_SIGNATURE_BAD', occurred_at: NOW }]);
    const invalidRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders({ ...payload, event_id: 'evt_M12C_BAD_SIG' }, badKey),
      payload: { ...payload, event_id: 'evt_M12C_BAD_SIG' },
    });
    expect(invalidRes.statusCode).toBe(401);

    const stalePayload = { ...payload, event_id: 'evt_M12C_STALE' };
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_STALE' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_STALE', occurred_at: NOW }]);
    const staleRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(stalePayload, signingKey, Math.floor(Date.now() / 1000) - 3600),
      payload: stalePayload,
    });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json<{ error: { code: string } }>().error.code).toBe('webhook_replay_detected');
  });

  it('accepts duplicate event IDs idempotently without another product update', async () => {
    const signingKey = runtimeSigningKey();
    const payload = merchantWebhookPayload({ event_id: 'evt_M12C_DUP' });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_DUP', processing_status: 'processed' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(payload, signingKey),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data.status).toBe('duplicate');
    expect(countSql(/INSERT INTO commerce_products/i)).toBe(0);
    expect(countSql(/UPDATE commerce_product_variants/i)).toBe(0);
  });

  it('rejects disabled source unsupported event type malformed schema and missing source', async () => {
    const signingKey = runtimeSigningKey();
    const disabledPayload = merchantWebhookPayload({ event_id: 'evt_M12C_DISABLED' });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey, { status: 'disabled' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_DISABLED' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_DISABLED', occurred_at: NOW }]);

    const disabledRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(disabledPayload, signingKey),
      payload: disabledPayload,
    });
    expect(disabledRes.statusCode).toBe(403);

    const unsupportedPayload = merchantWebhookPayload({
      event_id: 'evt_M12C_UNSUPPORTED',
      event_type: 'catalog.product.deleted',
    });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_UNSUPPORTED' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_UNSUPPORTED', occurred_at: NOW }]);
    const unsupportedRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(unsupportedPayload, signingKey),
      payload: unsupportedPayload,
    });
    expect(unsupportedRes.statusCode).toBe(422);
    expect(unsupportedRes.json<{ error: { code: string } }>().error.code).toBe('unsupported_merchant_webhook_event');

    const malformedPayload = merchantWebhookPayload({
      event_id: 'evt_M12C_MALFORMED',
      product: { product_id: 'BAD', title: 'Bad', category_preset: 'fashion_lifestyle', variants: [] },
    });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_MALFORMED' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_MALFORMED', occurred_at: NOW }]);
    const malformedRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(malformedPayload, signingKey),
      payload: malformedPayload,
    });
    expect(malformedRes.statusCode).toBe(422);
    expect(malformedRes.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('product.variants');

    sqlMock.mockResolvedValueOnce([]);
    const missingSourceRes = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/missing_source`,
      payload: merchantWebhookPayload({ event_id: 'evt_M12C_MISSING_SOURCE' }),
    });
    expect(missingSourceRes.statusCode).toBe(404);
  });

  it('rotated source material rejects signatures made with the old key', async () => {
    const oldKey = runtimeSigningKey();
    const rotatedKey = runtimeSigningKey();
    const payload = merchantWebhookPayload({ event_id: 'evt_M12C_OLD_KEY' });
    sqlMock.mockResolvedValueOnce([sourceRow(rotatedKey)]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_OLD_KEY' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_OLD_KEY_REJECTED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(payload, oldKey),
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('webhook_signature_invalid');
  });

  it('price webhook update does not mutate active cart or payment snapshots', async () => {
    const signingKey = runtimeSigningKey();
    const payload = merchantWebhookPayload({
      event_id: 'evt_M12C_PRICE_PATCH',
      product: {
        product_id: 'TOASTER-M12C',
        title: 'Webhook Toaster',
        category_preset: 'electronics_appliances',
        variants: [{ sku: 'TOASTER-M12C-WHITE', price_amount: 375000, currency: 'INR' }],
      },
    });
    sqlMock.mockResolvedValueOnce([sourceRow(signingKey)]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_PRICE_PATCH' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_RECEIVED_PRICE_PATCH', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT }]);
    sqlMock.mockResolvedValueOnce([{ id: VARIANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CATALOG_PRICE_PATCH', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/merchant/${MERCHANT}/${SOURCE}`,
      headers: signedHeaders(payload, signingKey),
      payload,
    });

    expect(res.statusCode).toBe(200);
    const text = sqlText();
    expect(text).toMatch(/INSERT INTO commerce_product_variants/i);
    expect(text).not.toMatch(/UPDATE commerce_carts/i);
    expect(text).not.toMatch(/UPDATE commerce_payment_intents/i);
    expect(text).not.toMatch(/line_items_snapshot\s*=/i);
  });
});

describe('M12C schema and OpenAPI drift guards', () => {
  it('adds metadata-only merchant webhook persistence', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('commerce_webhook_sources');
    expect(migration).toContain('commerce_merchant_webhook_events');
    expect(migration).toContain('encrypted_secret');
    expect(migration).toContain('secret_hash');
    expect(migration).toContain('payload_hash');
    expect(migration).toContain('uq_merchant_webhook_source_event');
    expect(migration).not.toContain('raw_payload JSONB');
  });

  it('marks webhook source and merchant webhook routes implemented', () => {
    expect(pathBlock('/v1/commerce/webhook-sources'))
      .toMatch(/post:[\s\S]*operationId:\s*createWebhookSource[\s\S]*x-implemented:\s*true[\s\S]*get:[\s\S]*operationId:\s*listWebhookSources[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/webhook-sources/{source_key}'))
      .toMatch(/patch:[\s\S]*operationId:\s*updateWebhookSource[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/webhook-sources/{source_key}/rotate-secret'))
      .toMatch(/post:[\s\S]*operationId:\s*rotateWebhookSourceSecret[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/webhooks/merchant/{merchant_id}/{source_key}'))
      .toMatch(/post:[\s\S]*operationId:\s*handleMerchantCatalogWebhook[\s\S]*x-implemented:\s*true/);
  });
});
