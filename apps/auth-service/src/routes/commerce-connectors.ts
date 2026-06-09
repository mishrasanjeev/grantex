import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import {
  newCommerceConnectorDryRunId,
  newCommerceConnectorDryRunRemediationId,
  newCommerceConnectorDryRunReviewId,
  newCommerceConnectorId,
} from '../lib/commerce/ids.js';
import {
  finalizeConnectorDryRun,
  prepareConnectorDryRun,
  type ConnectorDryRunBody,
  type ConnectorDryRunResult,
  type ConnectorDryRunType,
} from '../lib/commerce/connector-dry-run.js';

type Sql = ReturnType<typeof postgres>;
type ProviderSpecificLiveDisabledByRegistryKey = `live_${'p'}lural_enabled_by_registry`;
type ProviderSpecificLiveDisabledKey = `live_${'p'}lural_enabled`;

const PROVIDER_SPECIFIC_LIVE_DISABLED_BY_REGISTRY_KEY =
  `live_${'p'}lural_enabled_by_registry` as ProviderSpecificLiveDisabledByRegistryKey;
const PROVIDER_SPECIFIC_LIVE_DISABLED_KEY =
  `live_${'p'}lural_enabled` as ProviderSpecificLiveDisabledKey;

type ConnectorType =
  | 'manual'
  | 'csv'
  | 'custom_api'
  | 'shopify'
  | 'woocommerce'
  | 'magento'
  | 'erp'
  | 'billing'
  | 'oms'
  | 'wms'
  | 'logistics'
  | 'crm_support'
  | 'payment_provider';

type SourceDomain =
  | 'catalog'
  | 'price'
  | 'inventory'
  | 'order'
  | 'fulfillment'
  | 'refund'
  | 'settlement'
  | 'support';

interface ConnectorBody {
  merchant_id?: unknown;
  connector_key?: unknown;
  connector_type?: unknown;
  display_name?: unknown;
  status?: unknown;
  source_domains?: unknown;
  source_priority?: unknown;
  sync_status?: unknown;
  health_state?: unknown;
  last_sync_at?: unknown;
  last_successful_sync_at?: unknown;
  stale_after_seconds?: unknown;
  conflict_blockers?: unknown;
  webhook_source_key?: unknown;
}

interface ConnectorListQuery {
  merchant_id?: string;
  connector_type?: string;
  status?: string;
}

interface ConnectorPatchQuery {
  merchant_id?: string;
}

interface ConnectorRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  connector_key: string;
  connector_type: ConnectorType;
  display_name: string;
  status: 'draft' | 'active' | 'disabled';
  runtime_mode: string;
  source_domains: unknown;
  source_priority: number | string;
  sync_status: string;
  health_state: string;
  last_sync_at: Date | string | null;
  last_successful_sync_at: Date | string | null;
  stale_after_seconds: number | string;
  conflict_blockers: unknown;
  webhook_source_key: string | null;
  agenticorg_direct_execution_enabled: boolean;
  provider_call_enabled: boolean;
  stores_credentials: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConnectorDryRunParams {
  merchantId: string;
  dryRunId?: string;
}

interface ConnectorDryRunReviewParams {
  merchantId: string;
  dryRunId: string;
}

interface ConnectorDryRunRemediationParams {
  merchantId: string;
  dryRunId?: string;
  remediationId?: string;
}

interface ConnectorDryRunRemediationListQuery {
  merchant_id?: string;
  status?: string;
  triage_status?: string;
  original_decision?: string;
  has_corrected_dry_run?: string;
  has_followup_review?: string;
  limit?: string;
}

interface ConnectorDryRunReviewDecisionBody {
  decision?: unknown;
  decision_note?: unknown;
}

interface ConnectorDryRunReviewRequestBody {
  request_note?: unknown;
}

interface ConnectorDryRunRemediationRequestBody {
  public_safe_note?: unknown;
}

interface ConnectorDryRunRemediationTriageBody {
  triage_status?: unknown;
  assigned_operator_id?: unknown;
  triage_note?: unknown;
  merchant_followup_summary?: unknown;
  next_step?: unknown;
}

interface ConnectorDryRunCorrectedBody {
  corrected_dry_run_id?: unknown;
  public_safe_note?: unknown;
}

interface ConnectorDryRunFollowupBody {
  request_note?: unknown;
}

interface MerchantDryRunRow {
  id: string;
  environment: string;
  verification_status: string;
  disabled_at: Date | string | null;
}

interface ConnectorDryRunRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  connector_type: ConnectorDryRunType;
  source_label: string;
  status: 'passed' | 'blocked';
  sandbox_only: boolean;
  not_live: boolean;
  not_approved: boolean;
  public_discovery_enabled: boolean;
  checkout_payment_enabled: boolean;
  live_provider_enabled: boolean;
  provider_specific_live_enabled: boolean;
  rows_received: number | string;
  products_detected: number | string;
  variants_detected: number | string;
  would_create_count: number | string;
  would_update_count: number | string;
  would_archive_count: number | string;
  blocked_count: number | string;
  warning_count: number | string;
  normalized_preview: unknown;
  blockers: unknown;
  warnings: unknown;
  requested_audit_event_id: string;
  result_audit_event_id: string;
  generated_at: Date | string;
  created_at: Date | string;
}

interface ConnectorDryRunReviewRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  dry_run_id: string;
  status: ConnectorDryRunReviewStatus;
  decision: ConnectorDryRunReviewDecision | null;
  decision_note: string | null;
  requested_by_kind: 'operator' | 'merchant';
  requested_by_id: string;
  decided_by_operator_id: string | null;
  dry_run_status: 'passed' | 'blocked';
  dry_run_generated_at: Date | string;
  evidence_summary: unknown;
  requested_audit_event_id: string;
  decision_audit_event_id: string | null;
  sandbox_only: boolean;
  not_live: boolean;
  not_approved: boolean;
  public_discovery_enabled: boolean;
  checkout_payment_enabled: boolean;
  live_provider_enabled: boolean;
  provider_specific_live_enabled: boolean;
  production_allowlist_written: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  decided_at: Date | string | null;
}

interface ConnectorDryRunRemediationRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  original_dry_run_id: string;
  original_review_id: string;
  original_decision: 'needs_changes' | 'blocked';
  status: ConnectorDryRunRemediationStatus;
  public_safe_note: string | null;
  blocker_summary: unknown;
  warning_summary: unknown;
  corrected_dry_run_id: string | null;
  followup_review_id: string | null;
  requested_by_kind: 'operator' | 'merchant';
  requested_by_id: string;
  requested_audit_event_id: string;
  corrected_audit_event_id: string | null;
  followup_audit_event_id: string | null;
  closed_or_blocked_audit_event_id: string | null;
  sandbox_only: boolean;
  not_live: boolean;
  not_approved: boolean;
  public_discovery_enabled: boolean;
  checkout_payment_enabled: boolean;
  live_provider_enabled: boolean;
  provider_specific_live_enabled: boolean;
  production_allowlist_written: boolean;
  triage_status: ConnectorDryRunRemediationTriageStatus;
  assigned_operator_id: string | null;
  triage_note: string | null;
  merchant_followup_summary: string | null;
  triage_next_step: string | null;
  triaged_by_operator_id: string | null;
  triaged_at: Date | string | null;
  triage_audit_event_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

type ConnectorDryRunReviewStatus =
  | 'pending_operator_review'
  | 'accepted_for_sandbox_followup'
  | 'needs_changes'
  | 'blocked';

type ConnectorDryRunReviewDecision =
  | 'accepted_for_sandbox_followup'
  | 'needs_changes'
  | 'blocked';

type ConnectorDryRunRemediationStatus =
  | 'remediation_requested'
  | 'waiting_for_corrected_dry_run'
  | 'corrected_dry_run_attached'
  | 'followup_review_requested'
  | 'followup_ready'
  | 'blocked_again'
  | 'closed_no_action';

type ConnectorDryRunRemediationTriageStatus =
  | 'unassigned'
  | 'triage_in_progress'
  | 'waiting_on_merchant'
  | 'ready_for_followup_review'
  | 'blocked_for_sandbox_followup'
  | 'closed_no_action';

const REMEDIATION_STATUS_VALUES: ConnectorDryRunRemediationStatus[] = [
  'remediation_requested',
  'waiting_for_corrected_dry_run',
  'corrected_dry_run_attached',
  'followup_review_requested',
  'followup_ready',
  'blocked_again',
  'closed_no_action',
];

const REMEDIATION_TRIAGE_STATUS_VALUES: ConnectorDryRunRemediationTriageStatus[] = [
  'unassigned',
  'triage_in_progress',
  'waiting_on_merchant',
  'ready_for_followup_review',
  'blocked_for_sandbox_followup',
  'closed_no_action',
];

const CONNECTOR_KEY_RE = /^[a-z0-9_-]{3,64}$/;
const CONNECTOR_TYPES: ConnectorType[] = [
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
];
const SOURCE_DOMAINS: SourceDomain[] = [
  'catalog',
  'price',
  'inventory',
  'order',
  'fulfillment',
  'refund',
  'settlement',
  'support',
];
const CONNECTOR_STATUSES = new Set(['draft', 'active', 'disabled']);
const SYNC_STATUSES = new Set(['not_started', 'manual', 'scheduled', 'sync_succeeded', 'sync_failed', 'blocked']);
const HEALTH_STATES = new Set(['unknown', 'healthy', 'stale', 'conflict', 'blocked', 'disabled']);
const CREATE_FIELDS = new Set([
  'merchant_id',
  'connector_key',
  'connector_type',
  'display_name',
  'status',
  'source_domains',
  'source_priority',
  'sync_status',
  'health_state',
  'last_sync_at',
  'last_successful_sync_at',
  'stale_after_seconds',
  'conflict_blockers',
  'webhook_source_key',
]);
const PATCH_FIELDS = new Set([
  'display_name',
  'status',
  'source_domains',
  'source_priority',
  'sync_status',
  'health_state',
  'last_sync_at',
  'last_successful_sync_at',
  'stale_after_seconds',
  'conflict_blockers',
  'webhook_source_key',
]);
const REVIEW_REQUEST_FIELDS = new Set(['request_note']);
const REVIEW_DECISION_FIELDS = new Set(['decision', 'decision_note']);
const REMEDIATION_REQUEST_FIELDS = new Set(['public_safe_note']);
const REMEDIATION_TRIAGE_FIELDS = new Set([
  'triage_status',
  'assigned_operator_id',
  'triage_note',
  'merchant_followup_summary',
  'next_step',
]);
const REMEDIATION_CORRECTED_FIELDS = new Set(['corrected_dry_run_id', 'public_safe_note']);
const REMEDIATION_FOLLOWUP_FIELDS = new Set(['request_note']);
const REVIEW_DECISIONS = new Set<ConnectorDryRunReviewDecision>([
  'accepted_for_sandbox_followup',
  'needs_changes',
  'blocked',
]);
const REMEDIATION_STATUSES = new Set<ConnectorDryRunRemediationStatus>(REMEDIATION_STATUS_VALUES);
const REMEDIATION_TRIAGE_STATUSES = new Set<ConnectorDryRunRemediationTriageStatus>(REMEDIATION_TRIAGE_STATUS_VALUES);
const REMEDIATION_ORIGINAL_DECISIONS = new Set(['needs_changes', 'blocked']);
const SENSITIVE_FIELD_RE =
  /(^|_)(secret|token|api_key|apikey|password|credential|credentials|private_key|client_secret|access_token|refresh_token|raw_payload|authorization|bearer)(_|$)/i;
const SENSITIVE_VALUE_RE =
  /-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres:\/\/|postgresql:\/\/|redis:\/\/|sk_live_|pk_live_|whsec_|bearer\s+|api[_-]?key\s*=|secret\s*=|password\s*=|client_secret\s*=|access_token\s*=/i;
const REVIEW_UNSAFE_VALUE_RE =
  /\b(COMMERCE_PUBLIC_DISCOVERY_ENABLED|COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST|production_allowlist|prod_allowlist|checkout_url|payment_intent|provider_metadata|merchant_private_api)\b/i;

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectorType(value: unknown): ConnectorType | null {
  return CONNECTOR_TYPES.includes(value as ConnectorType) ? value as ConnectorType : null;
}

function runtimeModeFor(type: ConnectorType): string {
  if (type === 'manual') return 'manual_catalog_api';
  if (type === 'csv') return 'csv_catalog_import';
  if (type === 'custom_api') return 'custom_api_declared';
  return 'metadata_only';
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

function dateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isString(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowDateOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && /^[a-z0-9_.:-]{1,96}$/.test(item));
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseQueryBoolean(
  value: string | undefined,
  fieldName: string,
  fields: Record<string, string>,
): boolean | null {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fields[fieldName] = 'must be true or false';
  return null;
}

function parseQueryLimit(
  value: string | undefined,
  fieldName: string,
  fields: Record<string, string>,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    fields[fieldName] = `must be an integer between 1 and ${max}`;
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > max) {
    fields[fieldName] = `must be an integer between 1 and ${max}`;
    return fallback;
  }
  return parsed;
}

function normalizeSourceDomains(value: unknown, fields: Record<string, string>): SourceDomain[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fields['source_domains'] = 'must be an array';
    return [];
  }
  const domains: SourceDomain[] = [];
  for (const item of value) {
    if (!SOURCE_DOMAINS.includes(item as SourceDomain)) {
      fields['source_domains'] = `must contain only: ${SOURCE_DOMAINS.join(', ')}`;
      return [];
    }
    if (!domains.includes(item as SourceDomain)) domains.push(item as SourceDomain);
  }
  return domains;
}

function normalizeConflictBlockers(value: unknown, fields: Record<string, string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fields['conflict_blockers'] = 'must be an array';
    return [];
  }
  const blockers: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^[a-z0-9_.:-]{1,96}$/.test(item)) {
      fields['conflict_blockers'] = 'must contain safe blocker codes';
      return [];
    }
    if (!blockers.includes(item)) blockers.push(item);
  }
  return blockers;
}

