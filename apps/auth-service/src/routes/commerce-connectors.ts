import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import {
  newCommerceConnectorDryRunId,
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

interface ConnectorDryRunReviewDecisionBody {
  decision?: unknown;
  decision_note?: unknown;
}

interface ConnectorDryRunReviewRequestBody {
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

type ConnectorDryRunReviewStatus =
  | 'pending_operator_review'
  | 'accepted_for_sandbox_followup'
  | 'needs_changes'
  | 'blocked';

type ConnectorDryRunReviewDecision =
  | 'accepted_for_sandbox_followup'
  | 'needs_changes'
  | 'blocked';

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
const REVIEW_DECISIONS = new Set<ConnectorDryRunReviewDecision>([
  'accepted_for_sandbox_followup',
  'needs_changes',
  'blocked',
]);
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
