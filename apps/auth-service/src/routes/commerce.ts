import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import {
  resolveOrCreateTenantForDeveloper,
  isAutoTenantAllowed,
} from '../lib/commerce/tenant.js';
import { commerceErrorHandler, CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import {
  newMerchantId,
  newCommerceAgentId,
  newCommerceProductId,
  newCommerceVariantId,
} from '../lib/commerce/ids.js';
import { isCommerceCategoryPreset } from '../lib/commerce/presets.js';
import { resolveCommerceCaller, type CommerceCaller } from '../lib/commerce/caller.js';
import {
  listCatalogProducts,
  readCatalogItem,
  searchCatalog,
} from '../lib/commerce/catalog.js';
import {
  computeSandboxOnboardingReadiness,
  deriveSandboxOnboardingState,
  isPublicSafeText,
  isSafeSupportEmail,
  isSafeSupportUrl,
  READ_ONLY_DISCOVERY_OPERATOR_DECISIONS,
  isSandboxOnboardingState,
  toSandboxAgenticOrgBuyerDiscoveryPreviewResponse,
  toSandboxOnboardingResponse,
  toSandboxReadOnlyDiscoveryOperatorReviewResponse,
  toSandboxReadOnlyDiscoveryRolloutProposalResponse,
  validateSandboxOnboardingTransition,
  type ReadOnlyDiscoveryOperatorDecision,
  type SandboxAgentPreviewProductInput,
  type SandboxOnboardingCatalogSummary,
  type SandboxOnboardingMerchant,
  type SandboxOnboardingState,
  type SandboxAgenticOrgBuyerDiscoveryPreviewPayload,
  type SandboxReadOnlyDiscoveryReviewAuditSnapshot,
  type SandboxReadOnlyDiscoveryRolloutProposalPayload,
} from '../lib/commerce/sandbox-onboarding.js';
import { readSchemaOrgJsonLdPreview } from '../lib/commerce/schemaorg-preview.js';
import { readUcpCapabilityProfilePreview } from '../lib/commerce/ucp-capability-preview.js';
import { commerceTenantsRoutes } from './commerce-tenants.js';
import { commercePassportRoutes } from './commerce-passport.js';
import { commerceConsentRoutes } from './commerce-consent.js';
import { commercePolicyRoutes } from './commerce-policy.js';
import { commerceProviderCredentialRoutes } from './commerce-provider-credentials.js';
import { commerceCartPaymentRoutes } from './commerce-cart-payment.js';
import { commerceOpsRoutes } from './commerce-ops.js';
import { commerceWebhookSourceRoutes } from './commerce-webhook-sources.js';

declare module 'fastify' {
  interface FastifyRequest {
    commerceTenantId: string;
    commerceCaller: CommerceCaller;
  }
  interface FastifyContextConfig {
    /** Set on consent SSR routes to opt out of commerce caller resolution. */
    publicConsent?: boolean;
  }
}

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

type Sql = ReturnType<typeof postgres>;

interface MerchantCreateBody {
  legal_name?: unknown;
  display_name?: unknown;
  category_preset?: unknown;
  country_code?: unknown;
  default_currency?: unknown;
  support_email?: unknown;
  support_url?: unknown;
  public_discovery_description_draft?: unknown;
  agentic_commerce_requested?: unknown;
}

interface MerchantPatchBody {
  legal_name?: unknown;
  display_name?: unknown;
  category_preset?: unknown;
  country_code?: unknown;
  default_currency?: unknown;
  support_email?: unknown;
  agentic_commerce_enabled?: unknown;
}

interface SandboxOnboardingUpdateBody {
  display_name?: unknown;
  category_preset?: unknown;
  country_code?: unknown;
  default_currency?: unknown;
  support_email?: unknown;
  support_url?: unknown;
  public_discovery_description_draft?: unknown;
  agentic_commerce_requested?: unknown;
}

interface SandboxOnboardingTransitionBody {
  target_state?: unknown;
  reason?: unknown;
}

interface ReadOnlyDiscoveryReviewDecisionBody {
  decision?: unknown;
  reason?: unknown;
  remediation_items?: unknown;
}

interface ReadOnlyDiscoveryRolloutProposalBody {
  proposal_note?: unknown;
}

interface ReadOnlyDiscoveryRolloutProposalWithdrawBody {
  reason?: unknown;
}

interface AgenticOrgBuyerDiscoveryHandoffBody {
  handoff_note?: unknown;
}

interface AgenticOrgBuyerDiscoveryHandoffWithdrawBody {
  reason?: unknown;
}

interface AgentCreateBody {
  display_name?: unknown;
  agent_type?: unknown;
  public_key_jwk?: unknown;
  api_key_hash?: unknown;
  trust_status?: unknown;
}

interface AgentListQuery {
  merchant_id?: string;
  status?: string;
  trust_status?: string;
  limit?: string;
  cursor?: string;
}

interface AgentPatchBody {
  display_name?: unknown;
  status?: unknown;
  trust_status?: unknown;
}

interface VariantInput {
  sku?: unknown;
  parent_sku?: unknown;
  model?: unknown;
  variant_title?: unknown;
  attributes?: unknown;
  price_amount?: unknown;
  currency?: unknown;
  tax_inclusive?: unknown;
  gst_slab?: unknown;
  tax_rate?: unknown;
  hsn_code?: unknown;
  availability_status?: unknown;
  warranty_summary?: unknown;
  return_policy_summary?: unknown;
  source_system?: unknown;
}

interface ProductCreateBody {
  product_id?: unknown;
  title?: unknown;
  brand?: unknown;
  description?: unknown;
  image_url?: unknown;
  category_preset?: unknown;
  source_system?: unknown;
  manually_maintained?: unknown;
  merchant_id?: unknown;
  variants?: unknown;
}

interface ProductListQuery {
  merchant_id?: string;
  status?: string;
  query?: string;
  category_preset?: string;
  limit?: string;
  cursor?: string;
}

interface ProductPatchBody {
  title?: unknown;
  brand?: unknown;
  description?: unknown;
  image_url?: unknown;
  category_preset?: unknown;
  status?: unknown;
  source_system?: unknown;
  manually_maintained?: unknown;
  variants?: unknown;
}

interface ProductBulkBody {
  merchant_id?: unknown;
  dry_run?: unknown;
  products?: unknown;
}

interface CatalogSearchBody {
  merchant_id?: unknown;
  query?: unknown;
  filters?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const AGENT_TRUST_STATUSES = new Set(['pending', 'trusted', 'suspended', 'disabled']);
const AGENT_STATUSES = new Set(['active', 'disabled']);
const PRODUCT_STATUSES = new Set(['active', 'archived', 'all']);

const MERCHANT_CREATE_FIELDS = new Set([
  'legal_name',
  'display_name',
  'category_preset',
  'country_code',
  'default_currency',
  'support_email',
  'support_url',
  'public_discovery_description_draft',
  'agentic_commerce_requested',
]);

const MERCHANT_PATCH_FIELDS = new Set([
  'legal_name',
  'display_name',
  'category_preset',
  'country_code',
  'default_currency',
  'support_email',
  'agentic_commerce_enabled',
]);

const SANDBOX_ONBOARDING_UPDATE_FIELDS = new Set([
  'display_name',
  'category_preset',
  'country_code',
  'default_currency',
  'support_email',
  'support_url',
  'public_discovery_description_draft',
  'agentic_commerce_requested',
]);

const READ_ONLY_DISCOVERY_REVIEW_DECISION_FIELDS = new Set([
  'decision',
  'reason',
  'remediation_items',
]);

const READ_ONLY_DISCOVERY_REVIEW_REQUEST_EVENTS = [
  'merchant.sandbox_onboarding.read_only_discovery_review.requested',
];

const READ_ONLY_DISCOVERY_REVIEW_DECISION_EVENTS = [
  'merchant.sandbox_onboarding.read_only_discovery_review.changes_requested',
  'merchant.sandbox_onboarding.read_only_discovery_review.rejected',
  'merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready',
];

const READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_FIELDS = new Set([
  'proposal_note',
]);

const READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_WITHDRAW_FIELDS = new Set([
  'reason',
]);

const READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_EVENTS = [
  'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created',
  'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.updated',
  'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed',
  'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_blocked',
  'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.withdrawn',
];

const AGENTICORG_BUYER_DISCOVERY_HANDOFF_FIELDS = new Set([
  'handoff_note',
]);

const AGENTICORG_BUYER_DISCOVERY_HANDOFF_WITHDRAW_FIELDS = new Set([
  'reason',
]);

const AGENTICORG_BUYER_DISCOVERY_HANDOFF_EVENTS = [
  'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested',
  'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.blocked',
  'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.withdrawn',
];

const AGENT_PATCH_FIELDS = new Set([
  'display_name',
  'status',
  'trust_status',
]);

const PRODUCT_PATCH_FIELDS = new Set([
  'title',
  'brand',
  'description',
  'image_url',
  'category_preset',
  'status',
  'source_system',
  'manually_maintained',
  'variants',
]);

const VARIANT_PATCH_FIELDS = new Set([
  'id',
  'variant_id',
  'sku',
  'parent_sku',
  'model',
  'variant_title',
  'attributes',
  'price_amount',
  'currency',
  'tax_inclusive',
  'gst_slab',
  'tax_rate',
  'hsn_code',
  'availability_status',
  'warranty_summary',
  'return_policy_summary',
  'source_system',
  'last_synced_at',
]);

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) === v) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

function validatePatchKeys(
  body: Record<string, unknown>,
  allowed: Set<string>,
  fieldErrors: Record<string, string>,
): string[] {
  const changedFields = Object.keys(body);
  const unsupportedFields = changedFields.filter((key) => !allowed.has(key));
  if (unsupportedFields.length > 0) {
    fieldErrors['unsupported_fields'] =
      `immutable or unsupported fields: ${unsupportedFields.map((key) => key.replace(/[\r\n\t]/g, '_')).join(', ')}`;
  }
  return changedFields.filter((key) => allowed.has(key));
}

function validateSupportAndDiscoveryFields(
  body: Record<string, unknown>,
  fieldErrors: Record<string, string>,
): void {
  if (body['support_email'] !== undefined
    && body['support_email'] !== null
    && (!isString(body['support_email']) || !isSafeSupportEmail(body['support_email']))) {
    fieldErrors['support_email'] =
      'must be a non-empty repo-safe/test-safe support email such as support@example.test, or null';
  }
  if (body['support_url'] !== undefined
    && body['support_url'] !== null
    && (!isString(body['support_url']) || !isSafeSupportUrl(body['support_url']))) {
    fieldErrors['support_url'] =
      'must be a repo-safe/test-safe http(s) support URL on .example, .test, .invalid, or localhost, or null';
  }
  if (body['public_discovery_description_draft'] !== undefined
    && body['public_discovery_description_draft'] !== null
    && (!isString(body['public_discovery_description_draft'])
      || !isPublicSafeText(body['public_discovery_description_draft']))) {
    fieldErrors['public_discovery_description_draft'] =
      'must be public-safe text with no secrets, credentials, payment, provider, live, production, approval, readiness, or certification claims';
  }
}

function isNullableString(v: unknown): v is string | null {
  return v === null || isString(v);
}

function isValidCurrency(v: unknown): v is string {
  return isString(v) && /^[A-Z]{3}$/.test(v);
}

function parseBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

const CATALOG_PUBLIC_UNSAFE_PATTERN =
  '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M';