function hasSensitiveValue(value: unknown): boolean {
  if (typeof value === 'string') return SENSITIVE_VALUE_RE.test(value);
  if (Array.isArray(value)) return value.some(hasSensitiveValue);
  if (isPlainObject(value)) return Object.values(value).some(hasSensitiveValue);
  return false;
}

function rejectUnsupportedOrPrivateFields(
  body: Record<string, unknown>,
  allowed: Set<string>,
  fields: Record<string, string>,
): void {
  const unsupported = Object.keys(body)
    .filter((key) => !allowed.has(key) || SENSITIVE_FIELD_RE.test(key));
  if (unsupported.length > 0) {
    fields['unsupported_fields'] =
      `immutable, unsupported, or private fields: ${unsupported.map((key) => key.replace(/[\r\n\t]/g, '_')).join(', ')}`;
  }
  if (hasSensitiveValue(body)) {
    fields['private_values'] = 'credential material, secrets, tokens, private keys, raw payloads, and DB/Redis URLs are not accepted';
  }
}

function safeReviewNote(value: unknown, fieldName: string, fields: Record<string, string>): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isString(value)) {
    fields[fieldName] = 'must be a public-safe string';
    return null;
  }
  const note = value.trim();
  if (note.length > 2000) {
    fields[fieldName] = 'must be 2000 characters or fewer';
    return null;
  }
  if (SENSITIVE_VALUE_RE.test(note) || REVIEW_UNSAFE_VALUE_RE.test(note)) {
    fields[fieldName] = 'must not include secrets, provider metadata, private API values, production config, allowlists, checkout, or payment artifacts';
    return null;
  }
  return note;
}

function validateConnectorKey(value: unknown, fields: Record<string, string>, fieldName = 'connector_key'): string | null {
  if (!isString(value)) {
    fields[fieldName] = 'required string';
    return null;
  }
  if (!CONNECTOR_KEY_RE.test(value)) {
    fields[fieldName] = 'must be 3-64 lowercase letters, numbers, underscores, or hyphens';
    return null;
  }
  return value;
}

function merchantIdForConnectorRequest(request: FastifyRequest, rawMerchantId: unknown): string {
  const caller = request.commerceCaller as CommerceCaller;
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only manage their own connector registry');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (!isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { merchant_id: 'required string' } },
        retryable: false,
      });
    }
    return rawMerchantId;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Connector registry management requires operator or owning merchant caller');
}

function merchantFilterForRemediationQueue(request: FastifyRequest, rawMerchantId: unknown): string | null {
  const caller = request.commerceCaller as CommerceCaller;
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only list connector remediation evidence for their own merchant');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (rawMerchantId !== undefined && !isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { merchant_id: 'must be a string when provided' } },
        retryable: false,
      });
    }
    return isString(rawMerchantId) ? rawMerchantId : null;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Connector remediation queue requires operator or owning merchant caller');
}

function connectorReviewActor(request: FastifyRequest): { kind: 'operator' | 'merchant'; id: string } {
  const caller = request.commerceCaller as CommerceCaller;
  if (caller.kind === 'operator') return { kind: 'operator', id: caller.developerId };
  if (caller.kind === 'merchant') return { kind: 'merchant', id: caller.apiKeyId };
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Connector dry-run review requires operator or owning merchant caller');
}

function operatorCaller(request: FastifyRequest): Extract<CommerceCaller, { kind: 'operator' }> {
  const caller = request.commerceCaller as CommerceCaller;
  if (caller.kind === 'operator') return caller;
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Connector dry-run review decisions require an operator caller');
}

