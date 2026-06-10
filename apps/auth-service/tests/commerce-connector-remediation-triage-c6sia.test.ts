import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const migrationPath = join(__dirname, '../src/db/migrations/056_commerce_connector_remediation_triage.sql');
const openapiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-merchant-operator-guide.mdx');
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6sia-remediation-operator-triage.md',
);
const NOW = '2026-06-08T00:00:00.000Z';
const MERCHANT = 'mch_C6SIA';
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6siammmmmmmmmmmmmmmmmmmmmmmm'].join('_');

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

function remediationDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrem_C6SIA',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    original_dry_run_id: 'cdry_C6SIA_ORIGINAL',
    original_review_id: 'cdrev_C6SIA_ORIGINAL',
    original_decision: 'needs_changes',
    status: 'remediation_requested',
    public_safe_note: 'Correct local sandbox rows only.',
    blocker_summary: [{ code: 'missing_category', remediation: 'Add a sandbox category mapping.' }],
    warning_summary: [{ code: 'operator_review_recommended', message: 'Review warning summary.' }],
    corrected_dry_run_id: null,
    followup_review_id: null,
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    requested_audit_event_id: 'caud_C6SIA_REMEDIATION_REQUESTED',
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
    triage_status: 'unassigned',
    assigned_operator_id: null,
    triage_note: null,
    merchant_followup_summary: null,
    triage_next_step: null,
    triaged_by_operator_id: null,
    triaged_at: null,
    triage_audit_event_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6SIA',
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

