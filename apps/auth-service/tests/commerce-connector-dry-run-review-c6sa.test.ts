import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const migrationPath = join(__dirname, '../src/db/migrations/054_commerce_connector_dry_run_reviews.sql');
const openapiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-merchant-operator-guide.mdx');
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6sa-connector-dry-run-review-foundation.md',
);
const NOW = '2026-06-08T00:00:00.000Z';
const MERCHANT = 'mch_C6SA';
const OTHER_MERCHANT = 'mch_OTHER_C6SA';
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6saaaaaaaaaaaaaaaaaaaaaaaaaaa'].join('_');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

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
    id: 'cdry_C6SA',
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
      category_preset: 'electronics_appliances',
      variants: [{ sku: 'DJS-HG-SOFA-001', price_amount: 12999, currency: 'USD' }],
    }],
    blockers: [],
    warnings: [{ code: 'category_mapped_for_sandbox', row_index: 0, field: 'category' }],
    requested_audit_event_id: 'caud_C6R_REQUESTED',
    result_audit_event_id: 'caud_C6R_COMPLETED',
    generated_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function reviewDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrev_C6SA',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    dry_run_id: 'cdry_C6SA',
    status: 'pending_operator_review',
    decision: null,
    decision_note: null,
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    decided_by_operator_id: null,
    dry_run_status: 'passed',
    dry_run_generated_at: NOW,
    evidence_summary: {
      dry_run_id: 'cdry_C6SA',
      rows_received: 3,
      blocked_count: 0,
      warning_count: 3,
    },
    requested_audit_event_id: 'caud_C6SA_REQUESTED',
    decision_audit_event_id: null,
    sandbox_only: true,
    not_live: true,
    not_approved: true,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    provider_specific_live_enabled: false,
    production_allowlist_written: false,
    created_at: NOW,
    updated_at: NOW,
    decided_at: null,
    ...overrides,
  };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6SA',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  sqlMock.mockResolvedValueOnce([]);
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