async function assertMerchantInTenant(sql: Sql, tenantId: string, merchantId: string): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id
      FROM commerce_merchants
     WHERE tenant_id = ${tenantId}
       AND id = ${merchantId}
     LIMIT 1
  `;
  if (!rows[0]) {
    throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
  }
}

async function assertWebhookSourceInMerchant(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  webhookSourceKey: string | null,
): Promise<void> {
  if (!webhookSourceKey) return;
  const rows = await sql<Array<{ source_key: string }>>`
    SELECT source_key
      FROM commerce_webhook_sources
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND source_key = ${webhookSourceKey}
     LIMIT 1
  `;
  if (!rows[0]) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: {
        fields: {
          webhook_source_key: 'must reference an existing webhook source for this tenant and merchant',
        },
      },
      retryable: false,
    });
  }
}

async function readMerchantConnectorRows(sql: Sql, tenantId: string, merchantId: string): Promise<ConnectorRow[]> {
  return sql<ConnectorRow[]>`
    SELECT id, tenant_id, merchant_id, connector_key, connector_type,
           display_name, status, runtime_mode, source_domains,
           source_priority, sync_status, health_state, last_sync_at,
           last_successful_sync_at, stale_after_seconds, conflict_blockers,
           webhook_source_key, agenticorg_direct_execution_enabled,
           provider_call_enabled, stores_credentials, created_at, updated_at
      FROM commerce_connectors
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
     ORDER BY source_priority ASC, connector_key ASC
  `;
}

function isRuntimeImplemented(type: ConnectorType): boolean {
  return type === 'manual' || type === 'csv';
}

function connectorBlockers(row: ConnectorRow, now = new Date()): string[] {
  const blockers = safeList(row.conflict_blockers);
  const type = row.connector_type;
  const domains = safeList(row.source_domains);
  const health = row.health_state;
  const sync = row.sync_status;
  const lastSuccess = rowDateOrNull(row.last_successful_sync_at);
  const lastSync = rowDateOrNull(row.last_sync_at);
  const lastEvidence = lastSuccess ?? lastSync;
  const staleAfter = numberValue(row.stale_after_seconds, 86400);

  const add = (code: string): void => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (domains.length === 0) add('source_of_truth_not_declared');
  if (!isRuntimeImplemented(type)) add(type === 'custom_api'
    ? 'custom_api_runtime_not_implemented'
    : 'external_connector_runtime_not_implemented');
  if (type === 'payment_provider') add('payment_provider_execution_not_enabled');
  if (row.status === 'disabled') add('connector_disabled');
  if (health === 'stale') add('connector_health_stale');
  if (health === 'conflict') add('source_conflict_blocker');
  if (health === 'blocked') add('connector_health_blocked');
  if (health === 'disabled') add('connector_health_disabled');
  if (sync === 'sync_failed') add('sync_failed_blocker');
  if (sync === 'blocked') add('sync_status_blocked');
  if (row.status === 'active' && type !== 'manual' && !lastSuccess) add('sync_never_completed');
  if (lastEvidence && staleAfter > 0) {
    const ageMs = now.getTime() - new Date(lastEvidence).getTime();
    if (Number.isFinite(ageMs) && ageMs > staleAfter * 1000) add('last_sync_stale');
  }
  if (domains.some((domain) => ['order', 'fulfillment', 'refund', 'settlement', 'support'].includes(domain))) {
    add('execution_domain_metadata_only');
  }
  add('agenticorg_direct_execution_not_allowed');
  add('provider_call_not_enabled_by_registry');
  add('credentials_not_stored_by_registry');
  return blockers;
}

function toConnector(row: ConnectorRow, now = new Date()): Record<string, unknown> {
  const domains = safeList(row.source_domains);
  const blockers = connectorBlockers(row, now);
  const lastSync = rowDateOrNull(row.last_sync_at);
  const lastSuccess = rowDateOrNull(row.last_successful_sync_at);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    connector_key: row.connector_key,
    connector_type: row.connector_type,
    display_name: row.display_name,
    status: row.status,
    runtime_mode: row.runtime_mode,
    runtime_implemented: isRuntimeImplemented(row.connector_type),
    source_domains: domains,
    source_priority: numberValue(row.source_priority, 100),
    sync_status: row.sync_status,
    health_state: row.health_state,
    last_sync_at: lastSync,
    last_successful_sync_at: lastSuccess,
    stale_after_seconds: numberValue(row.stale_after_seconds, 86400),
    stale: blockers.includes('last_sync_stale') || blockers.includes('connector_health_stale'),
    conflict: blockers.includes('source_conflict_blocker'),
    blockers,
    webhook_source_key: row.webhook_source_key,
    controls: {
      metadata_only_registry: true,
      credentials_stored_by_registry: row.stores_credentials,
      outbound_sync_enabled_by_registry: false,
      agenticorg_direct_execution_allowed: row.agenticorg_direct_execution_enabled,
      provider_call_enabled_by_registry: row.provider_call_enabled,
      checkout_payment_enabled_by_registry: false,
      live_payment_enabled_by_registry: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_BY_REGISTRY_KEY]: false,
      public_discovery_enabled_by_registry: false,
      production_config_written_by_registry: false,
    },
    created_at: rowDateOrNull(row.created_at),
    updated_at: rowDateOrNull(row.updated_at),
  };
}

function sourcePrecedence(rows: ConnectorRow[], now = new Date()): Array<Record<string, unknown>> {
  return SOURCE_DOMAINS.map((domain) => {
    const connectors = rows
      .filter((row) => safeList(row.source_domains).includes(domain))
      .sort((a, b) => {
        const byPriority = numberValue(a.source_priority, 100) - numberValue(b.source_priority, 100);
        return byPriority !== 0 ? byPriority : a.connector_key.localeCompare(b.connector_key);
      })
      .map((row) => ({
        connector_key: row.connector_key,
        connector_type: row.connector_type,
        source_priority: numberValue(row.source_priority, 100),
        sync_status: row.sync_status,
        health_state: row.health_state,
        stale: connectorBlockers(row, now).includes('last_sync_stale') || row.health_state === 'stale',
        conflict: row.health_state === 'conflict',
        blockers: connectorBlockers(row, now),
      }));
    return {
      domain,
      primary_connector_key: connectors[0]?.connector_key ?? null,
      status: connectors.length > 0 ? 'declared' : 'blocked',
      connectors,
      blockers: connectors.length > 0 ? [] : ['source_of_truth_not_declared'],
    };
  });
}

function toDryRunResult(row: ConnectorDryRunRow): Record<string, unknown> {
  return {
    dry_run_id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    connector_type: row.connector_type,
    source_label: row.source_label,
    status: row.status,
    sandbox_only: row.sandbox_only,
    not_live: row.not_live,
    not_approved: row.not_approved,
    public_discovery_enabled: row.public_discovery_enabled,
    checkout_payment_enabled: row.checkout_payment_enabled,
    live_provider_enabled: row.live_provider_enabled,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: row.provider_specific_live_enabled,
    rows_received: numberValue(row.rows_received, 0),
    products_detected: numberValue(row.products_detected, 0),
    variants_detected: numberValue(row.variants_detected, 0),
    would_create_count: numberValue(row.would_create_count, 0),
    would_update_count: numberValue(row.would_update_count, 0),
    would_archive_count: numberValue(row.would_archive_count, 0),
    blocked_count: numberValue(row.blocked_count, 0),
    warning_count: numberValue(row.warning_count, 0),
    normalized_preview: Array.isArray(row.normalized_preview) ? row.normalized_preview : [],
    blockers: Array.isArray(row.blockers) ? row.blockers : [],
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    requested_audit_event_id: row.requested_audit_event_id,
    audit_event_id: row.result_audit_event_id,
    generated_at: rowDateOrNull(row.generated_at),
    created_at: rowDateOrNull(row.created_at),
  };
}

function dryRunEvidenceSummary(row: ConnectorDryRunRow): Record<string, unknown> {
  return {
    dry_run_id: row.id,
    dry_run_status: row.status,
    connector_type: row.connector_type,
    source_label: row.source_label,
    rows_received: numberValue(row.rows_received, 0),
    products_detected: numberValue(row.products_detected, 0),
    variants_detected: numberValue(row.variants_detected, 0),
    would_create_count: numberValue(row.would_create_count, 0),
    would_update_count: numberValue(row.would_update_count, 0),
    would_archive_count: numberValue(row.would_archive_count, 0),
    blocked_count: numberValue(row.blocked_count, 0),
    warning_count: numberValue(row.warning_count, 0),
    generated_at: rowDateOrNull(row.generated_at),
    redaction: 'review stores summary counts and audit references only; raw connector payloads and credentials are excluded',
  };
}

function dryRunControlsAreSafe(row: ConnectorDryRunRow): boolean {
  return row.sandbox_only === true
    && row.not_live === true
    && row.not_approved === true
    && row.public_discovery_enabled === false
    && row.checkout_payment_enabled === false
    && row.live_provider_enabled === false
    && row.provider_specific_live_enabled === false;
}

function remediationControlsAreSafe(row: ConnectorDryRunRemediationRow): boolean {
  return row.sandbox_only === true
    && row.not_live === true
    && row.not_approved === true
    && row.public_discovery_enabled === false
    && row.checkout_payment_enabled === false
    && row.live_provider_enabled === false
    && row.provider_specific_live_enabled === false
    && row.production_allowlist_written === false;
}

function toDryRunReview(row: ConnectorDryRunReviewRow): Record<string, unknown> {
  return {
    review_id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    dry_run_id: row.dry_run_id,
    status: row.status,
    decision: row.decision,
    decision_note: row.decision_note,
    requested_by: {
      kind: row.requested_by_kind,
      id: row.requested_by_id,
    },
    decided_by_operator_id: row.decided_by_operator_id,
    dry_run_status: row.dry_run_status,
    dry_run_generated_at: rowDateOrNull(row.dry_run_generated_at),
    evidence_summary: isPlainObject(row.evidence_summary) ? row.evidence_summary : {},
    requested_audit_event_id: row.requested_audit_event_id,
    audit_event_id: row.decision_audit_event_id,
    controls: {
      sandbox_only: row.sandbox_only,
      not_live: row.not_live,
      not_approved: row.not_approved,
      public_discovery_enabled: row.public_discovery_enabled,
      checkout_payment_enabled: row.checkout_payment_enabled,
      live_provider_enabled: row.live_provider_enabled,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: row.provider_specific_live_enabled,
      production_allowlist_written: row.production_allowlist_written,
      review_is_production_approval: false,
      review_enables_connector_execution: false,
    },
    created_at: rowDateOrNull(row.created_at),
    updated_at: rowDateOrNull(row.updated_at),
    decided_at: rowDateOrNull(row.decided_at),
  };
}

function remediationStatusFromFollowup(review: ConnectorDryRunReviewRow): ConnectorDryRunRemediationStatus {
  if (review.status === 'accepted_for_sandbox_followup') return 'followup_ready';
  if (review.status === 'needs_changes' || review.status === 'blocked') return 'blocked_again';
  return 'followup_review_requested';
}

function toDryRunRemediation(row: ConnectorDryRunRemediationRow): Record<string, unknown> {
  return {
    remediation_id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    original_dry_run_id: row.original_dry_run_id,
    original_review_id: row.original_review_id,
    original_decision: row.original_decision,
    status: row.status,
    public_safe_note: row.public_safe_note,
    blocker_summary: Array.isArray(row.blocker_summary) ? row.blocker_summary : [],
    warning_summary: Array.isArray(row.warning_summary) ? row.warning_summary : [],
    corrected_dry_run_id: row.corrected_dry_run_id,
    followup_review_id: row.followup_review_id,
    requested_by: {
      kind: row.requested_by_kind,
      id: row.requested_by_id,
    },
    audit_references: {
      requested_audit_event_id: row.requested_audit_event_id,
      corrected_audit_event_id: row.corrected_audit_event_id,
      followup_audit_event_id: row.followup_audit_event_id,
      closed_or_blocked_audit_event_id: row.closed_or_blocked_audit_event_id,
      triage_audit_event_id: row.triage_audit_event_id,
    },
    triage: {
      triage_status: row.triage_status,
      assigned_operator_id: row.assigned_operator_id,
      triage_note: row.triage_note,
      merchant_followup_summary: row.merchant_followup_summary,
      next_step: row.triage_next_step,
      triaged_by_operator_id: row.triaged_by_operator_id,
      triaged_at: rowDateOrNull(row.triaged_at),
      triage_audit_event_id: row.triage_audit_event_id,
      triage_is_production_approval: false,
      triage_enables_connector_execution: false,
    },
    controls: {
      sandbox_only: row.sandbox_only,
      not_live: row.not_live,
      not_approved: row.not_approved,
      public_discovery_enabled: row.public_discovery_enabled,
      checkout_payment_enabled: row.checkout_payment_enabled,
      live_provider_enabled: row.live_provider_enabled,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: row.provider_specific_live_enabled,
      production_allowlist_written: row.production_allowlist_written,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
      followup_ready_is_launch_approval: false,
      triage_is_production_approval: false,
      triage_enables_connector_execution: false,
    },
    created_at: rowDateOrNull(row.created_at),
    updated_at: rowDateOrNull(row.updated_at),
  };
}

function dryRunRemediationControls(row: ConnectorDryRunRemediationRow): Record<string, unknown> {
  return {
    sandbox_only: row.sandbox_only,
    not_live: row.not_live,
    not_approved: row.not_approved,
    public_discovery_enabled: row.public_discovery_enabled,
    checkout_payment_enabled: row.checkout_payment_enabled,
    live_provider_enabled: row.live_provider_enabled,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: row.provider_specific_live_enabled,
    production_allowlist_written: row.production_allowlist_written,
    credential_entry_enabled: false,
    outbound_sync_enabled: false,
    production_connector_setup_enabled: false,
    provider_call_enabled: false,
    merchant_private_api_calls_enabled: false,
    remediation_is_production_approval: false,
    remediation_enables_connector_execution: false,
    followup_ready_is_launch_approval: false,
    triage_is_production_approval: false,
    triage_enables_connector_execution: false,
  };
}

function toDryRunRemediationQueueItem(row: ConnectorDryRunRemediationRow): Record<string, unknown> {
  const blockerSummary = safeArray(row.blocker_summary);
  const warningSummary = safeArray(row.warning_summary);
  return {
    ...toDryRunRemediation(row),
    queue: {
      operator_queue_status: row.status,
      merchant_visible_status: row.status,
      requires_corrected_dry_run: row.corrected_dry_run_id === null
        && (row.status === 'remediation_requested' || row.status === 'waiting_for_corrected_dry_run'),
      requires_operator_followup: row.status === 'corrected_dry_run_attached'
        || row.status === 'followup_review_requested',
      timeline_available: true,
      evidence_redacted: true,
    },
    summary: {
      blocker_count: blockerSummary.length,
      warning_count: warningSummary.length,
      corrected_dry_run_attached: row.corrected_dry_run_id !== null,
      followup_review_requested: row.followup_review_id !== null,
      triage_status: row.triage_status,
      assigned_operator_id: row.assigned_operator_id,
      last_audit_event_id: row.triage_audit_event_id
        ?? row.followup_audit_event_id
        ?? row.corrected_audit_event_id
        ?? row.closed_or_blocked_audit_event_id
        ?? row.requested_audit_event_id,
    },
  };
}

function timelineEntry(input: {
  sequence: number;
  key: string;
  label: string;
  status: 'complete' | 'pending' | 'blocked';
  eventType: string;
  occurredAt: Date | string | null;
  auditEventId: string | null;
  actorKind: 'operator' | 'merchant' | null;
  actorId: string | null;
  resourceReferences: Record<string, string | null>;
  evidenceSummary: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    sequence: input.sequence,
    key: input.key,
    label: input.label,
    status: input.status,
    event_type: input.eventType,
    occurred_at: rowDateOrNull(input.occurredAt),
    audit_event_id: input.auditEventId,
    actor: {
      kind: input.actorKind,
      id: input.actorId,
    },
    resource_references: input.resourceReferences,
    evidence_summary: input.evidenceSummary,
    redaction: {
      raw_connector_rows_included: false,
      credentials_included: false,
      provider_metadata_included: false,
      merchant_private_api_payload_included: false,
      production_config_values_included: false,
    },
  };
}

function toDryRunRemediationTimeline(
  row: ConnectorDryRunRemediationRow,
  followupReview: ConnectorDryRunReviewRow | null = null,
): Record<string, unknown> {
  const blockerSummary = safeArray(row.blocker_summary);
  const warningSummary = safeArray(row.warning_summary);
  const followupDecisionAuditEventId = followupReview?.decision_audit_event_id ?? null;
  const followupDecidedAt = followupReview?.decided_at ?? null;
  const entries: Array<Record<string, unknown>> = [
    timelineEntry({
      sequence: 1,
      key: 'remediation_requested',
      label: 'Remediation requested',
      status: 'complete',
      eventType: 'connector_remediation_requested',
      occurredAt: row.created_at,
      auditEventId: row.requested_audit_event_id,
      actorKind: row.requested_by_kind,
      actorId: row.requested_by_id,
      resourceReferences: {
        remediation_id: row.id,
        original_dry_run_id: row.original_dry_run_id,
        original_review_id: row.original_review_id,
        corrected_dry_run_id: row.corrected_dry_run_id,
        followup_review_id: row.followup_review_id,
      },
      evidenceSummary: {
        original_decision: row.original_decision,
        blocker_count: blockerSummary.length,
        warning_count: warningSummary.length,
        public_safe_note_present: row.public_safe_note !== null,
      },
    }),
  ];

  if (row.corrected_dry_run_id) {
    entries.push(timelineEntry({
      sequence: entries.length + 1,
      key: 'corrected_dry_run_attached',
      label: 'Corrected dry-run attached',
      status: 'complete',
      eventType: 'connector_remediation_corrected_dry_run_attached',
      occurredAt: row.updated_at,
      auditEventId: row.corrected_audit_event_id,
      actorKind: null,
      actorId: null,
      resourceReferences: {
        remediation_id: row.id,
        original_dry_run_id: row.original_dry_run_id,
        original_review_id: row.original_review_id,
        corrected_dry_run_id: row.corrected_dry_run_id,
        followup_review_id: row.followup_review_id,
      },
      evidenceSummary: {
        corrected_dry_run_attached: true,
        corrected_dry_run_id: row.corrected_dry_run_id,
      },
    }));
  }

  if (row.triage_audit_event_id) {
    entries.push(timelineEntry({
      sequence: entries.length + 1,
      key: 'operator_triage_recorded',
      label: 'Operator triage recorded',
      status: row.triage_status === 'blocked_for_sandbox_followup' ? 'blocked' : 'complete',
      eventType: 'connector_remediation_triage_recorded',
      occurredAt: row.triaged_at,
      auditEventId: row.triage_audit_event_id,
      actorKind: 'operator',
      actorId: row.triaged_by_operator_id,
      resourceReferences: {
        remediation_id: row.id,
        original_dry_run_id: row.original_dry_run_id,
        original_review_id: row.original_review_id,
        corrected_dry_run_id: row.corrected_dry_run_id,
        followup_review_id: row.followup_review_id,
      },
      evidenceSummary: {
        triage_status: row.triage_status,
        assigned_operator_id_present: row.assigned_operator_id !== null,
        triage_note_present: row.triage_note !== null,
        merchant_followup_summary_present: row.merchant_followup_summary !== null,
        next_step_present: row.triage_next_step !== null,
        triage_is_production_approval: false,
        triage_enables_connector_execution: false,
      },
    }));
  }

  if (row.followup_review_id) {
    entries.push(timelineEntry({
      sequence: entries.length + 1,
      key: 'followup_review_requested',
      label: 'Follow-up review requested',
      status: 'complete',
      eventType: 'connector_remediation_followup_review_requested',
      occurredAt: row.updated_at,
      auditEventId: row.followup_audit_event_id,
      actorKind: null,
      actorId: null,
      resourceReferences: {
        remediation_id: row.id,
        original_dry_run_id: row.original_dry_run_id,
        original_review_id: row.original_review_id,
        corrected_dry_run_id: row.corrected_dry_run_id,
        followup_review_id: row.followup_review_id,
      },
      evidenceSummary: {
        followup_review_requested: true,
        followup_review_id: row.followup_review_id,
        followup_ready_is_launch_approval: false,
      },
    }));
  }

  if (row.status === 'followup_ready' || row.status === 'blocked_again' || row.status === 'closed_no_action') {
    entries.push(timelineEntry({
      sequence: entries.length + 1,
      key: row.status,
      label: row.status === 'followup_ready' ? 'Sandbox follow-up ready' : 'Follow-up blocked or closed',
      status: row.status === 'followup_ready' ? 'complete' : 'blocked',
      eventType: row.status === 'closed_no_action'
        ? 'connector_remediation_closed_or_blocked'
        : 'connector_dry_run_review_decision_recorded',
      occurredAt: row.status === 'closed_no_action' ? row.updated_at : followupDecidedAt,
      auditEventId: row.status === 'closed_no_action'
        ? row.closed_or_blocked_audit_event_id
        : followupDecisionAuditEventId,
      actorKind: null,
      actorId: null,
      resourceReferences: {
        remediation_id: row.id,
        original_dry_run_id: row.original_dry_run_id,
        original_review_id: row.original_review_id,
        corrected_dry_run_id: row.corrected_dry_run_id,
        followup_review_id: row.followup_review_id,
      },
      evidenceSummary: {
        remediation_status: row.status,
        followup_review_decision: followupReview?.decision ?? null,
        followup_ready_is_launch_approval: false,
        production_approval_granted: false,
      },
    }));
  }

  return {
    remediation: toDryRunRemediation(row),
    timeline: entries,
    operator_queue: {
      queue_status: row.status,
      visible_to_operator: true,
      evidence_redacted: true,
      requires_corrected_dry_run: row.corrected_dry_run_id === null
        && (row.status === 'remediation_requested' || row.status === 'waiting_for_corrected_dry_run'),
      requires_operator_followup: row.status === 'corrected_dry_run_attached'
        || row.status === 'followup_review_requested',
    },
    merchant_status: {
      visible_to_merchant: true,
      status: row.status,
      triage_status: row.triage_status,
      merchant_followup_summary: row.merchant_followup_summary,
      triage_next_step: row.triage_next_step,
      corrected_dry_run_id: row.corrected_dry_run_id,
      followup_review_id: row.followup_review_id,
      next_step: row.status === 'remediation_requested' || row.status === 'waiting_for_corrected_dry_run'
        ? 'attach_corrected_sandbox_dry_run'
        : row.status === 'corrected_dry_run_attached'
          ? 'request_operator_followup_review'
          : row.status === 'followup_review_requested'
            ? 'wait_for_operator_decision'
            : 'review_status_with_operator',
    },
    redaction_summary: {
      blocker_summary_count: blockerSummary.length,
      warning_summary_count: warningSummary.length,
      raw_connector_rows_included: false,
      credentials_included: false,
      provider_metadata_included: false,
      merchant_private_api_payload_included: false,
      production_config_values_included: false,
    },
    controls: dryRunRemediationControls(row),
  };
}

async function readMerchantForDryRun(sql: Sql, tenantId: string, merchantId: string): Promise<MerchantDryRunRow | null> {
  const rows = await sql<MerchantDryRunRow[]>`
    SELECT id, environment, verification_status, disabled_at
      FROM commerce_merchants
     WHERE tenant_id = ${tenantId}
       AND id = ${merchantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunEvidence(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  dryRunId: string,
): Promise<ConnectorDryRunRow | null> {
  const rows = await sql<ConnectorDryRunRow[]>`
    SELECT id, tenant_id, merchant_id, connector_type, source_label, status,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, rows_received, products_detected,
           variants_detected, would_create_count, would_update_count,
           would_archive_count, blocked_count, warning_count,
           normalized_preview, blockers, warnings, requested_audit_event_id,
           result_audit_event_id, generated_at, created_at
      FROM commerce_connector_dry_runs
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND id = ${dryRunId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunReview(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  dryRunId: string,
): Promise<ConnectorDryRunReviewRow | null> {
  const rows = await sql<ConnectorDryRunReviewRow[]>`
    SELECT id, tenant_id, merchant_id, dry_run_id, status, decision,
           decision_note, requested_by_kind, requested_by_id,
           decided_by_operator_id, dry_run_status, dry_run_generated_at,
           evidence_summary, requested_audit_event_id, decision_audit_event_id,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, production_allowlist_written,
           created_at, updated_at, decided_at
      FROM commerce_connector_dry_run_reviews
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND dry_run_id = ${dryRunId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunReviewById(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  reviewId: string,
): Promise<ConnectorDryRunReviewRow | null> {
  const rows = await sql<ConnectorDryRunReviewRow[]>`
    SELECT id, tenant_id, merchant_id, dry_run_id, status, decision,
           decision_note, requested_by_kind, requested_by_id,
           decided_by_operator_id, dry_run_status, dry_run_generated_at,
           evidence_summary, requested_audit_event_id, decision_audit_event_id,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, production_allowlist_written,
           created_at, updated_at, decided_at
      FROM commerce_connector_dry_run_reviews
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND id = ${reviewId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunRemediationById(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  remediationId: string,
): Promise<ConnectorDryRunRemediationRow | null> {
  const rows = await sql<ConnectorDryRunRemediationRow[]>`
    SELECT id, tenant_id, merchant_id, original_dry_run_id,
           original_review_id, original_decision, status, public_safe_note,
           blocker_summary, warning_summary, corrected_dry_run_id,
           followup_review_id, requested_by_kind, requested_by_id,
           requested_audit_event_id, corrected_audit_event_id,
           followup_audit_event_id, closed_or_blocked_audit_event_id,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, production_allowlist_written,
           triage_status, assigned_operator_id, triage_note,
           merchant_followup_summary, triage_next_step,
           triaged_by_operator_id, triaged_at, triage_audit_event_id,
           created_at, updated_at
      FROM commerce_connector_dry_run_remediations
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND id = ${remediationId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunRemediationForOriginal(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  dryRunId: string,
  reviewId: string,
): Promise<ConnectorDryRunRemediationRow | null> {
  const rows = await sql<ConnectorDryRunRemediationRow[]>`
    SELECT id, tenant_id, merchant_id, original_dry_run_id,
           original_review_id, original_decision, status, public_safe_note,
           blocker_summary, warning_summary, corrected_dry_run_id,
           followup_review_id, requested_by_kind, requested_by_id,
           requested_audit_event_id, corrected_audit_event_id,
           followup_audit_event_id, closed_or_blocked_audit_event_id,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, production_allowlist_written,
           triage_status, assigned_operator_id, triage_note,
           merchant_followup_summary, triage_next_step,
           triaged_by_operator_id, triaged_at, triage_audit_event_id,
           created_at, updated_at
      FROM commerce_connector_dry_run_remediations
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND original_dry_run_id = ${dryRunId}
       AND original_review_id = ${reviewId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readDryRunRemediationQueue(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string | null;
    status: ConnectorDryRunRemediationStatus | null;
    triageStatus: ConnectorDryRunRemediationTriageStatus | null;
    originalDecision: 'needs_changes' | 'blocked' | null;
    hasCorrectedDryRun: boolean | null;
    hasFollowupReview: boolean | null;
    limit: number;
  },
): Promise<ConnectorDryRunRemediationRow[]> {
  return sql<ConnectorDryRunRemediationRow[]>`
    SELECT id, tenant_id, merchant_id, original_dry_run_id,
           original_review_id, original_decision, status, public_safe_note,
           blocker_summary, warning_summary, corrected_dry_run_id,
           followup_review_id, requested_by_kind, requested_by_id,
           requested_audit_event_id, corrected_audit_event_id,
           followup_audit_event_id, closed_or_blocked_audit_event_id,
           sandbox_only, not_live, not_approved, public_discovery_enabled,
           checkout_payment_enabled, live_provider_enabled,
           provider_specific_live_enabled, production_allowlist_written,
           triage_status, assigned_operator_id, triage_note,
           merchant_followup_summary, triage_next_step,
           triaged_by_operator_id, triaged_at, triage_audit_event_id,
           created_at, updated_at
      FROM commerce_connector_dry_run_remediations
     WHERE tenant_id = ${input.tenantId}
       AND (${input.merchantId}::text IS NULL OR merchant_id = ${input.merchantId})
       AND (${input.status}::text IS NULL OR status = ${input.status})
       AND (${input.triageStatus}::text IS NULL OR triage_status = ${input.triageStatus})
       AND (${input.originalDecision}::text IS NULL OR original_decision = ${input.originalDecision})
       AND (
         ${input.hasCorrectedDryRun}::boolean IS NULL
         OR (corrected_dry_run_id IS NOT NULL) = ${input.hasCorrectedDryRun}
       )
       AND (
         ${input.hasFollowupReview}::boolean IS NULL
         OR (followup_review_id IS NOT NULL) = ${input.hasFollowupReview}
       )
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ${input.limit}
  `;
}

async function existingDryRunProductIds(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  productRefs: string[],
): Promise<Set<string>> {
  if (productRefs.length === 0) return new Set();
  const rows = await sql<Array<{ product_id: string }>>`
    SELECT product_id
      FROM commerce_products
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND archived_at IS NULL
       AND product_id = ANY(${productRefs}::text[])
  `;
  return new Set(rows.map((row) => row.product_id));
}

async function insertDryRunResult(
  sql: Sql,
  result: ConnectorDryRunResult,
  requestedAuditEventId: string,
  resultAuditEventId: string,
): Promise<ConnectorDryRunRow> {
  const rows = await sql<ConnectorDryRunRow[]>`
    INSERT INTO commerce_connector_dry_runs (
      id, tenant_id, merchant_id, connector_type, source_label, status,
      sandbox_only, not_live, not_approved, public_discovery_enabled,
      checkout_payment_enabled, live_provider_enabled,
      provider_specific_live_enabled, rows_received, products_detected,
      variants_detected, would_create_count, would_update_count,
      would_archive_count, blocked_count, warning_count, normalized_preview,
      blockers, warnings, requested_audit_event_id, result_audit_event_id,
      generated_at
    ) VALUES (
      ${result.dry_run_id}, ${result.tenant_id}, ${result.merchant_id},
      ${result.connector_type}, ${result.source_label}, ${result.status},
      ${result.sandbox_only}, ${result.not_live}, ${result.not_approved},
      ${result.public_discovery_enabled}, ${result.checkout_payment_enabled},
      ${result.live_provider_enabled}, ${result.provider_specific_live_enabled},
      ${result.rows_received}, ${result.products_detected},
      ${result.variants_detected}, ${result.would_create_count},
      ${result.would_update_count}, ${result.would_archive_count},
      ${result.blocked_count}, ${result.warning_count},
      ${JSON.stringify(result.normalized_preview)}::jsonb,
      ${JSON.stringify(result.blockers)}::jsonb,
      ${JSON.stringify(result.warnings)}::jsonb,
      ${requestedAuditEventId}, ${resultAuditEventId}, ${result.generated_at}
    )
    RETURNING id, tenant_id, merchant_id, connector_type, source_label, status,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, rows_received, products_detected,
              variants_detected, would_create_count, would_update_count,
              would_archive_count, blocked_count, warning_count,
              normalized_preview, blockers, warnings, requested_audit_event_id,
              result_audit_event_id, generated_at, created_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(500, 'connector_dry_run_insert_failed',
      'Connector dry-run metadata could not be stored', { retryable: true });
  }
  return row;
}

async function persistDryRunWithAudit(
  tx: TxSql,
  result: ConnectorDryRunResult,
  requestId: string,
): Promise<{ row: ConnectorDryRunRow; requestedAuditEventId: string; resultAuditEventId: string }> {
  const baseMetadata = {
    dry_run_id: result.dry_run_id,
    connector_type: result.connector_type,
    source_label: result.source_label,
    result_status: result.status,
    rows_received: result.rows_received,
    products_detected: result.products_detected,
    variants_detected: result.variants_detected,
    would_create_count: result.would_create_count,
    would_update_count: result.would_update_count,
    blocked_count: result.blocked_count,
    warning_count: result.warning_count,
    sandbox_only: true,
    not_live: true,
    not_approved: true,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
    redaction: 'no credentials, raw files, private URLs, provider metadata, production config, allowlists, checkout URLs, payment IDs, or merchant private API payloads stored',
  };
  const requested = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: result.tenant_id,
    merchantId: result.merchant_id,
    eventType: 'connector_dry_run_requested',
    resourceType: 'commerce_connector_dry_run',
    resourceId: result.dry_run_id,
    requestId,
    metadata: baseMetadata,
  });
  const resultAudit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: result.tenant_id,
    merchantId: result.merchant_id,
    eventType: result.status === 'passed' ? 'connector_dry_run_completed' : 'connector_dry_run_blocked',
    resourceType: 'commerce_connector_dry_run',
    resourceId: result.dry_run_id,
    requestId,
    metadata: {
      ...baseMetadata,
      blocker_codes: result.blockers.map((blocker) => blocker.code),
      warning_codes: result.warnings.map((warning) => warning.code),
    },
  });
  const row = await insertDryRunResult(tx as unknown as Sql, result, requested.id, resultAudit.id);
  return { row, requestedAuditEventId: requested.id, resultAuditEventId: resultAudit.id };
}