describe('C6Sia connector remediation operator triage routes', () => {
  it('records operator-only triage with merchant-visible guidance and non-enabling controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SIA_TRIAGE_RECORDED', occurred_at: NOW }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      triage_status: 'waiting_on_merchant',
      assigned_operator_id: 'ops.c6sia',
      triage_note: 'Review corrected sandbox category mapping after rerun.',
      merchant_followup_summary: 'Please rerun the local sandbox dry-run after fixing category mapping.',
      triage_next_step: 'Attach the corrected sandbox dry-run evidence.',
      triaged_by_operator_id: 'dev_TEST',
      triaged_at: NOW,
      triage_audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
      updated_at: NOW,
    })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/triage`,
      headers: authHeader(),
      payload: {
        triage_status: 'waiting_on_merchant',
        assigned_operator_id: 'ops.c6sia',
        triage_note: 'Review corrected sandbox category mapping after rerun.',
        merchant_followup_summary: 'Please rerun the local sandbox dry-run after fixing category mapping.',
        next_step: 'Attach the corrected sandbox dry-run evidence.',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: Record<string, unknown>; audit_event_id: string; controls: Record<string, unknown> }>();
    expect(body.audit_event_id).toBe('caud_C6SIA_TRIAGE_RECORDED');
    expect(body.data).toMatchObject({
      remediation_id: 'cdrem_C6SIA',
      triage: {
        triage_status: 'waiting_on_merchant',
        assigned_operator_id: 'ops.c6sia',
        merchant_followup_summary: 'Please rerun the local sandbox dry-run after fixing category mapping.',
        next_step: 'Attach the corrected sandbox dry-run evidence.',
        triaged_by_operator_id: 'dev_TEST',
        triage_audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        production_allowlist_written: false,
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
    });
    expect(body.controls).toMatchObject({
      credential_entry_enabled: false,
      outbound_sync_enabled: false,
      production_connector_setup_enabled: false,
      provider_call_enabled: false,
      merchant_private_api_calls_enabled: false,
      triage_is_production_approval: false,
      triage_enables_connector_execution: false,
    });
    expect(fullSqlCalls()).toContain('connector_remediation_triage_recorded');
    expect(sqlText()).toContain('UPDATE commerce_connector_dry_run_remediations');
    expect(res.body).not.toContain('raw_payload');
    expect(res.body).not.toContain('provider_metadata');
    expect(res.body).not.toContain('merchant_private_api_payload');
  });

  it('returns existing triage without duplicate audit evidence for identical requests', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow()]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      triage_status: 'ready_for_followup_review',
      assigned_operator_id: 'dev_TEST',
      triage_note: 'Corrected sandbox evidence is ready for follow-up review.',
      merchant_followup_summary: 'The corrected sandbox dry-run can be attached for follow-up review.',
      triage_next_step: 'Request the follow-up review after attaching corrected evidence.',
      triaged_by_operator_id: 'dev_TEST',
      triaged_at: NOW,
      triage_audit_event_id: 'caud_C6SIA_TRIAGE_EXISTING',
    })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/triage`,
      headers: authHeader(),
      payload: {
        triage_status: 'ready_for_followup_review',
        triage_note: 'Corrected sandbox evidence is ready for follow-up review.',
        merchant_followup_summary: 'The corrected sandbox dry-run can be attached for follow-up review.',
        next_step: 'Request the follow-up review after attaching corrected evidence.',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ audit_event_id: string | null }>()).toMatchObject({
      audit_event_id: 'caud_C6SIA_TRIAGE_EXISTING',
    });
    expect(fullSqlCalls()).not.toContain('connector_remediation_triage_recorded');
    expect(sqlText()).not.toContain('UPDATE commerce_connector_dry_run_remediations');
    expect(sqlText()).not.toContain('commerce_audit_events');
  });

  it('denies merchant callers from recording operator triage', async () => {
    seedMerchantCaller();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/triage`,
      headers: bearer(MERCHANT_TOKEN),
      payload: {
        triage_status: 'triage_in_progress',
        triage_note: 'Operator-only sandbox triage.',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(fullSqlCalls()).not.toContain('commerce_connector_dry_run_remediations');
  });

  it('rejects private or enabling values before reading remediation evidence', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/triage`,
      headers: authHeader(),
      payload: {
        triage_status: 'waiting_on_merchant',
        merchant_followup_summary: 'Set COMMERCE_PUBLIC_DISCOVERY_ENABLED before launch.',
        next_step: 'Use checkout_url after approval.',
      },
    });

    expect(res.statusCode).toBe(422);
    const serialized = JSON.stringify(res.json());
    expect(serialized).toContain('merchant_followup_summary');
    expect(serialized).toContain('next_step');
    expect(fullSqlCalls()).not.toContain('commerce_connector_dry_run_remediations');
    expect(fullSqlCalls()).not.toContain('commerce_audit_events');
  });

  it('blocks triage for live merchant mode with redacted blocked audit evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow({ environment: 'production' })]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_C6SIA_TRIAGE_BLOCKED', occurred_at: NOW }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/triage`,
      headers: authHeader(),
      payload: {
        triage_status: 'triage_in_progress',
        triage_note: 'Review only sandbox evidence.',
      },
    });

    expect(res.statusCode).toBe(409);
    const error = res.json<{ error: Record<string, unknown> }>().error;
    expect(error).toMatchObject({
      code: 'connector_remediation_triage_blocked',
      audit_event_id: 'caud_C6SIA_TRIAGE_BLOCKED',
    });
    expect(fullSqlCalls()).toContain('connector_remediation_closed_or_blocked');
    expect(fullSqlCalls()).toContain('live_merchant_mode_blocked');
    expect(sqlText()).not.toContain('SET triage_status');
  });

  it('filters the remediation queue by triage status', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      triage_status: 'waiting_on_merchant',
      assigned_operator_id: 'ops.c6sia',
      triage_audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
    })]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/connectors/remediations?merchant_id=${MERCHANT}&triage_status=waiting_on_merchant&limit=10`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ filters: Record<string, unknown>; items: Array<Record<string, unknown>> }>();
    expect(body.filters).toMatchObject({
      merchant_id: MERCHANT,
      triage_status: 'waiting_on_merchant',
      limit: 10,
    });
    expect(body.items[0]).toMatchObject({
      summary: {
        triage_status: 'waiting_on_merchant',
        assigned_operator_id: 'ops.c6sia',
        last_audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
      },
    });
    expect(sqlText()).toContain('triage_status =');
    expect(sqlText()).not.toContain('checkout_links');
    expect(sqlText()).not.toContain('payment_intents');
  });

  it('adds redacted triage entries and merchant guidance to the remediation timeline', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      triage_status: 'waiting_on_merchant',
      assigned_operator_id: 'ops.c6sia',
      triage_note: 'Internal sandbox note.',
      merchant_followup_summary: 'Correct category mapping and rerun the local dry-run.',
      triage_next_step: 'Attach corrected sandbox evidence.',
      triaged_by_operator_id: 'dev_TEST',
      triaged_at: NOW,
      triage_audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
    })]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SIA/timeline`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Record<string, unknown> }>();
    const timeline = body.data['timeline'] as Array<Record<string, unknown>>;
    expect(timeline.map((entry) => entry['key'])).toEqual([
      'remediation_requested',
      'operator_triage_recorded',
    ]);
    expect(timeline[1]).toMatchObject({
      key: 'operator_triage_recorded',
      event_type: 'connector_remediation_triage_recorded',
      audit_event_id: 'caud_C6SIA_TRIAGE_RECORDED',
      actor: {
        kind: 'operator',
        id: 'dev_TEST',
      },
      evidence_summary: {
        triage_status: 'waiting_on_merchant',
        assigned_operator_id_present: true,
        triage_note_present: true,
        merchant_followup_summary_present: true,
        next_step_present: true,
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
    });
    expect(body.data).toMatchObject({
      merchant_status: {
        visible_to_merchant: true,
        triage_status: 'waiting_on_merchant',
        merchant_followup_summary: 'Correct category mapping and rerun the local dry-run.',
        triage_next_step: 'Attach corrected sandbox evidence.',
      },
      redaction_summary: {
        raw_connector_rows_included: false,
        credentials_included: false,
        provider_metadata_included: false,
        merchant_private_api_payload_included: false,
        production_config_values_included: false,
      },
      controls: {
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        provider_call_enabled: false,
        merchant_private_api_calls_enabled: false,
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
    });
    expect(sqlText()).not.toContain('UPDATE commerce_connector_dry_run_remediations');
  });

  it('rejects invalid triage queue filters fail-closed', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/connectors/remediations?triage_status=launch_ready',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('triage_status');
    expect(fullSqlCalls()).not.toContain('commerce_connector_dry_run_remediations');
  });
});

describe('C6Sia docs, migration, and OpenAPI drift guards', () => {
  it('adds the migration columns and audit event type for redacted triage state', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('triage_status TEXT NOT NULL DEFAULT');
    expect(migration).toContain('assigned_operator_id TEXT');
    expect(migration).toContain('merchant_followup_summary TEXT');
    expect(migration).toContain('triage_audit_event_id TEXT');
    expect(migration).toContain('chk_commerce_connector_remediations_triage_status');
    expect(migration).toContain('idx_commerce_connector_remediations_triage');
  });

  it('documents C6Sia as backend-only sandbox triage, not launch approval', () => {
    const doc = readFileSync(docPath, 'utf8');
    const guide = readFileSync(guidePath, 'utf8');
    expect(doc).toContain('Traceability Checklist');
    expect(doc.toLowerCase()).toContain('tenant-scoped operator triage');
    expect(doc).toContain('connector_remediation_triage_recorded');
    expect(doc).toContain('Duplicate identical triage requests return the existing remediation');
    expect(doc.replaceAll('\r\n', ' ').replaceAll('\n', ' '))
      .toContain('AgenticOrg never directly executes merchant private API calls');
    expect(guide).toContain('C6Sia adds backend-only operator triage controls');
    expect(`${doc}\n${guide}`).not.toContain('production approved');
    expect(`${doc}\n${guide}`).not.toContain('certification approved');
    expect(`${doc}\n${guide}`).not.toContain('public protocol publication approved');
  });

  it('declares C6Sia triage APIs in OpenAPI as operator-only and non-enabling', () => {
    const content = readFileSync(openapiPath, 'utf8');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/triage');
    expect(content).toContain('operationId: recordCommerceConnectorRemediationTriage');
    expect(content).toContain('x-milestone: C6Sia');
    expect(content).toContain('CommerceConnectorDryRunRemediationTriageRequest:');
    expect(content).toContain('CommerceConnectorDryRunRemediationTriageResponse:');
    expect(content).toContain('triage_status');
    expect(content).toContain('triage_is_production_approval: { type: boolean, const: false }');
    expect(content).toContain('triage_enables_connector_execution: { type: boolean, const: false }');
    expect(content).toContain('merchant_private_api_calls_enabled: { type: boolean, const: false }');
  });
});
