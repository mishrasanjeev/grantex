import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const openapiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-merchant-operator-guide.mdx');
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6sh-connector-remediation-queue-timeline.md',
);
const NOW = '2026-06-08T00:00:00.000Z';
const MERCHANT = 'mch_C6SH';
const OTHER_MERCHANT = 'mch_OTHER_C6SH';
const MERCHANT_TOKEN = ['grtx', 'sk', 'sandbox', 'c6shmmmmmmmmmmmmmmmmmmmmmmmm'].join('_');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function bearer(token: string): Record<string, string> {
  return { authorization: ['Bearer', token].join(' ') };
}

function remediationDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrem_C6SH',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    original_dry_run_id: 'cdry_C6SH_ORIGINAL',
    original_review_id: 'cdrev_C6SH_ORIGINAL',
    original_decision: 'needs_changes',
    status: 'remediation_requested',
    public_safe_note: 'Correct local sandbox rows only.',
    blocker_summary: [{ code: 'missing_category', remediation: 'Add a sandbox category mapping.' }],
    warning_summary: [{ code: 'operator_review_recommended', message: 'Review warning summary.' }],
    corrected_dry_run_id: null,
    followup_review_id: null,
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    requested_audit_event_id: 'caud_C6SH_REMEDIATION_REQUESTED',
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

function followupReviewDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cdrev_C6SH_FOLLOWUP',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    dry_run_id: 'cdry_C6SH_CORRECTED',
    status: 'accepted_for_sandbox_followup',
    decision: 'accepted_for_sandbox_followup',
    decision_note: 'Sandbox follow-up evidence is ready for operator review.',
    requested_by_kind: 'operator',
    requested_by_id: 'dev_TEST',
    decided_by_operator_id: 'dev_TEST_OPERATOR',
    dry_run_status: 'passed',
    dry_run_generated_at: '2026-06-08T00:03:00.000Z',
    evidence_summary: { blocked_count: 0, warning_count: 0 },
    requested_audit_event_id: 'caud_C6SH_FOLLOWUP_REVIEW_REQUESTED',
    decision_audit_event_id: 'caud_C6SH_FOLLOWUP_DECISION',
    sandbox_only: true,
    not_live: true,
    not_approved: true,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    provider_specific_live_enabled: false,
    production_allowlist_written: false,
    created_at: '2026-06-08T00:04:00.000Z',
    updated_at: '2026-06-08T00:07:00.000Z',
    decided_at: '2026-06-08T00:07:00.000Z',
    ...overrides,
  };
}

function seedMerchantCaller(merchantId = MERCHANT): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_C6SH',
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