function validateReviewRequestBody(body: Record<string, unknown>): { requestNote: string | null } {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REVIEW_REQUEST_FIELDS, fields);
  const requestNote = safeReviewNote(body['request_note'], 'request_note', fields);
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { requestNote };
}

function validateReviewDecisionBody(body: Record<string, unknown>): {
  decision: ConnectorDryRunReviewDecision;
  decisionNote: string | null;
} {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REVIEW_DECISION_FIELDS, fields);
  const rawDecision = body['decision'];
  let decision: ConnectorDryRunReviewDecision = 'blocked';
  if (REVIEW_DECISIONS.has(rawDecision as ConnectorDryRunReviewDecision)) {
    decision = rawDecision as ConnectorDryRunReviewDecision;
  } else {
    fields['decision'] = 'must be accepted_for_sandbox_followup, needs_changes, or blocked';
  }
  const decisionNote = safeReviewNote(body['decision_note'], 'decision_note', fields);
  if ((decision === 'needs_changes' || decision === 'blocked') && !decisionNote) {
    fields['decision_note'] = 'required for needs_changes or blocked decisions';
  }
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { decision, decisionNote };
}

function validateRemediationRequestBody(body: Record<string, unknown>): { publicSafeNote: string | null } {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REMEDIATION_REQUEST_FIELDS, fields);
  const publicSafeNote = safeReviewNote(body['public_safe_note'], 'public_safe_note', fields);
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { publicSafeNote };
}

function safeOperatorReference(value: unknown, fieldName: string, fields: Record<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (!isString(value)) {
    fields[fieldName] = 'must be a string when provided';
    return null;
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    fields[fieldName] = 'must be a public-safe operator reference';
    return null;
  }
  if (SENSITIVE_VALUE_RE.test(trimmed) || REVIEW_UNSAFE_VALUE_RE.test(trimmed)) {
    fields[fieldName] = 'must not include secrets, provider metadata, private API values, production config, allowlists, checkout, or payment artifacts';
    return null;
  }
  return trimmed;
}

function validateRemediationTriageBody(
  body: Record<string, unknown>,
  defaultOperatorId: string,
): {
  triageStatus: ConnectorDryRunRemediationTriageStatus;
  assignedOperatorId: string | null;
  triageNote: string | null;
  merchantFollowupSummary: string | null;
  nextStep: string | null;
} {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REMEDIATION_TRIAGE_FIELDS, fields);
  const rawStatus = body['triage_status'];
  let triageStatus: ConnectorDryRunRemediationTriageStatus = 'triage_in_progress';
  if (REMEDIATION_TRIAGE_STATUSES.has(rawStatus as ConnectorDryRunRemediationTriageStatus)) {
    triageStatus = rawStatus as ConnectorDryRunRemediationTriageStatus;
  } else {
    fields['triage_status'] = `must be one of: ${REMEDIATION_TRIAGE_STATUS_VALUES.join(', ')}`;
  }
  const assignedOperatorId = body['assigned_operator_id'] === undefined
    ? defaultOperatorId
    : safeOperatorReference(body['assigned_operator_id'], 'assigned_operator_id', fields);
  const triageNote = safeReviewNote(body['triage_note'], 'triage_note', fields);
  const merchantFollowupSummary = safeReviewNote(
    body['merchant_followup_summary'],
    'merchant_followup_summary',
    fields,
  );
  const nextStep = safeReviewNote(body['next_step'], 'next_step', fields);
  if ((triageStatus === 'waiting_on_merchant' || triageStatus === 'blocked_for_sandbox_followup')
    && !merchantFollowupSummary) {
    fields['merchant_followup_summary'] = 'required for merchant-visible waiting or blocked triage statuses';
  }
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { triageStatus, assignedOperatorId, triageNote, merchantFollowupSummary, nextStep };
}

function validateCorrectedDryRunBody(body: Record<string, unknown>): {
  correctedDryRunId: string;
  publicSafeNote: string | null;
} {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REMEDIATION_CORRECTED_FIELDS, fields);
  const correctedDryRunId = isString(body['corrected_dry_run_id'])
    ? body['corrected_dry_run_id'].trim()
    : '';
  if (!correctedDryRunId) fields['corrected_dry_run_id'] = 'required string';
  const publicSafeNote = safeReviewNote(body['public_safe_note'], 'public_safe_note', fields);
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { correctedDryRunId, publicSafeNote };
}

function validateFollowupReviewBody(body: Record<string, unknown>): { requestNote: string | null } {
  const fields: Record<string, string> = {};
  rejectUnsupportedOrPrivateFields(body, REMEDIATION_FOLLOWUP_FIELDS, fields);
  const requestNote = safeReviewNote(body['request_note'], 'request_note', fields);
  if (Object.keys(fields).length > 0) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return { requestNote };
}

