import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapiPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'm12bbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('_');
const AGENT_TOKEN = ['grtx', 'agent', 'M12BXXXXXXXXXXXXXXXXXXXXXXXX'].join('_');
const MERCHANT = 'mch_M12B';
const PRODUCT = 'cprd_M12B';
const VARIANT = 'cvar_M12B';
const NOW = new Date().toISOString();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_M12B',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
}

function seedAgentCaller(agentId = 'cag_M12B'): void {
  sqlMock.mockResolvedValueOnce([{
    id: agentId,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'sha256:test',
    tenant_status: 'active',
  }]);
}

function bearer(token: string): Record<string, string> {
  return { authorization: ['Bearer', token].join(' ') };
}

function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRODUCT,
    product_id: 'TOASTER-V2',
    merchant_id: MERCHANT,
    title: 'Acme Pop-Up Toaster',
    brand: 'Acme',
    image_url: 'https://cdn.example.test/toaster.png',
    category_preset: 'electronics_appliances',
    updated_at: NOW,
    variant_id: VARIANT,
    sku: 'TOASTER-V2-WHITE',
    variant_title: 'White',
    model: 'T100',
    price_amount: 250000,
    currency: 'INR',
    availability_status: 'in_stock',
    last_synced_at: NOW,
    ...overrides,
  };
}

function productDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRODUCT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    product_id: 'TOASTER-V2',
    title: 'Acme Pop-Up Toaster Pro',
    brand: 'Acme',
    description: '4-slice toaster',
    image_url: 'https://cdn.example.test/toaster.png',
    category_preset: 'electronics_appliances',
    source_system: 'manual',
    manually_maintained: true,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function variantDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VARIANT,
    sku: 'TOASTER-V2-WHITE',
    parent_sku: null,
    model: 'T100',
    variant_title: 'White',
    attributes: { color: 'white' },
    price_amount: 300000,
    currency: 'INR',
    tax_inclusive: true,
    gst_slab: '18',
    tax_rate: '0.18',
    hsn_code: '8516',
    availability_status: 'in_stock',
    warranty_summary: '1 year',
    return_policy_summary: '7 day replacement',
    source_system: 'manual',
    last_synced_at: NOW,
    archived_at: null,
    ...overrides,
  };
}

function bulkProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    merchant_id: MERCHANT,
    product_id: 'TOASTER-V2',
    title: 'Acme Pop-Up Toaster',
    category_preset: 'electronics_appliances',
    brand: 'Acme',
    variants: [{
      sku: 'TOASTER-V2-WHITE',
      price_amount: 250000,
      currency: 'INR',
      tax_inclusive: true,
      availability_status: 'in_stock',
    }],
    ...overrides,
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

function findAuditCall(eventType: string): unknown[] | undefined {
  return sqlMock.mock.calls.find((call) => {
    const tpl = call[0] as unknown;
    const text = Array.isArray(tpl) ? tpl.join(' ') : '';
    return /INSERT INTO commerce_audit_events/i.test(text) && call.slice(1).includes(eventType);
  });
}

describe('M12B GET /v1/commerce/catalog/products', () => {
  it('lists product summaries for an operator scoped to a merchant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([catalogRow()]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/catalog/products?merchant_id=${MERCHANT}&limit=10`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; variants_summary: unknown[] }>; next_cursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(PRODUCT);
    expect(body.items[0]!.variants_summary).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });

  it('lists a merchant caller own catalog without accepting a cross-merchant selector', async () => {
    seedMerchantCaller(MERCHANT);
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([catalogRow()]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/catalog/products',
      headers: bearer(MERCHANT_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: Array<{ merchant_id: string }> }>().items[0]!.merchant_id).toBe(MERCHANT);
  });

  it('excludes archived products by default', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/catalog/products?merchant_id=${MERCHANT}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(sqlText()).toContain('p.archived_at IS NULL');
  });

  it('returns 404 when merchant scope is not in the caller tenant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/catalog/products?merchant_id=mch_OTHER',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });
});

