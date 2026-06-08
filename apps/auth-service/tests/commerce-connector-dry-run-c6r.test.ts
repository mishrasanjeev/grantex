import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import {
  finalizeConnectorDryRun,
  prepareConnectorDryRun,
  type ConnectorDryRunResult,
} from '../src/lib/commerce/connector-dry-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const fixturePath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6q-sandbox-e2e',
  'dummyjson-homegoods-products.snapshot.json',
);
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6r-sandbox-connector-dry-run-foundation.md',
);
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-merchant-operator-guide.mdx');
const openapiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const migrationPath = join(__dirname, '../src/db/migrations/053_commerce_connector_dry_runs.sql');
const NOW = new Date('2026-06-08T00:00:00.000Z');
const MERCHANT = 'mch_C6R';
const OTHER_MERCHANT = 'mch_OTHER_C6R';
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6rrrrrrrrrrrrrrrrrrrrrrrrrr'].join('_');
const AGENT_TOKEN = ['grtx', 'agent', 'C6RXXXXXXXXXXXXXXXXXXXXXXXX'].join('_');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

interface C6QFixture {
  source: {
    snapshot_recorded_at: string;
  };
  products: Array<Record<string, unknown>>;
}

function readFixture(): C6QFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as C6QFixture;
}

function bearer(token: string): Record<string, string> {
  return { authorization: ['Bearer', token].join(' ') };
}

function merchantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MERCHANT,
    environment: 'sandbox',
    verification_status: 'unverified',
    disabled_at: null,
    ...overrides,
  };
}

function dryRunDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdry_C6R',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    connector_type: 'csv',
    source_label: 'c6q_dummyjson_fixture',
    status: 'passed',
    sandbox_only: true,
    not_live: true,
    not_approved: true,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    provider_specific_live_enabled: false,
    rows_received: 3,
    products_detected: 3,
    variants_detected: 3,
    would_create_count: 2,
    would_update_count: 1,
    would_archive_count: 0,
    blocked_count: 0,
    warning_count: 3,
    normalized_preview: [{
      source_product_ref: 'row_1',
      title: 'Modular Sofa Test Fixture',
      brand: 'DummyJSON Test Fixture',
      description: 'Fake home seating item for sandbox catalog rehearsal.',
      image_url: 'https://cdn.dummyjson.com/products/images/furniture/Modular%20Sofa%20Test%20Fixture/thumbnail.png',
      category_preset: 'electronics_appliances',
      variants: [{
        sku: 'DJS-HG-SOFA-001',
        variant_title: 'furniture',
        price_amount: 12999,
        currency: 'USD',
        availability_status: 'in_stock',
        warranty_summary: 'Fixture warranty summary for local rehearsal.',
        return_policy_summary: 'Fixture return summary for local rehearsal.',
      }],
    }],
    blockers: [],
    warnings: [{
      code: 'category_mapped_for_sandbox',
      message: 'Source category was mapped into the current sandbox runtime category preset.',
      row_index: 0,
      field: 'category',
    }],
    requested_audit_event_id: 'caud_C6R_REQUESTED',
    result_audit_event_id: 'caud_C6R_COMPLETED',
    generated_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6R',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
}

function seedAgentCaller(): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'cag_C6R',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'sha256:test',
    tenant_status: 'active',
  }]);
}

function seedDryRunPersistence(row: Record<string, unknown> = dryRunDbRow()): void {
  sqlMock.mockResolvedValueOnce([{ id: 'caud_C6R_REQUESTED', occurred_at: NOW.toISOString() }]);
  sqlMock.mockResolvedValueOnce([{ id: row.status === 'passed' ? 'caud_C6R_COMPLETED' : 'caud_C6R_BLOCKED', occurred_at: NOW.toISOString() }]);
  sqlMock.mockResolvedValueOnce([{
    ...row,
    result_audit_event_id: row.status === 'passed' ? 'caud_C6R_COMPLETED' : 'caud_C6R_BLOCKED',
  }]);
}

function sqlText(): string {
  return sqlMock.mock.calls
    .map((call) => {
      const tpl = call[0] as unknown;
      return Array.isArray(tpl) ? tpl.join(' ') : '';
    })
    .join('\n');
}

function fullSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

function c6qDryRunPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = readFixture();
  return {
    connector_type: 'csv',
    source_label: 'c6q_dummyjson_fixture',
    source_snapshot_at: fixture.source.snapshot_recorded_at,
    rows: fixture.products,
    ...overrides,
  };
}

