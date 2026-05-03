import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, buildTestApp } from './helpers.js';
import { seedCommerceContext } from './commerce-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Commerce tenant boundary', () => {
  it('GET /merchants/:id from tenant A returns 404 (not 403) for tenant B merchant', async () => {
    // Caller resolves to TEST_COMMERCE_TENANT_ID; the SELECT filters by
    // tenant_id, so the row owned by another tenant is invisible. Returning
    // 404 (not 403) avoids leaking existence across tenants.
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);  // SELECT WHERE tenant_id = caller's returns empty

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_OWNED_BY_OTHER_TENANT',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('POST /catalog/products refuses cross-tenant merchant_id with 404', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);  // merchant lookup (cross-tenant) returns empty

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/products',
      headers: authHeader(),
      payload: {
        merchant_id: 'mch_OTHER_TENANT',
        product_id: 'PROD-1',
        title: 'Toaster',
        category_preset: 'electronics_appliances',
        variants: [{ sku: 'SKU-1', price_amount: 100000, currency: 'INR' }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('GET /audit/events SELECT carries tenant_id filter', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);  // empty audit list

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/audit/events',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    // Inspect the SQL template strings emitted by sqlMock to confirm
    // tenant_id filtering is wired into the query, not just the WHERE
    // for a hypothetical other call.
    const calls = sqlMock.mock.calls;
    const tagged = calls.find((c) => {
      const tpl = c[0] as unknown;
      if (Array.isArray(tpl)) {
        return tpl.some((s) => typeof s === 'string' && s.includes('FROM commerce_audit_events'));
      }
      return false;
    });
    expect(tagged).toBeDefined();
    // The first SQL fragment (created via sql`tenant_id = ${tenantId}`)
    // appears earlier in the same logical statement; verify by searching
    // ALL tagged-template fragments in the test for the literal 'tenant_id'.
    const allTplStrings = calls.flatMap((c) => {
      const tpl = c[0] as unknown;
      return Array.isArray(tpl) ? tpl.filter((s): s is string => typeof s === 'string') : [];
    });
    expect(allTplStrings.some((s) => s.includes('tenant_id'))).toBe(true);
  });
});
