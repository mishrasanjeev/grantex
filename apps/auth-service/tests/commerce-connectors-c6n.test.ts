import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(__dirname, '../src/db/migrations/052_commerce_connectors.sql');
const openapiPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const MERCHANT = 'mch_C6N';
const OTHER_MERCHANT = 'mch_OTHER_C6N';
const NOW = new Date('2026-06-07T00:00:00.000Z').toISOString();
const OLD = new Date('2026-06-01T00:00:00.000Z').toISOString();
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6nnnnnnnnnnnnnnnnnnnnnnnnnn'].join('_');
const AGENT_TOKEN = ['grtx', 'agent', 'C6NXXXXXXXXXXXXXXXXXXXXXXXX'].join('_');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function bearer(token: string): Record<string, string> {
  return { authorization: ['Bearer', token].join(' ') };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6N',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
}

function seedAgentCaller(agentId = 'cag_C6N'): void {
  sqlMock.mockResolvedValueOnce([{
    id: agentId,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'sha256:test',
    tenant_status: 'active',
  }]);
}

function connectorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cconn_C6N',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    connector_key: 'manual_catalog',
    connector_type: 'manual',
    display_name: 'Manual Catalog',
    status: 'active',
    runtime_mode: 'manual_catalog_api',
    source_domains: ['catalog', 'price', 'inventory'],
    source_priority: 10,
    sync_status: 'manual',
    health_state: 'healthy',
    last_sync_at: NOW,
    last_successful_sync_at: NOW,
    stale_after_seconds: 86400,
    conflict_blockers: [],
    webhook_source_key: null,
    agenticorg_direct_execution_enabled: false,
    provider_call_enabled: false,
    stores_credentials: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

function sqlText(): string {
  return sqlMock.mock.calls
    .map((call) => {
      const tpl = call[0] as unknown;
      return Array.isArray(tpl) ? tpl.join(' ') : '';
    })
    .join('\n');
}