function dryRunReviewBlockedDetails(
  dryRun: ConnectorDryRunRow,
  blockerCodes: string[],
): Record<string, unknown> {
  return {
    dry_run_id: dryRun.id,
    dry_run_status: dryRun.status,
    blocker_codes: blockerCodes,
    controls: {
      sandbox_only: dryRun.sandbox_only === true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
    },
  };
}

async function appendDryRunReviewBlockedAudit(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string;
    dryRunId: string;
    requestId: string;
    blockerCodes: string[];
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_dry_run_review_blocked',
    resourceType: 'commerce_connector_dry_run_review',
    resourceId: input.dryRunId,
    requestId: input.requestId,
    metadata: {
      dry_run_id: input.dryRunId,
      blocker_codes: input.blockerCodes,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      review_is_production_approval: false,
      review_enables_connector_execution: false,
    },
  });
  return audit.id;
}

function remediationBlockedDetails(
  remediation: ConnectorDryRunRemediationRow | null,
  blockerCodes: string[],
): Record<string, unknown> {
  return {
    remediation_id: remediation?.id ?? null,
    original_dry_run_id: remediation?.original_dry_run_id ?? null,
    original_review_id: remediation?.original_review_id ?? null,
    blocker_codes: blockerCodes,
    controls: {
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
    },
  };
}

async function appendRemediationBlockedAudit(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string;
    remediationId: string | null;
    requestId: string;
    blockerCodes: string[];
  },
): Promise<string> {
  const audit = await appendCommerceAudit(sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_remediation_closed_or_blocked',
    resourceType: 'commerce_connector_dry_run_remediation',
    resourceId: input.remediationId,
    requestId: input.requestId,
    metadata: {
      remediation_id: input.remediationId,
      blocker_codes: input.blockerCodes,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
    },
  });
  return audit.id;
}

async function insertDryRunReviewRequest(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    dryRun: ConnectorDryRunRow;
    actor: { kind: 'operator' | 'merchant'; id: string };
    requestNote: string | null;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunReviewRow; auditEventId: string; created: boolean }> {
  const existing = await readDryRunReview(
    tx as unknown as Sql,
    input.tenantId,
    input.merchantId,
    input.dryRun.id,
  );
  if (existing) {
    return { row: existing, auditEventId: existing.requested_audit_event_id, created: false };
  }
  const evidenceSummary = {
    ...dryRunEvidenceSummary(input.dryRun),
    request_note_present: input.requestNote !== null,
  };
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_dry_run_review_requested',
    resourceType: 'commerce_connector_dry_run_review',
    resourceId: input.dryRun.id,
    requestId: input.requestId,
    metadata: {
      ...evidenceSummary,
      requested_by_kind: input.actor.kind,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      review_is_production_approval: false,
    },
  });
  const rows = await tx<ConnectorDryRunReviewRow[]>`
    INSERT INTO commerce_connector_dry_run_reviews (
      id, tenant_id, merchant_id, dry_run_id, status, requested_by_kind,
      requested_by_id, dry_run_status, dry_run_generated_at, evidence_summary,
      requested_audit_event_id, sandbox_only, not_live, not_approved,
      public_discovery_enabled, checkout_payment_enabled, live_provider_enabled,
      provider_specific_live_enabled, production_allowlist_written
    ) VALUES (
      ${newCommerceConnectorDryRunReviewId()}, ${input.tenantId},
      ${input.merchantId}, ${input.dryRun.id}, 'pending_operator_review',
      ${input.actor.kind}, ${input.actor.id}, ${input.dryRun.status},
      ${input.dryRun.generated_at}, ${JSON.stringify(evidenceSummary)}::jsonb,
      ${audit.id}, TRUE, TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE
    )
    RETURNING id, tenant_id, merchant_id, dry_run_id, status, decision,
              decision_note, requested_by_kind, requested_by_id,
              decided_by_operator_id, dry_run_status, dry_run_generated_at,
              evidence_summary, requested_audit_event_id, decision_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              created_at, updated_at, decided_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(500, 'connector_dry_run_review_insert_failed',
      'Connector dry-run review request could not be stored', { retryable: true });
  }
  return { row, auditEventId: audit.id, created: true };
}

async function insertDryRunRemediationRequest(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    dryRun: ConnectorDryRunRow;
    review: ConnectorDryRunReviewRow;
    actor: { kind: 'operator' | 'merchant'; id: string };
    publicSafeNote: string | null;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunRemediationRow; auditEventId: string; created: boolean }> {
  const existing = await readDryRunRemediationForOriginal(
    tx as unknown as Sql,
    input.tenantId,
    input.merchantId,
    input.dryRun.id,
    input.review.id,
  );
  if (existing) {
    return { row: existing, auditEventId: existing.requested_audit_event_id, created: false };
  }
  const blockerSummary = Array.isArray(input.dryRun.blockers)
    ? input.dryRun.blockers.slice(0, 20)
    : [];
  const warningSummary = Array.isArray(input.dryRun.warnings)
    ? input.dryRun.warnings.slice(0, 20)
    : [];
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_remediation_requested',
    resourceType: 'commerce_connector_dry_run_remediation',
    resourceId: input.review.id,
    requestId: input.requestId,
    metadata: {
      original_dry_run_id: input.dryRun.id,
      original_review_id: input.review.id,
      original_decision: input.review.status,
      public_safe_note_present: input.publicSafeNote !== null,
      blocker_count: numberValue(input.dryRun.blocked_count, 0),
      warning_count: numberValue(input.dryRun.warning_count, 0),
      requested_by_kind: input.actor.kind,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
    },
  });
  const rows = await tx<ConnectorDryRunRemediationRow[]>`
    INSERT INTO commerce_connector_dry_run_remediations (
      id, tenant_id, merchant_id, original_dry_run_id, original_review_id,
      original_decision, status, public_safe_note, blocker_summary,
      warning_summary, requested_by_kind, requested_by_id,
      requested_audit_event_id, sandbox_only, not_live, not_approved,
      public_discovery_enabled, checkout_payment_enabled, live_provider_enabled,
      provider_specific_live_enabled, production_allowlist_written
    ) VALUES (
      ${newCommerceConnectorDryRunRemediationId()}, ${input.tenantId},
      ${input.merchantId}, ${input.dryRun.id}, ${input.review.id},
      ${input.review.status}, 'remediation_requested', ${input.publicSafeNote},
      ${JSON.stringify(blockerSummary)}::jsonb,
      ${JSON.stringify(warningSummary)}::jsonb,
      ${input.actor.kind}, ${input.actor.id}, ${audit.id},
      TRUE, TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE
    )
    RETURNING id, tenant_id, merchant_id, original_dry_run_id,
              original_review_id, original_decision, status, public_safe_note,
              blocker_summary, warning_summary, corrected_dry_run_id,
              followup_review_id, requested_by_kind, requested_by_id,
              requested_audit_event_id, corrected_audit_event_id,
              followup_audit_event_id, closed_or_blocked_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              triage_status, assigned_operator_id, triage_note,
              merchant_followup_summary, triage_next_step,
              triaged_by_operator_id, triaged_at, triage_audit_event_id,
              created_at, updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(500, 'connector_remediation_insert_failed',
      'Connector dry-run remediation request could not be stored', { retryable: true });
  }
  return { row, auditEventId: audit.id, created: true };
}

async function attachCorrectedDryRunToRemediation(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    remediation: ConnectorDryRunRemediationRow;
    correctedDryRun: ConnectorDryRunRow;
    publicSafeNote: string | null;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunRemediationRow; auditEventId: string | null; created: boolean }> {
  if (input.remediation.corrected_dry_run_id === input.correctedDryRun.id) {
    return { row: input.remediation, auditEventId: input.remediation.corrected_audit_event_id, created: false };
  }
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_remediation_corrected_dry_run_attached',
    resourceType: 'commerce_connector_dry_run_remediation',
    resourceId: input.remediation.id,
    requestId: input.requestId,
    metadata: {
      remediation_id: input.remediation.id,
      original_dry_run_id: input.remediation.original_dry_run_id,
      corrected_dry_run_id: input.correctedDryRun.id,
      public_safe_note_present: input.publicSafeNote !== null,
      corrected_dry_run_status: input.correctedDryRun.status,
      blocked_count: numberValue(input.correctedDryRun.blocked_count, 0),
      warning_count: numberValue(input.correctedDryRun.warning_count, 0),
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
    },
  });
  const rows = await tx<ConnectorDryRunRemediationRow[]>`
    UPDATE commerce_connector_dry_run_remediations
       SET corrected_dry_run_id = ${input.correctedDryRun.id},
           corrected_audit_event_id = ${audit.id},
           public_safe_note = COALESCE(${input.publicSafeNote}, public_safe_note),
           status = 'corrected_dry_run_attached',
           updated_at = NOW()
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND id = ${input.remediation.id}
       AND (corrected_dry_run_id IS NULL OR corrected_dry_run_id = ${input.correctedDryRun.id})
    RETURNING id, tenant_id, merchant_id, original_dry_run_id,
              original_review_id, original_decision, status, public_safe_note,
              blocker_summary, warning_summary, corrected_dry_run_id,
              followup_review_id, requested_by_kind, requested_by_id,
              requested_audit_event_id, corrected_audit_event_id,
              followup_audit_event_id, closed_or_blocked_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              triage_status, assigned_operator_id, triage_note,
              merchant_followup_summary, triage_next_step,
              triaged_by_operator_id, triaged_at, triage_audit_event_id,
              created_at, updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(409, 'connector_remediation_corrected_dry_run_conflict',
      'Connector remediation already references a different corrected dry-run', { retryable: false });
  }
  return { row, auditEventId: audit.id, created: true };
}

async function attachFollowupReviewToRemediation(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    remediation: ConnectorDryRunRemediationRow;
    correctedDryRun: ConnectorDryRunRow;
    followupReview: ConnectorDryRunReviewRow;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunRemediationRow; auditEventId: string | null; created: boolean }> {
  if (input.remediation.followup_review_id === input.followupReview.id) {
    return { row: input.remediation, auditEventId: input.remediation.followup_audit_event_id, created: false };
  }
  const status = remediationStatusFromFollowup(input.followupReview);
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_remediation_followup_review_requested',
    resourceType: 'commerce_connector_dry_run_remediation',
    resourceId: input.remediation.id,
    requestId: input.requestId,
    metadata: {
      remediation_id: input.remediation.id,
      corrected_dry_run_id: input.correctedDryRun.id,
      followup_review_id: input.followupReview.id,
      followup_review_status: input.followupReview.status,
      remediation_status: status,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      remediation_is_production_approval: false,
      remediation_enables_connector_execution: false,
      followup_ready_is_launch_approval: false,
    },
  });
  const rows = await tx<ConnectorDryRunRemediationRow[]>`
    UPDATE commerce_connector_dry_run_remediations
       SET followup_review_id = ${input.followupReview.id},
           followup_audit_event_id = ${audit.id},
           status = ${status},
           updated_at = NOW()
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND id = ${input.remediation.id}
       AND (followup_review_id IS NULL OR followup_review_id = ${input.followupReview.id})
    RETURNING id, tenant_id, merchant_id, original_dry_run_id,
              original_review_id, original_decision, status, public_safe_note,
              blocker_summary, warning_summary, corrected_dry_run_id,
              followup_review_id, requested_by_kind, requested_by_id,
              requested_audit_event_id, corrected_audit_event_id,
              followup_audit_event_id, closed_or_blocked_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              triage_status, assigned_operator_id, triage_note,
              merchant_followup_summary, triage_next_step,
              triaged_by_operator_id, triaged_at, triage_audit_event_id,
              created_at, updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(409, 'connector_remediation_followup_review_conflict',
      'Connector remediation already references a different follow-up review', { retryable: false });
  }
  return { row, auditEventId: audit.id, created: true };
}

