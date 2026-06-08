import { isCommerceCategoryPreset, type CommerceCategoryPreset } from './presets.js';

export type ConnectorDryRunType = 'manual' | 'csv';
export type ConnectorDryRunStatus = 'passed' | 'blocked';

export interface ConnectorDryRunBody {
  connector_type?: unknown;
  source_label?: unknown;
  rows?: unknown;
  source_snapshot_at?: unknown;
  stale_after_seconds?: unknown;
  preview_limit?: unknown;
}

export interface NormalizedConnectorPreviewVariant {
  sku: string;
  variant_title: string | null;
  price_amount: number;
  currency: string;
  availability_status: string;
  warranty_summary: string | null;
  return_policy_summary: string | null;
}

export interface NormalizedConnectorPreviewProduct {
  source_product_ref: string;
  title: string;
  brand: string | null;
  description: string | null;
  image_url: string | null;
  category_preset: CommerceCategoryPreset;
  variants: NormalizedConnectorPreviewVariant[];
}

export interface ConnectorDryRunBlocker {
  code: string;
  message: string;
  row_index?: number;
  field?: string;
  remediation: string;
}

export interface ConnectorDryRunWarning {
  code: string;
  message: string;
  row_index?: number;
  field?: string;
}

export interface ConnectorDryRunPrepared {
  connector_type: ConnectorDryRunType;
  source_label: string;
  rows_received: number;
  products_detected: number;
  variants_detected: number;
  blocked_count: number;
  warning_count: number;
  normalized_products: NormalizedConnectorPreviewProduct[];
  normalized_preview: NormalizedConnectorPreviewProduct[];
  blockers: ConnectorDryRunBlocker[];
  warnings: ConnectorDryRunWarning[];
}

export interface ConnectorDryRunFinalizeInput extends ConnectorDryRunPrepared {
  dryRunId: string;
  tenantId: string;
  merchantId: string;
  existingProductIds: Set<string>;
  generatedAt: Date;
}

export interface ConnectorDryRunResult {
  dry_run_id: string;
  tenant_id: string;
  merchant_id: string;
  connector_type: ConnectorDryRunType;
  source_label: string;
  status: ConnectorDryRunStatus;
  sandbox_only: true;
  not_live: true;
  not_approved: true;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  provider_specific_live_enabled: false;
  rows_received: number;
  products_detected: number;
  variants_detected: number;
  would_create_count: number;
  would_update_count: number;
  would_archive_count: number;
  blocked_count: number;
  warning_count: number;
  normalized_preview: NormalizedConnectorPreviewProduct[];
  blockers: ConnectorDryRunBlocker[];
  warnings: ConnectorDryRunWarning[];
  generated_at: string;
}

const SUPPORTED_CONNECTOR_TYPES = new Set(['manual', 'csv']);
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .:_-]{2,120}$/;
const SAFE_SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
const PRODUCT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,96}$/;
const SOURCE_CATEGORY_MAP: Record<string, CommerceCategoryPreset> = {
  electronics: 'electronics_appliances',
  appliance: 'electronics_appliances',
  appliances: 'electronics_appliances',
  furniture: 'electronics_appliances',
  'home-decoration': 'electronics_appliances',
  lighting: 'electronics_appliances',
};
const ALLOWED_IMAGE_HOSTS = new Set([
  'cdn.dummyjson.com',
  'example.com',
  'example.test',
  'localhost',
]);
const REQUEST_FIELDS = new Set([
  'connector_type',
  'source_label',
  'rows',
  'source_snapshot_at',
  'stale_after_seconds',
  'preview_limit',
]);
const CREDENTIAL_FIELD_RE =
  /(^|_)(secret|token|jwt|api_key|apikey|password|credential|credentials|private_key|client_secret|access_token|refresh_token|authorization|bearer|raw_payload|provider_metadata)(_|$)/i;
