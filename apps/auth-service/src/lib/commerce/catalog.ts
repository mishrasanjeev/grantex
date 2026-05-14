import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export const V1_COMMERCE_TOOLS = [
  'merchant.get_profile',
  'catalog.search',
  'catalog.get_item',
  'inventory.check',
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
] as const;

export const V1_COMMERCE_REQUIRED_SCOPES = {
  browse: ['commerce:catalog.read', 'commerce:inventory.read'],
  checkout: ['commerce:checkout.create', 'commerce:payment.initiate', 'commerce:payment.status.read'],
} as const;

export interface MerchantPublishingProfile {
  merchant_id: string;
  display_name: string;
  legal_name: string;
  category_preset: string;
  verification_status: string;
  environment: 'sandbox' | 'live';
  default_currency: string;
  country_code: string;
  capabilities: string[];
}

interface MerchantProfileRow {
  id: string;
  legal_name: string;
  display_name: string;
  category_preset: string;
  verification_status: string;
  environment: 'sandbox' | 'live' | string;
  default_currency: string;
  country_code: string;
  default_capabilities: unknown;
}

export type MerchantPublishingProfileResult =
  | { kind: 'found'; profile: MerchantPublishingProfile }
  | { kind: 'not_found' }
  | { kind: 'selector_required' };

export interface CatalogSearchFilters {
  brand?: string;
  category_preset?: string;
  availability_status?: string;
  currency?: string;
}

export interface CatalogSearchInput {
  tenantId: string;
  merchantId: string;
  query?: string | null;
  filters?: CatalogSearchFilters;
  limit?: number;
  cursor?: string | null;
  now?: Date;
}

export interface CatalogListInput {
  tenantId: string;
  merchantId: string;
  query?: string | null;
  categoryPreset?: string | null;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  cursor?: string | null;
  now?: Date;
}

export interface VariantSummary {
  variant_id: string;
  sku: string;
  variant_title: string | null;
  model: string | null;
  price_amount: number | string;
  currency: string;
  availability_status: string;
  last_synced_at: Date | string;
  stale: boolean;
  freshness: 'fresh' | 'stale';
}

export interface CatalogProductSummary {
  id: string;
  product_id: string;
  merchant_id: string;
  title: string;
  brand: string | null;
  image_url: string | null;
  category_preset: string;
  variants_summary: VariantSummary[];
  updated_at: Date | string;
}

export interface CatalogSearchResult {
  items: CatalogProductSummary[];
  next_cursor: string | null;
}

interface CatalogSearchRow {
  id: string;
  product_id: string;
  merchant_id: string;
  title: string;
  brand: string | null;
  image_url: string | null;
  category_preset: string;
  updated_at: Date | string;
  variant_id: string | null;
  sku: string | null;
  variant_title: string | null;
  model: string | null;
  price_amount: number | string | null;
  currency: string | null;
  availability_status: string | null;
  last_synced_at: Date | string | null;
}

export interface CatalogItem {
  id: string;
  tenant_id: string;
  merchant_id: string;
  product_id: string;
  title: string;
  brand: string | null;
  description: string | null;
  image_url: string | null;
  category_preset: string;
  source_system: string;
  manually_maintained: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  variants: CatalogVariantDetail[];
}

export interface CatalogVariantDetail {
  id: string;
  sku: string;
  parent_sku: string | null;
  model: string | null;
  variant_title: string | null;
  attributes: unknown;
  price_amount: number | string;
  currency: string;
  tax_inclusive: boolean;
  gst_slab: string | null;
  tax_rate: string | number | null;
  hsn_code: string | null;
  availability_status: string;
  warranty_summary: string | null;
  return_policy_summary: string | null;
  source_system: string;
  last_synced_at: Date | string;
  archived_at: Date | string | null;
  stale: boolean;
  freshness: 'fresh' | 'stale';
}

interface ProductRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  product_id: string;
  title: string;
  brand: string | null;
  description: string | null;
  image_url: string | null;
  category_preset: string;
  source_system: string;
  manually_maintained: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VariantRow {
  id: string;
  sku: string;
  parent_sku: string | null;
  model: string | null;
  variant_title: string | null;
  attributes: unknown;
  price_amount: number | string;
  currency: string;
  tax_inclusive: boolean;
  gst_slab: string | null;
  tax_rate: string | number | null;
  hsn_code: string | null;
  availability_status: string;
  warranty_summary: string | null;
  return_policy_summary: string | null;
  source_system: string;
  last_synced_at: Date | string;
  archived_at: Date | string | null;
}

