import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const MERCHANT = 'mch_M5A';
const OTHER_MERCHANT = 'mch_OTHER_M5A';
const PRODUCT = 'cprd_M5A';
const NOW = new Date().toISOString();
const OLD = new Date('2026-05-09T10:00:00.000Z').toISOString();
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
beforeAll(async () => { app = await buildTestApp(); });

function merchantProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MERCHANT,
    legal_name: 'Grantex Test Merchant Pvt Ltd',
    display_name: 'Grantex Test Merchant',
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
    id: PRODUCT,
    product_id: 'TOASTER-V2',
    merchant_id: MERCHANT,
    title: 'Acme Pop-Up Toaster',
    brand: 'Acme',
    image_url: 'https://cdn.example.test/toaster.png',
    category_preset: 'electronics_appliances',
    updated_at: NOW,
    variant_id: 'cvar_M5A_WHITE',
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

function sqlText(): string {
  return sqlMock.mock.calls
    .map((call) => {
      const template = call[0] as unknown;
      return Array.isArray(template) ? template.join('?') : '';
    })
    .join('\n');
}

function openApiBlock(path: string): string {
  const content = readFileSync(OPENAPI_PATH, 'utf8');
  const start = content.indexOf(path);
  expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
  const next = content.indexOf('\n  /', start + path.length);
  return content.slice(start, next === -1 ? undefined : next);
}

describe('GET /.well-known/grantex-commerce', () => {
  it('returns the public merchant publishing profile', async () => {
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      version: string;
      merchant: { merchant_id: string; display_name: string; legal_name: string };
      environment: string;
      native_rest: { base_url: string };
      auth_requirements: { public_browse: boolean; public_browse_status: string };
    }>();
    expect(body.version).toBe('grantex-commerce-v1');
    expect(body.merchant).toMatchObject({
      merchant_id: MERCHANT,
      display_name: 'Grantex Test Merchant',
      legal_name: 'Grantex Test Merchant Pvt Ltd',
    });
    expect(body.environment).toBe('sandbox');
    expect(body.native_rest.base_url).toContain('/v1/commerce');
    expect(body.auth_requirements.public_browse).toBe(false);
    expect(body.auth_requirements.public_browse_status).toBe('deferred_until_publish_flag_exists');
  });

  it('does not claim UCP/ACP/AP2/MPP/A2A certification', async () => {
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toMatch(/\b(UCP|ACP|AP2|MPP|A2A)\b/);
    expect(body).not.toMatch(/certif/i);
  });

  it('lists streamable_http MCP transport and all V1 tools', async () => {
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ supported_tools: string[]; mcp: { transport: string; url: string } }>();
    expect(body.mcp.transport).toBe('streamable_http');
    expect(body.mcp.url).toContain('/mcp');
    expect(body.supported_tools).toEqual(V1_TOOLS);
  });

  it('keeps the commerce well-known profile rate limited outside the JWKS allowlist', async () => {
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('requires a merchant selector when more than one merchant exists', async () => {
    sqlMock.mockResolvedValueOnce([
      merchantProfile({ id: MERCHANT }),
      merchantProfile({ id: OTHER_MERCHANT }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_selector_required');
  });

  it('returns 404 for a missing selected merchant', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_MISSING',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });
});

describe('POST /v1/commerce/catalog/search', () => {
  it('returns product and active variant summaries', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([
      catalogRow(),
      catalogRow({
        variant_id: 'cvar_M5A_BLACK',
        sku: 'TOASTER-V2-BLACK',
        variant_title: 'Black',
        availability_status: 'out_of_stock',
        last_synced_at: OLD,
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/search',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        query: 'toaster',
        filters: { category_preset: 'electronics_appliances' },
        limit: 10,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{
        id: string;
        variants_summary: Array<{ sku: string; availability_status: string; stale: boolean; freshness: string }>;
      }>;
      next_cursor: string | null;
    }>();
    expect(body.next_cursor).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(PRODUCT);
    expect(body.items[0]?.variants_summary).toEqual([
      expect.objectContaining({
        sku: 'TOASTER-V2-WHITE',
        availability_status: 'in_stock',
        stale: false,
        freshness: 'fresh',
      }),
      expect.objectContaining({
        sku: 'TOASTER-V2-BLACK',
        availability_status: 'out_of_stock',
        stale: true,
        freshness: 'stale',
      }),
    ]);
  });

  it('keeps catalog search tenant and merchant scoped', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([catalogRow()]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/search',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, limit: 5 },
    });

    expect(res.statusCode).toBe(200);
    const calls = sqlText();
    expect(calls).toMatch(/p\.tenant_id\s*=/);
    expect(calls).toMatch(/p\.merchant_id\s*=/);
    expect(sqlMock.mock.calls.flat()).toContain(TEST_COMMERCE_TENANT_ID);
    expect(sqlMock.mock.calls.flat()).toContain(MERCHANT);
  });

  it('excludes archived products and variants by default', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/search',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT },
    });

    expect(res.statusCode).toBe(200);
    const calls = sqlText();
    expect(calls).toContain('p.archived_at IS NULL');
    expect(calls).toContain('v.archived_at IS NULL');
  });

  it('validates filters and limit', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/catalog/search',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        filters: { availability_status: 'maybe', unknown: 'x' },
        limit: 101,
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields).toHaveProperty('filters.availability_status');
    expect(fields).toHaveProperty('filters.unknown');
    expect(fields).toHaveProperty('limit');
  });
});

describe('M5A OpenAPI contract', () => {
  it('marks well-known and catalog search routes implemented', () => {
    const wellKnown = openApiBlock('/.well-known/grantex-commerce:');
    expect(wellKnown).toMatch(/operationId:\s*getGrantexCommerceProfile/);
    expect(wellKnown).toMatch(/x-implemented:\s*true/);
    expect(wellKnown).toContain('streamable_http');

    const search = openApiBlock('/v1/commerce/catalog/search:');
    expect(search).toMatch(/operationId:\s*searchCommerceCatalog/);
    expect(search).toMatch(/x-implemented:\s*true/);
    expect(search).toContain('CatalogSearchRequest');
    expect(search).toContain('CatalogSearchResponse');
  });
});
