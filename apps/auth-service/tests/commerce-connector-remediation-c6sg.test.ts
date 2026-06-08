import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const migrationPath = join(__dirname, '../src/db/migrations/055_commerce_connector_dry_run_remediations.sql');
const openapiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-merchant-operator-guide.mdx');
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6sg-connector-dry-run-remediation-persistence.md',
);
const NOW = '2026-06-08T00:00:00.000Z';
const MERCHANT = 'mch_C6SG';
const OTHER_MERCHANT = 'mch_OTHER_C6SG';
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6sgmmmmmmmmmmmmmmmmmmmmmmmm'].join('_');

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
    id: 'cdry_C6SG_ORIGINAL',
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
    warning_count: 1,
    normalized_preview: [],
    blockers: [],
    warnings: [{ code: 'category_mapped_for_sandbox', message: 'Fixture category mapped.' }],
    requested_audit_event_id: 'caud_C6R_REQUESTED',
    result_audit_event_id: 'caud_C6R_COMPLETED',
    generated_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function blockedDryRunDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dryRunDbRow({
    id: 'cdry_C6SG_BLOCKED',
    status: 'blocked',
    blocked_count: 1,
    blockers: [{
      code: 'missing_price',
      message: 'Price is required.',
      remediation: 'Add a public-safe price before follow-up.',
    }],
    result_audit_event_id: 'caud_C6R_BLOCKED',
    ...overrides,
  });
}

function reviewDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrev_C6SG_ORIGINAL',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    dry_run_id: 'cdry_C6SG_ORIGINAL',
    status: 'needs_changes',
    decision: 'needs_changes',
    decision_note: 'Fix category mapping and rerun the local sandbox dry-run.',
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    decided_by_operator_id: 'dev_TEST',
    dry_run_status: 'passed',
    dry_run_generated_at: NOW,
    evidence_summary: { dry_run_id: 'cdry_C6SG_ORIGINAL', rows_received: 3 },
    requested_audit_event_id: 'caud_C6SA_REQUESTED',
    decision_audit_event_id: 'caud_C6SA_NEEDS_CHANGES',
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
    decided_at: NOW,
    ...overrides,
  };
}

function remediationDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrem_C6SG',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    original_dry_run_id: 'cdry_C6SG_ORIGINAL',
    original_review_id: 'cdrev_C6SG_ORIGINAL',
    original_decision: 'needs_changes',
    status: 'remediation_requested',
    public_safe_note: 'Correct local sandbox rows only.',
    blocker_summary: [],
    warning_summary: [{ code: 'category_mapped_for_sandbox', message: 'Fixture category mapped.' }],
    corrected_dry_run_id: null,
    followup_review_id: null,
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    requested_audit_event_id: 'caud_C6SG_REMEDIATION_REQUESTED',
    corrected_audit_event_id: null,
    followup_audit_event_id: null,
    closed_or_blocked_audit_event_id: null,
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
    ...overrides,
  };
}

function followupReviewDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return reviewDbRow({
    id: 'cdrev_C6SG_FOLLOWUP',
    dry_run_id: 'cdry_C6SG_CORRECTED',
    status: 'pending_operator_review',
    decision: null,
    decision_note: null,
    decision_audit_event_id: null,
    decided_by_operator_id: null,
    requested_audit_event_id: 'caud_C6SG_FOLLOWUP_REVIEW_REQUESTED',
    decided_at: null,
    ...overrides,
  });
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6SG',
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