async function recordDryRunRemediationTriage(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    remediation: ConnectorDryRunRemediationRow;
    operatorId: string;
    triageStatus: ConnectorDryRunRemediationTriageStatus;
    assignedOperatorId: string | null;
    triageNote: string | null;
    merchantFollowupSummary: string | null;
    nextStep: string | null;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunRemediationRow; auditEventId: string | null; created: boolean }> {
  const unchanged = input.remediation.triage_status === input.triageStatus
    && (input.remediation.assigned_operator_id ?? null) === input.assignedOperatorId
    && (input.remediation.triage_note ?? null) === input.triageNote
    && (input.remediation.merchant_followup_summary ?? null) === input.merchantFollowupSummary
    && (input.remediation.triage_next_step ?? null) === input.nextStep;
  if (unchanged) {
    return { row: input.remediation, auditEventId: input.remediation.triage_audit_event_id, created: false };
  }
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_remediation_triage_recorded',
    resourceType: 'commerce_connector_dry_run_remediation',
    resourceId: input.remediation.id,
    requestId: input.requestId,
    metadata: {
      remediation_id: input.remediation.id,
      original_dry_run_id: input.remediation.original_dry_run_id,
      original_review_id: input.remediation.original_review_id,
      previous_triage_status: input.remediation.triage_status,
      triage_status: input.triageStatus,
      assigned_operator_id_present: input.assignedOperatorId !== null,
      triage_note_present: input.triageNote !== null,
      merchant_followup_summary_present: input.merchantFollowupSummary !== null,
      next_step_present: input.nextStep !== null,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      triage_is_production_approval: false,
      triage_enables_connector_execution: false,
    },
  });
  const rows = await tx<ConnectorDryRunRemediationRow[]>`
    UPDATE commerce_connector_dry_run_remediations
       SET triage_status = ${input.triageStatus},
           assigned_operator_id = ${input.assignedOperatorId},
           triage_note = ${input.triageNote},
           merchant_followup_summary = ${input.merchantFollowupSummary},
           triage_next_step = ${input.nextStep},
           triaged_by_operator_id = ${input.operatorId},
           triaged_at = NOW(),
           triage_audit_event_id = ${audit.id},
           updated_at = NOW()
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND id = ${input.remediation.id}
    RETURNING id, tenant_id, merchant_id, original_dry_run_id,
              original_review_id, original_decision, status, public_safe_note,
              blocker_summary, warning_summary, corrected_dry_run_id,
              followup_review_id, requested_by_kind, requested_by_id,
              requested_audit_event_id, corrected_audit_event_id,
              followup_audit_event_id, closed_or_blocked_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              triage_status, assigned_operator_id, triage_note,
              merchant_followup_summary, triage_next_step,
              triaged_by_operator_id, triaged_at, triage_audit_event_id,
              created_at, updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(404, 'connector_remediation_not_found',
      'Connector dry-run remediation was not found in this tenant and merchant');
  }
  return { row, auditEventId: audit.id, created: true };
}

async function recordDryRunReviewDecision(
  tx: TxSql,
  input: {
    tenantId: string;
    merchantId: string;
    dryRun: ConnectorDryRunRow;
    review: ConnectorDryRunReviewRow;
    operatorId: string;
    decision: ConnectorDryRunReviewDecision;
    decisionNote: string | null;
    requestId: string;
  },
): Promise<{ row: ConnectorDryRunReviewRow; auditEventId: string }> {
  const audit = await appendCommerceAudit(tx as unknown as Sql, {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    eventType: 'connector_dry_run_review_decision_recorded',
    resourceType: 'commerce_connector_dry_run_review',
    resourceId: input.review.id,
    requestId: input.requestId,
    metadata: {
      review_id: input.review.id,
      dry_run_id: input.dryRun.id,
      dry_run_status: input.dryRun.status,
      decision: input.decision,
      decision_note_present: input.decisionNote !== null,
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
      production_allowlist_written: false,
      review_is_production_approval: false,
      review_enables_connector_execution: false,
    },
  });
  const rows = await tx<ConnectorDryRunReviewRow[]>`
    UPDATE commerce_connector_dry_run_reviews
       SET status = ${input.decision},
           decision = ${input.decision},
           decision_note = ${input.decisionNote},
           decided_by_operator_id = ${input.operatorId},
           decision_audit_event_id = ${audit.id},
           decided_at = NOW(),
           updated_at = NOW()
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND dry_run_id = ${input.dryRun.id}
       AND status = 'pending_operator_review'
    RETURNING id, tenant_id, merchant_id, dry_run_id, status, decision,
              decision_note, requested_by_kind, requested_by_id,
              decided_by_operator_id, dry_run_status, dry_run_generated_at,
              evidence_summary, requested_audit_event_id, decision_audit_event_id,
              sandbox_only, not_live, not_approved, public_discovery_enabled,
              checkout_payment_enabled, live_provider_enabled,
              provider_specific_live_enabled, production_allowlist_written,
              created_at, updated_at, decided_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceHttpError(409, 'connector_dry_run_review_not_pending',
      'Connector dry-run review is not pending operator review', { retryable: false });
  }
  const remediationStatus: ConnectorDryRunRemediationStatus = input.decision === 'accepted_for_sandbox_followup'
    ? 'followup_ready'
    : 'blocked_again';
  await tx`
    UPDATE commerce_connector_dry_run_remediations
       SET status = ${remediationStatus},
           updated_at = NOW()
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND followup_review_id = ${row.id}
  `;
  return { row, auditEventId: audit.id };
}

function dryRunErrorDetails(result: ConnectorDryRunResult): Record<string, unknown> {
  return {
    dry_run_id: result.dry_run_id,
    status: result.status,
    blockers: result.blockers.map((blocker) => ({
      code: blocker.code,
      row_index: blocker.row_index ?? null,
      field: blocker.field ?? null,
      remediation: blocker.remediation,
    })),
    controls: {
      sandbox_only: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
    },
  };
}

function validateCreateBody(body: ConnectorBody): {
  merchantId: string;
  connectorKey: string;
  connectorType: ConnectorType;
  displayName: string;
  status: string;
  sourceDomains: SourceDomain[];
  sourcePriority: number;
  syncStatus: string;
  healthState: string;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  staleAfterSeconds: number;
  conflictBlockers: string[];
  webhookSourceKey: string | null;
} {
  const fields: Record<string, string> = {};
  const raw = body as Record<string, unknown>;
  rejectUnsupportedOrPrivateFields(raw, CREATE_FIELDS, fields);
  const merchantId = isString(body.merchant_id) ? body.merchant_id : '';
  if (!merchantId) fields['merchant_id'] = 'required string';
  const connectorKey = validateConnectorKey(body.connector_key, fields) ?? '';
  const type = connectorType(body.connector_type);
  if (!type) fields['connector_type'] = `must be one of: ${CONNECTOR_TYPES.join(', ')}`;
  if (!isString(body.display_name)) fields['display_name'] = 'required string';
  const status = body.status === undefined ? 'draft' : body.status;
  if (typeof status !== 'string' || !CONNECTOR_STATUSES.has(status)) {
    fields['status'] = 'must be one of: draft, active, disabled';
  }
  const syncStatus = body.sync_status === undefined ? (type === 'manual' ? 'manual' : 'not_started') : body.sync_status;
  if (typeof syncStatus !== 'string' || !SYNC_STATUSES.has(syncStatus)) {
    fields['sync_status'] = 'must be one of: not_started, manual, scheduled, sync_succeeded, sync_failed, blocked';
  }
  const healthState = body.health_state === undefined ? 'unknown' : body.health_state;
  if (typeof healthState !== 'string' || !HEALTH_STATES.has(healthState)) {
    fields['health_state'] = 'must be one of: unknown, healthy, stale, conflict, blocked, disabled';
  }
  const sourceDomains = normalizeSourceDomains(body.source_domains, fields);
  const conflictBlockers = normalizeConflictBlockers(body.conflict_blockers, fields);
  const sourcePriority = numberValue(body.source_priority, 100);
  if (sourcePriority < 0) fields['source_priority'] = 'must be a non-negative integer';
  const staleAfterSeconds = numberValue(body.stale_after_seconds, 86400);
  if (staleAfterSeconds < 0 || staleAfterSeconds > 31536000) {
    fields['stale_after_seconds'] = 'must be between 0 and 31536000';
  }
  const lastSyncAt = dateOrNull(body.last_sync_at);
  const lastSuccessfulSyncAt = dateOrNull(body.last_successful_sync_at);
  if (body.last_sync_at !== undefined && !lastSyncAt) fields['last_sync_at'] = 'must be an ISO date-time string';
  if (body.last_successful_sync_at !== undefined && !lastSuccessfulSyncAt) {
    fields['last_successful_sync_at'] = 'must be an ISO date-time string';
  }
  const webhookSourceKey = body.webhook_source_key === undefined || body.webhook_source_key === null
    ? null
    : validateConnectorKey(body.webhook_source_key, fields, 'webhook_source_key');
  if (Object.keys(fields).length > 0 || !type) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields },
      retryable: false,
    });
  }
  return {
    merchantId,
    connectorKey,
    connectorType: type,
    displayName: body.display_name as string,
    status: status as string,
    sourceDomains,
    sourcePriority,
    syncStatus: syncStatus as string,
    healthState: healthState as string,
    lastSyncAt,
    lastSuccessfulSyncAt,
    staleAfterSeconds,
    conflictBlockers,
    webhookSourceKey,
  };
}