export interface InventoryCheckItem {
  variant_id: string;
  sku: string;
  availability_status: string;
  last_synced_at: Date | string;
  stale: boolean;
  freshness: 'fresh' | 'stale';
}

interface InventoryRow {
  id: string;
  sku: string;
  availability_status: string;
  last_synced_at: Date | string;
}

function asCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [...V1_COMMERCE_TOOLS];
}

function normalizeMerchant(row: MerchantProfileRow): MerchantPublishingProfile {
  return {
    merchant_id: row.id,
    display_name: row.display_name,
    legal_name: row.legal_name,
    category_preset: row.category_preset,
    verification_status: row.verification_status,
    environment: row.environment === 'live' ? 'live' : 'sandbox',
    default_currency: row.default_currency,
    country_code: row.country_code,
    capabilities: asCapabilities(row.default_capabilities),
  };
}

export async function readMerchantPublishingProfile(
  sql: Sql,
  input: { merchantId?: string | null; tenantId?: string | null },
): Promise<MerchantPublishingProfileResult> {
  const merchantId = input.merchantId ?? null;
  const tenantId = input.tenantId ?? null;
  const rows = await sql<MerchantProfileRow[]>`
    SELECT m.id, m.legal_name, m.display_name, m.category_preset,
           m.verification_status,
           CASE WHEN m.environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           m.default_currency, m.country_code,
           cp.default_capabilities
      FROM commerce_merchants m
      LEFT JOIN commerce_category_presets cp
        ON cp.preset_key = m.category_preset
     WHERE (${merchantId}::text IS NULL OR m.id = ${merchantId})
       AND (${tenantId}::text IS NULL OR m.tenant_id = ${tenantId})
       AND m.disabled_at IS NULL
     ORDER BY m.created_at ASC
     LIMIT ${merchantId ? 1 : 2}
  `;
  if (rows.length === 0) return { kind: 'not_found' };
  if (!merchantId && rows.length > 1) return { kind: 'selector_required' };
  return { kind: 'found', profile: normalizeMerchant(rows[0] as MerchantProfileRow) };
}