const PRIVATE_FIELD_RE =
  /(^|_)(legal_name|address|phone|email|tax_id|gst|pan|customer|private_note|private_url|merchant_private_api|provider_payload)(_|$)/i;
const EXECUTION_FIELD_RE =
  /(^|_)(public_discovery_enabled|agenticorg_public_discovery_enabled|checkout_payment_enabled|payment_enabled|live_provider_enabled|live_payment_enabled|provider_call_enabled|merchant_private_api_call_enabled|agenticorg_direct_execution_enabled|outbound_sync_enabled|production_allowlist_written|production_config_written)(_|$)/i;
const PRIVATE_VALUE_RE =
  /-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres:\/\/|postgresql:\/\/|redis:\/\/|sk_live_|pk_live_|whsec_|gho_|bearer\s+|api[_-]?key\s*=|secret\s*=|password\s*=|client_secret\s*=|access_token\s*=|refresh_token\s*=/i;
const PRODUCTION_VALUE_RE =
  /\b(COMMERCE_PUBLIC_DISCOVERY_ENABLED|COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST|production_allowlist|prod_allowlist|live_provider|live_payment|checkout_url)\b/i;
const PRODUCTION_ID_RE = /\bmch_(?!sandbox_|C6|TEST)[A-Za-z0-9]{10,}\b/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asSafeString(value: unknown): string | null {
  return isString(value) ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null || Math.trunc(parsed) !== parsed) return null;
  return parsed;
}

function addBlocker(
  blockers: ConnectorDryRunBlocker[],
  code: string,
  message: string,
  remediation: string,
  row_index?: number,
  field?: string,
): void {
  blockers.push({
    code,
    message,
    remediation,
    ...(row_index !== undefined ? { row_index } : {}),
    ...(field !== undefined ? { field } : {}),
  });
}

function addWarning(
  warnings: ConnectorDryRunWarning[],
  code: string,
  message: string,
  row_index?: number,
  field?: string,
): void {
  warnings.push({
    code,
    message,
    ...(row_index !== undefined ? { row_index } : {}),
    ...(field !== undefined ? { field } : {}),
  });
}

function recursiveScan(value: unknown, visit: (key: string | null, value: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => recursiveScan(item, visit, String(index)));
    return;
  }
  if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      recursiveScan(childValue, visit, childKey);
    }
  }
}

function containsPrivateValue(value: unknown): boolean {
  let found = false;
  recursiveScan(value, (_key, scanned) => {
    if (typeof scanned !== 'string') return;
    if (PRIVATE_VALUE_RE.test(scanned) || PRODUCTION_VALUE_RE.test(scanned) || PRODUCTION_ID_RE.test(scanned)) {
      found = true;
    }
  });
  return found;
}

function hasEnabledExecutionField(value: unknown): boolean {
  let found = false;
  recursiveScan(value, (key, scanned) => {
    if (!key || !EXECUTION_FIELD_RE.test(key)) return;
    if (scanned === true || scanned === 'true' || scanned === 1 || scanned === '1') found = true;
  });
  return found;
}

function hasForbiddenKey(value: unknown): string | null {
  let found: string | null = null;
  recursiveScan(value, (key) => {
    if (!key || found) return;
    if (CREDENTIAL_FIELD_RE.test(key) || PRIVATE_FIELD_RE.test(key)) found = key;
  });
  return found;
}

function hasPrivateExecutionUrl(value: unknown): boolean {
  let found = false;
  recursiveScan(value, (key, scanned) => {
    if (!key || typeof scanned !== 'string') return;
    const lower = key.toLowerCase();
    if ((lower.includes('url') || lower.includes('endpoint')) && lower !== 'image_url' && lower !== 'thumbnail') {
      if (/^https?:\/\//i.test(scanned)) found = true;
    }
  });
  return found;
}

function safeImageUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (ALLOWED_IMAGE_HOSTS.has(url.hostname)) return true;
    return url.hostname.endsWith('.example') || url.hostname.endsWith('.test');
  } catch {
    return false;
  }
}