function pathBlock(path: string): string {
  const content = readFileSync(openapiPath, 'utf8');
  const start = content.indexOf(`  ${path}:`);
  expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
  const after = content.slice(start + path.length + 3);
  const next = after.search(/\n {2}\/[A-Za-z0-9{.]/);
  return next === -1 ? after : after.slice(0, next);
}

describe('C6N merchant existing-system connector registry', () => {
  it('creates a metadata-only manual connector with non-enabling controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([connectorRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CONNECTOR_CREATED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([connectorRow()]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        connector_key: 'manual_catalog',
        connector_type: 'manual',
        display_name: 'Manual Catalog',
        status: 'active',
        source_domains: ['catalog', 'price', 'inventory'],
        source_priority: 10,
        sync_status: 'manual',
        health_state: 'healthy',
        last_sync_at: NOW,
        last_successful_sync_at: NOW,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: Record<string, unknown>;
      source_precedence: Array<Record<string, unknown>>;
      audit_event_id: string;
    }>();
    expect(body.data.connector_type).toBe('manual');
    expect(body.data.runtime_mode).toBe('manual_catalog_api');
    expect(body.data.runtime_implemented).toBe(true);
    expect(body.data.controls).toMatchObject({
      metadata_only_registry: true,
      credentials_stored_by_registry: false,
      outbound_sync_enabled_by_registry: false,
      agenticorg_direct_execution_allowed: false,
      provider_call_enabled_by_registry: false,
      checkout_payment_enabled_by_registry: false,
      live_payment_enabled_by_registry: false,
      live_plural_enabled_by_registry: false,
      public_discovery_enabled_by_registry: false,
      production_config_written_by_registry: false,
    });
    expect(body.data.blockers).toContain('agenticorg_direct_execution_not_allowed');
    expect(body.data.blockers).toContain('credentials_not_stored_by_registry');
    const price = body.source_precedence.find((entry) => entry.domain === 'price');
    expect(price?.primary_connector_key).toBe('manual_catalog');
    expect(body.audit_event_id).toBe('caud_CONNECTOR_CREATED');
    expect(flattenedSqlCalls()).toContain('merchant.connector.created');
    expect(sqlText()).toMatch(/INSERT INTO commerce_connectors/i);
    expect(sqlText()).not.toMatch(/encrypted_secret|access_token|client_secret|raw_payload/i);
  });

  it('returns merchant-wide source precedence after connector creation', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([connectorRow({
      connector_key: 'shopify_declared',
      connector_type: 'shopify',
      display_name: 'Shopify Declared',
      runtime_mode: 'metadata_only',
      source_domains: ['price'],
      source_priority: 20,
      health_state: 'conflict',
      sync_status: 'blocked',
      last_successful_sync_at: null,
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CONNECTOR_CREATED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([
      connectorRow({
        connector_key: 'manual_price',
        display_name: 'Manual Price',
        source_domains: ['price'],
        source_priority: 10,
      }),
      connectorRow({
        connector_key: 'shopify_declared',
        connector_type: 'shopify',
        display_name: 'Shopify Declared',
        runtime_mode: 'metadata_only',
        source_domains: ['price'],
        source_priority: 20,
        health_state: 'conflict',
        sync_status: 'blocked',
        last_successful_sync_at: null,
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        connector_key: 'shopify_declared',
        connector_type: 'shopify',
        display_name: 'Shopify Declared',
        source_domains: ['price'],
        source_priority: 20,
        health_state: 'conflict',
        sync_status: 'blocked',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      source_precedence: Array<{
        domain: string;
        primary_connector_key: string | null;
        connectors: Array<Record<string, unknown>>;
      }>;
    }>();
    const price = body.source_precedence.find((entry) => entry.domain === 'price');
    expect(price?.primary_connector_key).toBe('manual_price');
    expect(price?.connectors.map((entry) => entry.connector_key)).toEqual(['manual_price', 'shopify_declared']);
  });

  it('lists source precedence and marks stale/conflict blockers explicitly', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([
      connectorRow({
        connector_key: 'csv_seed',
        connector_type: 'csv',
        display_name: 'CSV Seed',
        runtime_mode: 'csv_catalog_import',
        source_domains: ['catalog', 'inventory'],
        source_priority: 5,
        health_state: 'stale',
        sync_status: 'sync_succeeded',
        last_successful_sync_at: OLD,
      }),
      connectorRow({
        connector_key: 'manual_price',
        connector_type: 'manual',
        display_name: 'Manual Price',
        source_domains: ['price'],
        source_priority: 10,
      }),
      connectorRow({
        connector_key: 'shopify_declared',
        connector_type: 'shopify',
        display_name: 'Shopify Declared',
        runtime_mode: 'metadata_only',
        source_domains: ['price', 'inventory'],
        source_priority: 20,
        health_state: 'conflict',
        sync_status: 'blocked',
        conflict_blockers: ['price_source_conflict'],
        last_successful_sync_at: null,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/connectors?merchant_id=${MERCHANT}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<Record<string, unknown>>;
      source_precedence: Array<{
        domain: string;
        primary_connector_key: string | null;
        connectors: Array<Record<string, unknown>>;
        blockers: string[];
      }>;
      controls: Record<string, unknown>;
    }>();
    const catalog = body.source_precedence.find((entry) => entry.domain === 'catalog');
    const price = body.source_precedence.find((entry) => entry.domain === 'price');
    const order = body.source_precedence.find((entry) => entry.domain === 'order');
    expect(catalog?.primary_connector_key).toBe('csv_seed');
    expect(price?.primary_connector_key).toBe('manual_price');
    expect(price?.connectors.map((entry) => entry.connector_key)).toEqual(['manual_price', 'shopify_declared']);
    expect(order?.blockers).toContain('source_of_truth_not_declared');
    const csv = body.items.find((item) => item.connector_key === 'csv_seed')!;
    const shopify = body.items.find((item) => item.connector_key === 'shopify_declared')!;
    expect(csv.blockers).toContain('connector_health_stale');
    expect(csv.blockers).toContain('last_sync_stale');
    expect(shopify.blockers).toContain('source_conflict_blocker');
    expect(shopify.blockers).toContain('external_connector_runtime_not_implemented');
    expect(shopify.blockers).toContain('sync_status_blocked');
    expect(body.controls).toMatchObject({
      agenticorg_direct_execution_allowed: false,
      provider_call_enabled_by_registry: false,
      credentials_stored_by_registry: false,
    });
  });

  it('rejects private fields and credential-like values without writing connector rows', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        connector_key: 'shopify_live',
        connector_type: 'shopify',
        display_name: 'Shopify',
        source_domains: ['catalog'],
        api_key: 'redacted',
        access_token: 'redacted',
        credential_reference_id: 'cpc_PRIVATE',
        raw_payload: { client_secret: 'redacted' },
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('api_key');
    expect(fields.unsupported_fields).toContain('access_token');
    expect(fields.unsupported_fields).toContain('credential_reference_id');
    expect(fields.unsupported_fields).toContain('raw_payload');
    expect(fields.private_values).toBeUndefined();
    expect(sqlText()).not.toMatch(/INSERT INTO commerce_connectors/i);
  });

  it('rejects missing webhook source references before writing connector rows', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: authHeader(),
      payload: {
        merchant_id: MERCHANT,
        connector_key: 'csv_seed',
        connector_type: 'csv',
        display_name: 'CSV Seed',
        source_domains: ['catalog'],
        webhook_source_key: 'missing_source',
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.webhook_source_key).toContain('must reference an existing webhook source');
    expect(sqlText()).toMatch(/FROM commerce_webhook_sources/i);
    expect(sqlText()).not.toMatch(/INSERT INTO commerce_connectors/i);
  });

  it('enforces tenant and caller boundaries and denies CommerceAgent direct connector management', async () => {
    seedAgentCaller();
    const agentRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: bearer(AGENT_TOKEN),
      payload: {
        merchant_id: MERCHANT,
        connector_key: 'csv_seed',
        connector_type: 'csv',
        display_name: 'CSV Seed',
        source_domains: ['catalog'],
      },
    });
    expect(agentRes.statusCode).toBe(403);
    expect(agentRes.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');

    seedMerchantCaller(MERCHANT);
    const crossMerchantRes = await app.inject({
      method: 'POST',
      url: '/v1/commerce/connectors',
      headers: bearer(MERCHANT_TOKEN),
      payload: {
        merchant_id: OTHER_MERCHANT,
        connector_key: 'csv_seed',
        connector_type: 'csv',
        display_name: 'CSV Seed',
        source_domains: ['catalog'],
      },
    });
    expect(crossMerchantRes.statusCode).toBe(403);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);
    const missingMerchantRes = await app.inject({
      method: 'GET',
      url: `/v1/commerce/connectors?merchant_id=${OTHER_MERCHANT}`,
      headers: authHeader(),
    });
    expect(missingMerchantRes.statusCode).toBe(404);
  });

  it('patches safe metadata and returns stale/conflict blockers without enabling execution', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([connectorRow({
      connector_key: 'custom_api_declared',
      connector_type: 'custom_api',
      display_name: 'Custom API Declared',
      runtime_mode: 'custom_api_declared',
      source_domains: ['catalog', 'price'],
      sync_status: 'sync_failed',
      health_state: 'conflict',
      last_successful_sync_at: OLD,
      conflict_blockers: ['catalog_source_conflict'],
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_CONNECTOR_UPDATED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([connectorRow({
      connector_key: 'custom_api_declared',
      connector_type: 'custom_api',
      display_name: 'Custom API Declared',
      runtime_mode: 'custom_api_declared',
      source_domains: ['catalog', 'price'],
      sync_status: 'sync_failed',
      health_state: 'conflict',
      last_successful_sync_at: OLD,
      conflict_blockers: ['catalog_source_conflict'],
    })]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/connectors/custom_api_declared?merchant_id=${MERCHANT}`,
      headers: authHeader(),
      payload: {
        display_name: 'Custom API Declared',
        source_domains: ['catalog', 'price'],
        sync_status: 'sync_failed',
        health_state: 'conflict',
        last_successful_sync_at: OLD,
        conflict_blockers: ['catalog_source_conflict'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string }>();
    expect(body.audit_event_id).toBe('caud_CONNECTOR_UPDATED');
    expect(body.data.runtime_implemented).toBe(false);
    expect(body.data.blockers).toContain('custom_api_runtime_not_implemented');
    expect(body.data.blockers).toContain('sync_failed_blocker');
    expect(body.data.blockers).toContain('source_conflict_blocker');
    expect(body.data.blockers).toContain('last_sync_stale');
    expect(body.data.controls).toMatchObject({
      agenticorg_direct_execution_allowed: false,
      provider_call_enabled_by_registry: false,
      credentials_stored_by_registry: false,
    });
    expect(flattenedSqlCalls()).toContain('merchant.connector.updated');
  });
});

describe('C6N connector schema and OpenAPI drift guards', () => {
  it('defines connector registry metadata without credential storage or execution enablement', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS commerce_connectors');
    expect(migration).toContain('connector_type IN');
    for (const type of [
      'manual',
      'csv',
      'custom_api',
      'shopify',
      'woocommerce',
      'magento',
      'erp',
      'billing',
      'oms',
      'wms',
      'logistics',
      'crm_support',
      'payment_provider',
    ]) {
      expect(migration).toContain(`'${type}'`);
    }
    for (const domain of ['catalog', 'price', 'inventory', 'order', 'fulfillment', 'refund', 'settlement', 'support']) {
      expect(migration).toContain(domain);
    }
    expect(migration).toContain('chk_commerce_connector_no_execution_or_secret_storage');
    expect(migration).toContain('agenticorg_direct_execution_enabled = FALSE');
    expect(migration).toContain('provider_call_enabled = FALSE');
    expect(migration).toContain('stores_credentials = FALSE');
    expect(migration).not.toContain('encrypted_secret');
    expect(migration).not.toContain('raw_payload JSONB');
  });

  it('declares connector APIs as C6N metadata-only routes', () => {
    expect(pathBlock('/v1/commerce/connectors'))
      .toMatch(/post:[\s\S]*operationId:\s*createCommerceConnector[\s\S]*x-milestone:\s*C6N[\s\S]*get:[\s\S]*operationId:\s*listCommerceConnectors[\s\S]*x-milestone:\s*C6N/);
    expect(pathBlock('/v1/commerce/connectors/{connector_key}'))
      .toMatch(/patch:[\s\S]*operationId:\s*updateCommerceConnector[\s\S]*x-milestone:\s*C6N/);
  });
});
