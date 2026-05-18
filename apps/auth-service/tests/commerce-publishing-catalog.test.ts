import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';
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
afterEach(() => { vi.unstubAllEnvs(); });

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
  it('fails closed when both Commerce V1 and public discovery are disabled', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', '');

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.json<{ error: { code: string } }>().error.code).toBe('commerce_disabled');
  });

  it('treats empty or invalid public discovery values as disabled', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    for (const value of ['', 'false', 'enabled-but-unsafe']) {
      vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', value);

      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('commerce_disabled');
    }
  });

  it('requires an allowlisted merchant when public read-only discovery is enabled', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'true');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', '');

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code)
      .toBe('commerce_public_discovery_allowlist_required');
  });

  it.each(['COMMERCE_LIVE_MODE_ENABLED', 'PLURAL_LIVE_ENABLED'])(
    'fails closed when public discovery is enabled with %s=true',
    async (liveFlag) => {
      vi.stubEnv('COMMERCE_V1_ENABLED', '');
      vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'true');
      vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', MERCHANT);
      vi.stubEnv(liveFlag, 'true');

      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
      });

      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
      expect(res.json<{ error: { code: string } }>().error.code)
        .toBe('commerce_public_discovery_live_flags_forbidden');
    },
  );

  it('fails closed when the requested merchant is not allowlisted', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'enabled');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', OTHER_MERCHANT);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('returns read-only discovery through the public gate without Commerce V1 runtime enabled', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'true');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', MERCHANT);
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce?merchant_id=mch_M5A',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    const body = res.json<{
      merchant: { merchant_id: string };
      discovery_posture: {
        mode: string;
        read_only_discovery_only: boolean;
        commerce_v1_runtime_enabled: boolean;
        checkout_payment_creation_enabled_by_discovery_gate: boolean;
        live_payments_enabled: boolean;
        live_plural_enabled: boolean;
        provider_credentials_exposed: boolean;
        readiness_claim: string;
        certification_claim: string;
      };
    }>();
    expect(body.merchant.merchant_id).toBe(MERCHANT);
    expect(body.discovery_posture).toMatchObject({
      mode: 'public_read_only_discovery',
      read_only_discovery_only: true,
      commerce_v1_runtime_enabled: false,
      checkout_payment_creation_enabled_by_discovery_gate: false,
      live_payments_enabled: false,
      live_plural_enabled: false,
      provider_credentials_exposed: false,
      readiness_claim: 'none',
      certification_claim: 'none',
    });
  });

  it('uses the single allowlisted merchant when no selector is supplied', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', '1');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', ` ${MERCHANT} `);
    sqlMock.mockResolvedValueOnce([merchantProfile()]);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce',
    });

    expect(res.statusCode).toBe(200);
    expect(sqlMock.mock.calls.flat()).toContain(MERCHANT);
  });

  it('requires a selector when multiple public discovery merchants are allowlisted', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'yes');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', `${MERCHANT},${OTHER_MERCHANT}`);

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/grantex-commerce',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_selector_required');
  });

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
    const parsed = res.json<{ discovery_posture: { certification_claim: string; readiness_claim: string } }>();
    const body = JSON.stringify(parsed);
    expect(body).not.toMatch(/\b(UCP|ACP|AP2|MPP|A2A)\b/);
    expect(parsed.discovery_posture.certification_claim).toBe('none');
    expect(parsed.discovery_posture.readiness_claim).toBe('none');
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

  it('does not let the public discovery gate enable MCP or Commerce runtime routes', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_ENABLED', 'true');
    vi.stubEnv('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', MERCHANT);

    const mcpList = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 'm5a', method: 'tools/list' },
    });
    expect(mcpList.statusCode).toBe(503);
    expect(mcpList.json<{ error: { data: { error: { code: string } } } }>().error.data.error.code)
      .toBe('commerce_disabled');

    const mcpCall = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 'm5a',
        method: 'tools/call',
        params: { name: 'merchant.get_profile', arguments: { merchant_id: MERCHANT } },
      },
    });
    expect(mcpCall.statusCode).toBe(503);

    seedAuth();
    const merchantRoute = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${MERCHANT}`,
      headers: authHeader(),
    });
    expect(merchantRoute.statusCode).toBe(503);
    expect(merchantRoute.json<{ error: { code: string } }>().error.code).toBe('commerce_disabled');

    seedAuth();
    const cartRoute = await app.inject({
      method: 'POST',
      url: '/v1/commerce/carts',
      headers: authHeader(),
      payload: { merchant_id: MERCHANT, currency: 'INR', line_items: [], idempotency_key: 'idem_test' },
    });
    expect(cartRoute.statusCode).toBe(503);
    expect(cartRoute.json<{ error: { code: string } }>().error.code).toBe('commerce_disabled');
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
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    expect(content).toContain('discovery_posture');
    expect(content).toContain('public_read_only_discovery');
    expect(content).toContain('checkout_payment_creation_enabled_by_discovery_gate');
    expect(content).toContain('live_payments_enabled');
    expect(content).toContain('live_plural_enabled');

    const search = openApiBlock('/v1/commerce/catalog/search:');
    expect(search).toMatch(/operationId:\s*searchCommerceCatalog/);
    expect(search).toMatch(/x-implemented:\s*true/);
    expect(search).toContain('CatalogSearchRequest');
    expect(search).toContain('CatalogSearchResponse');
  });
});