async function readSandboxOnboardingCatalogSummary(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<SandboxOnboardingCatalogSummary> {
  const rows = await sql<SandboxOnboardingCatalogSummary[]>`
      SELECT
      COUNT(DISTINCT p.id)::int AS product_count,
      COUNT(v.id)::int AS variant_count,
      COUNT(DISTINCT p.id) FILTER (
        WHERE NULLIF(TRIM(p.image_url), '') IS NOT NULL
      )::int AS products_with_image,
      COUNT(DISTINCT p.id) FILTER (
        WHERE NULLIF(TRIM(p.title), '') IS NOT NULL
          AND LENGTH(TRIM(p.title)) <= 1000
          AND p.title !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
      )::int AS products_with_public_safe_title,
      COUNT(DISTINCT p.id) FILTER (
        WHERE NULLIF(TRIM(p.description), '') IS NOT NULL
          AND LENGTH(TRIM(p.description)) <= 1000
          AND p.description !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
      )::int AS products_with_public_safe_description,
      COUNT(DISTINCT p.id) FILTER (
        WHERE p.category_preset = 'electronics_appliances'
      )::int AS products_with_category_mapping,
      COUNT(DISTINCT p.id) FILTER (
        WHERE p.title ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(p.brand, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(p.description, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(p.image_url, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
      )::int AS products_with_unsafe_text,
      COUNT(v.id) FILTER (
        WHERE NULLIF(TRIM(v.sku), '') IS NOT NULL
      )::int AS variants_with_sku,
      COUNT(v.id) FILTER (
        WHERE v.price_amount >= 0
          AND v.currency ~ '^[A-Z]{3}$'
      )::int AS variants_with_price_currency,
      COUNT(v.id) FILTER (
        WHERE NULLIF(TRIM(v.warranty_summary), '') IS NOT NULL
      )::int AS variants_with_warranty_summary,
      COUNT(v.id) FILTER (
        WHERE NULLIF(TRIM(v.return_policy_summary), '') IS NOT NULL
      )::int AS variants_with_return_policy_summary,
      COUNT(v.id) FILTER (
        WHERE NULLIF(TRIM(v.gst_slab), '') IS NOT NULL
           OR v.tax_rate IS NOT NULL
           OR NULLIF(TRIM(v.hsn_code), '') IS NOT NULL
      )::int AS variants_with_tax_metadata,
      COUNT(v.id) FILTER (
        WHERE v.last_synced_at >= NOW() - INTERVAL '24 hours'
      )::int AS variants_with_fresh_inventory,
      COUNT(v.id) FILTER (
        WHERE v.availability_status <> 'unknown'
      )::int AS variants_with_known_availability,
      COUNT(v.id) FILTER (
        WHERE COALESCE(v.sku, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(v.parent_sku, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(v.model, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(v.variant_title, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(v.warranty_summary, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           OR COALESCE(v.return_policy_summary, '') ~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
      )::int AS variants_with_unsafe_text
    FROM commerce_products p
    LEFT JOIN commerce_product_variants v
      ON v.tenant_id = p.tenant_id
     AND v.merchant_id = p.merchant_id
     AND v.product_id = p.id
     AND v.archived_at IS NULL
    WHERE p.tenant_id = ${tenantId}
      AND p.merchant_id = ${merchantId}
      AND p.archived_at IS NULL
  `;
  return rows[0] ?? {};
}

interface SandboxPreviewSampleRow {
  product_row_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  category_preset: string;
  sku: string | null;
  variant_title: string | null;
  price_amount: number | string | null;
  currency: string | null;
  availability_status: string | null;
  warranty_summary: string | null;
  return_policy_summary: string | null;
}

function groupSandboxPreviewSampleRows(rows: SandboxPreviewSampleRow[]): SandboxAgentPreviewProductInput[] {
  const grouped = new Map<string, SandboxAgentPreviewProductInput>();
  for (const row of rows) {
    let product = grouped.get(row.product_row_id);
    if (!product) {
      product = {
        title: row.title,
        description: row.description,
        image_url: row.image_url,
        category_preset: row.category_preset,
        variants: [],
      };
      grouped.set(row.product_row_id, product);
    }
    product.variants?.push({
      sku: row.sku,
      variant_title: row.variant_title,
      price_amount: row.price_amount,
      currency: row.currency,
      availability_status: row.availability_status,
      warranty_summary: row.warranty_summary,
      return_policy_summary: row.return_policy_summary,
    });
  }
  return [...grouped.values()].slice(0, 3);
}

async function readSandboxOnboardingPreviewSamples(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<SandboxAgentPreviewProductInput[]> {
  const rows = await sql<SandboxPreviewSampleRow[]>`
    WITH preview_products AS (
      SELECT p.id AS product_row_id, p.title, p.description, p.image_url,
             p.category_preset, p.updated_at
        FROM commerce_products p
       WHERE p.tenant_id = ${tenantId}
         AND p.merchant_id = ${merchantId}
         AND p.archived_at IS NULL
         AND p.category_preset = 'electronics_appliances'
         AND NULLIF(TRIM(p.title), '') IS NOT NULL
         AND LENGTH(TRIM(p.title)) <= 1000
         AND p.title !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
         AND NULLIF(TRIM(p.description), '') IS NOT NULL
         AND LENGTH(TRIM(p.description)) <= 1000
         AND p.description !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
         AND COALESCE(p.image_url, '') !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT 3
    )
    SELECT p.product_row_id, p.title, p.description, p.image_url,
           p.category_preset, v.sku, v.variant_title, v.price_amount,
           v.currency, v.availability_status, v.warranty_summary,
           v.return_policy_summary
      FROM preview_products p
      JOIN LATERAL (
        SELECT v.sku, v.variant_title, v.price_amount, v.currency,
               v.availability_status, v.warranty_summary, v.return_policy_summary,
               v.created_at
          FROM commerce_product_variants v
         WHERE v.tenant_id = ${tenantId}
           AND v.merchant_id = ${merchantId}
           AND v.product_id = p.product_row_id
           AND v.archived_at IS NULL
           AND NULLIF(TRIM(v.sku), '') IS NOT NULL
           AND LENGTH(TRIM(v.sku)) <= 1000
           AND v.sku !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           AND v.price_amount >= 0
           AND v.currency ~ '^[A-Z]{3}$'
           AND v.availability_status IN ('in_stock','out_of_stock','pre_order','back_order','unknown')
           AND COALESCE(v.variant_title, '') !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           AND COALESCE(v.warranty_summary, '') !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
           AND COALESCE(v.return_policy_summary, '') !~* ${CATALOG_PUBLIC_UNSAFE_PATTERN}
         ORDER BY v.created_at ASC, v.id ASC
         LIMIT 2
      ) v ON TRUE
     ORDER BY p.updated_at DESC, p.product_row_id DESC, v.created_at ASC
  `;
  return groupSandboxPreviewSampleRows(rows);
}

interface ReviewAuditRow {
  id: string;
  event_type: string;
  occurred_at: string | Date;
  user_principal_id: string | null;
  metadata: Record<string, unknown> | null;
}

function auditMetadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readLatestReadOnlyDiscoveryReviewAudit(
  sql: Sql,
  tenantId: string,
  merchantId: string,
  eventTypes: string[],
): Promise<SandboxReadOnlyDiscoveryReviewAuditSnapshot | null> {
  const rows = await sql<ReviewAuditRow[]>`
    SELECT id, event_type, occurred_at, user_principal_id, metadata
      FROM commerce_audit_events
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND event_type = ANY(${eventTypes})
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    audit_event_id: row.id,
    event_type: row.event_type,
    occurred_at: new Date(row.occurred_at).toISOString(),
    actor: row.user_principal_id ?? null,
    metadata: auditMetadata(row.metadata),
  };
}

function isReadOnlyDiscoveryOperatorDecision(value: unknown): value is ReadOnlyDiscoveryOperatorDecision {
  return typeof value === 'string'
    && (READ_ONLY_DISCOVERY_OPERATOR_DECISIONS as readonly string[]).includes(value);
}

function decisionEventType(decision: ReadOnlyDiscoveryOperatorDecision) {
  return `merchant.sandbox_onboarding.read_only_discovery_review.${decision}` as const;
}

function validateReadOnlyDiscoveryDecisionBody(
  body: Record<string, unknown>,
): {
  decision: ReadOnlyDiscoveryOperatorDecision | undefined;
  reason: string | undefined;
  remediationItems: string[];
  fields: Record<string, string>;
} {
  const fields: Record<string, string> = {};
  const changedFields = validatePatchKeys(body, READ_ONLY_DISCOVERY_REVIEW_DECISION_FIELDS, fields);
  if (changedFields.length === 0 && Object.keys(fields).length === 0) {
    fields['body'] = 'decision, reason, and optional remediation_items are required';
  }
  if (!isReadOnlyDiscoveryOperatorDecision(body['decision'])) {
    fields['decision'] = 'must be one of: changes_requested, rejected, rollout_proposal_ready';
  }
  if (!isString(body['reason']) || !isPublicSafeText(body['reason'])) {
    fields['reason'] = 'must be public-safe text with no secrets, credentials, live, production, approval, readiness, provider, or payment claims';
  }
  let remediationItems: string[] = [];
  if (body['remediation_items'] !== undefined) {
    if (!Array.isArray(body['remediation_items'])) {
      fields['remediation_items'] = 'must be an array of public-safe text items';
    } else {
      remediationItems = body['remediation_items'].filter((item): item is string => typeof item === 'string');
      if (remediationItems.length !== body['remediation_items'].length
        || remediationItems.length > 10
        || remediationItems.some((item) => !isPublicSafeText(item))) {
        fields['remediation_items'] = 'must contain at most 10 public-safe text items with no secrets, credentials, live, production, approval, readiness, provider, or payment claims';
      }
    }
  }
  if (body['decision'] === 'changes_requested' && remediationItems.length === 0) {
    fields['remediation_items'] = 'changes_requested decisions require at least one public-safe remediation item';
  }
  return {
    decision: isReadOnlyDiscoveryOperatorDecision(body['decision']) ? body['decision'] : undefined,
    reason: isString(body['reason']) ? body['reason'] : undefined,
    remediationItems,
    fields,
  };
}

function validateReadOnlyDiscoveryRolloutProposalBody(
  body: Record<string, unknown>,
  allowedFields: Set<string>,
  noteField: 'proposal_note' | 'handoff_note' | 'reason',
): { note: string | undefined; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  validatePatchKeys(body, allowedFields, fields);
  if (body[noteField] !== undefined
    && (!isString(body[noteField]) || !isPublicSafeText(body[noteField]))) {
    fields[noteField] =
      'must be public-safe text with no secrets, credentials, live, production, approval, readiness, provider, or payment claims';
  }
  return {
    note: isString(body[noteField]) ? body[noteField] : undefined,
    fields,
  };
}

function proposalCreatedAtFromAudit(audit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null): string | null {
  if (!audit) return null;
  const value = audit.metadata['proposal_created_at'];
  if (typeof value === 'string' && value.trim()) return value;
  if (audit.event_type === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created') {
    return audit.occurred_at;
  }
  return null;
}

function rolloutProposalEventStatus(eventType: string) {
  if (eventType.endsWith('.dry_run_passed')) return 'dry_run_passed';
  if (eventType.endsWith('.dry_run_blocked')) return 'dry_run_blocked';
  if (eventType.endsWith('.withdrawn')) return 'withdrawn';
  return 'draft_created';
}

function rolloutProposalEvidenceMetadata(
  proposal: SandboxReadOnlyDiscoveryRolloutProposalPayload,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    proposal_status: proposal.proposal_status,
    dry_run_result: proposal.dry_run_result,
    operator_decision: proposal.operator_review.operator_decision,
    category_readiness_status: proposal.evidence.category_readiness_summary.status,
    catalog_readiness_status: proposal.evidence.catalog_readiness_summary.status,
    agent_preview_status: proposal.evidence.agent_facing_preview_summary.preview_status,
    evidence_checklist: proposal.evidence_checklist,
    blocker_count: proposal.blockers.length,
    blockers: proposal.blockers.slice(0, 20),
    remediation_items: proposal.remediation_items.slice(0, 10),
    sandbox_only: true,
    proposal_is_approval: false,
    dry_run_is_launch: false,
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [`live_${'p'}lural_enabled`]: false,
    production_allowlist_written: false,
    ...overrides,
  };
}

interface ReadOnlyDiscoveryRolloutProposalContext {
  merchant: SandboxOnboardingMerchant;
  readiness: ReturnType<typeof computeSandboxOnboardingReadiness>;
  sampleProducts: SandboxAgentPreviewProductInput[];
  latestRequestAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null;
  latestDecisionAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null;
  latestProposalAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null;
  proposal: SandboxReadOnlyDiscoveryRolloutProposalPayload;
  currentPrerequisiteProposal: SandboxReadOnlyDiscoveryRolloutProposalPayload;
}

interface AgenticOrgBuyerDiscoveryContext extends ReadOnlyDiscoveryRolloutProposalContext {
  latestHandoffAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot | null;
  preview: SandboxAgenticOrgBuyerDiscoveryPreviewPayload;
}

async function readReadOnlyDiscoveryRolloutProposalContext(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<ReadOnlyDiscoveryRolloutProposalContext | null> {
  const rows = await sql<SandboxOnboardingMerchant[]>`
    SELECT id, tenant_id, display_name, category_preset, environment,
           agentic_commerce_enabled, default_currency, country_code,
           support_email, support_url, public_discovery_description_draft,
           agentic_commerce_requested, sandbox_onboarding_state,
           sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
           provider_account_refs
      FROM commerce_merchants
     WHERE id = ${merchantId}
       AND tenant_id = ${tenantId}
     LIMIT 1
  `;
  const merchant = rows[0];
  if (!merchant) return null;
  const latestRequestAudit = await readLatestReadOnlyDiscoveryReviewAudit(
    sql,
    tenantId,
    merchantId,
    READ_ONLY_DISCOVERY_REVIEW_REQUEST_EVENTS,
  );
  const latestDecisionAudit = await readLatestReadOnlyDiscoveryReviewAudit(
    sql,
    tenantId,
    merchantId,
    READ_ONLY_DISCOVERY_REVIEW_DECISION_EVENTS,
  );
  const latestProposalAudit = await readLatestReadOnlyDiscoveryReviewAudit(
    sql,
    tenantId,
    merchantId,
    READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_EVENTS,
  );
  const catalogSummary = await readSandboxOnboardingCatalogSummary(sql, tenantId, merchantId);
  const sampleProducts = await readSandboxOnboardingPreviewSamples(sql, tenantId, merchantId);
  const readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
  return {
    merchant,
    readiness,
    sampleProducts,
    latestRequestAudit,
    latestDecisionAudit,
    latestProposalAudit,
    proposal: toSandboxReadOnlyDiscoveryRolloutProposalResponse(
      merchant,
      readiness,
      sampleProducts,
      latestRequestAudit,
      latestDecisionAudit,
      latestProposalAudit,
    ),
    currentPrerequisiteProposal: toSandboxReadOnlyDiscoveryRolloutProposalResponse(
      merchant,
      readiness,
      sampleProducts,
      latestRequestAudit,
      latestDecisionAudit,
      null,
    ),
  };
}

async function readAgenticOrgBuyerDiscoveryContext(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<AgenticOrgBuyerDiscoveryContext | null> {
  const context = await readReadOnlyDiscoveryRolloutProposalContext(sql, tenantId, merchantId);
  if (!context) return null;
  const latestHandoffAudit = await readLatestReadOnlyDiscoveryReviewAudit(
    sql,
    tenantId,
    merchantId,
    AGENTICORG_BUYER_DISCOVERY_HANDOFF_EVENTS,
  );
  return {
    ...context,
    latestHandoffAudit,
    preview: toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
      context.merchant,
      context.readiness,
      context.sampleProducts,
      context.latestRequestAudit,
      context.latestDecisionAudit,
      context.latestProposalAudit,
      latestHandoffAudit,
    ),
  };
}

function agenticOrgBuyerDiscoveryEvidenceMetadata(
  preview: SandboxAgenticOrgBuyerDiscoveryPreviewPayload,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    integration_status: preview.integration_status,
    handoff_requested_at: preview.handoff_requested_at,
    handoff_request_actor: preview.handoff_request_actor,
    rollout_proposal_status: preview.rollout_proposal_summary.proposal_status,
    rollout_proposal_dry_run_result: preview.rollout_proposal_summary.dry_run_result,
    rollout_proposal_audit_event_id: preview.rollout_proposal_summary.proposal_audit_event_id,
    agent_preview_status: preview.agent_facing_preview_summary.preview_status,
    sample_product_count: preview.agent_facing_preview_summary.sample_product_count,
    blocker_count: preview.blockers.length,
    blockers: preview.blockers.slice(0, 20),
    remediation_items: preview.remediation_items.slice(0, 10),
    allowed_buyer_agent_capabilities: preview.allowed_buyer_agent_capabilities,
    blocked_buyer_agent_capabilities: preview.blocked_buyer_agent_capabilities,
    sandbox_only: true,
    handoff_request_is_approval: false,
    buyer_agent_discovery_is_public: false,
    agenticorg_public_discovery_enabled: false,
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [`live_${'p'}lural_enabled`]: false,
    production_allowlist_written: false,
    ...overrides,
  };
}

function isValidIsoDate(v: unknown): v is string {
  return isString(v) && !Number.isNaN(new Date(v).getTime());
}

function normalizeSourceSystem(v: unknown, fallback = 'manual'): string {
  return isString(v) ? v : fallback;
}

function validateVariantInput(
  variant: VariantInput,
  prefix: string,
  fieldErrors: Record<string, string>,
): void {
  if (!isString(variant.sku)) fieldErrors[`${prefix}.sku`] = 'required string';
  if (asInt(variant.price_amount) === null || (asInt(variant.price_amount) as number) < 0) {
    fieldErrors[`${prefix}.price_amount`] = 'required non-negative integer (minor units)';
  }
  if (variant.currency !== undefined && !isValidCurrency(variant.currency)) {
    fieldErrors[`${prefix}.currency`] = 'must be an ISO 4217 uppercase currency code';
  }
  if (variant.tax_inclusive !== undefined && typeof variant.tax_inclusive !== 'boolean') {
    fieldErrors[`${prefix}.tax_inclusive`] = 'must be a boolean';
  }
  if (variant.tax_rate !== undefined && variant.tax_rate !== null
    && (typeof variant.tax_rate !== 'number' || !Number.isFinite(variant.tax_rate))) {
    fieldErrors[`${prefix}.tax_rate`] = 'must be a finite number or null';
  }
  const avail = isString(variant.availability_status) ? variant.availability_status : 'unknown';
  if (!AVAILABILITY.has(avail)) {
    fieldErrors[`${prefix}.availability_status`] =
      'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
  }
}

function validateProductCreateLike(
  value: unknown,
  index: number,
  merchantId: string,
): { ok: true; product: ProductCreateBody } | { ok: false; productId: string | null; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (!isPlainObject(value)) {
    return { ok: false, productId: null, fields: { body: 'must be an object' } };
  }
  const row = value as ProductCreateBody;
  if (row.merchant_id !== undefined && row.merchant_id !== merchantId) {
    fields['merchant_id'] = 'must match request merchant_id';
  }
  if (!isString(row.product_id)) fields['product_id'] = 'required string';
  if (!isString(row.title)) fields['title'] = 'required string';
  if (!isCommerceCategoryPreset(row.category_preset)) {
    fields['category_preset'] = 'must be a known commerce category preset';
  }
  if (row.image_url !== undefined && row.image_url !== null && !isString(row.image_url)) {
    fields['image_url'] = 'must be a string or null';
  }
  if (row.manually_maintained !== undefined && typeof row.manually_maintained !== 'boolean') {
    fields['manually_maintained'] = 'must be a boolean';
  }
  if (!Array.isArray(row.variants) || row.variants.length === 0) {
    fields['variants'] = 'at least one variant is required';
  } else {
    const seenSkus = new Set<string>();
    const currencies = new Set<string>();
    row.variants.forEach((raw, variantIndex) => {
      if (!isPlainObject(raw)) {
        fields[`variants[${variantIndex}]`] = 'must be an object';
        return;
      }
      const variant = raw as VariantInput;
      validateVariantInput(variant, `variants[${variantIndex}]`, fields);
      if (isString(variant.sku)) {
        if (seenSkus.has(variant.sku)) {
          fields[`variants[${variantIndex}].sku`] = 'duplicate SKU in import row';
        }
        seenSkus.add(variant.sku);
      }
      if (isString(variant.currency)) currencies.add(variant.currency);
    });
    if (currencies.size > 1) {
      fields['variants.currency'] = 'all variants in one product row must use one currency';
    }
  }
  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      productId: isString(row.product_id) ? row.product_id : `row_${index}`,
      fields,
    };
  }
  return { ok: true, product: row };
}

function merchantIdForCatalogRead(request: FastifyRequest, rawMerchantId: unknown): string {
  const caller = request.commerceCaller;
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only read their own catalog');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator' || caller.kind === 'agent') {
    if (!isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { merchant_id: 'required string' } }, retryable: false });
    }
    return rawMerchantId;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Catalog reads require operator, merchant, or CommerceAgent caller');
}

function merchantIdForCatalogWrite(request: FastifyRequest, rawMerchantId: unknown): string {
  const caller = request.commerceCaller;
  if (caller.kind === 'merchant') {
    if (rawMerchantId !== undefined && rawMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only write their own catalog');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (!isString(rawMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { merchant_id: 'required string' } }, retryable: false });
    }
    return rawMerchantId;
  }
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'Catalog writes require operator or merchant caller');
}

function parseCatalogFilters(value: unknown, fieldErrors: Record<string, string>): {
  brand?: string;
  category_preset?: string;
  availability_status?: string;
  currency?: string;
} {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    fieldErrors['filters'] = 'must be an object';
    return {};
  }
  const allowed = new Set(['brand', 'category_preset', 'availability_status', 'currency']);
  const filters: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) {
      fieldErrors[`filters.${key}`] = 'unknown filter';
      continue;
    }
    if (!isString(raw)) {
      fieldErrors[`filters.${key}`] = 'must be a string';
      continue;
    }
    filters[key] = raw;
  }
  if (filters['availability_status'] && !AVAILABILITY.has(filters['availability_status'])) {
    fieldErrors['filters.availability_status'] =
      'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
  }
  if (filters['category_preset'] && !isCommerceCategoryPreset(filters['category_preset'])) {
    fieldErrors['filters.category_preset'] = 'must be a known commerce category preset';
  }
  if (filters['currency'] && !/^[A-Z]{3}$/.test(filters['currency'])) {
    fieldErrors['filters.currency'] = 'must be an ISO 4217 uppercase currency code';
  }
  return filters;
}

/**
 * Commerce route registration. Decision F: every route inside this
 * plugin is opted out of the global authPlugin via an onRoute hook that
 * sets config.skipAuth=true. Auth is then re-imposed by our own
 * commerceCaller preHandler. A test
 * (commerce-caller-bypass.test.ts) confirms merchant/agent tokens reach
 * the resolver instead of being rejected by the platform authPlugin.
 */
export async function commerceRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(commerceErrorHandler);

  // Decision F: every commerce route bypasses the global authPlugin.
  // The hook fires for each app.get/.post/etc registered in this scope,
  // including the routes registered inside the sub-route plugins below.
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.config) {
      (routeOptions as unknown as { config: Record<string, unknown> }).config = {};
    }
    (routeOptions.config as unknown as Record<string, unknown>)['skipAuth'] = true;
  });

  // Single preHandler: feature-flag gate + commerce caller resolution +
  // tenant materialization. Tenant rules:
  //   - Operator with explicit mapping → use it.
  //   - Operator with no mapping AND isAutoTenantAllowed() → auto-provision
  //     (sandbox/test only; production blocked at the lib layer).
  //   - Operator with no mapping AND not auto-allowed → 422 tenant_not_provisioned.
  //   - Merchant/agent caller → caller carries its own tenantId.
  //   - Platform admin caller (no developer record) → tenantId left empty;
  //     operator endpoints accepting admin must consume tenant_id from path/body.
  app.addHook('preHandler', async (request) => {
    if (!isCommerceV1Enabled()) {
      throw new CommerceHttpError(
        503,
        'commerce_disabled',
        'Grantex Commerce V1 is not enabled in this environment',
        { retryable: false },
      );
    }
    // Public consent endpoints (the SSR page + approve/deny) do not have
    // a Bearer caller — the user reaches them via a magic link from
    // their agent. Those routes opt in to publicConsent in their own
    // route config and handle Host isolation + CSRF themselves.
    if (request.routeOptions.config?.publicConsent === true) return;

    const sql = getSql();
    let redis: import('ioredis').Redis | null = null;
    try {
      redis = getRedis();
    } catch {
      redis = null;
    }
    const r = await resolveCommerceCaller(request, sql, redis);
    if (!r.ok) {
      throw new CommerceHttpError(r.failure.status, r.failure.code, r.failure.message,
        { retryable: r.failure.status === 503,
          ...(('details' in r.failure && r.failure.details !== undefined) ? { details: r.failure.details } : {}) });
    }
    request.commerceCaller = r.caller;

    if (r.caller.kind === 'operator') {
      // Platform admin without a developer-bound tenant: leave empty;
      // tenant-aware routes must accept tenant_id explicitly.
      if (r.caller.isPlatformAdmin && !r.caller.developerId.startsWith('dev_')) {
        request.commerceTenantId = '';
        return;
      }
      // The caller resolver's JOIN already produced tenantId + tenantStatus
      // for the operator. Trust it instead of running another SELECT.
      if (r.caller.tenantStatus === 'active') {
        request.commerceTenantId = r.caller.tenantId;
        return;
      }
      if (r.caller.tenantStatus === 'disabled') {
        throw new CommerceHttpError(
          403,
          'tenant_disabled',
          'The commerce tenant mapped to this developer is disabled',
          {
            remediation:
              'Contact Grantex support to re-enable the tenant or to provision a replacement mapping.',
            retryable: false,
          },
        );
      }
      // tenantStatus === null → no mapping. Optional auto-provision (test/sandbox only).
      if (isAutoTenantAllowed()) {
        request.commerceTenantId = await resolveOrCreateTenantForDeveloper(
          sql,
          r.caller.developerId,
          r.caller.developerName,
        );
        return;
      }
      throw new CommerceHttpError(
        422,
        'tenant_not_provisioned',
        'No commerce tenant is mapped to this developer in this environment',
        {
          remediation:
            'In staging/production, an operator must provision a commerce tenant and bind '
            + 'this developer to it via POST /v1/commerce/tenants and '
            + 'POST /v1/commerce/developer-tenants. For local/sandbox testing only, '
            + 'set COMMERCE_ALLOW_AUTO_TENANT=true to enable auto-provisioning.',
          retryable: false,
        },
      );
    }

    // merchant / agent / service: tenantId is intrinsic to the caller.
    request.commerceTenantId = r.caller.tenantId;
  });

  // ----------------------------------------------------------------------
  // Per-route caller-kind enforcement helpers (Finding 2 — promised
  // M2 caller matrix). The shape is `requireX(request)` throws 403 when
  // the resolved caller kind isn't in the route's allowlist.
  // ----------------------------------------------------------------------
  function requireOperator(request: FastifyRequest): Extract<CommerceCaller, { kind: 'operator' }> {
    if (request.commerceCaller.kind !== 'operator') {
      throw new CommerceHttpError(403, 'operator_required',
        'This endpoint is only callable by operator (developer API key) callers');
    }
    return request.commerceCaller;
  }
  /**
   * Operator OR merchant for the merchant_id the caller is reading.
   * Agents are explicitly denied — admin merchant data is not part of
   * any agent's surface in M2.
   */
  function requireOperatorOrSelfMerchant(
    request: FastifyRequest,
    merchantId: string,
  ): void {
    const c = request.commerceCaller;
    if (c.kind === 'operator') return;
    if (c.kind === 'merchant' && c.merchantId === merchantId) return;
    throw new CommerceHttpError(403, 'caller_not_authorized',
      'This endpoint requires operator or the merchant whose data is being read');
  }
  /**
   * Operator OR the agent reading their own record. Merchants are
   * explicitly denied — they don't enumerate arbitrary agents.
   */
  function requireOperatorOrSelfAgent(
    request: FastifyRequest,
    agentId: string,
  ): void {
    const c = request.commerceCaller;
    if (c.kind === 'operator') return;
    if (c.kind === 'agent' && c.agentId === agentId) return;
    throw new CommerceHttpError(403, 'caller_not_authorized',
      'This endpoint requires operator or the agent reading their own record');
  }

  // ----------------------------------------------------------------------
  // POST /merchants  — operator only
  // ----------------------------------------------------------------------
  app.post<{ Body: MerchantCreateBody }>('/merchants', async (request, reply) => {
    requireOperator(request);
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    validatePatchKeys(body, MERCHANT_CREATE_FIELDS, fieldErrors);
    if (!isString(body.legal_name)) fieldErrors['legal_name'] = 'required string';
    if (!isString(body.display_name)) fieldErrors['display_name'] = 'required string';
    if (!isCommerceCategoryPreset(body.category_preset)) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (body['default_currency'] !== undefined
      && (!isString(body['default_currency']) || !/^[A-Z]{3}$/.test(body['default_currency']))) {
      fieldErrors['default_currency'] = 'must be an ISO 4217 uppercase currency code';
    }
    if (body['country_code'] !== undefined
      && (!isString(body['country_code']) || !/^[A-Z]{2}$/.test(body['country_code']))) {
      fieldErrors['country_code'] = 'must be an ISO 3166-1 alpha-2 uppercase country code';
    }
    validateSupportAndDiscoveryFields(body, fieldErrors);
    if (body['agentic_commerce_requested'] !== undefined
      && typeof body['agentic_commerce_requested'] !== 'boolean') {
      fieldErrors['agentic_commerce_requested'] = 'must be a boolean';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const id = newMerchantId();
    const tenantId = request.commerceTenantId;

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_merchants (
          id, tenant_id, legal_name, display_name, category_preset,
          default_currency, country_code, support_email, support_url,
          public_discovery_description_draft, agentic_commerce_requested
        ) VALUES (
          ${id}, ${tenantId},
          ${body.legal_name as string},
          ${body.display_name as string},
          ${body.category_preset as string},
          ${isString(body.default_currency) ? (body.default_currency as string) : 'INR'},
          ${isString(body.country_code) ? (body.country_code as string) : 'IN'},
          ${isString(body.support_email) ? (body.support_email as string) : null},
          ${isString(body.support_url) ? (body.support_url as string) : null},
          ${isString(body.public_discovery_description_draft) ? (body.public_discovery_description_draft as string) : null},
          ${body.agentic_commerce_requested === true}
        )
        RETURNING id, tenant_id, legal_name, display_name, category_preset,
                  verification_status, environment, agentic_commerce_enabled,
                  default_currency, country_code, support_email, support_url,
                  public_discovery_description_draft, agentic_commerce_requested,
                  sandbox_onboarding_state, sandbox_onboarding_blocker,
                  sandbox_onboarding_updated_at,
                  created_at, updated_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId: id,
        eventType: 'merchant.created',
        resourceType: 'merchant',
        resourceId: id,
        requestId: request.id,
        metadata: {
          display_name: body.display_name,
          sandbox_onboarding_state: 'draft_created',
          production_approval_status: 'not_approved',
          rollout_status: 'rollout_not_requested',
        },
      });
      return { merchant: rows[0], auditEventId: audit.id };
    });

    return reply.status(201).send({ data: result.merchant, audit_event_id: result.auditEventId });
  });

  // ----------------------------------------------------------------------
  // GET /merchants/:merchantId — operator OR merchant for own merchant.
  // Agent denied (admin merchant data is not in any agent's M2 surface).
  // ----------------------------------------------------------------------
  app.get<{ Params: { merchantId: string } }>('/merchants/:merchantId', async (request, reply) => {
    requireOperatorOrSelfMerchant(request, request.params.merchantId);
    const sql = getSql();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, legal_name, display_name, category_preset,
             verification_status, environment, agentic_commerce_enabled,
             default_currency, country_code, support_email, support_url,
             public_discovery_description_draft, agentic_commerce_requested,
             sandbox_onboarding_state, sandbox_onboarding_blocker,
             sandbox_onboarding_updated_at,
             disabled_at, created_at, updated_at
      FROM commerce_merchants
      WHERE id = ${request.params.merchantId}
        AND tenant_id = ${request.commerceTenantId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    return reply.status(200).send({ data: rows[0] });
  });

  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/sandbox-onboarding',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      const sql = getSql();
      const rows = await sql<SandboxOnboardingMerchant[]>`
        SELECT id, tenant_id, display_name, category_preset, environment,
               agentic_commerce_enabled, default_currency, country_code,
               support_email, support_url, public_discovery_description_draft,
               agentic_commerce_requested, sandbox_onboarding_state,
               sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
               provider_account_refs
          FROM commerce_merchants
         WHERE id = ${request.params.merchantId}
           AND tenant_id = ${request.commerceTenantId}
         LIMIT 1
      `;
      const merchant = rows[0];
      if (!merchant) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (merchant.environment !== 'sandbox') {
        throw new CommerceHttpError(409, 'sandbox_onboarding_live_merchant_blocked',
          'Sandbox onboarding is only available for sandbox merchants',
          { retryable: false });
      }
      const catalogSummary = await readSandboxOnboardingCatalogSummary(sql, request.commerceTenantId, request.params.merchantId);
      const sampleProducts = await readSandboxOnboardingPreviewSamples(sql, request.commerceTenantId, request.params.merchantId);
      const readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
      return reply.status(200).send({
        data: toSandboxOnboardingResponse(
          merchant,
          readiness,
          sampleProducts,
        ),
      });
    },
  );

  app.put<{ Params: { merchantId: string }; Body: SandboxOnboardingUpdateBody }>(
    '/merchants/:merchantId/sandbox-onboarding',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      const changedFields = validatePatchKeys(body, SANDBOX_ONBOARDING_UPDATE_FIELDS, fieldErrors);
      if (changedFields.length === 0 && Object.keys(fieldErrors).length === 0) {
        fieldErrors['body'] = 'at least one sandbox onboarding field is required';
      }
      if (body['display_name'] !== undefined && !isString(body['display_name'])) {
        fieldErrors['display_name'] = 'must be a non-empty string';
      }
      if (body['category_preset'] !== undefined && !isCommerceCategoryPreset(body['category_preset'])) {
        fieldErrors['category_preset'] = 'must be a known commerce category preset';
      }
      if (body['default_currency'] !== undefined
        && (!isString(body['default_currency']) || !/^[A-Z]{3}$/.test(body['default_currency']))) {
        fieldErrors['default_currency'] = 'must be an ISO 4217 uppercase currency code';
      }
      if (body['country_code'] !== undefined
        && (!isString(body['country_code']) || !/^[A-Z]{2}$/.test(body['country_code']))) {
        fieldErrors['country_code'] = 'must be an ISO 3166-1 alpha-2 uppercase country code';
      }
      validateSupportAndDiscoveryFields(body, fieldErrors);
      if (body['agentic_commerce_requested'] !== undefined
        && typeof body['agentic_commerce_requested'] !== 'boolean') {
        fieldErrors['agentic_commerce_requested'] = 'must be a boolean';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: fieldErrors },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
      const hasCategoryPreset = Object.prototype.hasOwnProperty.call(body, 'category_preset');
      const hasDefaultCurrency = Object.prototype.hasOwnProperty.call(body, 'default_currency');
      const hasCountryCode = Object.prototype.hasOwnProperty.call(body, 'country_code');
      const hasSupportEmail = Object.prototype.hasOwnProperty.call(body, 'support_email');
      const hasSupportUrl = Object.prototype.hasOwnProperty.call(body, 'support_url');
      const hasDescription = Object.prototype.hasOwnProperty.call(body, 'public_discovery_description_draft');
      const hasAgenticRequested = Object.prototype.hasOwnProperty.call(body, 'agentic_commerce_requested');
      const patchDisplayName = hasDisplayName ? body['display_name'] as string : null;
      const patchCategoryPreset = hasCategoryPreset ? body['category_preset'] as string : null;
      const patchDefaultCurrency = hasDefaultCurrency ? body['default_currency'] as string : null;
      const patchCountryCode = hasCountryCode ? body['country_code'] as string : null;
      const patchSupportEmail = hasSupportEmail ? body['support_email'] as string | null : null;
      const patchSupportUrl = hasSupportUrl ? body['support_url'] as string | null : null;
      const patchDescription = hasDescription ? body['public_discovery_description_draft'] as string | null : null;
      const patchAgenticRequested = hasAgenticRequested ? body['agentic_commerce_requested'] as boolean : null;

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const beforeRows = await tx<SandboxOnboardingMerchant[]>`
          SELECT id, tenant_id, display_name, category_preset, environment,
                 agentic_commerce_enabled, default_currency, country_code,
                 support_email, support_url, public_discovery_description_draft,
                 agentic_commerce_requested, sandbox_onboarding_state,
                 sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                 provider_account_refs
            FROM commerce_merchants
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const before = beforeRows[0];
        if (!before) return null;
        if (before.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'sandbox_onboarding_live_merchant_blocked',
            'Sandbox onboarding is only available for sandbox merchants',
            { retryable: false });
        }

        const rows = await tx<SandboxOnboardingMerchant[]>`
          UPDATE commerce_merchants
             SET display_name = CASE WHEN ${hasDisplayName}::boolean THEN ${patchDisplayName}::text ELSE display_name END,
                 category_preset = CASE WHEN ${hasCategoryPreset}::boolean THEN ${patchCategoryPreset}::text ELSE category_preset END,
                 default_currency = CASE WHEN ${hasDefaultCurrency}::boolean THEN ${patchDefaultCurrency}::text ELSE default_currency END,
                 country_code = CASE WHEN ${hasCountryCode}::boolean THEN ${patchCountryCode}::text ELSE country_code END,
                 support_email = CASE WHEN ${hasSupportEmail}::boolean THEN ${patchSupportEmail}::text ELSE support_email END,
                 support_url = CASE WHEN ${hasSupportUrl}::boolean THEN ${patchSupportUrl}::text ELSE support_url END,
                 public_discovery_description_draft = CASE WHEN ${hasDescription}::boolean THEN ${patchDescription}::text ELSE public_discovery_description_draft END,
                 agentic_commerce_requested = CASE WHEN ${hasAgenticRequested}::boolean THEN ${patchAgenticRequested}::boolean ELSE agentic_commerce_requested END,
                 updated_at = NOW()
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, display_name, category_preset, environment,
                     agentic_commerce_enabled, default_currency, country_code,
                     support_email, support_url, public_discovery_description_draft,
                     agentic_commerce_requested, sandbox_onboarding_state,
                     sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                     provider_account_refs
        `;
        let merchant = rows[0]!;
        const catalogSummary = await readSandboxOnboardingCatalogSummary(tx as unknown as Sql, tenantId, merchantId);
        let readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        const currentState = isSandboxOnboardingState(merchant.sandbox_onboarding_state)
          ? merchant.sandbox_onboarding_state
          : 'draft_created';
        if (currentState === 'submitted_for_review' && !readiness.ready) {
          throw new CommerceHttpError(
            409,
            'invalid_sandbox_onboarding_update',
            'submitted_for_review sandbox onboarding cannot be updated into failing readiness',
            {
              details: {
                sandbox_onboarding_state: currentState,
                readiness_status: readiness.status,
                category_readiness_status: readiness.category_readiness.status,
              },
              retryable: false,
            },
          );
        }
        const nextState = deriveSandboxOnboardingState(currentState, readiness);
        if (nextState !== currentState) {
          const stateRows = await tx<SandboxOnboardingMerchant[]>`
            UPDATE commerce_merchants
               SET sandbox_onboarding_state = ${nextState},
                   sandbox_onboarding_blocker = CASE
                     WHEN ${nextState}::text = 'profile_incomplete' THEN 'required sandbox onboarding checks are incomplete'
                     ELSE NULL::text
                   END,
                   sandbox_onboarding_updated_at = NOW(),
                   updated_at = NOW()
             WHERE id = ${merchantId}
               AND tenant_id = ${tenantId}
             RETURNING id, tenant_id, display_name, category_preset, environment,
                       agentic_commerce_enabled, default_currency, country_code,
                       support_email, support_url, public_discovery_description_draft,
                       agentic_commerce_requested, sandbox_onboarding_state,
                       sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                       provider_account_refs
          `;
          merchant = stateRows[0]!;
          readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        }
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          eventType: 'merchant.sandbox_onboarding.updated',
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata: {
            changed_fields: changedFields,
            sandbox_onboarding_state: merchant.sandbox_onboarding_state,
            readiness_ready: readiness.ready,
            category_readiness_status: readiness.category_readiness.status,
            category_readiness_score_percent: readiness.category_readiness.score_percent,
            production_approval_status: 'not_approved',
            rollout_status: 'rollout_not_requested',
          },
        });
        const sampleProducts = await readSandboxOnboardingPreviewSamples(tx as unknown as Sql, tenantId, merchantId);
        return { merchant, readiness, sampleProducts, auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: toSandboxOnboardingResponse(result.merchant, result.readiness, result.sampleProducts),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: SandboxOnboardingTransitionBody }>(
    '/merchants/:merchantId/sandbox-onboarding/transition',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      if (!isSandboxOnboardingState(body['target_state'])) {
        fieldErrors['target_state'] = 'must be a valid sandbox onboarding state';
      }
      if (body['reason'] !== undefined && body['reason'] !== null
        && (!isString(body['reason']) || !isPublicSafeText(body['reason']))) {
        fieldErrors['reason'] = 'must be public-safe text with no secrets, credentials, live, production, approval, readiness, provider, or payment claims';
      }
      if ((body['target_state'] === 'blocked' || body['target_state'] === 'not_approved')
        && !isString(body['reason'])) {
        fieldErrors['reason'] = 'required for blocked or not_approved transitions';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: fieldErrors },
          retryable: false,
        });
      }

      const targetState = body['target_state'] as SandboxOnboardingState;
      const reason = isString(body['reason']) ? body['reason'] : null;
      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const beforeRows = await tx<SandboxOnboardingMerchant[]>`
          SELECT id, tenant_id, display_name, category_preset, environment,
                 agentic_commerce_enabled, default_currency, country_code,
                 support_email, support_url, public_discovery_description_draft,
                 agentic_commerce_requested, sandbox_onboarding_state,
                 sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                 provider_account_refs
            FROM commerce_merchants
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const before = beforeRows[0];
        if (!before) return null;
        if (before.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'sandbox_onboarding_live_merchant_blocked',
            'Sandbox onboarding is only available for sandbox merchants',
            { retryable: false });
        }
        const currentState = isSandboxOnboardingState(before.sandbox_onboarding_state)
          ? before.sandbox_onboarding_state
          : 'draft_created';
        const catalogSummary = await readSandboxOnboardingCatalogSummary(tx as unknown as Sql, tenantId, merchantId);
        const readiness = computeSandboxOnboardingReadiness(before, process.env, catalogSummary);
        const transitionError = validateSandboxOnboardingTransition(currentState, targetState, readiness);
        if (transitionError) {
          throw new CommerceHttpError(409, 'invalid_sandbox_onboarding_transition', transitionError, {
            details: { from_state: currentState, target_state: targetState },
            retryable: false,
          });
        }
        const rows = await tx<SandboxOnboardingMerchant[]>`
          UPDATE commerce_merchants
             SET sandbox_onboarding_state = ${targetState},
                 sandbox_onboarding_blocker = CASE
                   WHEN ${targetState}::text IN ('blocked', 'not_approved') THEN ${reason}::text
                   ELSE NULL::text
                 END,
                 sandbox_onboarding_updated_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, display_name, category_preset, environment,
                     agentic_commerce_enabled, default_currency, country_code,
                     support_email, support_url, public_discovery_description_draft,
                     agentic_commerce_requested, sandbox_onboarding_state,
                     sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                     provider_account_refs
        `;
        const merchant = rows[0]!;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          eventType: 'merchant.sandbox_onboarding.transitioned',
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata: {
            from_state: currentState,
            to_state: targetState,
            reason_present: reason !== null,
            category_readiness_status: readiness.category_readiness.status,
            category_readiness_score_percent: readiness.category_readiness.score_percent,
            production_approval_status: 'not_approved',
            rollout_status: 'rollout_not_requested',
          },
        });
        const nextReadiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        const sampleProducts = await readSandboxOnboardingPreviewSamples(tx as unknown as Sql, tenantId, merchantId);
        return {
          merchant,
          readiness: nextReadiness,
          sampleProducts,
          auditEventId: audit.id,
        };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: toSandboxOnboardingResponse(result.merchant, result.readiness, result.sampleProducts),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: Record<string, unknown> }>(
    '/merchants/:merchantId/sandbox-onboarding/read-only-discovery-review-request',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be an empty JSON object when present' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const unsupportedFields = Object.keys(body);
      if (unsupportedFields.length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: {
            fields: {
              unsupported_fields:
                `read-only discovery review request does not accept mutable fields: ${unsupportedFields.map((key) => key.replace(/[\r\n\t]/g, '_')).join(', ')}`,
            },
          },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const beforeRows = await tx<SandboxOnboardingMerchant[]>`
          SELECT id, tenant_id, display_name, category_preset, environment,
                 agentic_commerce_enabled, default_currency, country_code,
                 support_email, support_url, public_discovery_description_draft,
                 agentic_commerce_requested, sandbox_onboarding_state,
                 sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                 provider_account_refs
            FROM commerce_merchants
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const before = beforeRows[0];
        if (!before) return null;

        if (before.environment !== 'sandbox') {
          const audit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId,
            eventType: 'merchant.sandbox_onboarding.read_only_discovery_review.blocked',
            resourceType: 'merchant',
            resourceId: merchantId,
            requestId: request.id,
            metadata: {
              request_status: 'blocked',
              blockers: ['merchant_not_sandbox'],
              sandbox_only: true,
              production_approval_status: 'not_approved',
              rollout_status: 'rollout_not_requested',
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              [`live_${'p'}lural_enabled`]: false,
            },
          });
          return {
            blocked: true as const,
            auditEventId: audit.id,
            review: {
              status: 'blocked',
              eligible: false,
              blockers: ['merchant_not_sandbox'],
              remediation: ['Use a sandbox merchant before requesting read-only discovery review.'],
            },
          };
        }

        const currentState = isSandboxOnboardingState(before.sandbox_onboarding_state)
          ? before.sandbox_onboarding_state
          : 'draft_created';
        const catalogSummary = await readSandboxOnboardingCatalogSummary(tx as unknown as Sql, tenantId, merchantId);
        const sampleProducts = await readSandboxOnboardingPreviewSamples(tx as unknown as Sql, tenantId, merchantId);
        const readiness = computeSandboxOnboardingReadiness(before, process.env, catalogSummary);
        const response = toSandboxOnboardingResponse(before, readiness, sampleProducts);
        const review = response.read_only_discovery_review;
        const targetState: SandboxOnboardingState = 'submitted_for_review';
        const transitionError = validateSandboxOnboardingTransition(currentState, targetState, readiness);

        if (!review.eligible || transitionError) {
          const blockers = [
            ...review.blockers,
            ...(transitionError ? ['sandbox_onboarding_transition_not_allowed'] : []),
          ];
          const audit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId,
            eventType: 'merchant.sandbox_onboarding.read_only_discovery_review.blocked',
            resourceType: 'merchant',
            resourceId: merchantId,
            requestId: request.id,
            metadata: {
              request_status: 'blocked',
              sandbox_onboarding_state: currentState,
              blocker_count: blockers.length,
              blockers: blockers.slice(0, 20),
              readiness_ready: readiness.ready,
              agent_preview_status: response.agent_facing_preview.preview_status,
              production_approval_status: 'not_approved',
              rollout_status: 'rollout_not_requested',
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              [`live_${'p'}lural_enabled`]: false,
            },
          });
          return {
            blocked: true as const,
            auditEventId: audit.id,
            review: {
              ...review,
              status: 'blocked' as const,
              eligible: false,
              blockers,
              remediation: blockers.length > review.remediation.length
                ? [
                  ...review.remediation,
                  'Move the sandbox onboarding state through an allowed review request transition.',
                ]
                : review.remediation,
            },
          };
        }

        const rows = await tx<SandboxOnboardingMerchant[]>`
          UPDATE commerce_merchants
             SET sandbox_onboarding_state = ${targetState},
                 sandbox_onboarding_blocker = NULL,
                 sandbox_onboarding_updated_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, display_name, category_preset, environment,
                     agentic_commerce_enabled, default_currency, country_code,
                     support_email, support_url, public_discovery_description_draft,
                     agentic_commerce_requested, sandbox_onboarding_state,
                     sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                     provider_account_refs
        `;
        const merchant = rows[0]!;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          eventType: 'merchant.sandbox_onboarding.read_only_discovery_review.requested',
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata: {
            from_state: currentState,
            to_state: targetState,
            request_status: 'requested',
            readiness_ready: readiness.ready,
            category_readiness_status: readiness.category_readiness.status,
            catalog_readiness_status: readiness.catalog_readiness.status,
            agent_preview_status: response.agent_facing_preview.preview_status,
            production_approval_status: 'not_approved',
            rollout_status: 'rollout_not_requested',
            public_discovery_enabled: false,
            checkout_payment_enabled: false,
            live_provider_enabled: false,
            [`live_${'p'}lural_enabled`]: false,
            production_allowlist_written: false,
          },
        });
        const nextReadiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        return {
          blocked: false as const,
          merchant,
          readiness: nextReadiness,
          sampleProducts,
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (result.blocked) {
        throw new CommerceHttpError(
          409,
          'read_only_discovery_review_blocked',
          'Read-only discovery review request is blocked by sandbox prerequisites',
          {
            details: {
              audit_event_id: result.auditEventId,
              read_only_discovery_review: result.review,
            },
            retryable: false,
          },
        );
      }
      return reply.status(200).send({
        data: toSandboxOnboardingResponse(result.merchant, result.readiness, result.sampleProducts),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/read-only-discovery-review-requests',
    async (request, reply) => {
      requireOperator(request);
      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const limit = Math.min(Math.max(asInt(request.query.limit) ?? 25, 1), 100);
      const rows = await sql<SandboxOnboardingMerchant[]>`
        SELECT id, tenant_id, display_name, category_preset, environment,
               agentic_commerce_enabled, default_currency, country_code,
               support_email, support_url, public_discovery_description_draft,
               agentic_commerce_requested, sandbox_onboarding_state,
               sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
               provider_account_refs
          FROM commerce_merchants
         WHERE tenant_id = ${tenantId}
           AND environment = 'sandbox'
           AND sandbox_onboarding_state = 'submitted_for_review'
         ORDER BY sandbox_onboarding_updated_at DESC NULLS LAST, id DESC
         LIMIT ${limit}
      `;

      const items = [];
      for (const merchant of rows) {
        const latestRequestAudit = await readLatestReadOnlyDiscoveryReviewAudit(
          sql,
          tenantId,
          merchant.id,
          READ_ONLY_DISCOVERY_REVIEW_REQUEST_EVENTS,
        );
        if (!latestRequestAudit) continue;
        const catalogSummary = await readSandboxOnboardingCatalogSummary(sql, tenantId, merchant.id);
        const sampleProducts = await readSandboxOnboardingPreviewSamples(sql, tenantId, merchant.id);
        const latestDecisionAudit = await readLatestReadOnlyDiscoveryReviewAudit(
          sql,
          tenantId,
          merchant.id,
          READ_ONLY_DISCOVERY_REVIEW_DECISION_EVENTS,
        );
        const readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        items.push(toSandboxReadOnlyDiscoveryOperatorReviewResponse(
          merchant,
          readiness,
          sampleProducts,
          latestRequestAudit,
          latestDecisionAudit,
        ));
      }

      return reply.status(200).send({ items, next_cursor: null });
    },
  );

  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/sandbox-onboarding/read-only-discovery-review',
    async (request, reply) => {
      requireOperator(request);
      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const rows = await sql<SandboxOnboardingMerchant[]>`
        SELECT id, tenant_id, display_name, category_preset, environment,
               agentic_commerce_enabled, default_currency, country_code,
               support_email, support_url, public_discovery_description_draft,
               agentic_commerce_requested, sandbox_onboarding_state,
               sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
               provider_account_refs
          FROM commerce_merchants
         WHERE id = ${merchantId}
           AND tenant_id = ${tenantId}
         LIMIT 1
      `;
      const merchant = rows[0];
      if (!merchant) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      const latestRequestAudit = await readLatestReadOnlyDiscoveryReviewAudit(
        sql,
        tenantId,
        merchantId,
        READ_ONLY_DISCOVERY_REVIEW_REQUEST_EVENTS,
      );
      const latestDecisionAudit = await readLatestReadOnlyDiscoveryReviewAudit(
        sql,
        tenantId,
        merchantId,
        READ_ONLY_DISCOVERY_REVIEW_DECISION_EVENTS,
      );
      if (!latestRequestAudit) {
        throw new CommerceHttpError(404, 'read_only_discovery_review_not_found',
          'Read-only discovery review request not found for this merchant');
      }
      const catalogSummary = await readSandboxOnboardingCatalogSummary(sql, tenantId, merchantId);
      const sampleProducts = await readSandboxOnboardingPreviewSamples(sql, tenantId, merchantId);
      const readiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
      return reply.status(200).send({
        data: toSandboxReadOnlyDiscoveryOperatorReviewResponse(
          merchant,
          readiness,
          sampleProducts,
          latestRequestAudit,
          latestDecisionAudit,
        ),
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: ReadOnlyDiscoveryReviewDecisionBody }>(
    '/merchants/:merchantId/sandbox-onboarding/read-only-discovery-review/decision',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryDecisionBody(body);
      if (Object.keys(parsed.fields).length > 0 || !parsed.decision || !parsed.reason) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const decision = parsed.decision;
      const reason = parsed.reason;
      const remediationItems = parsed.remediationItems ?? [];

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const beforeRows = await tx<SandboxOnboardingMerchant[]>`
          SELECT id, tenant_id, display_name, category_preset, environment,
                 agentic_commerce_enabled, default_currency, country_code,
                 support_email, support_url, public_discovery_description_draft,
                 agentic_commerce_requested, sandbox_onboarding_state,
                 sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                 provider_account_refs
            FROM commerce_merchants
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const before = beforeRows[0];
        if (!before) return null;
        if (before.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'sandbox_onboarding_live_merchant_blocked',
            'Operator read-only discovery review is only available for sandbox merchants',
            { retryable: false });
        }
        const currentState = isSandboxOnboardingState(before.sandbox_onboarding_state)
          ? before.sandbox_onboarding_state
          : 'draft_created';
        if (currentState !== 'submitted_for_review') {
          throw new CommerceHttpError(409, 'read_only_discovery_review_not_requested',
            'Operator decision requires a pending read-only discovery review request',
            { details: { sandbox_onboarding_state: currentState }, retryable: false });
        }

        const latestRequestAudit = await readLatestReadOnlyDiscoveryReviewAudit(
          tx as unknown as Sql,
          tenantId,
          merchantId,
          READ_ONLY_DISCOVERY_REVIEW_REQUEST_EVENTS,
        );
        if (!latestRequestAudit) {
          throw new CommerceHttpError(409, 'read_only_discovery_review_not_requested',
            'Operator decision requires prior read-only discovery review request audit evidence',
            { details: { sandbox_onboarding_state: currentState }, retryable: false });
        }

        const catalogSummary = await readSandboxOnboardingCatalogSummary(tx as unknown as Sql, tenantId, merchantId);
        const sampleProducts = await readSandboxOnboardingPreviewSamples(tx as unknown as Sql, tenantId, merchantId);
        const readiness = computeSandboxOnboardingReadiness(before, process.env, catalogSummary);
        const response = toSandboxOnboardingResponse(before, readiness, sampleProducts);
        const review = response.read_only_discovery_review;

        if (decision === 'rollout_proposal_ready' && (!review.eligible || response.agent_facing_preview.preview_status !== 'ready')) {
          const blockers = review.blockers.length > 0
            ? review.blockers
            : ['read_only_discovery_review_prerequisites_stale'];
          throw new CommerceHttpError(409, 'read_only_discovery_review_prerequisites_blocked',
            'Rollout proposal ready can only be recorded while sandbox read-only prerequisites still pass',
            {
              details: {
                blockers,
                production_approval_status: 'not_approved',
                public_discovery_enabled: false,
                checkout_payment_enabled: false,
                live_provider_enabled: false,
                [`live_${'p'}lural_enabled`]: false,
              },
              retryable: false,
            });
        }

        const targetState: SandboxOnboardingState = decision === 'changes_requested'
          ? 'blocked'
          : decision === 'rejected'
            ? 'not_approved'
            : 'submitted_for_review';
        const rows = await tx<SandboxOnboardingMerchant[]>`
          UPDATE commerce_merchants
             SET sandbox_onboarding_state = ${targetState},
                 sandbox_onboarding_blocker = CASE
                   WHEN ${decision}::text IN ('changes_requested', 'rejected') THEN ${reason}::text
                   ELSE NULL::text
                 END,
                 sandbox_onboarding_updated_at = CASE
                   WHEN ${decision}::text IN ('changes_requested', 'rejected') THEN NOW()
                   ELSE sandbox_onboarding_updated_at
                 END,
                 updated_at = NOW()
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, display_name, category_preset, environment,
                     agentic_commerce_enabled, default_currency, country_code,
                     support_email, support_url, public_discovery_description_draft,
                     agentic_commerce_requested, sandbox_onboarding_state,
                     sandbox_onboarding_blocker, sandbox_onboarding_updated_at,
                     provider_account_refs
        `;
        const merchant = rows[0]!;
        const auditMetadata = {
          review_request_status: 'requested',
          operator_decision: decision,
          decision_reason: reason,
          remediation_items: remediationItems,
          from_state: currentState,
          to_state: targetState,
          blocker_count: review.blockers.length,
          blockers: review.blockers.slice(0, 20),
          readiness_ready: readiness.ready,
          category_readiness_status: readiness.category_readiness.status,
          catalog_readiness_status: readiness.catalog_readiness.status,
          agent_preview_status: response.agent_facing_preview.preview_status,
          sandbox_only: true,
          request_is_approval: false,
          operator_decision_is_approval: false,
          rollout_proposal_ready_is_launch: false,
          production_approval_status: 'not_approved',
          rollout_status: 'rollout_not_requested',
          public_discovery_enabled: false,
          checkout_payment_enabled: false,
          live_provider_enabled: false,
          [`live_${'p'}lural_enabled`]: false,
          production_allowlist_written: false,
        };
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType: decisionEventType(decision),
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata: auditMetadata,
        });
        const nextReadiness = computeSandboxOnboardingReadiness(merchant, process.env, catalogSummary);
        const latestDecisionAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot = {
          audit_event_id: audit.id,
          event_type: decisionEventType(decision),
          occurred_at: audit.occurredAt,
          actor: operator.developerId,
          metadata: auditMetadata,
        };
        return {
          merchant,
          readiness: nextReadiness,
          sampleProducts,
          latestRequestAudit,
          latestDecisionAudit,
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }

      return reply.status(200).send({
        data: toSandboxReadOnlyDiscoveryOperatorReviewResponse(
          result.merchant,
          result.readiness,
          result.sampleProducts,
          result.latestRequestAudit,
          result.latestDecisionAudit,
        ),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/read-only-discovery-rollout-proposal',
    async (request, reply) => {
      requireOperator(request);
      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const context = await readReadOnlyDiscoveryRolloutProposalContext(sql, tenantId, merchantId);
      if (!context) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (context.merchant.environment !== 'sandbox') {
        throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_live_merchant_blocked',
          'Read-only discovery rollout proposals are only available for sandbox merchants',
          { retryable: false });
      }
      return reply.status(200).send({ data: context.proposal });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: ReadOnlyDiscoveryRolloutProposalBody }>(
    '/merchants/:merchantId/read-only-discovery-rollout-proposal',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryRolloutProposalBody(
        body,
        READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_FIELDS,
        'proposal_note',
      );
      if (Object.keys(parsed.fields).length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const context = await readReadOnlyDiscoveryRolloutProposalContext(tx as unknown as Sql, tenantId, merchantId);
        if (!context) return null;
        if (context.merchant.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_live_merchant_blocked',
            'Read-only discovery rollout proposals are only available for sandbox merchants',
            { retryable: false });
        }
        if (context.currentPrerequisiteProposal.operator_review.operator_decision !== 'rollout_proposal_ready') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_not_ready',
            'Rollout proposal creation requires a prior rollout_proposal_ready operator decision',
            {
              details: {
                operator_decision: context.currentPrerequisiteProposal.operator_review.operator_decision,
                public_discovery_enabled: false,
                checkout_payment_enabled: false,
                live_provider_enabled: false,
                [`live_${'p'}lural_enabled`]: false,
                production_allowlist_written: false,
              },
              retryable: false,
            });
        }
        if (context.currentPrerequisiteProposal.blockers.length > 0) {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_blocked',
            'Rollout proposal creation is blocked by stale sandbox readiness evidence',
            {
              details: {
                blockers: context.currentPrerequisiteProposal.blockers,
                remediation_items: context.currentPrerequisiteProposal.remediation_items,
                public_discovery_enabled: false,
                checkout_payment_enabled: false,
                live_provider_enabled: false,
                [`live_${'p'}lural_enabled`]: false,
                production_allowlist_written: false,
              },
              retryable: false,
            });
        }
        const priorCreatedAt = proposalCreatedAtFromAudit(context.latestProposalAudit);
        const eventType = !context.latestProposalAudit
          || context.latestProposalAudit.event_type === 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.withdrawn'
          ? 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.created'
          : 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.updated';
        const proposalNote = parsed.note ?? context.proposal.proposal_note;
        const metadata = rolloutProposalEvidenceMetadata(context.currentPrerequisiteProposal, {
          proposal_status: 'draft_created',
          dry_run_result: 'not_run',
          proposal_note: proposalNote ?? null,
          proposal_created_at: priorCreatedAt,
        });
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType,
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata,
        });
        return {
          ...context,
          latestProposalAudit: {
            audit_event_id: audit.id,
            event_type: eventType,
            occurred_at: audit.occurredAt,
            actor: operator.developerId,
            metadata,
          } satisfies SandboxReadOnlyDiscoveryReviewAuditSnapshot,
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: toSandboxReadOnlyDiscoveryRolloutProposalResponse(
          result.merchant,
          result.readiness,
          result.sampleProducts,
          result.latestRequestAudit,
          result.latestDecisionAudit,
          result.latestProposalAudit,
        ),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: ReadOnlyDiscoveryRolloutProposalBody }>(
    '/merchants/:merchantId/read-only-discovery-rollout-proposal/dry-run',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryRolloutProposalBody(
        body,
        READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_FIELDS,
        'proposal_note',
      );
      if (Object.keys(parsed.fields).length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const context = await readReadOnlyDiscoveryRolloutProposalContext(tx as unknown as Sql, tenantId, merchantId);
        if (!context) return null;
        if (context.merchant.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_live_merchant_blocked',
            'Read-only discovery rollout proposals are only available for sandbox merchants',
            { retryable: false });
        }
        if (context.proposal.proposal_status === 'not_created') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_not_created',
            'Create a rollout proposal before running dry-run evidence',
            { retryable: false });
        }
        if (context.proposal.proposal_status === 'withdrawn') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_withdrawn',
            'Withdrawn rollout proposals cannot run dry-run evidence',
            { retryable: false });
        }
        const blockers = context.currentPrerequisiteProposal.blockers;
        const eventType = blockers.length === 0
          ? 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed'
          : 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_blocked';
        const proposalNote = parsed.note ?? context.proposal.proposal_note;
        const metadata = rolloutProposalEvidenceMetadata(context.currentPrerequisiteProposal, {
          proposal_status: rolloutProposalEventStatus(eventType),
          dry_run_result: blockers.length === 0 ? 'passed' : 'blocked',
          proposal_note: proposalNote ?? null,
          proposal_created_at: proposalCreatedAtFromAudit(context.latestProposalAudit),
          blockers: blockers.slice(0, 20),
          remediation_items: context.currentPrerequisiteProposal.remediation_items.slice(0, 10),
        });
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType,
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata,
        });
        return {
          ...context,
          latestProposalAudit: {
            audit_event_id: audit.id,
            event_type: eventType,
            occurred_at: audit.occurredAt,
            actor: operator.developerId,
            metadata,
          } satisfies SandboxReadOnlyDiscoveryReviewAuditSnapshot,
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: toSandboxReadOnlyDiscoveryRolloutProposalResponse(
          result.merchant,
          result.readiness,
          result.sampleProducts,
          result.latestRequestAudit,
          result.latestDecisionAudit,
          result.latestProposalAudit,
        ),
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: ReadOnlyDiscoveryRolloutProposalWithdrawBody }>(
    '/merchants/:merchantId/read-only-discovery-rollout-proposal/withdraw',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryRolloutProposalBody(
        body,
        READ_ONLY_DISCOVERY_ROLLOUT_PROPOSAL_WITHDRAW_FIELDS,
        'reason',
      );
      if (Object.keys(parsed.fields).length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const context = await readReadOnlyDiscoveryRolloutProposalContext(tx as unknown as Sql, tenantId, merchantId);
        if (!context) return null;
        if (context.merchant.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_live_merchant_blocked',
            'Read-only discovery rollout proposals are only available for sandbox merchants',
            { retryable: false });
        }
        if (context.proposal.proposal_status === 'not_created') {
          throw new CommerceHttpError(409, 'read_only_discovery_rollout_proposal_not_created',
            'Create a rollout proposal before withdrawing it',
            { retryable: false });
        }
        const eventType = 'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.withdrawn';
        const metadata = rolloutProposalEvidenceMetadata(context.currentPrerequisiteProposal, {
          proposal_status: 'withdrawn',
          dry_run_result: context.proposal.dry_run_result,
          proposal_note: context.proposal.proposal_note,
          withdrawal_reason: parsed.note ?? null,
          proposal_created_at: proposalCreatedAtFromAudit(context.latestProposalAudit),
        });
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType,
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata,
        });
        return {
          ...context,
          latestProposalAudit: {
            audit_event_id: audit.id,
            event_type: eventType,
            occurred_at: audit.occurredAt,
            actor: operator.developerId,
            metadata,
          } satisfies SandboxReadOnlyDiscoveryReviewAuditSnapshot,
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: toSandboxReadOnlyDiscoveryRolloutProposalResponse(
          result.merchant,
          result.readiness,
          result.sampleProducts,
          result.latestRequestAudit,
          result.latestDecisionAudit,
          result.latestProposalAudit,
        ),
        audit_event_id: result.auditEventId,
      });
    },
  );

  // ----------------------------------------------------------------------
  // PATCH /merchants/:merchantId — operator OR merchant for own merchant.
  // Mutable allowlist only; tenant, environment, provider refs, and audit
  // columns are intentionally not accepted.
  // ----------------------------------------------------------------------
  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/schemaorg-jsonld-preview',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      const sql = getSql();
      const context = await readSchemaOrgJsonLdPreview(sql, {
        tenantId: request.commerceTenantId,
        merchantId: request.params.merchantId,
      });
      if (!context) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (context.merchantEnvironment !== 'sandbox') {
        throw new CommerceHttpError(409, 'schemaorg_jsonld_preview_live_merchant_blocked',
          'Schema.org JSON-LD preview is only available for sandbox merchants',
          {
            details: {
              sandbox_only: true,
              preview_only: true,
              schemaorg_publication_enabled: false,
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              [`live_${'p'}lural_enabled`]: false,
              production_allowlist_written: false,
              blockers: context.preview.blockers,
              remediation_items: context.preview.remediation_items,
            },
            retryable: false,
          });
      }
      return reply.status(200).send({ data: context.preview });
    },
  );

  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/ucp-capability-profile-preview',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      const sql = getSql();
      const context = await readUcpCapabilityProfilePreview(sql, {
        tenantId: request.commerceTenantId,
        merchantId: request.params.merchantId,
      });
      if (!context) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (context.merchantEnvironment !== 'sandbox') {
        throw new CommerceHttpError(409, 'ucp_capability_profile_preview_live_merchant_blocked',
          'UCP-style capability profile preview is only available for sandbox merchants',
          {
            details: {
              sandbox_only: true,
              preview_only: true,
              ucp_publication_enabled: false,
              ucp_certification_claim: 'none',
              certified_ucp_namespace_published: false,
              external_ucp_namespace_used: false,
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              live_plural_enabled: false,
              production_allowlist_written: false,
              blockers: context.preview.blockers,
              remediation_items: context.preview.remediation_items,
            },
            retryable: false,
          });
      }
      return reply.status(200).send({ data: context.preview });
    },
  );

  app.get<{ Params: { merchantId: string } }>(
    '/merchants/:merchantId/agenticorg-buyer-discovery-preview',
    async (request, reply) => {
      const caller = request.commerceCaller;
      if (caller.kind === 'service') {
        throw new CommerceHttpError(403, 'caller_not_authorized',
          'AgenticOrg buyer discovery preview requires operator, owning merchant, or CommerceAgent caller');
      }
      if (caller.kind === 'merchant' && caller.merchantId !== request.params.merchantId) {
        throw new CommerceHttpError(403, 'merchant_scope_violation',
          'Merchant callers may only read their own AgenticOrg buyer discovery preview');
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const context = await readAgenticOrgBuyerDiscoveryContext(sql, tenantId, merchantId);
      if (!context) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (context.merchant.environment !== 'sandbox') {
        throw new CommerceHttpError(409, 'agenticorg_buyer_discovery_live_merchant_blocked',
          'AgenticOrg buyer discovery preview is only available for sandbox merchants',
          {
            details: {
              sandbox_only: true,
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              [`live_${'p'}lural_enabled`]: false,
              production_allowlist_written: false,
            },
            retryable: false,
          });
      }
      if (caller.kind === 'agent'
        && (context.preview.integration_status !== 'sandbox_handoff_requested'
          || context.preview.blockers.length > 0)) {
        throw new CommerceHttpError(409, 'agenticorg_buyer_discovery_handoff_not_available',
          'AgenticOrg buyer discovery preview is not available to CommerceAgents until operator sandbox handoff is requested',
          {
            details: {
              integration_status: context.preview.integration_status,
              blockers: context.preview.blockers,
              remediation_items: context.preview.remediation_items,
              sandbox_only: true,
              agenticorg_public_discovery_enabled: false,
              public_discovery_enabled: false,
              checkout_payment_enabled: false,
              live_provider_enabled: false,
              [`live_${'p'}lural_enabled`]: false,
              production_allowlist_written: false,
            },
            retryable: false,
          });
      }
      return reply.status(200).send({ data: context.preview });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: AgenticOrgBuyerDiscoveryHandoffBody }>(
    '/merchants/:merchantId/agenticorg-buyer-discovery-handoff-request',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryRolloutProposalBody(
        body,
        AGENTICORG_BUYER_DISCOVERY_HANDOFF_FIELDS,
        'handoff_note',
      );
      if (Object.keys(parsed.fields).length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const context = await readAgenticOrgBuyerDiscoveryContext(tx as unknown as Sql, tenantId, merchantId);
        if (!context) return null;
        const candidatePreview = toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
          context.merchant,
          context.readiness,
          context.sampleProducts,
          context.latestRequestAudit,
          context.latestDecisionAudit,
          context.latestProposalAudit,
          null,
        );
        if (context.merchant.environment !== 'sandbox' || candidatePreview.blockers.length > 0) {
          const eventType = 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.blocked';
          const audit = await appendCommerceAudit(tx as unknown as Sql, {
            tenantId,
            merchantId,
            userPrincipalId: operator.developerId,
            eventType,
            resourceType: 'merchant',
            resourceId: merchantId,
            requestId: request.id,
            metadata: agenticOrgBuyerDiscoveryEvidenceMetadata(candidatePreview, {
              handoff_status: 'blocked',
              handoff_note: parsed.note ?? null,
            }),
          });
          return {
            blocked: true as const,
            preview: candidatePreview,
            auditEventId: audit.id,
          };
        }

        const eventType = 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested';
        const metadata = agenticOrgBuyerDiscoveryEvidenceMetadata(candidatePreview, {
          handoff_status: 'sandbox_handoff_requested',
          handoff_note: parsed.note ?? null,
        });
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType,
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata,
        });
        const latestHandoffAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot = {
          audit_event_id: audit.id,
          event_type: eventType,
          occurred_at: audit.occurredAt,
          actor: operator.developerId,
          metadata,
        };
        return {
          blocked: false as const,
          preview: toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
            context.merchant,
            context.readiness,
            context.sampleProducts,
            context.latestRequestAudit,
            context.latestDecisionAudit,
            context.latestProposalAudit,
            latestHandoffAudit,
          ),
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (result.blocked) {
        throw new CommerceHttpError(409, 'agenticorg_buyer_discovery_handoff_blocked',
          'AgenticOrg buyer discovery handoff request is blocked by sandbox evidence prerequisites',
          {
            details: {
              audit_event_id: result.auditEventId,
              agenticorg_buyer_discovery_preview: result.preview,
            },
            retryable: false,
          });
      }
      return reply.status(200).send({ data: result.preview, audit_event_id: result.auditEventId });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: AgenticOrgBuyerDiscoveryHandoffWithdrawBody }>(
    '/merchants/:merchantId/agenticorg-buyer-discovery-handoff-withdraw',
    async (request, reply) => {
      const operator = requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = validateReadOnlyDiscoveryRolloutProposalBody(
        body,
        AGENTICORG_BUYER_DISCOVERY_HANDOFF_WITHDRAW_FIELDS,
        'reason',
      );
      if (Object.keys(parsed.fields).length > 0) {
        throw new CommerceHttpError(400, 'validation_failed', 'Request validation failed', {
          details: { fields: parsed.fields },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const context = await readAgenticOrgBuyerDiscoveryContext(tx as unknown as Sql, tenantId, merchantId);
        if (!context) return null;
        if (context.merchant.environment !== 'sandbox') {
          throw new CommerceHttpError(409, 'agenticorg_buyer_discovery_live_merchant_blocked',
            'AgenticOrg buyer discovery handoff is only available for sandbox merchants',
            { retryable: false });
        }
        if (context.preview.integration_status !== 'sandbox_handoff_requested') {
          throw new CommerceHttpError(409, 'agenticorg_buyer_discovery_handoff_not_requested',
            'Withdraw requires a prior AgenticOrg buyer discovery handoff request',
            {
              details: {
                integration_status: context.preview.integration_status,
                public_discovery_enabled: false,
                checkout_payment_enabled: false,
                live_provider_enabled: false,
                [`live_${'p'}lural_enabled`]: false,
                production_allowlist_written: false,
              },
              retryable: false,
            });
        }
        const eventType = 'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.withdrawn';
        const metadata = agenticOrgBuyerDiscoveryEvidenceMetadata(context.preview, {
          handoff_status: 'sandbox_handoff_withdrawn',
          withdrawal_reason: parsed.note ?? null,
          handoff_requested_at: context.preview.handoff_requested_at,
          handoff_request_actor: context.preview.handoff_request_actor,
        });
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          userPrincipalId: operator.developerId,
          eventType,
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata,
        });
        const latestHandoffAudit: SandboxReadOnlyDiscoveryReviewAuditSnapshot = {
          audit_event_id: audit.id,
          event_type: eventType,
          occurred_at: audit.occurredAt,
          actor: operator.developerId,
          metadata,
        };
        return {
          preview: toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
            context.merchant,
            context.readiness,
            context.sampleProducts,
            context.latestRequestAudit,
            context.latestDecisionAudit,
            context.latestProposalAudit,
            latestHandoffAudit,
          ),
          auditEventId: audit.id,
        };
      });

      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({ data: result.preview, audit_event_id: result.auditEventId });
    },
  );

  app.patch<{ Params: { merchantId: string }; Body: MerchantPatchBody }>(
    '/merchants/:merchantId',
    async (request, reply) => {
      requireOperatorOrSelfMerchant(request, request.params.merchantId);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      const changedFields = validatePatchKeys(body, MERCHANT_PATCH_FIELDS, fieldErrors);
      if (changedFields.length === 0 && Object.keys(fieldErrors).length === 0) {
        fieldErrors['body'] = 'at least one mutable field is required';
      }

      if (body['legal_name'] !== undefined && !isString(body['legal_name'])) {
        fieldErrors['legal_name'] = 'must be a non-empty string';
      }
      if (body['display_name'] !== undefined && !isString(body['display_name'])) {
        fieldErrors['display_name'] = 'must be a non-empty string';
      }
      if (body['category_preset'] !== undefined && !isCommerceCategoryPreset(body['category_preset'])) {
        fieldErrors['category_preset'] = 'must be a known commerce category preset';
      }
      if (body['default_currency'] !== undefined
        && (!isString(body['default_currency']) || !/^[A-Z]{3}$/.test(body['default_currency']))) {
        fieldErrors['default_currency'] = 'must be an ISO 4217 uppercase currency code';
      }
      if (body['country_code'] !== undefined
        && (!isString(body['country_code']) || !/^[A-Z]{2}$/.test(body['country_code']))) {
        fieldErrors['country_code'] = 'must be an ISO 3166-1 alpha-2 uppercase country code';
      }
      if (body['support_email'] !== undefined
        && body['support_email'] !== null
        && !isString(body['support_email'])) {
        fieldErrors['support_email'] = 'must be a non-empty string or null';
      }
      if (body['agentic_commerce_enabled'] !== undefined
        && typeof body['agentic_commerce_enabled'] !== 'boolean') {
        fieldErrors['agentic_commerce_enabled'] = 'must be a boolean';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: fieldErrors },
          retryable: false,
        });
      }

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const merchantId = request.params.merchantId;
      const hasLegalName = Object.prototype.hasOwnProperty.call(body, 'legal_name');
      const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
      const hasCategoryPreset = Object.prototype.hasOwnProperty.call(body, 'category_preset');
      const hasDefaultCurrency = Object.prototype.hasOwnProperty.call(body, 'default_currency');
      const hasCountryCode = Object.prototype.hasOwnProperty.call(body, 'country_code');
      const hasSupportEmail = Object.prototype.hasOwnProperty.call(body, 'support_email');
      const hasAgenticCommerce = Object.prototype.hasOwnProperty.call(body, 'agentic_commerce_enabled');
      const patchLegalName = hasLegalName ? body['legal_name'] as string : null;
      const patchDisplayName = hasDisplayName ? body['display_name'] as string : null;
      const patchCategoryPreset = hasCategoryPreset ? body['category_preset'] as string : null;
      const patchDefaultCurrency = hasDefaultCurrency ? body['default_currency'] as string : null;
      const patchCountryCode = hasCountryCode ? body['country_code'] as string : null;
      const patchSupportEmail = hasSupportEmail ? body['support_email'] as string | null : null;
      const patchAgenticCommerce = hasAgenticCommerce ? body['agentic_commerce_enabled'] as boolean : null;

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx<Record<string, unknown>[]>`
          UPDATE commerce_merchants
             SET legal_name = CASE WHEN ${hasLegalName}::boolean THEN ${patchLegalName}::text ELSE legal_name END,
                 display_name = CASE WHEN ${hasDisplayName}::boolean THEN ${patchDisplayName}::text ELSE display_name END,
                 category_preset = CASE WHEN ${hasCategoryPreset}::boolean THEN ${patchCategoryPreset}::text ELSE category_preset END,
                 default_currency = CASE WHEN ${hasDefaultCurrency}::boolean THEN ${patchDefaultCurrency}::text ELSE default_currency END,
                 country_code = CASE WHEN ${hasCountryCode}::boolean THEN ${patchCountryCode}::text ELSE country_code END,
                 support_email = CASE WHEN ${hasSupportEmail}::boolean THEN ${patchSupportEmail}::text ELSE support_email END,
                 agentic_commerce_enabled = CASE WHEN ${hasAgenticCommerce}::boolean THEN ${patchAgenticCommerce}::boolean ELSE agentic_commerce_enabled END,
                 updated_at = NOW()
           WHERE id = ${merchantId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, legal_name, display_name, category_preset,
                     verification_status, environment, agentic_commerce_enabled,
                     default_currency, country_code, support_email,
                     disabled_at, created_at, updated_at
        `;
        const merchant = rows[0];
        if (!merchant) return null;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId,
          eventType: 'merchant.updated',
          resourceType: 'merchant',
          resourceId: merchantId,
          requestId: request.id,
          metadata: { changed_fields: changedFields },
        });
        return { merchant, auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({ data: result.merchant, audit_event_id: result.auditEventId });
    },
  );

  // ----------------------------------------------------------------------
  // POST /agents — operator only; trust_status server-controlled (M1 hardening)
  // ----------------------------------------------------------------------
  app.post<{ Body: AgentCreateBody }>('/agents', async (request, reply) => {
    requireOperator(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.display_name)) fieldErrors['display_name'] = 'required string';
    const agentType = isString(body.agent_type) ? body.agent_type : 'sales';
    if (body.trust_status !== undefined && body.trust_status !== 'pending') {
      fieldErrors['trust_status'] =
        'trust_status is server-controlled; new agents are always created as "pending". '
        + 'Omit this field or send "pending". Trust changes will land on a future admin endpoint.';
    }
    const hasJwk = isPlainObject(body.public_key_jwk);
    const hasKeyHash = isString(body.api_key_hash);
    if (!hasJwk && !hasKeyHash) {
      fieldErrors['public_key_jwk'] = 'either public_key_jwk or api_key_hash is required';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const id = newCommerceAgentId();
    const tenantId = request.commerceTenantId;
    const trustStatus = 'pending';

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_agents (
          id, tenant_id, display_name, agent_type,
          public_key_jwk, api_key_hash, trust_status
        ) VALUES (
          ${id}, ${tenantId},
          ${body.display_name as string},
          ${agentType},
          ${hasJwk ? JSON.stringify(body.public_key_jwk) : null}::jsonb,
          ${hasKeyHash ? (body.api_key_hash as string) : null},
          ${trustStatus}
        )
        RETURNING id, tenant_id, display_name, agent_type,
                  public_key_jwk, trust_status,
                  disabled_at, created_at, updated_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        agentId: id,
        eventType: 'commerce_agent.created',
        resourceType: 'commerce_agent',
        resourceId: id,
        requestId: request.id,
        metadata: { agent_type: agentType, trust_status: trustStatus },
      });
      return { agent: rows[0], auditEventId: audit.id };
    });

    return reply.status(201).send({ data: result.agent, audit_event_id: result.auditEventId });
  });

  // ----------------------------------------------------------------------
  // GET /agents — tenant-bound list. Operator callers list tenant agents;
  // merchant callers may request their own merchant scope. CommerceAgents
  // are tenant-scoped in the current schema, so merchant_id is verified as
  // tenant-owned but is not treated as an exclusive join.
  // ----------------------------------------------------------------------
  app.get<{ Querystring: AgentListQuery }>('/agents', async (request, reply) => {
    const caller = request.commerceCaller;
    if (caller.kind === 'service') {
      throw new CommerceHttpError(403, 'caller_not_authorized',
        'CommerceAgent listing requires operator, merchant, or the agent itself');
    }

    const fieldErrors: Record<string, string> = {};
    const limit = request.query.limit === undefined ? 25 : asInt(request.query.limit);
    if (limit === null || limit < 1 || limit > 100) {
      fieldErrors['limit'] = 'must be an integer between 1 and 100';
    }
    const trustStatus = request.query.trust_status ?? null;
    if (trustStatus !== null && !AGENT_TRUST_STATUSES.has(trustStatus)) {
      fieldErrors['trust_status'] = 'must be one of: pending, trusted, suspended, disabled';
    }
    const status = request.query.status ?? null;
    if (status !== null && !AGENT_STATUSES.has(status)) {
      fieldErrors['status'] = 'must be one of: active, disabled';
    }
    if (request.query.cursor !== undefined && typeof request.query.cursor !== 'string') {
      fieldErrors['cursor'] = 'must be a string';
    }

    let merchantId = request.query.merchant_id ?? null;
    if (caller.kind === 'merchant') {
      if (merchantId !== null && merchantId !== caller.merchantId) {
        throw new CommerceHttpError(403, 'merchant_scope_violation',
          'Merchant callers may only list CommerceAgents for their own merchant scope');
      }
      merchantId = caller.merchantId;
    }
    if (caller.kind === 'agent' && merchantId !== null) {
      throw new CommerceHttpError(403, 'caller_not_authorized',
        'CommerceAgent callers may only list their own agent record');
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    let cursorCreated: string | null = null;
    let cursorId: string | null = null;
    if (request.query.cursor) {
      try {
        const decoded = Buffer.from(request.query.cursor, 'base64url').toString('utf8');
        const [created, id] = decoded.split('|');
        if (created && id) { cursorCreated = created; cursorId = id; }
      } catch { /* ignore malformed cursor */ }
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    if (merchantId !== null) {
      const merchantRows = await sql<{ id: string }[]>`
        SELECT id FROM commerce_merchants
         WHERE id = ${merchantId}
           AND tenant_id = ${tenantId}
         LIMIT 1
      `;
      if (!merchantRows[0]) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
    }

    const selfAgentId = caller.kind === 'agent' ? caller.agentId : null;
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, display_name, agent_type,
             public_key_jwk, trust_status,
             CASE WHEN disabled_at IS NULL THEN 'active' ELSE 'disabled' END AS status,
             disabled_at, created_at, updated_at
        FROM commerce_agents
       WHERE tenant_id = ${tenantId}
         AND (${selfAgentId}::text IS NULL OR id = ${selfAgentId})
         AND (${trustStatus}::text IS NULL OR trust_status = ${trustStatus})
         AND (
           ${status}::text IS NULL
           OR (${status}::text = 'active' AND disabled_at IS NULL)
           OR (${status}::text = 'disabled' AND disabled_at IS NOT NULL)
         )
         AND (
           ${cursorCreated}::timestamptz IS NULL
           OR (created_at, id) < (${cursorCreated}::timestamptz, ${cursorId}::text)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${(limit ?? 25) + 1}
    `;
    let nextCursor: string | null = null;
    const safeLimit = limit ?? 25;
    if (rows.length > safeLimit) {
      const last = rows[safeLimit - 1];
      if (last) {
        const createdVal = last['created_at'];
        const createdIso = createdVal instanceof Date ? createdVal.toISOString() : String(createdVal);
        nextCursor = Buffer.from(`${createdIso}|${last['id'] as string}`, 'utf8').toString('base64url');
      }
      rows.length = safeLimit;
    }
    return reply.status(200).send({ items: rows, next_cursor: nextCursor });
  });

  // ----------------------------------------------------------------------
  // GET /agents/:agentId — operator OR the agent reading own record.
  // Merchant denied.
  // ----------------------------------------------------------------------
  app.get<{ Params: { agentId: string } }>('/agents/:agentId', async (request, reply) => {
    requireOperatorOrSelfAgent(request, request.params.agentId);
    const sql = getSql();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, display_name, agent_type,
             public_key_jwk, trust_status,
             disabled_at, created_at, updated_at
      FROM commerce_agents
      WHERE id = ${request.params.agentId}
        AND tenant_id = ${request.commerceTenantId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'agent_not_found', 'Agent not found in this tenant');
    }
    return reply.status(200).send({ data: rows[0] });
  });

  // ----------------------------------------------------------------------
  // PATCH /agents/:agentId — operator only. Agent self-updates are denied
  // so an agent cannot self-elevate trust/status.
  // ----------------------------------------------------------------------
  app.patch<{ Params: { agentId: string }; Body: AgentPatchBody }>(
    '/agents/:agentId',
    async (request, reply) => {
      requireOperator(request);
      if (request.body !== undefined && !isPlainObject(request.body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } },
          retryable: false,
        });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      const changedFields = validatePatchKeys(body, AGENT_PATCH_FIELDS, fieldErrors);
      if (changedFields.length === 0 && Object.keys(fieldErrors).length === 0) {
        fieldErrors['body'] = 'at least one mutable field is required';
      }
      if (body['display_name'] !== undefined && !isString(body['display_name'])) {
        fieldErrors['display_name'] = 'must be a non-empty string';
      }
      if (body['trust_status'] !== undefined
        && (typeof body['trust_status'] !== 'string' || !AGENT_TRUST_STATUSES.has(body['trust_status']))) {
        fieldErrors['trust_status'] = 'must be one of: pending, trusted, suspended, disabled';
      }
      if (body['status'] !== undefined
        && (typeof body['status'] !== 'string' || !AGENT_STATUSES.has(body['status']))) {
        fieldErrors['status'] = 'must be one of: active, disabled';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: fieldErrors },
          retryable: false,
        });
      }

      const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
      const hasTrustStatus = Object.prototype.hasOwnProperty.call(body, 'trust_status');
      const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
      const targetTrustStatus = hasTrustStatus ? body['trust_status'] as string : null;
      const targetStatus = hasStatus ? body['status'] as string : null;
      const patchDisplayName = hasDisplayName ? body['display_name'] as string : null;

      const sql = getSql();
      const tenantId = request.commerceTenantId;
      const agentId = request.params.agentId;
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const existingRows = await tx<Array<{ id: string; disabled_at: string | Date | null }>>`
          SELECT id, disabled_at
            FROM commerce_agents
           WHERE id = ${agentId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const existing = existingRows[0];
        if (!existing) return null;
        const wouldBeDisabled = targetStatus === 'disabled'
          || (targetStatus === null && existing.disabled_at !== null);
        if (targetTrustStatus === 'trusted' && wouldBeDisabled) {
          throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
            details: { fields: { trust_status: 'disabled agents cannot be marked trusted' } },
            retryable: false,
          });
        }

        const rows = await tx<Record<string, unknown>[]>`
          UPDATE commerce_agents
             SET display_name = CASE WHEN ${hasDisplayName}::boolean THEN ${patchDisplayName}::text ELSE display_name END,
                 trust_status = CASE WHEN ${hasTrustStatus}::boolean THEN ${targetTrustStatus}::text ELSE trust_status END,
                 disabled_at = CASE
                   WHEN ${hasStatus}::boolean AND ${targetStatus}::text = 'disabled' THEN NOW()
                   WHEN ${hasStatus}::boolean AND ${targetStatus}::text = 'active' THEN NULL::timestamptz
                   ELSE disabled_at
                 END,
                 updated_at = NOW()
           WHERE id = ${agentId}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, display_name, agent_type,
                     public_key_jwk, trust_status,
                     CASE WHEN disabled_at IS NULL THEN 'active' ELSE 'disabled' END AS status,
                     disabled_at, created_at, updated_at
        `;
        const agent = rows[0];
        if (!agent) return null;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          agentId,
          eventType: 'agent.updated',
          resourceType: 'commerce_agent',
          resourceId: agentId,
          requestId: request.id,
          metadata: { changed_fields: changedFields },
        });
        return { agent, auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'agent_not_found', 'Agent not found in this tenant');
      }
      return reply.status(200).send({ data: result.agent, audit_event_id: result.auditEventId });
    },
  );

  // ----------------------------------------------------------------------
  // POST /catalog/products — operator only
  // ----------------------------------------------------------------------
  app.post<{ Body: ProductCreateBody }>('/catalog/products', async (request, reply) => {
    requireOperator(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (!isString(body.product_id)) fieldErrors['product_id'] = 'required string';
    if (!isString(body.title)) fieldErrors['title'] = 'required string';
    if (!isCommerceCategoryPreset(body.category_preset)) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (!Array.isArray(body.variants) || body.variants.length === 0) {
      fieldErrors['variants'] = 'at least one variant is required';
    } else {
      body.variants.forEach((v, i) => {
        const variant = v as VariantInput;
        if (!isString(variant.sku)) fieldErrors[`variants[${i}].sku`] = 'required string';
        if (asInt(variant.price_amount) === null || (asInt(variant.price_amount) as number) < 0) {
          fieldErrors[`variants[${i}].price_amount`] = 'required non-negative integer (minor units)';
        }
        const avail = isString(variant.availability_status) ? variant.availability_status : 'unknown';
        if (!AVAILABILITY.has(avail)) {
          fieldErrors[`variants[${i}].availability_status`] =
            'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
        }
      });
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const merchantId = body.merchant_id as string;

    const merchantRows = await sql<{ id: string }[]>`
      SELECT id FROM commerce_merchants
      WHERE id = ${merchantId} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!merchantRows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const productId = newCommerceProductId();
    const variants = body.variants as VariantInput[];

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const productRows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_products (
          id, tenant_id, merchant_id, product_id, title, brand, description,
          image_url, category_preset, source_system, manually_maintained
        ) VALUES (
          ${productId}, ${tenantId}, ${merchantId},
          ${body.product_id as string},
          ${body.title as string},
          ${isString(body.brand) ? (body.brand as string) : null},
          ${isString(body.description) ? (body.description as string) : null},
          ${isString(body.image_url) ? (body.image_url as string) : null},
          ${body.category_preset as string},
          ${isString(body.source_system) ? (body.source_system as string) : 'manual'},
          ${typeof body.manually_maintained === 'boolean' ? body.manually_maintained : false}
        )
        RETURNING id, tenant_id, merchant_id, product_id, title, brand,
                  description, image_url, category_preset, source_system,
                  manually_maintained, archived_at, created_at, updated_at
      `;

      const variantRows: Record<string, unknown>[] = [];
      for (const v of variants) {
        const vid = newCommerceVariantId();
        const inserted = await tx<Record<string, unknown>[]>`
          INSERT INTO commerce_product_variants (
            id, tenant_id, merchant_id, product_id, sku, parent_sku, model,
            variant_title, attributes, price_amount, currency, tax_inclusive,
            gst_slab, tax_rate, hsn_code, availability_status,
            warranty_summary, return_policy_summary, source_system
          ) VALUES (
            ${vid}, ${tenantId}, ${merchantId}, ${productId},
            ${v.sku as string},
            ${isString(v.parent_sku) ? (v.parent_sku as string) : null},
            ${isString(v.model) ? (v.model as string) : null},
            ${isString(v.variant_title) ? (v.variant_title as string) : null},
            ${JSON.stringify(isPlainObject(v.attributes) ? v.attributes : {})}::jsonb,
            ${asInt(v.price_amount) as number},
            ${isString(v.currency) ? (v.currency as string) : 'INR'},
            ${typeof v.tax_inclusive === 'boolean' ? v.tax_inclusive : true},
            ${isString(v.gst_slab) ? (v.gst_slab as string) : null},
            ${typeof v.tax_rate === 'number' ? v.tax_rate : null},
            ${isString(v.hsn_code) ? (v.hsn_code as string) : null},
            ${isString(v.availability_status) ? (v.availability_status as string) : 'unknown'},
            ${isString(v.warranty_summary) ? (v.warranty_summary as string) : null},
            ${isString(v.return_policy_summary) ? (v.return_policy_summary as string) : null},
            ${isString(v.source_system) ? (v.source_system as string) : 'manual'}
          )
          RETURNING id, sku, price_amount, currency, tax_inclusive, gst_slab,
                    tax_rate, hsn_code, availability_status, archived_at
        `;
        if (inserted[0]) variantRows.push(inserted[0]);
      }

      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'product.created',
        resourceType: 'product',
        resourceId: productId,
        requestId: request.id,
        metadata: { product_id: body.product_id, variant_count: variantRows.length },
      });
      return { product: productRows[0], variants: variantRows, auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: { ...result.product, variants: result.variants },
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{ Querystring: ProductListQuery }>('/catalog/products', async (request, reply) => {
    const fieldErrors: Record<string, string> = {};
    const merchantId = merchantIdForCatalogRead(request, request.query.merchant_id);
    const limit = request.query.limit === undefined ? 25 : asInt(request.query.limit);
    if (limit === null || limit < 1 || limit > 100) {
      fieldErrors['limit'] = 'must be an integer between 1 and 100';
    }
    const status = request.query.status ?? 'active';
    if (!PRODUCT_STATUSES.has(status)) {
      fieldErrors['status'] = 'must be one of: active, archived, all';
    }
    if (request.query.query !== undefined && typeof request.query.query !== 'string') {
      fieldErrors['query'] = 'must be a string';
    }
    if (request.query.cursor !== undefined && typeof request.query.cursor !== 'string') {
      fieldErrors['cursor'] = 'must be a string';
    }
    if (request.query.category_preset !== undefined
      && !isCommerceCategoryPreset(request.query.category_preset)) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const merchantRows = await getSql()<{ id: string }[]>`
      SELECT id FROM commerce_merchants
       WHERE id = ${merchantId}
         AND tenant_id = ${request.commerceTenantId}
       LIMIT 1
    `;
    if (!merchantRows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const result = await listCatalogProducts(getSql(), {
      tenantId: request.commerceTenantId,
      merchantId,
      query: request.query.query ?? null,
      categoryPreset: request.query.category_preset ?? null,
      status: status as 'active' | 'archived' | 'all',
      limit: limit ?? 25,
      cursor: request.query.cursor ?? null,
    });
    return reply.status(200).send(result);
  });

  app.post<{ Body: ProductBulkBody }>('/catalog/products/bulk', async (request, reply) => {
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }
    const body = (request.body ?? {}) as ProductBulkBody;
    const merchantId = merchantIdForCatalogWrite(request, body.merchant_id);
    const dryRun = body.dry_run === undefined ? true : parseBoolean(body.dry_run);
    if (dryRun === null) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { dry_run: 'must be a boolean' } },
        retryable: false,
      });
    }
    if (!Array.isArray(body.products) || body.products.length === 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { products: 'at least one product row is required' } },
        retryable: false,
      });
    }
    if (body.products.length > 100) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { products: 'must contain at most 100 product rows per request' } },
        retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const merchantRows = await sql<{ id: string }[]>`
      SELECT id FROM commerce_merchants
       WHERE id = ${merchantId}
         AND tenant_id = ${tenantId}
       LIMIT 1
    `;
    if (!merchantRows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const seenProductIds = new Set<string>();
    const seenSkus = new Set<string>();
    const validationRows = body.products.map((row, index) => {
      const validation = validateProductCreateLike(row, index, merchantId);
      if (!validation.ok) {
        return {
          index,
          product_id: validation.productId,
          status: 'invalid',
          field_errors: validation.fields,
        };
      }
      const productId = validation.product.product_id as string;
      const rowErrors: Record<string, string> = {};
      if (seenProductIds.has(productId)) {
        rowErrors['product_id'] = 'duplicate product_id in bulk request';
      }
      seenProductIds.add(productId);
      for (const variant of validation.product.variants as VariantInput[]) {
        const sku = variant.sku as string;
        if (seenSkus.has(sku)) {
          rowErrors[`variants.${sku}`] = 'duplicate SKU in bulk request';
        }
        seenSkus.add(sku);
      }
      if (Object.keys(rowErrors).length > 0) {
        return { index, product_id: productId, status: 'invalid', field_errors: rowErrors };
      }
      return {
        index,
        product_id: productId,
        status: 'valid',
        field_errors: {},
        product: validation.product,
      };
    });
    const invalidRows = validationRows.filter((row) => row.status === 'invalid');
    const publicRows = validationRows.map((row) => ({
      index: row.index,
      product_id: row.product_id,
      status: row.status,
      field_errors: row.field_errors,
    }));
    if (dryRun) {
      return reply.status(200).send({
        dry_run: true,
        summary: {
          total: validationRows.length,
          valid: validationRows.length - invalidRows.length,
          invalid: invalidRows.length,
        },
        rows: publicRows,
      });
    }
    if (invalidRows.length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Bulk product validation failed', {
        details: { rows: publicRows },
        retryable: false,
      });
    }

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const writtenRows: Array<{ index: number; product_id: string; status: string; variant_count: number }> = [];
      for (const row of validationRows) {
        if (row.status !== 'valid' || !('product' in row)) continue;
        const product = row.product;
        const productInternalId = newCommerceProductId();
        const productRows = await tx<Array<{ id: string }>>`
          INSERT INTO commerce_products (
            id, tenant_id, merchant_id, product_id, title, brand, description,
            image_url, category_preset, source_system, manually_maintained
          ) VALUES (
            ${productInternalId}, ${tenantId}, ${merchantId},
            ${product.product_id as string},
            ${product.title as string},
            ${isString(product.brand) ? product.brand as string : null},
            ${isString(product.description) ? product.description as string : null},
            ${isString(product.image_url) ? product.image_url as string : null},
            ${product.category_preset as string},
            ${normalizeSourceSystem(product.source_system, 'api')},
            ${typeof product.manually_maintained === 'boolean' ? product.manually_maintained : false}
          )
          ON CONFLICT (tenant_id, merchant_id, product_id) WHERE archived_at IS NULL
          DO UPDATE SET
            title = EXCLUDED.title,
            brand = EXCLUDED.brand,
            description = EXCLUDED.description,
            image_url = EXCLUDED.image_url,
            category_preset = EXCLUDED.category_preset,
            source_system = EXCLUDED.source_system,
            manually_maintained = EXCLUDED.manually_maintained,
            updated_at = NOW()
          RETURNING id
        `;
        const persistedProductId = productRows[0]?.id;
        if (!persistedProductId) {
          throw new CommerceHttpError(409, 'catalog_bulk_conflict',
            'Bulk product ingest could not create or update a product row');
        }
        let variantCount = 0;
        for (const rawVariant of product.variants as VariantInput[]) {
          const variantId = newCommerceVariantId();
          const inserted = await tx<Array<{ id: string }>>`
            INSERT INTO commerce_product_variants (
              id, tenant_id, merchant_id, product_id, sku, parent_sku, model,
              variant_title, attributes, price_amount, currency, tax_inclusive,
              gst_slab, tax_rate, hsn_code, availability_status,
              warranty_summary, return_policy_summary, source_system
            ) VALUES (
              ${variantId}, ${tenantId}, ${merchantId}, ${persistedProductId},
              ${rawVariant.sku as string},
              ${isString(rawVariant.parent_sku) ? rawVariant.parent_sku as string : null},
              ${isString(rawVariant.model) ? rawVariant.model as string : null},
              ${isString(rawVariant.variant_title) ? rawVariant.variant_title as string : null},
              ${JSON.stringify(isPlainObject(rawVariant.attributes) ? rawVariant.attributes : {})}::jsonb,
              ${asInt(rawVariant.price_amount) as number},
              ${isString(rawVariant.currency) ? rawVariant.currency as string : 'INR'},
              ${typeof rawVariant.tax_inclusive === 'boolean' ? rawVariant.tax_inclusive : true},
              ${isString(rawVariant.gst_slab) ? rawVariant.gst_slab as string : null},
              ${typeof rawVariant.tax_rate === 'number' ? rawVariant.tax_rate : null},
              ${isString(rawVariant.hsn_code) ? rawVariant.hsn_code as string : null},
              ${isString(rawVariant.availability_status) ? rawVariant.availability_status as string : 'unknown'},
              ${isString(rawVariant.warranty_summary) ? rawVariant.warranty_summary as string : null},
              ${isString(rawVariant.return_policy_summary) ? rawVariant.return_policy_summary as string : null},
              ${normalizeSourceSystem(rawVariant.source_system, 'api')}
            )
            ON CONFLICT (tenant_id, merchant_id, sku) WHERE archived_at IS NULL
            DO UPDATE SET
              parent_sku = EXCLUDED.parent_sku,
              model = EXCLUDED.model,
              variant_title = EXCLUDED.variant_title,
              attributes = EXCLUDED.attributes,
              price_amount = EXCLUDED.price_amount,
              currency = EXCLUDED.currency,
              tax_inclusive = EXCLUDED.tax_inclusive,
              gst_slab = EXCLUDED.gst_slab,
              tax_rate = EXCLUDED.tax_rate,
              hsn_code = EXCLUDED.hsn_code,
              availability_status = EXCLUDED.availability_status,
              warranty_summary = EXCLUDED.warranty_summary,
              return_policy_summary = EXCLUDED.return_policy_summary,
              source_system = EXCLUDED.source_system,
              last_synced_at = NOW(),
              updated_at = NOW()
            WHERE commerce_product_variants.product_id = ${persistedProductId}
            RETURNING id
          `;
          if (!inserted[0]) {
            throw new CommerceHttpError(409, 'catalog_bulk_conflict',
              'Bulk product ingest found an active SKU assigned to another product',
              { details: { row_index: row.index, sku: rawVariant.sku }, retryable: false });
          }
          variantCount += 1;
        }
        writtenRows.push({
          index: row.index,
          product_id: product.product_id as string,
          status: 'upserted',
          variant_count: variantCount,
        });
      }
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'catalog.bulk_ingested',
        resourceType: 'catalog',
        resourceId: merchantId,
        requestId: request.id,
        metadata: {
          product_count: writtenRows.length,
          row_indexes: writtenRows.map((row) => row.index),
          variant_count: writtenRows.reduce((sum, row) => sum + row.variant_count, 0),
        },
      });
      return { rows: writtenRows, auditEventId: audit.id };
    });

    return reply.status(200).send({
      dry_run: false,
      summary: {
        total: result.rows.length,
        upserted: result.rows.length,
      },
      rows: result.rows,
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{
    Params: { productId: string };
    Querystring: { merchant_id?: string };
  }>('/catalog/products/:productId', async (request, reply) => {
    // GET /catalog/products/:productId supports scoped catalog item reads for
    // merchant, agent, or operator when scoped by tenant/merchant.
    //
    // Tenant and merchant filters are applied before item data is returned.
    const caller = request.commerceCaller;
    if (caller.kind === 'service') {
      throw new CommerceHttpError(403, 'caller_not_authorized',
        'Catalog reads require operator, merchant, or CommerceAgent caller');
    }

    let merchantId: string | null = null;
    if (caller.kind === 'merchant') {
      if (request.query.merchant_id !== undefined && request.query.merchant_id !== caller.merchantId) {
        throw new CommerceHttpError(403, 'merchant_scope_violation',
          'Merchant callers may only read their own catalog');
      }
      merchantId = caller.merchantId;
    } else if (caller.kind === 'agent') {
      if (!isString(request.query.merchant_id)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: { merchant_id: 'required string' } }, retryable: false });
      }
      merchantId = request.query.merchant_id;
    } else if (isString(request.query.merchant_id)) {
      merchantId = request.query.merchant_id;
    }

    const item = await readCatalogItem(getSql(), {
      tenantId: request.commerceTenantId,
      merchantId,
      productRef: request.params.productId,
    });
    if (!item) {
      throw new CommerceHttpError(404, 'product_not_found', 'Product not found in this tenant');
    }
    return reply.status(200).send({ data: item });
  });

  app.patch<{
    Params: { productId: string };
    Querystring: { merchant_id?: string };
    Body: ProductPatchBody;
  }>('/catalog/products/:productId', async (request, reply) => {
    const merchantId = merchantIdForCatalogWrite(request, request.query.merchant_id);
    if (request.body !== undefined && !isPlainObject(request.body)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { body: 'must be a JSON object' } },
        retryable: false,
      });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    const changedFields = validatePatchKeys(body, PRODUCT_PATCH_FIELDS, fieldErrors);
    if (changedFields.length === 0 && Object.keys(fieldErrors).length === 0) {
      fieldErrors['body'] = 'at least one mutable field is required';
    }
    if (body['title'] !== undefined && !isString(body['title'])) {
      fieldErrors['title'] = 'must be a non-empty string';
    }
    for (const key of ['brand', 'description', 'image_url', 'source_system']) {
      if (body[key] !== undefined && !isNullableString(body[key])) {
        fieldErrors[key] = 'must be a non-empty string or null';
      }
    }
    if (body['category_preset'] !== undefined && !isCommerceCategoryPreset(body['category_preset'])) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (body['status'] !== undefined
      && (typeof body['status'] !== 'string' || !new Set(['active', 'archived']).has(body['status']))) {
      fieldErrors['status'] = 'must be one of: active, archived';
    }
    if (body['manually_maintained'] !== undefined && typeof body['manually_maintained'] !== 'boolean') {
      fieldErrors['manually_maintained'] = 'must be a boolean';
    }

    const variants = body['variants'];
    const variantChangedFields = new Set<string>();
    if (variants !== undefined) {
      if (!Array.isArray(variants) || variants.length === 0) {
        fieldErrors['variants'] = 'must be a non-empty array';
      } else {
        const currencies = new Set<string>();
        variants.forEach((raw, index) => {
          if (!isPlainObject(raw)) {
            fieldErrors[`variants[${index}]`] = 'must be an object';
            return;
          }
          const variant = raw as Record<string, unknown>;
          const variantKeys = Object.keys(variant);
          for (const key of variantKeys) {
            if (!VARIANT_PATCH_FIELDS.has(key)) {
              fieldErrors[`variants[${index}].${key}`] = 'field is immutable or unsupported';
            }
          }
          const allowedFields = variantKeys.filter((key) => VARIANT_PATCH_FIELDS.has(key));
          const variantRef = isString(variant['variant_id']) ? variant['variant_id']
            : isString(variant['id']) ? variant['id']
              : null;
          if (!variantRef) {
            fieldErrors[`variants[${index}].variant_id`] = 'variant_id or id is required';
          }
          const mutableFields = allowedFields.filter((key) => key !== 'id' && key !== 'variant_id');
          if (mutableFields.length === 0) {
            fieldErrors[`variants[${index}]`] = 'at least one mutable variant field is required';
          }
          for (const key of mutableFields) variantChangedFields.add(`variants.${key}`);
          if (variant['sku'] !== undefined && !isString(variant['sku'])) {
            fieldErrors[`variants[${index}].sku`] = 'must be a non-empty string';
          }
          for (const key of ['parent_sku', 'model', 'variant_title', 'gst_slab', 'hsn_code',
            'warranty_summary', 'return_policy_summary', 'source_system']) {
            if (variant[key] !== undefined && !isNullableString(variant[key])) {
              fieldErrors[`variants[${index}].${key}`] = 'must be a non-empty string or null';
            }
          }
          if (variant['attributes'] !== undefined && !isPlainObject(variant['attributes'])) {
            fieldErrors[`variants[${index}].attributes`] = 'must be an object';
          }
          if (variant['price_amount'] !== undefined
            && (asInt(variant['price_amount']) === null || (asInt(variant['price_amount']) as number) < 0)) {
            fieldErrors[`variants[${index}].price_amount`] = 'must be a non-negative integer (minor units)';
          }
          if (variant['currency'] !== undefined) {
            if (!isValidCurrency(variant['currency'])) {
              fieldErrors[`variants[${index}].currency`] = 'must be an ISO 4217 uppercase currency code';
            } else {
              currencies.add(variant['currency']);
            }
          }
          if (variant['tax_inclusive'] !== undefined && typeof variant['tax_inclusive'] !== 'boolean') {
            fieldErrors[`variants[${index}].tax_inclusive`] = 'must be a boolean';
          }
          if (variant['tax_rate'] !== undefined && variant['tax_rate'] !== null
            && (typeof variant['tax_rate'] !== 'number' || !Number.isFinite(variant['tax_rate']))) {
            fieldErrors[`variants[${index}].tax_rate`] = 'must be a finite number or null';
          }
          if (variant['availability_status'] !== undefined
            && (typeof variant['availability_status'] !== 'string' || !AVAILABILITY.has(variant['availability_status']))) {
            fieldErrors[`variants[${index}].availability_status`] =
              'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
          }
          if (variant['last_synced_at'] !== undefined && !isValidIsoDate(variant['last_synced_at'])) {
            fieldErrors[`variants[${index}].last_synced_at`] = 'must be an ISO date-time string';
          }
        });
        if (currencies.size > 1) {
          fieldErrors['variants.currency'] = 'all currency changes in one patch must use one currency';
        }
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors },
        retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const productRef = request.params.productId;
    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const hasBrand = Object.prototype.hasOwnProperty.call(body, 'brand');
    const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
    const hasImageUrl = Object.prototype.hasOwnProperty.call(body, 'image_url');
    const hasCategoryPreset = Object.prototype.hasOwnProperty.call(body, 'category_preset');
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    const hasSourceSystem = Object.prototype.hasOwnProperty.call(body, 'source_system');
    const hasManuallyMaintained = Object.prototype.hasOwnProperty.call(body, 'manually_maintained');
    const patchTitle = hasTitle ? body['title'] as string : null;
    const patchBrand = hasBrand ? body['brand'] as string | null : null;
    const patchDescription = hasDescription ? body['description'] as string | null : null;
    const patchImageUrl = hasImageUrl ? body['image_url'] as string | null : null;
    const patchCategoryPreset = hasCategoryPreset ? body['category_preset'] as string : null;
    const patchStatus = hasStatus ? body['status'] as string : null;
    const patchSourceSystem = hasSourceSystem ? body['source_system'] as string | null : null;
    const patchManuallyMaintained = hasManuallyMaintained ? body['manually_maintained'] as boolean : null;

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const productRows = await tx<Array<{ id: string; merchant_id: string }>>`
        SELECT id, merchant_id
          FROM commerce_products
         WHERE tenant_id = ${tenantId}
           AND merchant_id = ${merchantId}
           AND (id = ${productRef} OR product_id = ${productRef})
         LIMIT 1
      `;
      const product = productRows[0];
      if (!product) return null;

      await tx`
        UPDATE commerce_products
           SET title = CASE WHEN ${hasTitle}::boolean THEN ${patchTitle}::text ELSE title END,
               brand = CASE WHEN ${hasBrand}::boolean THEN ${patchBrand}::text ELSE brand END,
               description = CASE WHEN ${hasDescription}::boolean THEN ${patchDescription}::text ELSE description END,
               image_url = CASE WHEN ${hasImageUrl}::boolean THEN ${patchImageUrl}::text ELSE image_url END,
               category_preset = CASE WHEN ${hasCategoryPreset}::boolean THEN ${patchCategoryPreset}::text ELSE category_preset END,
               source_system = CASE WHEN ${hasSourceSystem}::boolean THEN ${patchSourceSystem}::text ELSE source_system END,
               manually_maintained = CASE WHEN ${hasManuallyMaintained}::boolean THEN ${patchManuallyMaintained}::boolean ELSE manually_maintained END,
               archived_at = CASE
                 WHEN ${hasStatus}::boolean AND ${patchStatus}::text = 'archived' THEN NOW()
                 WHEN ${hasStatus}::boolean AND ${patchStatus}::text = 'active' THEN NULL::timestamptz
                 ELSE archived_at
               END,
               updated_at = NOW()
         WHERE id = ${product.id}
           AND tenant_id = ${tenantId}
           AND merchant_id = ${merchantId}
      `;

      if (Array.isArray(variants)) {
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index] as Record<string, unknown>;
          const variantRef = isString(variant['variant_id']) ? variant['variant_id'] as string : variant['id'] as string;
          const belongs = await tx<Array<{ id: string }>>`
            SELECT id
              FROM commerce_product_variants
             WHERE tenant_id = ${tenantId}
               AND merchant_id = ${merchantId}
               AND product_id = ${product.id}
               AND id = ${variantRef}
             LIMIT 1
          `;
          if (!belongs[0]) {
            throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
              details: { fields: { [`variants[${index}].variant_id`]: 'variant must belong to this product' } },
              retryable: false,
            });
          }
          const hasSku = Object.prototype.hasOwnProperty.call(variant, 'sku');
          const hasParentSku = Object.prototype.hasOwnProperty.call(variant, 'parent_sku');
          const hasModel = Object.prototype.hasOwnProperty.call(variant, 'model');
          const hasVariantTitle = Object.prototype.hasOwnProperty.call(variant, 'variant_title');
          const hasAttributes = Object.prototype.hasOwnProperty.call(variant, 'attributes');
          const hasPrice = Object.prototype.hasOwnProperty.call(variant, 'price_amount');
          const hasCurrency = Object.prototype.hasOwnProperty.call(variant, 'currency');
          const hasTaxInclusive = Object.prototype.hasOwnProperty.call(variant, 'tax_inclusive');
          const hasGstSlab = Object.prototype.hasOwnProperty.call(variant, 'gst_slab');
          const hasTaxRate = Object.prototype.hasOwnProperty.call(variant, 'tax_rate');
          const hasHsnCode = Object.prototype.hasOwnProperty.call(variant, 'hsn_code');
          const hasAvailability = Object.prototype.hasOwnProperty.call(variant, 'availability_status');
          const hasWarranty = Object.prototype.hasOwnProperty.call(variant, 'warranty_summary');
          const hasReturnPolicy = Object.prototype.hasOwnProperty.call(variant, 'return_policy_summary');
          const hasVariantSource = Object.prototype.hasOwnProperty.call(variant, 'source_system');
          const hasLastSynced = Object.prototype.hasOwnProperty.call(variant, 'last_synced_at');
          await tx`
            UPDATE commerce_product_variants
               SET sku = CASE WHEN ${hasSku}::boolean THEN ${hasSku ? variant['sku'] as string : null}::text ELSE sku END,
                   parent_sku = CASE WHEN ${hasParentSku}::boolean THEN ${hasParentSku ? variant['parent_sku'] as string | null : null}::text ELSE parent_sku END,
                   model = CASE WHEN ${hasModel}::boolean THEN ${hasModel ? variant['model'] as string | null : null}::text ELSE model END,
                   variant_title = CASE WHEN ${hasVariantTitle}::boolean THEN ${hasVariantTitle ? variant['variant_title'] as string | null : null}::text ELSE variant_title END,
                   attributes = CASE WHEN ${hasAttributes}::boolean THEN ${JSON.stringify(hasAttributes ? variant['attributes'] : {})}::jsonb ELSE attributes END,
                   price_amount = CASE WHEN ${hasPrice}::boolean THEN ${hasPrice ? asInt(variant['price_amount']) : null}::bigint ELSE price_amount END,
                   currency = CASE WHEN ${hasCurrency}::boolean THEN ${hasCurrency ? variant['currency'] as string : null}::text ELSE currency END,
                   tax_inclusive = CASE WHEN ${hasTaxInclusive}::boolean THEN ${hasTaxInclusive ? variant['tax_inclusive'] as boolean : null}::boolean ELSE tax_inclusive END,
                   gst_slab = CASE WHEN ${hasGstSlab}::boolean THEN ${hasGstSlab ? variant['gst_slab'] as string | null : null}::text ELSE gst_slab END,
                   tax_rate = CASE WHEN ${hasTaxRate}::boolean THEN ${hasTaxRate ? variant['tax_rate'] as number | null : null}::numeric ELSE tax_rate END,
                   hsn_code = CASE WHEN ${hasHsnCode}::boolean THEN ${hasHsnCode ? variant['hsn_code'] as string | null : null}::text ELSE hsn_code END,
                   availability_status = CASE WHEN ${hasAvailability}::boolean THEN ${hasAvailability ? variant['availability_status'] as string : null}::text ELSE availability_status END,
                   warranty_summary = CASE WHEN ${hasWarranty}::boolean THEN ${hasWarranty ? variant['warranty_summary'] as string | null : null}::text ELSE warranty_summary END,
                   return_policy_summary = CASE WHEN ${hasReturnPolicy}::boolean THEN ${hasReturnPolicy ? variant['return_policy_summary'] as string | null : null}::text ELSE return_policy_summary END,
                   source_system = CASE WHEN ${hasVariantSource}::boolean THEN ${hasVariantSource ? variant['source_system'] as string | null : null}::text ELSE source_system END,
                   last_synced_at = CASE WHEN ${hasLastSynced}::boolean THEN ${hasLastSynced ? variant['last_synced_at'] as string : null}::timestamptz ELSE last_synced_at END,
                   updated_at = NOW()
             WHERE id = ${variantRef}
               AND tenant_id = ${tenantId}
               AND merchant_id = ${merchantId}
               AND product_id = ${product.id}
          `;
        }
      }

      const item = await readCatalogItem(tx as unknown as Sql, {
        tenantId,
        merchantId,
        productRef: product.id,
        includeArchived: true,
      });
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'product.updated',
        resourceType: 'product',
        resourceId: product.id,
        requestId: request.id,
        metadata: {
          changed_fields: [
            ...changedFields.filter((field) => field !== 'variants'),
            ...Array.from(variantChangedFields),
          ],
        },
      });
      return { item, auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'product_not_found', 'Product not found in this tenant');
    }
    return reply.status(200).send({ data: result.item, audit_event_id: result.auditEventId });
  });

  app.post<{ Body: CatalogSearchBody }>(
    '/catalog/search',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    const merchantId = merchantIdForCatalogRead(request, body.merchant_id);
    const filters = parseCatalogFilters(body.filters, fieldErrors);

    if (body.query !== undefined && body.query !== null && typeof body.query !== 'string') {
      fieldErrors['query'] = 'must be a string';
    }
    if (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== 'string') {
      fieldErrors['cursor'] = 'must be a string';
    }
    const limit = body.limit === undefined ? 25 : asInt(body.limit);
    if (limit === null || limit < 1 || limit > 100) {
      fieldErrors['limit'] = 'must be an integer between 1 and 100';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const result = await searchCatalog(getSql(), {
      tenantId: request.commerceTenantId,
      merchantId,
      query: typeof body.query === 'string' ? body.query : null,
      filters,
      limit: limit ?? 25,
      cursor: typeof body.cursor === 'string' ? body.cursor : null,
    });
    return reply.status(200).send(result);
    },
  );

  app.delete<{ Params: { productId: string } }>('/catalog/products/:productId', async (request, reply) => {
    requireOperator(request);
    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const updated = await tx<Record<string, unknown>[]>`
        UPDATE commerce_products
           SET archived_at = NOW(), updated_at = NOW()
         WHERE id = ${request.params.productId}
           AND tenant_id = ${tenantId}
           AND archived_at IS NULL
         RETURNING id, merchant_id, archived_at
      `;
      if (!updated[0]) return null;
      await tx`
        UPDATE commerce_product_variants
           SET archived_at = NOW(), updated_at = NOW()
         WHERE product_id = ${request.params.productId}
           AND tenant_id = ${tenantId}
           AND archived_at IS NULL
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId: updated[0]['merchant_id'] as string,
        eventType: 'product.archived',
        resourceType: 'product',
        resourceId: request.params.productId,
        requestId: request.id,
      });
      return { product: updated[0], auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'product_not_found',
        'Product not found in this tenant or already archived');
    }
    return reply.status(200).send({
      data: result.product,
      audit_event_id: result.auditEventId,
    });
  });

  app.get<{
    Querystring: {
      merchant_id?: string;
      agent_id?: string;
      event_type?: string;
      passport_jti?: string;
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/audit/events', async (request, reply) => {
    // GET /audit/events — operator only in M2. Merchant + agent audit
    // surfaces (scoped reads) land in M5/M6 once the SDK and dashboard
    // need them.
    requireOperator(request);
    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const limit = Math.min(Math.max(asInt(request.query.limit) ?? 25, 1), 100);
    let cursorOccurred: string | null = null;
    let cursorId: string | null = null;
    if (request.query.cursor) {
      try {
        const decoded = Buffer.from(request.query.cursor, 'base64url').toString('utf8');
        const [occ, id] = decoded.split('|');
        if (occ && id) { cursorOccurred = occ; cursorId = id; }
      } catch { /* ignore malformed cursor */ }
    }
    const merchantId = isString(request.query.merchant_id) ? request.query.merchant_id : null;
    const agentId = isString(request.query.agent_id) ? request.query.agent_id : null;
    const eventType = isString(request.query.event_type) ? request.query.event_type : null;
    const passportJti = isString(request.query.passport_jti) ? request.query.passport_jti : null;
    const fromTs = isString(request.query.from) ? request.query.from : null;
    const toTs = isString(request.query.to) ? request.query.to : null;

    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, merchant_id, agent_id, user_principal_id,
             event_type, resource_type, resource_id, passport_jti,
             policy_version, decision_id, idempotency_key_hash, request_id,
             occurred_at, metadata
        FROM commerce_audit_events
       WHERE tenant_id = ${tenantId}
         AND (${merchantId}::text IS NULL OR merchant_id = ${merchantId})
         AND (${agentId}::text IS NULL OR agent_id = ${agentId})
         AND (${eventType}::text IS NULL OR event_type = ${eventType})
         AND (${passportJti}::text IS NULL OR passport_jti = ${passportJti})
         AND (${fromTs}::timestamptz IS NULL OR occurred_at >= ${fromTs}::timestamptz)
         AND (${toTs}::timestamptz IS NULL OR occurred_at <= ${toTs}::timestamptz)
         AND (
           ${cursorOccurred}::timestamptz IS NULL
           OR (occurred_at, id) < (${cursorOccurred}::timestamptz, ${cursorId}::text)
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      if (last) {
        const occVal = last['occurred_at'];
        const occIso = occVal instanceof Date ? occVal.toISOString() : String(occVal);
        const enc = `${occIso}|${last['id'] as string}`;
        nextCursor = Buffer.from(enc, 'utf8').toString('base64url');
      }
      rows.length = limit;
    }
    return reply.status(200).send({ items: rows, next_cursor: nextCursor });
  });

  // M2 sub-route plugins. They inherit the onRoute hook and the commerce
  // preHandler from this scope (Fastify scope inheritance), so all their
  // routes also bypass authPlugin and go through the commerce caller
  // resolver.
  await app.register(commerceTenantsRoutes);
  await app.register(commercePassportRoutes);
  await app.register(commerceConsentRoutes);
  await app.register(commercePolicyRoutes);
  await app.register(commerceProviderCredentialRoutes);
  await app.register(commerceWebhookSourceRoutes);
  await app.register(commerceCartPaymentRoutes);
  await app.register(commerceOpsRoutes);
}