describe('C6Sa connector dry-run review routes', () => {
  it('lets an operator request review for redacted sandbox dry-run evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SA_REQUESTED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([reviewDbRow()]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review-request`,
      headers: authHeader(),
      payload: { request_note: 'Please review this sandbox dry-run evidence.' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: Record<string, unknown>; dry_run: Record<string, unknown>; audit_event_id: string }>();
    expect(body.data).toMatchObject({
      review_id: 'cdrev_C6SA',
      status: 'pending_operator_review',
      dry_run_id: 'cdry_C6SA',
      dry_run_status: 'passed',
      requested_by: { kind: 'operator', id: 'dev_TEST' },
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        production_allowlist_written: false,
        review_is_production_approval: false,
      },
    });
    expect(body.dry_run).toMatchObject({ dry_run_id: 'cdry_C6SA', status: 'passed' });
    expect(body.audit_event_id).toBe('caud_C6SA_REQUESTED');
    expect(fullSqlCalls()).toContain('connector_dry_run_review_requested');
    expect(sqlText()).toContain('INSERT INTO commerce_connector_dry_run_reviews');
    expect(sqlText()).not.toMatch(/INSERT INTO commerce_products|commerce_product_variants|checkout_links|payment_intents/i);
  });

  it('lets an owning merchant read an existing review without deciding it', async () => {
    seedMerchantCaller(MERCHANT);
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow({ requested_by_kind: 'merchant', requested_by_id: 'mkey_C6SA' })]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review`,
      headers: bearer(MERCHANT_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      review_id: 'cdrev_C6SA',
      status: 'pending_operator_review',
      requested_by: { kind: 'merchant', id: 'mkey_C6SA' },
    });
  });

  it('records an operator-only sandbox follow-up decision without enabling commerce', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SA_DECISION', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([reviewDbRow({
      status: 'accepted_for_sandbox_followup',
      decision: 'accepted_for_sandbox_followup',
      decision_note: 'Safe sandbox follow-up only.',
      decided_by_operator_id: 'dev_TEST',
      decision_audit_event_id: 'caud_C6SA_DECISION',
      decided_at: NOW,
    })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review/decision`,
      headers: authHeader(),
      payload: {
        decision: 'accepted_for_sandbox_followup',
        decision_note: 'Safe sandbox follow-up only.',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string }>();
    expect(body.data).toMatchObject({
      status: 'accepted_for_sandbox_followup',
      decision: 'accepted_for_sandbox_followup',
      decided_by_operator_id: 'dev_TEST',
      controls: {
        review_is_production_approval: false,
        review_enables_connector_execution: false,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
      },
    });
    expect(body.audit_event_id).toBe('caud_C6SA_DECISION');
    expect(fullSqlCalls()).toContain('connector_dry_run_review_decision_recorded');
    expect(sqlText()).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true|INSERT INTO checkout_links|INSERT INTO payment_intents/i);
  });

  it('denies merchant callers on the operator decision route', async () => {
    seedMerchantCaller(MERCHANT);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review/decision`,
      headers: bearer(MERCHANT_TOKEN),
      payload: { decision: 'blocked', decision_note: 'Sandbox blocker remains.' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });

  it('blocks unsafe review requests and writes a blocked review audit event', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow({ environment: 'live', verification_status: 'verified' })]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SA_BLOCKED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review-request`,
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{ error: { code: string; audit_event_id: string; details: Record<string, unknown> } }>().error;
    expect(error.code).toBe('connector_dry_run_review_blocked');
    expect(error.audit_event_id).toBe('caud_C6SA_BLOCKED');
    expect(JSON.stringify(error.details)).toContain('live_merchant_mode_blocked');
    expect(fullSqlCalls()).toContain('connector_dry_run_review_blocked');
  });

  it('blocks accepting a blocked dry-run as sandbox follow-up', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ status: 'blocked', blocked_count: 1 })]);
    sqlMock.mockResolvedValueOnce([reviewDbRow({ dry_run_status: 'blocked' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SA_BLOCKED_DECISION', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SA/review/decision`,
      headers: authHeader(),
      payload: {
        decision: 'accepted_for_sandbox_followup',
        decision_note: 'This should not be accepted.',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; details: Record<string, unknown> } }>().error.code)
      .toBe('connector_dry_run_review_blocked');
    expect(fullSqlCalls()).toContain('blocked_dry_run_cannot_be_accepted');
    expect(sqlText()).not.toMatch(/UPDATE commerce_connector_dry_run_reviews/);
  });

  it('enforces merchant boundary before review read access', async () => {
    seedMerchantCaller(MERCHANT);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${OTHER_MERCHANT}/connectors/dry-runs/cdry_C6SA/review`,
      headers: bearer(MERCHANT_TOKEN),
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('C6Sa docs, migration, and OpenAPI drift guards', () => {
  it('declares review persistence as tenant-scoped and non-enabling', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS commerce_connector_dry_run_reviews');
    expect(migration).toContain('chk_commerce_connector_dry_run_reviews_non_enabling');
    expect(migration).toContain('public_discovery_enabled = FALSE');
    expect(migration).toContain('checkout_payment_enabled = FALSE');
    expect(migration).toContain('production_allowlist_written = FALSE');
    expect(migration).not.toMatch(/raw_payload JSONB|encrypted_secret|access_token|client_secret/i);
  });

  it('documents C6Sa as sandbox evidence review only', () => {
    const doc = readFileSync(docPath, 'utf8');
    const guide = readFileSync(guidePath, 'utf8');
    expect(doc).toContain('Traceability Checklist');
    expect(doc).toContain('operator review of C6R dry-run evidence');
    expect(doc).toContain('AgenticOrg never directly executes merchant private API calls');
    expect(guide).toContain('C6Sa adds an operator review foundation for C6R dry-run evidence');
    expect(`${doc}\n${guide}`).not.toMatch(/certification approved|production approved|public protocol publication approved|live payment approved/i);
  });

  it('declares C6Sa review APIs in OpenAPI as sandbox-only and non-enabling', () => {
    const content = readFileSync(openapiPath, 'utf8');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}/review-request');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}/review');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}/review/decision');
    expect(content).toMatch(/operationId:\s*requestCommerceConnectorDryRunReview/);
    expect(content).toMatch(/operationId:\s*getCommerceConnectorDryRunReview/);
    expect(content).toMatch(/operationId:\s*recordCommerceConnectorDryRunReviewDecision/);
    expect(content).toMatch(/x-milestone:\s*C6Sa/);
    expect(content).toMatch(/CommerceConnectorDryRunReview:/);
    expect(content).toMatch(/review_is_production_approval:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/review_enables_connector_execution:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
  });
});