function encodeCursor(row: { updated_at: Date | string; id: string }): string {
  const updated = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return Buffer.from(`${updated}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string | null): { updatedAt: string | null; id: string | null } {
  if (!cursor) return { updatedAt: null, id: null };
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [updatedAt, id] = decoded.split('|');
    if (!updatedAt || !id) return { updatedAt: null, id: null };
    return { updatedAt, id };
  } catch {
    return { updatedAt: null, id: null };
  }
}

function freshness(
  lastSyncedAt: Date | string,
  now: Date,
  staleAfterSeconds = 86400,
): { stale: boolean; freshness: 'fresh' | 'stale' } {
  const synced = lastSyncedAt instanceof Date ? lastSyncedAt : new Date(lastSyncedAt);
  const stale = Number.isNaN(synced.getTime())
    || now.getTime() - synced.getTime() > staleAfterSeconds * 1000;
  return { stale, freshness: stale ? 'stale' : 'fresh' };
}

function normalizeVariantSummary(row: CatalogSearchRow, now: Date): VariantSummary | null {
  if (!row.variant_id || !row.sku || row.price_amount === null || !row.currency
    || !row.availability_status || !row.last_synced_at) {
    return null;
  }
  return {
    variant_id: row.variant_id,
    sku: row.sku,
    variant_title: row.variant_title,
    model: row.model,
    price_amount: row.price_amount,
    currency: row.currency,
    availability_status: row.availability_status,
    last_synced_at: row.last_synced_at,
    ...freshness(row.last_synced_at, now),
  };
}

export async function searchCatalog(
  sql: Sql,
  input: CatalogSearchInput,
): Promise<CatalogSearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const now = input.now ?? new Date();
  const query = input.query && input.query.trim().length > 0 ? input.query.trim() : null;
  const filters = input.filters ?? {};
  const brand = filters.brand ?? null;
  const categoryPreset = filters.category_preset ?? null;
  const availability = filters.availability_status ?? null;
  const currency = filters.currency ?? null;
  const cursor = decodeCursor(input.cursor);

  const rows = await sql<CatalogSearchRow[]>`
    WITH matched_products AS (
      SELECT p.id, p.product_id, p.merchant_id, p.title, p.brand,
             p.image_url, p.category_preset, p.updated_at
        FROM commerce_products p
       WHERE p.tenant_id = ${input.tenantId}
         AND p.merchant_id = ${input.merchantId}
         AND p.archived_at IS NULL
         AND (${query}::text IS NULL
              OR p.title ILIKE ('%' || ${query} || '%')
              OR p.brand ILIKE ('%' || ${query} || '%')
              OR p.product_id ILIKE ('%' || ${query} || '%'))
         AND (${brand}::text IS NULL OR p.brand = ${brand})
         AND (${categoryPreset}::text IS NULL OR p.category_preset = ${categoryPreset})
         AND (
           ${availability}::text IS NULL
           OR EXISTS (
             SELECT 1 FROM commerce_product_variants vf
              WHERE vf.tenant_id = p.tenant_id
                AND vf.merchant_id = p.merchant_id
                AND vf.product_id = p.id
                AND vf.archived_at IS NULL
                AND vf.availability_status = ${availability}
           )
         )
         AND (
           ${currency}::text IS NULL
           OR EXISTS (
             SELECT 1 FROM commerce_product_variants vf
              WHERE vf.tenant_id = p.tenant_id
                AND vf.merchant_id = p.merchant_id
                AND vf.product_id = p.id
                AND vf.archived_at IS NULL
                AND vf.currency = ${currency}
           )
         )
         AND (
           ${cursor.updatedAt}::timestamptz IS NULL
           OR (p.updated_at, p.id) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::text)
         )
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT ${limit + 1}
    )
    SELECT p.id, p.product_id, p.merchant_id, p.title, p.brand,
           p.image_url, p.category_preset, p.updated_at,
           v.id AS variant_id, v.sku, v.variant_title, v.model,
           v.price_amount, v.currency, v.availability_status, v.last_synced_at
      FROM matched_products p
      LEFT JOIN commerce_product_variants v
        ON v.tenant_id = ${input.tenantId}
       AND v.merchant_id = p.merchant_id
       AND v.product_id = p.id
       AND v.archived_at IS NULL
       AND (${availability}::text IS NULL OR v.availability_status = ${availability})
       AND (${currency}::text IS NULL OR v.currency = ${currency})
     ORDER BY p.updated_at DESC, p.id DESC, v.created_at ASC
  `;

  const grouped = new Map<string, CatalogProductSummary>();
  for (const row of rows) {
    let product = grouped.get(row.id);
    if (!product) {
      product = {
        id: row.id,
        product_id: row.product_id,
        merchant_id: row.merchant_id,
        title: row.title,
        brand: row.brand,
        image_url: row.image_url,
        category_preset: row.category_preset,
        variants_summary: [],
        updated_at: row.updated_at,
      };
      grouped.set(row.id, product);
    }
    const variant = normalizeVariantSummary(row, now);
    if (variant) product.variants_summary.push(variant);
  }

  const products = [...grouped.values()];
  const items = products.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = products.length > limit && last ? encodeCursor(last) : null;
  return { items, next_cursor: nextCursor };
}

export async function listCatalogProducts(
  sql: Sql,
  input: CatalogListInput,
): Promise<CatalogSearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const now = input.now ?? new Date();
  const query = input.query && input.query.trim().length > 0 ? input.query.trim() : null;
  const categoryPreset = input.categoryPreset ?? null;
  const status = input.status ?? 'active';
  const cursor = decodeCursor(input.cursor);

  const rows = await sql<CatalogSearchRow[]>`
    WITH matched_products AS (
      SELECT p.id, p.product_id, p.merchant_id, p.title, p.brand,
             p.image_url, p.category_preset, p.updated_at
        FROM commerce_products p
       WHERE p.tenant_id = ${input.tenantId}
         AND p.merchant_id = ${input.merchantId}
         AND (
           ${status}::text = 'all'
           OR (${status}::text = 'active' AND p.archived_at IS NULL)
           OR (${status}::text = 'archived' AND p.archived_at IS NOT NULL)
         )
         AND (${query}::text IS NULL
              OR p.title ILIKE ('%' || ${query} || '%')
              OR p.brand ILIKE ('%' || ${query} || '%')
              OR p.product_id ILIKE ('%' || ${query} || '%'))
         AND (${categoryPreset}::text IS NULL OR p.category_preset = ${categoryPreset})
         AND (
           ${cursor.updatedAt}::timestamptz IS NULL
           OR (p.updated_at, p.id) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::text)
         )
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT ${limit + 1}
    )
    SELECT p.id, p.product_id, p.merchant_id, p.title, p.brand,
           p.image_url, p.category_preset, p.updated_at,
           v.id AS variant_id, v.sku, v.variant_title, v.model,
           v.price_amount, v.currency, v.availability_status, v.last_synced_at
      FROM matched_products p
      LEFT JOIN commerce_product_variants v
        ON v.tenant_id = ${input.tenantId}
       AND v.merchant_id = p.merchant_id
       AND v.product_id = p.id
       AND (
         ${status}::text IN ('all', 'archived')
         OR v.archived_at IS NULL
       )
     ORDER BY p.updated_at DESC, p.id DESC, v.created_at ASC
  `;

  const grouped = new Map<string, CatalogProductSummary>();
  for (const row of rows) {
    let product = grouped.get(row.id);
    if (!product) {
      product = {
        id: row.id,
        product_id: row.product_id,
        merchant_id: row.merchant_id,
        title: row.title,
        brand: row.brand,
        image_url: row.image_url,
        category_preset: row.category_preset,
        variants_summary: [],
        updated_at: row.updated_at,
      };
      grouped.set(row.id, product);
    }
    const variant = normalizeVariantSummary(row, now);
    if (variant) product.variants_summary.push(variant);
  }

  const products = [...grouped.values()];
  const items = products.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = products.length > limit && last ? encodeCursor(last) : null;
  return { items, next_cursor: nextCursor };
}

function normalizeVariantDetail(row: VariantRow, now: Date): CatalogVariantDetail {
  return {
    ...row,
    ...freshness(row.last_synced_at, now),
  };
}

export async function readCatalogItem(
  sql: Sql,
  input: {
    tenantId: string;
    productRef: string;
    merchantId?: string | null;
    includeArchived?: boolean;
    now?: Date;
  },
): Promise<CatalogItem | null> {
  const merchantId = input.merchantId ?? null;
  const includeArchived = input.includeArchived === true;
  const products = await sql<ProductRow[]>`
    SELECT id, tenant_id, merchant_id, product_id, title, brand, description,
           image_url, category_preset, source_system, manually_maintained,
           archived_at, created_at, updated_at
      FROM commerce_products
     WHERE tenant_id = ${input.tenantId}
       AND (${merchantId}::text IS NULL OR merchant_id = ${merchantId})
       AND (id = ${input.productRef} OR product_id = ${input.productRef})
       AND (${includeArchived}::boolean OR archived_at IS NULL)
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const product = products[0];
  if (!product) return null;
  const variants = await sql<VariantRow[]>`
    SELECT id, sku, parent_sku, model, variant_title, attributes,
           price_amount, currency, tax_inclusive, gst_slab, tax_rate,
           hsn_code, availability_status, warranty_summary,
           return_policy_summary, source_system, last_synced_at,
           archived_at
      FROM commerce_product_variants
     WHERE product_id = ${product.id}
       AND tenant_id = ${input.tenantId}
       AND merchant_id = ${product.merchant_id}
       AND (${includeArchived}::boolean OR archived_at IS NULL)
     ORDER BY created_at ASC
  `;
  const now = input.now ?? new Date();
  return {
    ...product,
    variants: variants.map((row) => normalizeVariantDetail(row, now)),
  };
}

export async function checkInventory(
  sql: Sql,
  input: {
    tenantId: string;
    merchantId: string;
    variantIds: string[];
    now?: Date;
  },
): Promise<InventoryCheckItem[]> {
  if (input.variantIds.length === 0) return [];
  const rows = await sql<InventoryRow[]>`
    SELECT id, sku, availability_status, last_synced_at
      FROM commerce_product_variants
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND archived_at IS NULL
       AND (id = ANY(${input.variantIds}::text[]) OR sku = ANY(${input.variantIds}::text[]))
     ORDER BY created_at ASC
  `;
  const now = input.now ?? new Date();
  return rows.map((row) => ({
    variant_id: row.id,
    sku: row.sku,
    availability_status: row.availability_status,
    last_synced_at: row.last_synced_at,
    ...freshness(row.last_synced_at, now),
  }));
}