describe('C6R sandbox connector dry-run service', () => {
  it('normalizes the C6Q fake fixture into a capped public-safe preview', () => {
    const prepared = prepareConnectorDryRun(c6qDryRunPayload({ preview_limit: 2 }), NOW);
    const result = finalizeConnectorDryRun({
      ...prepared,
      dryRunId: 'cdry_C6R',
      tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: MERCHANT,
      existingProductIds: new Set(['row_2']),
      generatedAt: NOW,
    });

    expect(result).toMatchObject({
      dry_run_id: 'cdry_C6R',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      connector_type: 'csv',
      source_label: 'c6q_dummyjson_fixture',
      status: 'passed',
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      provider_specific_live_enabled: false,
      rows_received: 3,
      products_detected: 3,
      variants_detected: 3,
      would_create_count: 2,
      would_update_count: 1,
      would_archive_count: 0,
      blocked_count: 0,
    });
    expect(result.normalized_preview).toHaveLength(2);
    expect(result.normalized_preview[0]).toMatchObject({
      source_product_ref: 'row_1',
      title: 'Modular Sofa Test Fixture',
      category_preset: 'electronics_appliances',
      variants: [{
        sku: 'DJS-HG-SOFA-001',
        price_amount: 12999,
        currency: 'USD',
        availability_status: 'in_stock',
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/raw_payload|provider_metadata|client_secret|access_token|checkout_url/i);
  });

  it('blocks invalid rows for stale/conflict, bad SKU, missing price, unsafe image, and unsupported category', () => {
    const prepared = prepareConnectorDryRun({
      connector_type: 'manual',
      source_label: 'manual_catalog_snapshot',
      source_snapshot_at: '2026-05-01T00:00:00.000Z',
      rows: [{
        product_id: 'bad row',
        title: 'Blocked Fixture Product',
        category_preset: 'home_furniture',
        sku: 'bad sku',
        price: null,
        currency: 'US',
        availability_status: 'maybe',
        image_url: 'http://private-merchant.invalid/image.png',
        conflict: true,
      }],
    }, NOW);
    const result = finalizeConnectorDryRun({
      ...prepared,
      dryRunId: 'cdry_BLOCKED',
      tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: MERCHANT,
      existingProductIds: new Set(),
      generatedAt: NOW,
    });

    expect(result.status).toBe('blocked');
    expect(result.products_detected).toBe(0);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'unsupported_category_preset',
      'invalid_sku',
      'invalid_product_ref',
      'missing_price',
      'invalid_currency',
      'invalid_availability',
      'unsafe_image_url',
      'stale_source_timestamp',
      'source_conflict_blocker',
    ]));
  });

  it('rejects credential/private fields, production config, allowlist-looking values, and enablement flags', () => {
    const prepared = prepareConnectorDryRun({
      connector_type: 'csv',
      source_label: 'manual_catalog_snapshot',
      public_discovery_enabled: true,
      rows: [{
        title: 'COMMERCE_PUBLIC_DISCOVERY_ENABLED should stay blocked',
        category_preset: 'electronics_appliances',
        sku: 'SAFE-SKU-001',
        price_amount: 1000,
        currency: 'USD',
        availability_status: 'in_stock',
        access_token: 'redacted',
        merchant_private_api_url: 'https://merchant-private.example.test/catalog',
      }],
    } as Record<string, unknown>, NOW);

    expect(prepared.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'unsupported_request_field',
      'private_field_rejected',
      'private_or_production_value_rejected',
      'enablement_field_rejected',
      'merchant_private_api_url_rejected',
    ]));
  });
});