describe('M12B PATCH /v1/commerce/catalog/products/:productId', () => {
  it('patches product and variant allowlisted fields with product.updated audit', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT, merchant_id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: VARIANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([productDetail()]);
    sqlMock.mockResolvedValueOnce([variantDetail()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PRODUCT_UPDATED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: {
        title: 'Acme Pop-Up Toaster Pro',
        variants: [{ variant_id: VARIANT, price_amount: 300000, currency: 'INR' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; variants: Array<{ id: string; price_amount: number }> }; audit_event_id: string }>();
    expect(body.data.id).toBe(PRODUCT);
    expect(body.data.variants[0]!.id).toBe(VARIANT);
    expect(body.audit_event_id).toBe('caud_PRODUCT_UPDATED');
    const auditCall = findAuditCall('product.updated');
    expect(auditCall).toBeDefined();
    const metadata = auditCall?.find((value) => typeof value === 'string' && value.includes('changed_fields')) as string;
    expect(metadata).toContain('title');
    expect(metadata).toContain('variants.price_amount');
    expect(metadata).not.toContain('300000');
  });

  it('rejects unknown immutable and sensitive product patch keys', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: {
        id: PRODUCT,
        tenant_id: TEST_COMMERCE_TENANT_ID,
        merchant_id: MERCHANT,
        provider_payment_id: 'pay_123',
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('id');
    expect(fields.unsupported_fields).toContain('tenant_id');
    expect(fields.unsupported_fields).toContain('merchant_id');
    expect(fields.unsupported_fields).toContain('provider_payment_id');
  });

  it('rejects invalid price and currency patches', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: {
        variants: [{ variant_id: VARIANT, price_amount: -1, currency: 'inr' }],
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields).toHaveProperty('variants[0].price_amount');
    expect(fields).toHaveProperty('variants[0].currency');
  });

  it('rejects a variant that does not belong to the product', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT, merchant_id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: { variants: [{ variant_id: 'cvar_OTHER', price_amount: 300000 }] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('variants[0].variant_id');
  });

  it('denies CommerceAgent callers on product patch', async () => {
    seedAgentCaller();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: bearer(AGENT_TOKEN),
      payload: { title: 'Agent Cannot Patch Catalog' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('does not mutate active cart or payment intent snapshots when price changes', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT, merchant_id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: VARIANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([productDetail()]);
    sqlMock.mockResolvedValueOnce([variantDetail({ price_amount: 350000 })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PRICE_PATCH', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/catalog/products/${PRODUCT}?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: { variants: [{ variant_id: VARIANT, price_amount: 350000 }] },
    });

    expect(res.statusCode).toBe(200);
    const text = sqlText();
    expect(text).toMatch(/UPDATE commerce_product_variants/);
    expect(text).not.toMatch(/UPDATE commerce_carts/i);
    expect(text).not.toMatch(/UPDATE commerce_payment_intents/i);
    expect(text).not.toMatch(/line_items_snapshot\s*=/i);
  });
});

describe('M12B POST /v1/commerce/catalog/products/bulk', () => {
  it('dry-runs valid rows and writes nothing by default', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products/bulk',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, products: [bulkProduct()] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ dry_run: boolean; summary: { valid: number; invalid: number } }>();
    expect(body.dry_run).toBe(true);
    expect(body.summary.valid).toBe(1);
    expect(body.summary.invalid).toBe(0);
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it('writes valid rows transactionally when dry_run is false and audits counts only', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([{ id: PRODUCT }]);
    sqlMock.mockResolvedValueOnce([{ id: VARIANT }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_BULK', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products/bulk',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, dry_run: false, products: [bulkProduct()] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ dry_run: boolean; rows: Array<{ status: string }>; audit_event_id: string }>();
    expect(body.dry_run).toBe(false);
    expect(body.rows[0]!.status).toBe('upserted');
    expect(body.audit_event_id).toBe('caud_BULK');
    const auditCall = findAuditCall('catalog.bulk_ingested');
    expect(auditCall).toBeDefined();
    const metadata = auditCall?.find((value) => typeof value === 'string' && value.includes('product_count')) as string;
    expect(metadata).toContain('product_count');
    expect(metadata).not.toContain('Acme Pop-Up Toaster');
  });

  it('reports per-row validation errors in dry-run mode', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products/bulk',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        products: [bulkProduct({
          category_preset: 'fashion_lifestyle',
          variants: [{ sku: 'BAD', price_amount: -1, currency: 'inr' }],
        })],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ summary: { invalid: number }; rows: Array<{ status: string; field_errors: Record<string, string> }> }>();
    expect(body.summary.invalid).toBe(1);
    expect(body.rows[0]!.status).toBe('invalid');
    expect(body.rows[0]!.field_errors).toHaveProperty('category_preset');
    expect(body.rows[0]!.field_errors).toHaveProperty('variants[0].price_amount');
  });

  it('rejects merchant caller attempts to override merchant scope', async () => {
    seedMerchantCaller(MERCHANT);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products/bulk',
      headers: bearer(MERCHANT_TOKEN),
      payload: { merchant_id: 'mch_OTHER', products: [bulkProduct({ merchant_id: 'mch_OTHER' })] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_scope_violation');
  });
});

describe('M12B OpenAPI drift guard', () => {
  function pathBlock(path: string): string {
    const content = readFileSync(openapiPath, 'utf8');
    const start = content.indexOf(`  ${path}:`);
    expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
    const after = content.slice(start + path.length + 3);
    const next = after.search(/\n {2}\/[A-Za-z0-9{]/);
    return next === -1 ? after : after.slice(0, next);
  }

  it('marks catalog list, patch, and bulk ingest as implemented', () => {
    expect(pathBlock('/v1/commerce/catalog/products'))
      .toMatch(/get:[\s\S]*operationId:\s*listProducts[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/catalog/products/bulk'))
      .toMatch(/post:[\s\S]*operationId:\s*bulkIngestProducts[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/catalog/products/{product_id}'))
      .toMatch(/patch:[\s\S]*operationId:\s*updateProduct[\s\S]*x-implemented:\s*true/);
  });
});