export async function commerceConnectorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ConnectorBody }>('/connectors', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = validateCreateBody((request.body ?? {}) as ConnectorBody);
    const merchantId = merchantIdForConnectorRequest(request, body.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const existing = await sql<Array<{ connector_key: string }>>`
      SELECT connector_key
        FROM commerce_connectors
       WHERE tenant_id = ${tenantId}
         AND merchant_id = ${merchantId}
         AND connector_key = ${body.connectorKey}
       LIMIT 1
    `;
    if (existing[0]) {
      throw new CommerceHttpError(409, 'connector_exists',
        'Connector already exists for this merchant and connector_key');
    }
    await assertWebhookSourceInMerchant(sql, tenantId, merchantId, body.webhookSourceKey);
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<ConnectorRow[]>`
        INSERT INTO commerce_connectors (
          id, tenant_id, merchant_id, connector_key, connector_type,
          display_name, status, runtime_mode, source_domains, source_priority,
          sync_status, health_state, last_sync_at, last_successful_sync_at,
          stale_after_seconds, conflict_blockers, webhook_source_key
        ) VALUES (
          ${newCommerceConnectorId()}, ${tenantId}, ${merchantId}, ${body.connectorKey},
          ${body.connectorType}, ${body.displayName}, ${body.status},
          ${runtimeModeFor(body.connectorType)}, ${JSON.stringify(body.sourceDomains)}::jsonb,
          ${body.sourcePriority}, ${body.syncStatus}, ${body.healthState},
          ${body.lastSyncAt}, ${body.lastSuccessfulSyncAt}, ${body.staleAfterSeconds},
          ${JSON.stringify(body.conflictBlockers)}::jsonb, ${body.webhookSourceKey}
        )
        RETURNING id, tenant_id, merchant_id, connector_key, connector_type,
                  display_name, status, runtime_mode, source_domains,
                  source_priority, sync_status, health_state, last_sync_at,
                  last_successful_sync_at, stale_after_seconds,
                  conflict_blockers, webhook_source_key,
                  agenticorg_direct_execution_enabled, provider_call_enabled,
                  stores_credentials, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) {
        throw new CommerceHttpError(500, 'connector_create_failed',
          'Connector registry row could not be created', { retryable: true });
      }
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'merchant.connector.created',
        resourceType: 'commerce_connector',
        resourceId: body.connectorKey,
        requestId: request.id,
        metadata: {
          connector_key: body.connectorKey,
          connector_type: body.connectorType,
          source_domains: body.sourceDomains,
          metadata_only_registry: true,
        },
      });
      const connectorRows = await readMerchantConnectorRows(tx as unknown as Sql, tenantId, merchantId);
      return { row, connectorRows, auditEventId: audit.id };
    });
    return reply.status(201).send({
      data: toConnector(result.row),
      source_precedence: sourcePrecedence(result.connectorRows),
      audit_event_id: result.auditEventId,
    });
  });

  app.post<{
    Params: ConnectorDryRunParams;
    Body: ConnectorDryRunBody;
  }>('/merchants/:merchantId/connectors/dry-run', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const generatedAt = new Date();
    const prepared = prepareConnectorDryRun((request.body ?? {}) as ConnectorDryRunBody, generatedAt);
    if (merchant.disabled_at !== null) {
      prepared.blockers.push({
        code: 'merchant_disabled',
        message: 'Merchant is disabled and cannot run connector dry-run evidence.',
        remediation: 'Re-enable the sandbox merchant through a separate reviewed operator action.',
      });
      prepared.blocked_count += 1;
    }
    if (merchant.environment !== 'sandbox') {
      prepared.blockers.push({
        code: 'live_merchant_mode_blocked',
        message: 'Connector dry-runs are available only for sandbox merchants.',
        remediation: 'Move this work to a sandbox merchant; live connector sync requires a later approval.',
      });
      prepared.blocked_count += 1;
    }

    const existingIds = await existingDryRunProductIds(
      sql,
      tenantId,
      merchantId,
      prepared.normalized_products.map((product) => product.source_product_ref),
    );
    const result = finalizeConnectorDryRun({
      ...prepared,
      dryRunId: newCommerceConnectorDryRunId(),
      tenantId,
      merchantId,
      existingProductIds: existingIds,
      generatedAt,
    });
    const persisted = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return persistDryRunWithAudit(tx, result, request.id);
    });

    const fatalBlockers = new Set([
      'unsupported_request_field',
      'unsupported_connector_type',
      'unsafe_source_label',
      'rows_missing',
      'rows_limit_exceeded',
      'invalid_stale_after_seconds',
      'private_field_rejected',
      'private_or_production_value_rejected',
      'enablement_field_rejected',
      'merchant_private_api_url_rejected',
    ]);
    const fatal = result.blockers.some((blocker) => fatalBlockers.has(blocker.code));
    if (merchant.disabled_at !== null || merchant.environment !== 'sandbox') {
      throw new CommerceHttpError(409, 'connector_dry_run_blocked',
        'Connector dry-run is blocked for this merchant', {
          auditEventId: persisted.resultAuditEventId,
          details: dryRunErrorDetails(result),
          retryable: false,
        });
    }
    if (fatal) {
      throw new CommerceHttpError(422, 'connector_dry_run_rejected',
        'Connector dry-run request contains unsupported, private, credential, execution, or enablement fields', {
          auditEventId: persisted.resultAuditEventId,
          details: dryRunErrorDetails(result),
          retryable: false,
        });
    }

    return reply.status(result.status === 'passed' ? 201 : 200).send({
      data: toDryRunResult(persisted.row),
      audit_events: [
        {
          event_type: 'connector_dry_run_requested',
          audit_event_id: persisted.requestedAuditEventId,
        },
        {
          event_type: result.status === 'passed' ? 'connector_dry_run_completed' : 'connector_dry_run_blocked',
          audit_event_id: persisted.resultAuditEventId,
        },
      ],
    });
  });

  app.get<{
    Params: Required<ConnectorDryRunParams>;
  }>('/merchants/:merchantId/connectors/dry-runs/:dryRunId', async (request, reply) => {
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const row = await readDryRunEvidence(sql, tenantId, merchantId, request.params.dryRunId);
    if (!row) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Connector dry-run evidence was not found in this tenant and merchant');
    }
    return reply.status(200).send({ data: toDryRunResult(row) });
  });

  app.post<{
    Params: ConnectorDryRunReviewParams;
    Body: ConnectorDryRunReviewRequestBody;
  }>('/merchants/:merchantId/connectors/dry-runs/:dryRunId/review-request', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const actor = connectorReviewActor(request);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    const { requestNote } = validateReviewRequestBody((request.body ?? {}) as Record<string, unknown>);
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const dryRun = await readDryRunEvidence(sql, tenantId, merchantId, request.params.dryRunId);
    if (!dryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Connector dry-run evidence was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (merchant.disabled_at !== null) blockerCodes.push('merchant_disabled');
    if (merchant.environment !== 'sandbox') blockerCodes.push('live_merchant_mode_blocked');
    if (!dryRunControlsAreSafe(dryRun)) blockerCodes.push('dry_run_controls_not_safe');
    if (blockerCodes.length > 0) {
      const auditEventId = await appendDryRunReviewBlockedAudit(sql, {
        tenantId,
        merchantId,
        dryRunId: dryRun.id,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_dry_run_review_blocked',
        'Connector dry-run review request is blocked', {
          auditEventId,
          details: dryRunReviewBlockedDetails(dryRun, blockerCodes),
          retryable: false,
        });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return insertDryRunReviewRequest(tx, {
        tenantId,
        merchantId,
        dryRun,
        actor,
        requestNote,
        requestId: request.id,
      });
    });
    return reply.status(result.created ? 201 : 200).send({
      data: toDryRunReview(result.row),
      dry_run: toDryRunResult(dryRun),
      audit_event_id: result.row.requested_audit_event_id,
    });
  });

  app.get<{
    Params: ConnectorDryRunReviewParams;
  }>('/merchants/:merchantId/connectors/dry-runs/:dryRunId/review', async (request, reply) => {
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const dryRun = await readDryRunEvidence(sql, tenantId, merchantId, request.params.dryRunId);
    if (!dryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Connector dry-run evidence was not found in this tenant and merchant');
    }
    const review = await readDryRunReview(sql, tenantId, merchantId, dryRun.id);
    if (!review) {
      throw new CommerceHttpError(404, 'connector_dry_run_review_not_found',
        'Connector dry-run review was not found in this tenant and merchant');
    }
    return reply.status(200).send({
      data: toDryRunReview(review),
      dry_run: toDryRunResult(dryRun),
    });
  });

  app.post<{
    Params: ConnectorDryRunReviewParams;
    Body: ConnectorDryRunReviewDecisionBody;
  }>('/merchants/:merchantId/connectors/dry-runs/:dryRunId/review/decision', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const operator = operatorCaller(request);
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const { decision, decisionNote } = validateReviewDecisionBody((request.body ?? {}) as Record<string, unknown>);
    const sql = getSql();
    const dryRun = await readDryRunEvidence(sql, tenantId, merchantId, request.params.dryRunId);
    if (!dryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Connector dry-run evidence was not found in this tenant and merchant');
    }
    const review = await readDryRunReview(sql, tenantId, merchantId, dryRun.id);
    if (!review) {
      throw new CommerceHttpError(404, 'connector_dry_run_review_not_found',
        'Connector dry-run review was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (review.status !== 'pending_operator_review') blockerCodes.push('review_not_pending');
    if (!dryRunControlsAreSafe(dryRun)) blockerCodes.push('dry_run_controls_not_safe');
    if (decision === 'accepted_for_sandbox_followup' && dryRun.status !== 'passed') {
      blockerCodes.push('blocked_dry_run_cannot_be_accepted');
    }
    if (blockerCodes.length > 0) {
      const auditEventId = await appendDryRunReviewBlockedAudit(sql, {
        tenantId,
        merchantId,
        dryRunId: dryRun.id,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_dry_run_review_blocked',
        'Connector dry-run review decision is blocked', {
          auditEventId,
          details: dryRunReviewBlockedDetails(dryRun, blockerCodes),
          retryable: false,
        });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return recordDryRunReviewDecision(tx, {
        tenantId,
        merchantId,
        dryRun,
        review,
        operatorId: operator.developerId,
        decision,
        decisionNote,
        requestId: request.id,
      });
    });
    return reply.status(200).send({
      data: toDryRunReview(result.row),
      dry_run: toDryRunResult(dryRun),
      audit_event_id: result.auditEventId,
    });
  });

  app.post<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'dryRunId'>>;
    Body: ConnectorDryRunRemediationRequestBody;
  }>('/merchants/:merchantId/connectors/dry-runs/:dryRunId/remediation', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const actor = connectorReviewActor(request);
    const tenantId = request.commerceTenantId;
    const { publicSafeNote } = validateRemediationRequestBody((request.body ?? {}) as Record<string, unknown>);
    const sql = getSql();
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const dryRun = await readDryRunEvidence(sql, tenantId, merchantId, request.params.dryRunId);
    if (!dryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Connector dry-run evidence was not found in this tenant and merchant');
    }
    const review = await readDryRunReview(sql, tenantId, merchantId, dryRun.id);
    if (!review) {
      throw new CommerceHttpError(404, 'connector_dry_run_review_not_found',
        'Connector dry-run review was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (merchant.disabled_at !== null) blockerCodes.push('merchant_disabled');
    if (merchant.environment !== 'sandbox') blockerCodes.push('live_merchant_mode_blocked');
    if (!dryRunControlsAreSafe(dryRun)) blockerCodes.push('dry_run_controls_not_safe');
    if (review.status !== 'needs_changes' && review.status !== 'blocked') {
      blockerCodes.push('original_review_not_remediable');
    }
    if (blockerCodes.length > 0) {
      const auditEventId = await appendRemediationBlockedAudit(sql, {
        tenantId,
        merchantId,
        remediationId: null,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_remediation_blocked',
        'Connector dry-run remediation request is blocked', {
          auditEventId,
          details: remediationBlockedDetails(null, blockerCodes),
          retryable: false,
        });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return insertDryRunRemediationRequest(tx, {
        tenantId,
        merchantId,
        dryRun,
        review,
        actor,
        publicSafeNote,
        requestId: request.id,
      });
    });
    return reply.status(result.created ? 201 : 200).send({
      data: toDryRunRemediation(result.row),
      original_dry_run: toDryRunResult(dryRun),
      original_review: toDryRunReview(review),
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{ Querystring: ConnectorDryRunRemediationListQuery }>('/connectors/remediations', async (request, reply) => {
    const fields: Record<string, string> = {};
    const merchantId = merchantFilterForRemediationQueue(request, request.query.merchant_id);
    const rawStatus = request.query.status;
    const status = rawStatus && REMEDIATION_STATUSES.has(rawStatus as ConnectorDryRunRemediationStatus)
      ? rawStatus as ConnectorDryRunRemediationStatus
      : null;
    if (rawStatus !== undefined && status === null) {
      fields['status'] = `must be one of: ${REMEDIATION_STATUS_VALUES.join(', ')}`;
    }
    const rawTriageStatus = request.query.triage_status;
    const triageStatus = rawTriageStatus
      && REMEDIATION_TRIAGE_STATUSES.has(rawTriageStatus as ConnectorDryRunRemediationTriageStatus)
      ? rawTriageStatus as ConnectorDryRunRemediationTriageStatus
      : null;
    if (rawTriageStatus !== undefined && triageStatus === null) {
      fields['triage_status'] = `must be one of: ${REMEDIATION_TRIAGE_STATUS_VALUES.join(', ')}`;
    }
    const rawOriginalDecision = request.query.original_decision;
    const originalDecision = rawOriginalDecision && REMEDIATION_ORIGINAL_DECISIONS.has(rawOriginalDecision)
      ? rawOriginalDecision as 'needs_changes' | 'blocked'
      : null;
    if (rawOriginalDecision !== undefined && originalDecision === null) {
      fields['original_decision'] = 'must be needs_changes or blocked';
    }
    const hasCorrectedDryRun = parseQueryBoolean(
      request.query.has_corrected_dry_run,
      'has_corrected_dry_run',
      fields,
    );
    const hasFollowupReview = parseQueryBoolean(
      request.query.has_followup_review,
      'has_followup_review',
      fields,
    );
    const limit = parseQueryLimit(request.query.limit, 'limit', fields, 25, 100);
    if (Object.keys(fields).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields },
        retryable: false,
      });
    }

    const tenantId = request.commerceTenantId;
    const sql = getSql();
    if (merchantId !== null) await assertMerchantInTenant(sql, tenantId, merchantId);
    const rows = await readDryRunRemediationQueue(sql, {
      tenantId,
      merchantId,
      status,
      triageStatus,
      originalDecision,
      hasCorrectedDryRun,
      hasFollowupReview,
      limit,
    });
    return reply.status(200).send({
      items: rows.map(toDryRunRemediationQueueItem),
      next_cursor: null,
      filters: {
        merchant_id: merchantId,
        status,
        triage_status: triageStatus,
        original_decision: originalDecision,
        has_corrected_dry_run: hasCorrectedDryRun,
        has_followup_review: hasFollowupReview,
        limit,
      },
      controls: {
        sandbox_only: true,
        not_live: true,
        not_approved: true,
        public_discovery_enabled: false,
        checkout_payment_enabled: false,
        live_provider_enabled: false,
        [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
        credential_entry_enabled: false,
        outbound_sync_enabled: false,
        production_connector_setup_enabled: false,
        provider_call_enabled: false,
        merchant_private_api_calls_enabled: false,
        production_allowlist_written: false,
      },
    });
  });

  app.get<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'remediationId'>>;
  }>('/merchants/:merchantId/connectors/remediations/:remediationId', async (request, reply) => {
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const remediation = await readDryRunRemediationById(sql, tenantId, merchantId, request.params.remediationId);
    if (!remediation) {
      throw new CommerceHttpError(404, 'connector_remediation_not_found',
        'Connector dry-run remediation was not found in this tenant and merchant');
    }
    return reply.status(200).send({ data: toDryRunRemediation(remediation) });
  });

  app.get<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'remediationId'>>;
  }>('/merchants/:merchantId/connectors/remediations/:remediationId/timeline', async (request, reply) => {
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const remediation = await readDryRunRemediationById(sql, tenantId, merchantId, request.params.remediationId);
    if (!remediation) {
      throw new CommerceHttpError(404, 'connector_remediation_not_found',
        'Connector dry-run remediation was not found in this tenant and merchant');
    }
    const followupReview = remediation.followup_review_id
      ? await readDryRunReviewById(sql, tenantId, merchantId, remediation.followup_review_id)
      : null;
    if (remediation.followup_review_id && !followupReview) {
      throw new CommerceHttpError(404, 'connector_dry_run_review_not_found',
        'Connector remediation follow-up review was not found in this tenant and merchant');
    }
    return reply.status(200).send({ data: toDryRunRemediationTimeline(remediation, followupReview) });
  });

  app.post<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'remediationId'>>;
    Body: ConnectorDryRunRemediationTriageBody;
  }>('/merchants/:merchantId/connectors/remediations/:remediationId/triage', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const operator = operatorCaller(request);
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const body = validateRemediationTriageBody((request.body ?? {}) as Record<string, unknown>, operator.developerId);
    const sql = getSql();
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const remediation = await readDryRunRemediationById(sql, tenantId, merchantId, request.params.remediationId);
    if (!remediation) {
      throw new CommerceHttpError(404, 'connector_remediation_not_found',
        'Connector dry-run remediation was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (merchant.disabled_at !== null) blockerCodes.push('merchant_disabled');
    if (merchant.environment !== 'sandbox') blockerCodes.push('live_merchant_mode_blocked');
    if (!remediationControlsAreSafe(remediation)) blockerCodes.push('remediation_controls_not_safe');
    if (blockerCodes.length > 0) {
      const auditEventId = await appendRemediationBlockedAudit(sql, {
        tenantId,
        merchantId,
        remediationId: remediation.id,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_remediation_triage_blocked',
        'Connector remediation triage is blocked for sandbox safety', {
          auditEventId,
          details: remediationBlockedDetails(remediation, blockerCodes),
          retryable: false,
        });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return recordDryRunRemediationTriage(tx, {
        tenantId,
        merchantId,
        remediation,
        operatorId: operator.developerId,
        triageStatus: body.triageStatus,
        assignedOperatorId: body.assignedOperatorId,
        triageNote: body.triageNote,
        merchantFollowupSummary: body.merchantFollowupSummary,
        nextStep: body.nextStep,
        requestId: request.id,
      });
    });
    return reply.status(result.created ? 201 : 200).send({
      data: toDryRunRemediation(result.row),
      audit_event_id: result.auditEventId,
      controls: dryRunRemediationControls(result.row),
    });
  });

  app.post<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'remediationId'>>;
    Body: ConnectorDryRunCorrectedBody;
  }>('/merchants/:merchantId/connectors/remediations/:remediationId/corrected-dry-run', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const tenantId = request.commerceTenantId;
    const { correctedDryRunId, publicSafeNote } = validateCorrectedDryRunBody((request.body ?? {}) as Record<string, unknown>);
    const sql = getSql();
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const remediation = await readDryRunRemediationById(sql, tenantId, merchantId, request.params.remediationId);
    if (!remediation) {
      throw new CommerceHttpError(404, 'connector_remediation_not_found',
        'Connector dry-run remediation was not found in this tenant and merchant');
    }
    const correctedDryRun = await readDryRunEvidence(sql, tenantId, merchantId, correctedDryRunId);
    if (!correctedDryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Corrected connector dry-run evidence was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (merchant.disabled_at !== null) blockerCodes.push('merchant_disabled');
    if (merchant.environment !== 'sandbox') blockerCodes.push('live_merchant_mode_blocked');
    if (correctedDryRun.id === remediation.original_dry_run_id) blockerCodes.push('corrected_dry_run_must_differ');
    if (correctedDryRun.status !== 'passed') blockerCodes.push('corrected_dry_run_blocked');
    if (numberValue(correctedDryRun.blocked_count, 0) > 0) blockerCodes.push('corrected_dry_run_has_blockers');
    if (!dryRunControlsAreSafe(correctedDryRun)) blockerCodes.push('corrected_dry_run_controls_not_safe');
    if (blockerCodes.length > 0) {
      const auditEventId = await appendRemediationBlockedAudit(sql, {
        tenantId,
        merchantId,
        remediationId: remediation.id,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_remediation_blocked',
        'Corrected connector dry-run attachment is blocked', {
          auditEventId,
          details: remediationBlockedDetails(remediation, blockerCodes),
          retryable: false,
        });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      return attachCorrectedDryRunToRemediation(tx, {
        tenantId,
        merchantId,
        remediation,
        correctedDryRun,
        publicSafeNote,
        requestId: request.id,
      });
    });
    return reply.status(200).send({
      data: toDryRunRemediation(result.row),
      corrected_dry_run: toDryRunResult(correctedDryRun),
      audit_event_id: result.auditEventId,
    });
  });

  app.post<{
    Params: Required<Pick<ConnectorDryRunRemediationParams, 'merchantId' | 'remediationId'>>;
    Body: ConnectorDryRunFollowupBody;
  }>('/merchants/:merchantId/connectors/remediations/:remediationId/follow-up-review', async (request, reply) => {
    if (!isPlainObject(request.body ?? {})) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const merchantId = merchantIdForConnectorRequest(request, request.params.merchantId);
    const actor = connectorReviewActor(request);
    const tenantId = request.commerceTenantId;
    const { requestNote } = validateFollowupReviewBody((request.body ?? {}) as Record<string, unknown>);
    const sql = getSql();
    const merchant = await readMerchantForDryRun(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const remediation = await readDryRunRemediationById(sql, tenantId, merchantId, request.params.remediationId);
    if (!remediation) {
      throw new CommerceHttpError(404, 'connector_remediation_not_found',
        'Connector dry-run remediation was not found in this tenant and merchant');
    }
    if (!remediation.corrected_dry_run_id) {
      const auditEventId = await appendRemediationBlockedAudit(sql, {
        tenantId,
        merchantId,
        remediationId: remediation.id,
        requestId: request.id,
        blockerCodes: ['corrected_dry_run_missing'],
      });
      throw new CommerceHttpError(409, 'connector_remediation_blocked',
        'Attach a corrected sandbox dry-run before requesting follow-up review', {
          auditEventId,
          details: remediationBlockedDetails(remediation, ['corrected_dry_run_missing']),
          retryable: false,
        });
    }
    const correctedDryRun = await readDryRunEvidence(sql, tenantId, merchantId, remediation.corrected_dry_run_id);
    if (!correctedDryRun) {
      throw new CommerceHttpError(404, 'connector_dry_run_not_found',
        'Corrected connector dry-run evidence was not found in this tenant and merchant');
    }
    const blockerCodes: string[] = [];
    if (merchant.disabled_at !== null) blockerCodes.push('merchant_disabled');
    if (merchant.environment !== 'sandbox') blockerCodes.push('live_merchant_mode_blocked');
    if (correctedDryRun.status !== 'passed') blockerCodes.push('corrected_dry_run_blocked');
    if (!dryRunControlsAreSafe(correctedDryRun)) blockerCodes.push('corrected_dry_run_controls_not_safe');
    if (blockerCodes.length > 0) {
      const auditEventId = await appendRemediationBlockedAudit(sql, {
        tenantId,
        merchantId,
        remediationId: remediation.id,
        requestId: request.id,
        blockerCodes,
      });
      throw new CommerceHttpError(409, 'connector_remediation_blocked',
        'Connector remediation follow-up review request is blocked', {
          auditEventId,
          details: remediationBlockedDetails(remediation, blockerCodes),
          retryable: false,
        });
    }
    if (remediation.followup_review_id) {
      const existingFollowup = await readDryRunReviewById(sql, tenantId, merchantId, remediation.followup_review_id);
      if (!existingFollowup) {
        throw new CommerceHttpError(404, 'connector_dry_run_review_not_found',
          'Connector remediation follow-up review was not found in this tenant and merchant');
      }
      return reply.status(200).send({
        data: toDryRunRemediation(remediation),
        corrected_dry_run: toDryRunResult(correctedDryRun),
        followup_review: toDryRunReview(existingFollowup),
        audit_event_id: remediation.followup_audit_event_id,
      });
    }
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const reviewRequest = await insertDryRunReviewRequest(tx, {
        tenantId,
        merchantId,
        dryRun: correctedDryRun,
        actor,
        requestNote,
        requestId: request.id,
      });
      const remediationResult = await attachFollowupReviewToRemediation(tx, {
        tenantId,
        merchantId,
        remediation,
        correctedDryRun,
        followupReview: reviewRequest.row,
        requestId: request.id,
      });
      return { reviewRequest, remediationResult };
    });
    return reply.status(result.remediationResult.created ? 201 : 200).send({
      data: toDryRunRemediation(result.remediationResult.row),
      corrected_dry_run: toDryRunResult(correctedDryRun),
      followup_review: toDryRunReview(result.reviewRequest.row),
      audit_event_id: result.remediationResult.auditEventId,
    });
  });

  app.get<{ Querystring: ConnectorListQuery }>('/connectors', async (request, reply) => {
    const fields: Record<string, string> = {};
    const merchantId = merchantIdForConnectorRequest(request, request.query.merchant_id);
    if (request.query.connector_type !== undefined && !connectorType(request.query.connector_type)) {
      fields['connector_type'] = `must be one of: ${CONNECTOR_TYPES.join(', ')}`;
    }
    if (request.query.status !== undefined && !CONNECTOR_STATUSES.has(request.query.status)) {
      fields['status'] = 'must be one of: draft, active, disabled';
    }
    if (Object.keys(fields).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields },
        retryable: false,
      });
    }
    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertMerchantInTenant(sql, tenantId, merchantId);
    const rows = await sql<ConnectorRow[]>`
      SELECT id, tenant_id, merchant_id, connector_key, connector_type,
             display_name, status, runtime_mode, source_domains,
             source_priority, sync_status, health_state, last_sync_at,
             last_successful_sync_at, stale_after_seconds, conflict_blockers,
             webhook_source_key, agenticorg_direct_execution_enabled,
             provider_call_enabled, stores_credentials, created_at, updated_at
        FROM commerce_connectors
       WHERE tenant_id = ${tenantId}
         AND merchant_id = ${merchantId}
         AND (${request.query.connector_type ?? null}::text IS NULL OR connector_type = ${request.query.connector_type ?? null})
         AND (${request.query.status ?? null}::text IS NULL OR status = ${request.query.status ?? null})
       ORDER BY source_priority ASC, connector_key ASC
    `;
    return reply.status(200).send({
      items: rows.map((row) => toConnector(row)),
      source_precedence: sourcePrecedence(rows),
      controls: {
        metadata_only_registry: true,
        credentials_stored_by_registry: false,
        outbound_sync_enabled_by_registry: false,
        agenticorg_direct_execution_allowed: false,
        provider_call_enabled_by_registry: false,
        checkout_payment_enabled_by_registry: false,
        live_payment_enabled_by_registry: false,
        [PROVIDER_SPECIFIC_LIVE_DISABLED_BY_REGISTRY_KEY]: false,
        public_discovery_enabled_by_registry: false,
        production_config_written_by_registry: false,
      },
    });
  });

  app.patch<{
    Params: { connector_key: string };
    Querystring: ConnectorPatchQuery;
    Body: ConnectorBody;
  }>('/connectors/:connector_key', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    rejectUnsupportedOrPrivateFields(rawBody, PATCH_FIELDS, fields);
    const connectorKey = validateConnectorKey(request.params.connector_key, fields) ?? '';
    const merchantId = merchantIdForConnectorRequest(request, request.query.merchant_id);
    const changedFields = Object.keys(rawBody).filter((key) => PATCH_FIELDS.has(key));
    if (changedFields.length === 0 && Object.keys(fields).length === 0) {
      fields['body'] = 'at least one mutable field is required';
    }
    if (rawBody['display_name'] !== undefined && !isString(rawBody['display_name'])) {
      fields['display_name'] = 'must be a non-empty string';
    }
    if (rawBody['status'] !== undefined
      && (typeof rawBody['status'] !== 'string' || !CONNECTOR_STATUSES.has(rawBody['status']))) {
      fields['status'] = 'must be one of: draft, active, disabled';
    }
    if (rawBody['sync_status'] !== undefined
      && (typeof rawBody['sync_status'] !== 'string' || !SYNC_STATUSES.has(rawBody['sync_status']))) {
      fields['sync_status'] = 'must be one of: not_started, manual, scheduled, sync_succeeded, sync_failed, blocked';
    }
    if (rawBody['health_state'] !== undefined
      && (typeof rawBody['health_state'] !== 'string' || !HEALTH_STATES.has(rawBody['health_state']))) {
      fields['health_state'] = 'must be one of: unknown, healthy, stale, conflict, blocked, disabled';
    }
    const sourceDomains = rawBody['source_domains'] === undefined
      ? null
      : normalizeSourceDomains(rawBody['source_domains'], fields);
    const conflictBlockers = rawBody['conflict_blockers'] === undefined
      ? null
      : normalizeConflictBlockers(rawBody['conflict_blockers'], fields);
    const sourcePriority = rawBody['source_priority'] === undefined
      ? null
      : numberValue(rawBody['source_priority'], -1);
    if (sourcePriority !== null && sourcePriority < 0) fields['source_priority'] = 'must be a non-negative integer';
    const staleAfterSeconds = rawBody['stale_after_seconds'] === undefined
      ? null
      : numberValue(rawBody['stale_after_seconds'], -1);
    if (staleAfterSeconds !== null && (staleAfterSeconds < 0 || staleAfterSeconds > 31536000)) {
      fields['stale_after_seconds'] = 'must be between 0 and 31536000';
    }
    const lastSyncAt = rawBody['last_sync_at'] === undefined ? null : dateOrNull(rawBody['last_sync_at']);
    const hasLastSyncAt = Object.prototype.hasOwnProperty.call(rawBody, 'last_sync_at');
    if (hasLastSyncAt && rawBody['last_sync_at'] !== null && !lastSyncAt) {
      fields['last_sync_at'] = 'must be an ISO date-time string or null';
    }
    const lastSuccessfulSyncAt = rawBody['last_successful_sync_at'] === undefined
      ? null
      : dateOrNull(rawBody['last_successful_sync_at']);
    const hasLastSuccessfulSyncAt = Object.prototype.hasOwnProperty.call(rawBody, 'last_successful_sync_at');
    if (hasLastSuccessfulSyncAt && rawBody['last_successful_sync_at'] !== null && !lastSuccessfulSyncAt) {
      fields['last_successful_sync_at'] = 'must be an ISO date-time string or null';
    }
    const hasWebhookSourceKey = Object.prototype.hasOwnProperty.call(rawBody, 'webhook_source_key');
    const webhookSourceKey = hasWebhookSourceKey && rawBody['webhook_source_key'] !== null
      ? validateConnectorKey(rawBody['webhook_source_key'], fields, 'webhook_source_key')
      : null;
    if (Object.keys(fields).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields },
        retryable: false,
      });
    }

    const tenantId = request.commerceTenantId;
    const sql = getSql();
    await assertWebhookSourceInMerchant(sql, tenantId, merchantId, webhookSourceKey);
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<ConnectorRow[]>`
        UPDATE commerce_connectors
           SET display_name = CASE WHEN ${Object.prototype.hasOwnProperty.call(rawBody, 'display_name')}::boolean THEN ${rawBody['display_name'] as string | null}::text ELSE display_name END,
               status = CASE WHEN ${Object.prototype.hasOwnProperty.call(rawBody, 'status')}::boolean THEN ${rawBody['status'] as string | null}::text ELSE status END,
               source_domains = CASE WHEN ${sourceDomains !== null}::boolean THEN ${JSON.stringify(sourceDomains ?? [])}::jsonb ELSE source_domains END,
               source_priority = CASE WHEN ${sourcePriority !== null}::boolean THEN ${sourcePriority}::integer ELSE source_priority END,
               sync_status = CASE WHEN ${Object.prototype.hasOwnProperty.call(rawBody, 'sync_status')}::boolean THEN ${rawBody['sync_status'] as string | null}::text ELSE sync_status END,
               health_state = CASE WHEN ${Object.prototype.hasOwnProperty.call(rawBody, 'health_state')}::boolean THEN ${rawBody['health_state'] as string | null}::text ELSE health_state END,
               last_sync_at = CASE WHEN ${hasLastSyncAt}::boolean THEN ${lastSyncAt}::timestamptz ELSE last_sync_at END,
               last_successful_sync_at = CASE WHEN ${hasLastSuccessfulSyncAt}::boolean THEN ${lastSuccessfulSyncAt}::timestamptz ELSE last_successful_sync_at END,
               stale_after_seconds = CASE WHEN ${staleAfterSeconds !== null}::boolean THEN ${staleAfterSeconds}::integer ELSE stale_after_seconds END,
               conflict_blockers = CASE WHEN ${conflictBlockers !== null}::boolean THEN ${JSON.stringify(conflictBlockers ?? [])}::jsonb ELSE conflict_blockers END,
               webhook_source_key = CASE WHEN ${hasWebhookSourceKey}::boolean THEN ${webhookSourceKey}::text ELSE webhook_source_key END,
               updated_at = NOW()
         WHERE tenant_id = ${tenantId}
           AND merchant_id = ${merchantId}
           AND connector_key = ${connectorKey}
        RETURNING id, tenant_id, merchant_id, connector_key, connector_type,
                  display_name, status, runtime_mode, source_domains,
                  source_priority, sync_status, health_state, last_sync_at,
                  last_successful_sync_at, stale_after_seconds,
                  conflict_blockers, webhook_source_key,
                  agenticorg_direct_execution_enabled, provider_call_enabled,
                  stores_credentials, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) return null;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'merchant.connector.updated',
        resourceType: 'commerce_connector',
        resourceId: connectorKey,
        requestId: request.id,
        metadata: {
          connector_key: connectorKey,
          changed_fields: changedFields,
          metadata_only_registry: true,
        },
      });
      const connectorRows = await readMerchantConnectorRows(tx as unknown as Sql, tenantId, merchantId);
      return { row, connectorRows, auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'connector_not_found',
        'Connector not found in this tenant and merchant');
    }
    return reply.status(200).send({
      data: toConnector(result.row),
      source_precedence: sourcePrecedence(result.connectorRows),
      audit_event_id: result.auditEventId,
    });
  });
}