describe('C6R connector dry-run routes', () => {
  it('creates a sandbox dry-run result with requested and completed audit events', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([{ product_id: 'row_2' }]);
    seedDryRunPersistence();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-run`,
      headers: authHeader(),
      payload: c6qDryRunPayload(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: Record<string, unknown>;
      audit_events: Array<{ event_type: string; audit_event_id: string }>;
    }>();
    expect(body.data).toMatchObject({
      dry_run_id: 'cdry_C6R',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      connector_type: 'csv',
      status: 'passed',
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      rows_received: 3,
      products_detected: 3,
      variants_detected: 3,
      would_create_count: 2,
      would_update_count: 1,
      would_archive_count: 0,
    });
    expect(body.audit_events).toEqual([
      { event_type: 'connector_dry_run_requested', audit_event_id: 'caud_C6R_REQUESTED' },
      { event_type: 'connector_dry_run_completed', audit_event_id: 'caud_C6R_COMPLETED' },
    ]);
    expect(sqlText()).toContain('INSERT INTO commerce_connector_dry_runs');
    expect(fullSqlCalls()).toContain('connector_dry_run_requested');
    expect(fullSqlCalls()).toContain('connector_dry_run_completed');
    expect(sqlText()).not.toMatch(/checkout_links|payment_intents|provider_credentials/i);
  });

  it('returns persisted dry-run evidence by tenant and merchant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6R`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      dry_run_id: 'cdry_C6R',
      merchant_id: MERCHANT,
      status: 'passed',
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
    });
  });

  it('enforces tenant and caller boundaries and denies CommerceAgent direct execution', async () => {
    seedMerchantCaller(MERCHANT);
    const crossMerchantRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${OTHER_MERCHANT}/connectors/dry-run`,
      headers: bearer(MERCHANT_TOKEN),
      payload: c6qDryRunPayload(),
    });
    expect(crossMerchantRes.statusCode).toBe(403);

    seedAgentCaller();
    const agentRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-run`,
      headers: bearer(AGENT_TOKEN),
      payload: c6qDryRunPayload(),
    });
    expect(agentRes.statusCode).toBe(403);
    expect(agentRes.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('blocks live merchants with redacted blocked audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow({ environment: 'live', verification_status: 'verified' })]);
    sqlMock.mockResolvedValueOnce([{ product_id: 'row_1' }]);
    seedDryRunPersistence(dryRunDbRow({
      status: 'blocked',
      blockers: [{
        code: 'live_merchant_mode_blocked',
        message: 'Connector dry-runs are available only for sandbox merchants.',
        remediation: 'Move this work to a sandbox merchant; live connector sync requires a later approval.',
      }],
      blocked_count: 1,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-run`,
      headers: authHeader(),
      payload: c6qDryRunPayload(),
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{ error: { code: string; audit_event_id: string; details: Record<string, unknown> } }>().error;
    expect(error.code).toBe('connector_dry_run_blocked');
    expect(error.audit_event_id).toBe('caud_C6R_BLOCKED');
    expect(JSON.stringify(error.details)).toContain('live_merchant_mode_blocked');
    expect(fullSqlCalls()).toContain('connector_dry_run_blocked');
  });

  it('rejects unsupported connector, credential fields, production values, and enablement attempts', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    seedDryRunPersistence(dryRunDbRow({
      status: 'blocked',
      blockers: [
        { code: 'unsupported_connector_type', message: 'Only manual and csv connector dry-runs are supported in C6R.', remediation: 'Use connector_type manual or csv.' },
        { code: 'private_field_rejected', message: 'Request contains private field.', remediation: 'Remove private fields.' },
      ],
      blocked_count: 2,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-run`,
      headers: authHeader(),
      payload: {
        connector_type: 'shopify',
        source_label: 'blocked_external_connector',
        public_discovery_enabled: true,
        rows: [{
          title: 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST must stay blocked',
          category_preset: 'electronics_appliances',
          sku: 'SAFE-SKU-002',
          price_amount: 1000,
          currency: 'USD',
          availability_status: 'in_stock',
          access_token: 'redacted',
          merchant_private_api_url: 'https://merchant-private.example.test/catalog',
        }],
      },
    });

    expect(res.statusCode).toBe(422);
    const error = res.json<{ error: { code: string; audit_event_id: string; details: Record<string, unknown> } }>().error;
    expect(error.code).toBe('connector_dry_run_rejected');
    expect(error.audit_event_id).toBe('caud_C6R_BLOCKED');
    expect(JSON.stringify(error.details)).toMatch(/unsupported_connector_type|private_field_rejected|enablement_field_rejected/);
    expect(sqlText()).not.toMatch(/INSERT INTO commerce_products|commerce_product_variants/i);
  });
});

describe('C6R docs, migration, and OpenAPI drift guards', () => {
  it('declares redacted dry-run persistence with non-enabling constraints', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS commerce_connector_dry_runs');
    expect(migration).toContain('chk_commerce_connector_dry_run_non_enabling');
    expect(migration).toContain('public_discovery_enabled = FALSE');
    expect(migration).toContain('checkout_payment_enabled = FALSE');
    expect(migration).toContain('live_provider_enabled = FALSE');
    expect(migration).toContain('provider_specific_live_enabled = FALSE');
    expect(migration).not.toMatch(/encrypted_secret|access_token|client_secret|raw_payload JSONB/i);
  });

  it('documents C6R as dry-run-only and AgenticOrg as preview-only consumer', () => {
    const doc = readFileSync(docPath, 'utf8');
    const guide = readFileSync(guidePath, 'utf8');
    expect(doc).toContain('Traceability Checklist');
    expect(doc).toContain('C6R lets a tenant-owned sandbox merchant run a local connector sync dry-run');
    expect(doc).toContain('AgenticOrg never directly executes merchant private API calls');
    expect(doc).toContain('does not approve production launch');
    expect(guide).toContain('C6R adds a sandbox connector sync dry-run foundation');
    expect(`${doc}\n${guide}`).not.toMatch(/certification approved|production approved|public protocol publication approved|live payment approved/i);
  });

  it('declares C6R dry-run APIs in OpenAPI as sandbox-only and non-enabling', () => {
    const content = readFileSync(openapiPath, 'utf8');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-run');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}');
    expect(content).toMatch(/operationId:\s*runCommerceConnectorDryRun/);
    expect(content).toMatch(/operationId:\s*getCommerceConnectorDryRun/);
    expect(content).toMatch(/x-milestone:\s*C6R/);
    expect(content).toMatch(/CommerceConnectorDryRunResult:/);
    expect(content).toMatch(/sandbox_only:\s*\{\s*type:\s*boolean,\s*const:\s*true\s*\}/);
    expect(content).toMatch(/public_discovery_enabled:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/checkout_payment_enabled:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/live_provider_enabled:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
  });
});