describe('C6Sg connector dry-run remediation persistence routes', () => {
  it('creates remediation from a needs_changes review with redacted audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow()]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_REMEDIATION_REQUESTED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: { public_safe_note: 'Correct local sandbox rows only.' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string }>();
    expect(body.data).toMatchObject({
      remediation_id: 'cdrem_C6SG',
      original_dry_run_id: 'cdry_C6SG_ORIGINAL',
      original_review_id: 'cdrev_C6SG_ORIGINAL',
      original_decision: 'needs_changes',
      status: 'remediation_requested',
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        production_allowlist_written: false,
        remediation_is_production_approval: false,
        remediation_enables_connector_execution: false,
      },
    });
    expect(body.audit_event_id).toBe('caud_C6SG_REMEDIATION_REQUESTED');
    expect(fullSqlCalls()).toContain('connector_remediation_requested');
    expect(sqlText()).toContain('INSERT INTO commerce_connector_dry_run_remediations');
    expect(sqlText()).not.toMatch(/checkout_links|payment_intents|provider_credentials|commerce_products/i);
  });

  it('creates remediation from a blocked review without treating it as production approval', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([blockedDryRunDbRow({ id: 'cdry_C6SG_ORIGINAL' })]);
    sqlMock.mockResolvedValueOnce([reviewDbRow({
      status: 'blocked',
      decision: 'blocked',
      original_decision: 'blocked',
      dry_run_status: 'blocked',
    })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_REMEDIATION_REQUESTED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({ original_decision: 'blocked' })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: { public_safe_note: 'Blocked sandbox issue needs local correction.' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      original_decision: 'blocked',
      controls: {
        remediation_is_production_approval: false,
        remediation_enables_connector_execution: false,
      },
    });
  });

  it('returns existing remediation without duplicate row or audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: { public_safe_note: 'Repeat request.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ audit_event_id: string }>().audit_event_id).toBe('caud_C6SG_REMEDIATION_REQUESTED');
    expect(fullSqlCalls()).not.toContain('connector_remediation_requested');
    expect(sqlText()).not.toContain('INSERT INTO commerce_connector_dry_run_remediations');
  });

  it('rejects accepted reviews, unsafe notes, wrong merchant scope, and live merchants', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow({
      status: 'accepted_for_sandbox_followup',
      decision: 'accepted_for_sandbox_followup',
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_REMEDIATION_BLOCKED', occurred_at: NOW }]);

    const acceptedRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: {},
    });
    expect(acceptedRes.statusCode).toBe(409);
    expect(JSON.stringify(acceptedRes.json())).toContain('original_review_not_remediable');

    seedCommerceContext();
    const unsafeRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: { public_safe_note: 'COMMERCE_PUBLIC_DISCOVERY_ENABLED should never be enabled.' },
    });
    expect(unsafeRes.statusCode).toBe(422);

    seedMerchantCaller(MERCHANT);
    const wrongMerchantRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${OTHER_MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: bearer(MERCHANT_TOKEN),
      payload: {},
    });
    expect(wrongMerchantRes.statusCode).toBe(403);

    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow({ environment: 'live', verification_status: 'verified' })]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow()]);
    sqlMock.mockResolvedValueOnce([reviewDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_REMEDIATION_BLOCKED_LIVE', occurred_at: NOW }]);
    const liveRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_ORIGINAL/remediation`,
      headers: authHeader(),
      payload: {},
    });
    expect(liveRes.statusCode).toBe(409);
    expect(JSON.stringify(liveRes.json())).toContain('live_merchant_mode_blocked');
  });

  it('attaches a corrected dry-run and keeps duplicate attachment idempotent', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ id: 'cdry_C6SG_CORRECTED' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_CORRECTED_ATTACHED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'corrected_dry_run_attached',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
      corrected_audit_event_id: 'caud_C6SG_CORRECTED_ATTACHED',
    })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/corrected-dry-run`,
      headers: authHeader(),
      payload: { corrected_dry_run_id: 'cdry_C6SG_CORRECTED', public_safe_note: 'Corrected local rows.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown>; audit_event_id: string }>().data).toMatchObject({
      status: 'corrected_dry_run_attached',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
    });
    expect(fullSqlCalls()).toContain('connector_remediation_corrected_dry_run_attached');

    sqlMock.mockClear();
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'corrected_dry_run_attached',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
      corrected_audit_event_id: 'caud_C6SG_CORRECTED_ATTACHED',
    })]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ id: 'cdry_C6SG_CORRECTED' })]);
    const duplicateRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/corrected-dry-run`,
      headers: authHeader(),
      payload: { corrected_dry_run_id: 'cdry_C6SG_CORRECTED' },
    });
    expect(duplicateRes.statusCode).toBe(200);
    expect(duplicateRes.json<{ audit_event_id: string }>().audit_event_id).toBe('caud_C6SG_CORRECTED_ATTACHED');
    expect(fullSqlCalls()).not.toContain('connector_remediation_corrected_dry_run_attached');
  });

  it('rejects blocked corrected dry-runs before follow-up review', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);
    sqlMock.mockResolvedValueOnce([blockedDryRunDbRow({ id: 'cdry_C6SG_CORRECTED_BLOCKED' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_CORRECTED_BLOCKED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/corrected-dry-run`,
      headers: authHeader(),
      payload: { corrected_dry_run_id: 'cdry_C6SG_CORRECTED_BLOCKED' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/corrected_dry_run_blocked|corrected_dry_run_has_blockers/);
    expect(fullSqlCalls()).toContain('connector_remediation_closed_or_blocked');
  });

  it('writes blocked audit when follow-up review is requested before corrected dry-run attachment', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_FOLLOWUP_MISSING_CORRECTION', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/follow-up-review`,
      headers: authHeader(),
      payload: { request_note: 'Please review corrected sandbox evidence.' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain('corrected_dry_run_missing');
    expect(JSON.stringify(res.json())).toContain('caud_C6SG_FOLLOWUP_MISSING_CORRECTION');
    expect(fullSqlCalls()).toContain('connector_remediation_closed_or_blocked');
  });

  it('requests follow-up review and reuses existing follow-up/audit on duplicates', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'corrected_dry_run_attached',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
      corrected_audit_event_id: 'caud_C6SG_CORRECTED_ATTACHED',
    })]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ id: 'cdry_C6SG_CORRECTED' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_FOLLOWUP_REVIEW_REQUESTED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([followupReviewDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_FOLLOWUP_ATTACHED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'followup_review_requested',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
      corrected_audit_event_id: 'caud_C6SG_CORRECTED_ATTACHED',
      followup_review_id: 'cdrev_C6SG_FOLLOWUP',
      followup_audit_event_id: 'caud_C6SG_FOLLOWUP_ATTACHED',
    })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/follow-up-review`,
      headers: authHeader(),
      payload: { request_note: 'Please review corrected sandbox evidence.' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: Record<string, unknown>; followup_review: Record<string, unknown> }>().data)
      .toMatchObject({ status: 'followup_review_requested', followup_review_id: 'cdrev_C6SG_FOLLOWUP' });
    expect(fullSqlCalls()).toContain('connector_dry_run_review_requested');
    expect(fullSqlCalls()).toContain('connector_remediation_followup_review_requested');

    sqlMock.mockClear();
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'followup_review_requested',
      corrected_dry_run_id: 'cdry_C6SG_CORRECTED',
      followup_review_id: 'cdrev_C6SG_FOLLOWUP',
      followup_audit_event_id: 'caud_C6SG_FOLLOWUP_ATTACHED',
    })]);
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ id: 'cdry_C6SG_CORRECTED' })]);
    sqlMock.mockResolvedValueOnce([followupReviewDbRow()]);
    const duplicateRes = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SG/follow-up-review`,
      headers: authHeader(),
      payload: { request_note: 'Repeat follow-up request.' },
    });
    expect(duplicateRes.statusCode).toBe(200);
    expect(duplicateRes.json<{ audit_event_id: string }>().audit_event_id).toBe('caud_C6SG_FOLLOWUP_ATTACHED');
    expect(fullSqlCalls()).not.toContain('connector_remediation_followup_review_requested');
  });

  it('updates linked remediation status when follow-up review decision is recorded', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([dryRunDbRow({ id: 'cdry_C6SG_CORRECTED' })]);
    sqlMock.mockResolvedValueOnce([followupReviewDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SG_FOLLOWUP_DECISION', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([followupReviewDbRow({
      status: 'accepted_for_sandbox_followup',
      decision: 'accepted_for_sandbox_followup',
      decision_note: 'Corrected sandbox follow-up only.',
      decided_by_operator_id: 'dev_TEST',
      decision_audit_event_id: 'caud_C6SG_FOLLOWUP_DECISION',
      decided_at: NOW,
    })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/dry-runs/cdry_C6SG_CORRECTED/review/decision`,
      headers: authHeader(),
      payload: {
        decision: 'accepted_for_sandbox_followup',
        decision_note: 'Corrected sandbox follow-up only.',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      review_id: 'cdrev_C6SG_FOLLOWUP',
      status: 'accepted_for_sandbox_followup',
    });
    expect(sqlText()).toContain('UPDATE commerce_connector_dry_run_remediations');
    expect(sqlText()).toContain('followup_review_id');
    expect(fullSqlCalls()).toContain('followup_ready');
  });
});

describe('C6Sg docs, migration, and OpenAPI drift guards', () => {
  it('declares remediation persistence as tenant-scoped and non-enabling', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS commerce_connector_dry_run_remediations');
    expect(migration).toContain('chk_commerce_connector_dry_run_remediations_non_enabling');
    expect(migration).toContain('public_discovery_enabled = FALSE');
    expect(migration).toContain('checkout_payment_enabled = FALSE');
    expect(migration).toContain('production_allowlist_written = FALSE');
    expect(migration).not.toMatch(/raw_payload JSONB|encrypted_secret|access_token|client_secret/i);
  });

  it('documents remediation persistence as sandbox evidence only', () => {
    const doc = readFileSync(docPath, 'utf8');
    const guide = readFileSync(guidePath, 'utf8');
    expect(doc).toContain('Traceability Checklist');
    expect(doc).toContain('tenant-scoped sandbox remediation');
    expect(doc).toContain('AgenticOrg never directly executes merchant private API calls');
    expect(guide).toContain('C6Sg persists the connector dry-run remediation loop');
    expect(`${doc}\n${guide}`).not.toMatch(/certification approved|production approved|public protocol publication approved|live payment approved/i);
  });

  it('declares C6Sg remediation APIs in OpenAPI as sandbox-only and non-enabling', () => {
    const content = readFileSync(openapiPath, 'utf8');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/dry-runs/{dry_run_id}/remediation');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/corrected-dry-run');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/follow-up-review');
    expect(content).toMatch(/operationId:\s*createCommerceConnectorDryRunRemediation/);
    expect(content).toMatch(/operationId:\s*attachCommerceConnectorRemediationCorrectedDryRun/);
    expect(content).toMatch(/operationId:\s*requestCommerceConnectorRemediationFollowUpReview/);
    expect(content).toMatch(/x-milestone:\s*C6Sg/);
    expect(content).toMatch(/CommerceConnectorDryRunRemediation:/);
    expect(content).toMatch(/remediation_is_production_approval:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/remediation_enables_connector_execution:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
  });
});