describe('C6Sh connector remediation queue and timeline routes', () => {
  it('lists tenant-scoped operator queue entries with filters and non-enabling controls', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'corrected_dry_run_attached',
      corrected_dry_run_id: 'cdry_C6SH_CORRECTED',
      corrected_audit_event_id: 'caud_C6SH_CORRECTED_ATTACHED',
    })]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/connectors/remediations?merchant_id=${MERCHANT}&status=corrected_dry_run_attached&has_corrected_dry_run=true&has_followup_review=false&limit=10`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<Record<string, unknown>>;
      filters: Record<string, unknown>;
      controls: Record<string, unknown>;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      remediation_id: 'cdrem_C6SH',
      status: 'corrected_dry_run_attached',
      queue: {
        operator_queue_status: 'corrected_dry_run_attached',
        merchant_visible_status: 'corrected_dry_run_attached',
        requires_operator_followup: true,
        timeline_available: true,
        evidence_redacted: true,
      },
      summary: {
        blocker_count: 1,
        warning_count: 1,
        corrected_dry_run_attached: true,
        followup_review_requested: false,
        last_audit_event_id: 'caud_C6SH_CORRECTED_ATTACHED',
      },
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        remediation_is_production_approval: false,
        remediation_enables_connector_execution: false,
      },
    });
    expect(body.filters).toMatchObject({
      merchant_id: MERCHANT,
      status: 'corrected_dry_run_attached',
      has_corrected_dry_run: true,
      has_followup_review: false,
      limit: 10,
    });
    expect(body.controls).toMatchObject({
      sandbox_only: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      credential_entry_enabled: false,
      outbound_sync_enabled: false,
      production_connector_setup_enabled: false,
      provider_call_enabled: false,
      merchant_private_api_calls_enabled: false,
      production_allowlist_written: false,
    });
    expect(sqlText()).toContain('FROM commerce_connector_dry_run_remediations');
    expect(sqlText()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|commerce_audit_events|checkout_links|payment_intents/i);
  });

  it('lets merchant callers see only their own remediation queue', async () => {
    seedMerchantCaller(MERCHANT);
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow()]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/connectors/remediations',
      headers: bearer(MERCHANT_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ filters: Record<string, unknown>; items: unknown[] }>())
      .toMatchObject({ filters: { merchant_id: MERCHANT }, items: [expect.any(Object)] });

    sqlMock.mockClear();
    seedMerchantCaller(MERCHANT);
    const crossScope = await app.inject({
      method: 'GET',
      url: `/v1/commerce/connectors/remediations?merchant_id=${OTHER_MERCHANT}`,
      headers: bearer(MERCHANT_TOKEN),
    });
    expect(crossScope.statusCode).toBe(403);
    expect(fullSqlCalls()).not.toContain('commerce_connector_dry_run_remediations');
  });

  it('renders a redacted remediation timeline without runtime enablement semantics', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: MERCHANT }]);
    sqlMock.mockResolvedValueOnce([remediationDbRow({
      status: 'followup_ready',
      corrected_dry_run_id: 'cdry_C6SH_CORRECTED',
      followup_review_id: 'cdrev_C6SH_FOLLOWUP',
      corrected_audit_event_id: 'caud_C6SH_CORRECTED_ATTACHED',
      followup_audit_event_id: 'caud_C6SH_FOLLOWUP_REQUESTED',
      updated_at: '2026-06-08T00:08:00.000Z',
    })]);
    sqlMock.mockResolvedValueOnce([followupReviewDbRow()]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/merchants/${MERCHANT}/connectors/remediations/cdrem_C6SH/timeline`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const bodyText = res.body.toLowerCase();
    const body = res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      operator_queue: {
        queue_status: 'followup_ready',
        visible_to_operator: true,
        evidence_redacted: true,
      },
      merchant_status: {
        visible_to_merchant: true,
        status: 'followup_ready',
        corrected_dry_run_id: 'cdry_C6SH_CORRECTED',
        followup_review_id: 'cdrev_C6SH_FOLLOWUP',
      },
      redaction_summary: {
        raw_connector_rows_included: false,
        credentials_included: false,
        provider_metadata_included: false,
        merchant_private_api_payload_included: false,
        production_config_values_included: false,
      },
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        live_plural_enabled: false,
        credential_entry_enabled: false,
        outbound_sync_enabled: false,
        production_connector_setup_enabled: false,
        provider_call_enabled: false,
        merchant_private_api_calls_enabled: false,
        followup_ready_is_launch_approval: false,
      },
    });
    const timeline = body.data['timeline'] as Array<Record<string, unknown>>;
    expect(timeline.map((entry) => entry['key'])).toEqual([
      'remediation_requested',
      'corrected_dry_run_attached',
      'followup_review_requested',
      'followup_ready',
    ]);
    expect(timeline[2]).toMatchObject({
      key: 'followup_review_requested',
      audit_event_id: 'caud_C6SH_FOLLOWUP_REQUESTED',
    });
    expect(timeline[3]).toMatchObject({
      key: 'followup_ready',
      event_type: 'connector_dry_run_review_decision_recorded',
      occurred_at: '2026-06-08T00:07:00.000Z',
      audit_event_id: 'caud_C6SH_FOLLOWUP_DECISION',
      evidence_summary: {
        followup_review_decision: 'accepted_for_sandbox_followup',
        followup_ready_is_launch_approval: false,
        production_approval_granted: false,
      },
    });
    expect(bodyText).toContain('caud_c6sh_remediation_requested');
    expect(bodyText).toContain('caud_c6sh_corrected_attached');
    expect(bodyText).toContain('caud_c6sh_followup_decision');
    expect(bodyText).not.toMatch(/secret_value|access_token|checkout_url|payment_intent_id|provider_metadata"\s*:\s*\{|merchant_private_api_payload"\s*:\s*\{/);
    expect(sqlText()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|checkout_links|payment_intents/i);
  });

  it('rejects invalid queue filters fail-closed', async () => {
    seedCommerceContext();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/connectors/remediations?status=live&has_corrected_dry_run=yes&limit=500',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(422);
    const serialized = JSON.stringify(res.json());
    expect(serialized).toContain('status');
    expect(serialized).toContain('has_corrected_dry_run');
    expect(serialized).toContain('limit');
    expect(fullSqlCalls()).not.toContain('commerce_connector_dry_run_remediations');
  });
});

describe('C6Sh docs and OpenAPI drift guards', () => {
  it('documents remediation queue and timeline as sandbox-only evidence visibility', () => {
    const doc = readFileSync(docPath, 'utf8');
    const guide = readFileSync(guidePath, 'utf8');
    expect(doc).toContain('Traceability Checklist');
    expect(doc).toContain('tenant-scoped operator queue');
    expect(doc.toLowerCase()).toContain('redacted remediation timeline');
    expect(doc.toLowerCase()).toContain('merchant self-serve status visibility');
    expect(doc).toMatch(/AgenticOrg never directly executes\s+merchant private API calls/);
    expect(guide).toContain('C6Sh adds a tenant-scoped remediation queue and redacted evidence timeline');
    expect(`${doc}\n${guide}`).not.toMatch(/certification approved|production approved|public protocol publication approved|live payment approved/i);
  });

  it('declares C6Sh queue and timeline APIs in OpenAPI as non-enabling', () => {
    const content = readFileSync(openapiPath, 'utf8');
    expect(content).toContain('/v1/commerce/connectors/remediations');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/connectors/remediations/{remediation_id}/timeline');
    expect(content).toMatch(/operationId:\s*listCommerceConnectorDryRunRemediations/);
    expect(content).toMatch(/operationId:\s*getCommerceConnectorDryRunRemediationTimeline/);
    expect(content).toMatch(/x-milestone:\s*C6Sh/);
    expect(content).toMatch(/CommerceConnectorDryRunRemediationTimeline:/);
    expect(content).toMatch(/merchant_private_api_calls_enabled:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/followup_ready_is_launch_approval:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
  });
});
