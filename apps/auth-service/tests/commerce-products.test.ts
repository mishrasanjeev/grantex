import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, buildTestApp } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });

const productPayload = {
  merchant_id: 'mch_OK',
  product_id: 'TOASTER-V2',
  title: 'Acme Pop-Up Toaster',
  brand: 'Acme',
  description: '4-slice toaster',
  category_preset: 'electronics_appliances',
  variants: [
    { sku: 'TOASTER-V2-WHITE', price_amount: 250000, currency: 'INR', tax_inclusive: true, gst_slab: '18', hsn_code: '8516', availability_status: 'in_stock' },
    { sku: 'TOASTER-V2-BLACK', price_amount: 250000, currency: 'INR', tax_inclusive: true, gst_slab: '18', hsn_code: '8516', availability_status: 'out_of_stock' },
  ],
};

describe('POST /v1/commerce/catalog/products', () => {
  it('creates product with multiple variants atomically', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: 'mch_OK' }]);  // merchant lookup ok
    // INSERT product
    sqlMock.mockResolvedValueOnce([{
      id: 'cprd_X', tenant_id: TEST_COMMERCE_TENANT_ID, merchant_id: 'mch_OK',
      product_id: 'TOASTER-V2', title: 'Acme Pop-Up Toaster', brand: 'Acme',
      description: '4-slice toaster', image_url: null,
      category_preset: 'electronics_appliances', source_system: 'manual',
      manually_maintained: false, archived_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }]);
    // INSERT variant 1
    sqlMock.mockResolvedValueOnce([{
      id: 'cvar_1', sku: 'TOASTER-V2-WHITE', price_amount: 250000,
      currency: 'INR', tax_inclusive: true, gst_slab: '18', tax_rate: null,
      hsn_code: '8516', availability_status: 'in_stock', archived_at: null,
    }]);
    // INSERT variant 2
    sqlMock.mockResolvedValueOnce([{
      id: 'cvar_2', sku: 'TOASTER-V2-BLACK', price_amount: 250000,
      currency: 'INR', tax_inclusive: true, gst_slab: '18', tax_rate: null,
      hsn_code: '8516', availability_status: 'out_of_stock', archived_at: null,
    }]);
    // INSERT audit
    sqlMock.mockResolvedValueOnce([{ id: 'caud_P', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products',
      headers: authHeader(),
      payload: productPayload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; variants: { id: string; sku: string }[] }; audit_event_id: string }>();
    expect(body.data.id).toBe('cprd_X');
    expect(body.data.variants).toHaveLength(2);
    expect(body.audit_event_id).toBe('caud_P');
  });

  it('rejects payload with no variants (422)', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products',
      headers: authHeader(),
      payload: { ...productPayload, variants: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('variants');
  });

  it('rejects negative price_amount (422)', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products',
      headers: authHeader(),
      payload: { ...productPayload, variants: [{ sku: 'NEG', price_amount: -1, currency: 'INR' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('variants[0].price_amount');
  });

  it('rejects invalid availability_status (422)', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products',
      headers: authHeader(),
      payload: { ...productPayload, variants: [{ sku: 'X', price_amount: 100, availability_status: 'maybe' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('variants[0].availability_status');
  });
});

describe('DELETE /v1/commerce/catalog/products/:productId (soft-delete)', () => {
  it('archives product and variants, returns 200 with audit_event_id', async () => {
    seedCommerceContext();
    // UPDATE product RETURNING
    sqlMock.mockResolvedValueOnce([{
      id: 'cprd_DEL', merchant_id: 'mch_OK',
      archived_at: new Date().toISOString(),
    }]);
    // UPDATE variants (no RETURNING in our SQL; mock returns empty)
    sqlMock.mockResolvedValueOnce([]);
    // INSERT audit
    sqlMock.mockResolvedValueOnce([{ id: 'caud_D', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/commerce/catalog/products/cprd_DEL',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; archived_at: string }; audit_event_id: string }>();
    expect(body.data.id).toBe('cprd_DEL');
    expect(body.data.archived_at).toBeTruthy();
    expect(body.audit_event_id).toBe('caud_D');
  });

  it('returns 404 when product is absent or already archived', async () => {
    seedCommerceContext();
    // UPDATE...WHERE archived_at IS NULL RETURNING [] when nothing matched
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/commerce/catalog/products/cprd_GONE',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('product_not_found');
  });
});