function parseDate(value: unknown): Date | null {
  if (!isString(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isStale(value: unknown, now: Date, staleAfterSeconds: number): boolean {
  const date = parseDate(value);
  if (!date) return false;
  return now.getTime() - date.getTime() > staleAfterSeconds * 1000;
}

function rowField(row: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

function normalizeCategory(rawPreset: unknown, rawCategory: unknown): CommerceCategoryPreset | null {
  if (isCommerceCategoryPreset(rawPreset)) return rawPreset;
  if (isString(rawCategory)) {
    const mapped = SOURCE_CATEGORY_MAP[rawCategory.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function normalizeAvailability(value: unknown): string {
  if (!isString(value)) return 'unknown';
  const normalized = value.trim();
  return AVAILABILITY.has(normalized) ? normalized : normalized;
}

function normalizePrice(row: Record<string, unknown>): number | null {
  const amount = asInteger(rowField(row, ['price_amount', 'price_minor_units']));
  if (amount !== null && amount >= 0) return amount;
  const price = asNumber(rowField(row, ['price']));
  if (price !== null && price >= 0) return Math.round(price * 100);
  return null;
}

function validateRequestShape(
  body: ConnectorDryRunBody,
  blockers: ConnectorDryRunBlocker[],
): { connectorType: ConnectorDryRunType | null; sourceLabel: string; previewLimit: number; staleAfterSeconds: number } {
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!REQUEST_FIELDS.has(key)) {
      addBlocker(
        blockers,
        'unsupported_request_field',
        `Unsupported or private request field: ${key.replace(/[\r\n\t]/g, '_')}`,
        'Remove unsupported fields and submit only connector_type, source_label, rows, source_snapshot_at, stale_after_seconds, or preview_limit.',
        undefined,
        key,
      );
    }
  }

  const connectorType = SUPPORTED_CONNECTOR_TYPES.has(body.connector_type as string)
    ? body.connector_type as ConnectorDryRunType
    : null;
  if (!connectorType) {
    addBlocker(
      blockers,
      'unsupported_connector_type',
      'Only manual and csv connector dry-runs are supported in C6R.',
      'Use connector_type manual or csv. External connectors remain metadata-only until a later approval.',
      undefined,
      'connector_type',
    );
  }

  const sourceLabel = asSafeString(body.source_label) ?? 'manual_catalog_snapshot';
  if (!SAFE_LABEL_RE.test(sourceLabel)) {
    addBlocker(
      blockers,
      'unsafe_source_label',
      'source_label must be a short public-safe label.',
      'Use a synthetic label such as c6q_dummyjson_fixture or manual_catalog_snapshot.',
      undefined,
      'source_label',
    );
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    addBlocker(
      blockers,
      'rows_missing',
      'At least one local manual or CSV-style row is required.',
      'Provide local test rows; do not provide credentials, private URLs, or raw merchant-system payloads.',
      undefined,
      'rows',
    );
  } else if (body.rows.length > 100) {
    addBlocker(
      blockers,
      'rows_limit_exceeded',
      'A dry-run request may include at most 100 rows.',
      'Split large local snapshots into smaller dry-runs.',
      undefined,
      'rows',
    );
  }

  const previewLimit = asInteger(body.preview_limit) ?? 3;
  const cappedPreviewLimit = Math.min(Math.max(previewLimit, 1), 10);
  const staleAfterSeconds = asInteger(body.stale_after_seconds) ?? 14 * 24 * 60 * 60;
  if (staleAfterSeconds < 0 || staleAfterSeconds > 31_536_000) {
    addBlocker(
      blockers,
      'invalid_stale_after_seconds',
      'stale_after_seconds must be between 0 and 31536000.',
      'Use a bounded stale threshold for local dry-run evidence.',
      undefined,
      'stale_after_seconds',
    );
  }

  return { connectorType, sourceLabel, previewLimit: cappedPreviewLimit, staleAfterSeconds };
}

function normalizeRow(
  row: Record<string, unknown>,
  index: number,
  body: ConnectorDryRunBody,
  now: Date,
  staleAfterSeconds: number,
): {
  product: NormalizedConnectorPreviewProduct | null;
  blockers: ConnectorDryRunBlocker[];
  warnings: ConnectorDryRunWarning[];
} {
  const blockers: ConnectorDryRunBlocker[] = [];
  const warnings: ConnectorDryRunWarning[] = [];
  const title = asSafeString(rowField(row, ['title', 'product_title', 'name']));
  const description = asSafeString(rowField(row, ['description', 'product_description']));
  const brand = asSafeString(rowField(row, ['brand']));
  const imageUrl = asSafeString(rowField(row, ['image_url', 'thumbnail', 'image']));
  const categoryPreset = normalizeCategory(rowField(row, ['category_preset']), rowField(row, ['category']));
  const productRef = asSafeString(rowField(row, ['product_id', 'id', 'source_product_ref'])) ?? `row_${index + 1}`;
  const sku = asSafeString(rowField(row, ['sku', 'variant_sku']));
  const variantTitle = asSafeString(rowField(row, ['variant_title', 'model', 'category']));
  const priceAmount = normalizePrice(row);
  const currency = asSafeString(rowField(row, ['currency']));
  const availability = normalizeAvailability(rowField(row, ['availability_status', 'availabilityStatus']));
  const warranty = asSafeString(rowField(row, ['warranty_summary', 'warrantyInformation']));
  const returnPolicy = asSafeString(rowField(row, ['return_policy_summary', 'returnPolicy']));
  const sourceUpdatedAt = rowField(row, ['source_updated_at', 'last_synced_at', 'updated_at']);
  const snapshotAt = body.source_snapshot_at ?? sourceUpdatedAt;

  const forbiddenKey = hasForbiddenKey(row);
  if (forbiddenKey) {
    addBlocker(
      blockers,
      'private_field_rejected',
      `Row contains private or credential-like field: ${forbiddenKey.replace(/[\r\n\t]/g, '_')}`,
      'Remove credentials, private merchant artifacts, provider metadata, and raw payload fields before dry-run.',
      index,
      forbiddenKey,
    );
  }
  if (containsPrivateValue(row)) {
    addBlocker(
      blockers,
      'private_or_production_value_rejected',
      'Row contains secret, private, production config, allowlist, live, or production-looking values.',
      'Use only synthetic sandbox catalog data and public-safe values.',
      index,
    );
  }
  if (hasEnabledExecutionField(row)) {
    addBlocker(
      blockers,
      'enablement_field_rejected',
      'Row attempts to enable public discovery, checkout/payment, live provider, provider calls, outbound sync, or production config.',
      'Remove enablement fields; C6R is dry-run-only.',
      index,
    );
  }
  if (hasPrivateExecutionUrl(row)) {
    addBlocker(
      blockers,
      'merchant_private_api_url_rejected',
      'Row contains an execution URL or endpoint field.',
      'Use local fixture rows only; do not include merchant private API URLs.',
      index,
    );
  }
  if (!title) {
    addBlocker(blockers, 'missing_title', 'Product title is required.', 'Add a public-safe product title.', index, 'title');
  }
  if (!categoryPreset) {
    addBlocker(
      blockers,
      'unsupported_category_preset',
      'Row does not map to the currently supported runtime category preset.',
      'Use electronics_appliances or a documented C6Q fake category mapping.',
      index,
      'category_preset',
    );
  } else if (!isCommerceCategoryPreset(rowField(row, ['category_preset']))) {
    addWarning(
      warnings,
      'category_mapped_for_sandbox',
      'Source category was mapped into the current sandbox runtime category preset.',
      index,
      'category',
    );
  }
  if (!sku || !SAFE_SKU_RE.test(sku)) {
    addBlocker(
      blockers,
      'invalid_sku',
      'A stable public-safe SKU is required for variant identity.',
      'Use a synthetic SKU with letters, numbers, dashes, underscores, or periods.',
      index,
      'sku',
    );
  }
  if (!PRODUCT_REF_RE.test(productRef)) {
    addBlocker(
      blockers,
      'invalid_product_ref',
      'Source product reference must be short and public-safe.',
      'Use a synthetic product_id or allow Grantex to use the row number.',
      index,
      'product_id',
    );
  }
  if (priceAmount === null) {
    addBlocker(blockers, 'missing_price', 'Price is required for dry-run mapping.', 'Provide price or price_amount.', index, 'price');
  }
  if (!currency || !ISO_CURRENCY_RE.test(currency)) {
    addBlocker(
      blockers,
      'invalid_currency',
      'Currency must be an ISO 4217 uppercase currency code.',
      'Provide a three-letter currency such as USD or INR.',
      index,
      'currency',
    );
  }
  if (!AVAILABILITY.has(availability)) {
    addBlocker(
      blockers,
      'invalid_availability',
      'Availability must be one of the supported availability buckets.',
      'Use in_stock, out_of_stock, pre_order, back_order, or unknown.',
      index,
      'availability_status',
    );
  }
  if (!safeImageUrl(imageUrl)) {
    addBlocker(
      blockers,
      'unsafe_image_url',
      'Image URL must be https and come from a safe test/public host.',
      'Use a safe fixture image URL or omit image_url from the dry-run.',
      index,
      'image_url',
    );
  }
  if (isStale(snapshotAt, now, staleAfterSeconds)) {
    addBlocker(
      blockers,
      'stale_source_timestamp',
      'Source snapshot timestamp is stale for this dry-run.',
      'Refresh the local snapshot evidence before requesting operator review.',
      index,
      'source_snapshot_at',
    );
  }
  if (row['conflict'] === true || row['source_conflict'] === true) {
    addBlocker(
      blockers,
      'source_conflict_blocker',
      'Row is marked as conflicted by the source snapshot.',
      'Resolve source conflicts before considering connector sync approval.',
      index,
      'conflict',
    );
  }

  if (blockers.length > 0 || !title || !categoryPreset || !sku || priceAmount === null || !currency) {
    return { product: null, blockers, warnings };
  }

  return {
    product: {
      source_product_ref: productRef,
      title,
      brand,
      description,
      image_url: imageUrl,
      category_preset: categoryPreset,
      variants: [{
        sku,
        variant_title: variantTitle,
        price_amount: priceAmount,
        currency,
        availability_status: availability,
        warranty_summary: warranty,
        return_policy_summary: returnPolicy,
      }],
    },
    blockers,
    warnings,
  };
}

export function prepareConnectorDryRun(
  body: ConnectorDryRunBody,
  now: Date = new Date(),
): ConnectorDryRunPrepared {
  const blockers: ConnectorDryRunBlocker[] = [];
  const warnings: ConnectorDryRunWarning[] = [];
  if (containsPrivateValue(body)) {
    addBlocker(
      blockers,
      'private_or_production_value_rejected',
      'Request contains secret, private, production config, allowlist, live, or production-looking values.',
      'Submit only synthetic sandbox rows with public-safe values.',
    );
  }
  const forbiddenKey = hasForbiddenKey(body);
  if (forbiddenKey) {
    addBlocker(
      blockers,
      'private_field_rejected',
      `Request contains private or credential-like field: ${forbiddenKey.replace(/[\r\n\t]/g, '_')}`,
      'Remove credentials, private merchant artifacts, provider metadata, and raw payload fields before dry-run.',
      undefined,
      forbiddenKey,
    );
  }
  if (hasEnabledExecutionField(body)) {
    addBlocker(
      blockers,
      'enablement_field_rejected',
      'Request attempts to enable public discovery, checkout/payment, live provider, provider calls, outbound sync, or production config.',
      'Remove enablement fields; C6R is dry-run-only.',
    );
  }
  if (hasPrivateExecutionUrl(body)) {
    addBlocker(
      blockers,
      'merchant_private_api_url_rejected',
      'Request contains an execution URL or endpoint field.',
      'Use local fixture rows only; do not include merchant private API URLs.',
    );
  }

  const { connectorType, sourceLabel, previewLimit, staleAfterSeconds } = validateRequestShape(body, blockers);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const normalized: NormalizedConnectorPreviewProduct[] = [];
  const seenSkus = new Set<string>();
  const seenProducts = new Set<string>();

  rows.forEach((rawRow, index) => {
    if (!isPlainObject(rawRow)) {
      addBlocker(
        blockers,
        'invalid_row_shape',
        'Each dry-run row must be a JSON object.',
        'Provide CSV/manual rows as objects.',
        index,
      );
      return;
    }
    const rowResult = normalizeRow(rawRow, index, body, now, staleAfterSeconds);
    blockers.push(...rowResult.blockers);
    warnings.push(...rowResult.warnings);
    if (!rowResult.product) return;
    const sku = rowResult.product.variants[0]?.sku;
    if (seenProducts.has(rowResult.product.source_product_ref)) {
      addBlocker(
        blockers,
        'duplicate_product_ref',
        'Duplicate source product reference in dry-run rows.',
        'Use one row per source product reference or group variants under a later approved adapter shape.',
        index,
        'product_id',
      );
      return;
    }
    if (sku && seenSkus.has(sku)) {
      addBlocker(
        blockers,
        'duplicate_sku',
        'Duplicate SKU in dry-run rows.',
        'Use stable unique synthetic SKUs.',
        index,
        'sku',
      );
      return;
    }
    seenProducts.add(rowResult.product.source_product_ref);
    if (sku) seenSkus.add(sku);
    normalized.push(rowResult.product);
  });

  const rowBlockedIndexes = new Set(
    blockers
      .map((blocker) => blocker.row_index)
      .filter((index): index is number => index !== undefined),
  );

  return {
    connector_type: connectorType ?? 'manual',
    source_label: sourceLabel,
    rows_received: rows.length,
    products_detected: normalized.length,
    variants_detected: normalized.reduce((sum, product) => sum + product.variants.length, 0),
    blocked_count: rowBlockedIndexes.size + blockers.filter((blocker) => blocker.row_index === undefined).length,
    warning_count: warnings.length,
    normalized_products: normalized,
    normalized_preview: normalized.slice(0, previewLimit),
    blockers,
    warnings,
  };
}

export function finalizeConnectorDryRun(input: ConnectorDryRunFinalizeInput): ConnectorDryRunResult {
  let wouldUpdate = 0;
  for (const product of input.normalized_products) {
    if (input.existingProductIds.has(product.source_product_ref)) wouldUpdate += 1;
  }
  const wouldCreate = input.normalized_products.length - wouldUpdate;
  return {
    dry_run_id: input.dryRunId,
    tenant_id: input.tenantId,
    merchant_id: input.merchantId,
    connector_type: input.connector_type,
    source_label: input.source_label,
    status: input.blockers.length > 0 ? 'blocked' : 'passed',
    sandbox_only: true,
    not_live: true,
    not_approved: true,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    provider_specific_live_enabled: false,
    rows_received: input.rows_received,
    products_detected: input.products_detected,
    variants_detected: input.variants_detected,
    would_create_count: wouldCreate,
    would_update_count: wouldUpdate,
    would_archive_count: 0,
    blocked_count: input.blocked_count,
    warning_count: input.warning_count,
    normalized_preview: input.normalized_preview,
    blockers: input.blockers,
    warnings: input.warnings,
    generated_at: input.generatedAt.toISOString(),
  };
}
