import type postgres from 'postgres';
import { isPublicSafeText } from './sandbox-onboarding.js';

type Sql = ReturnType<typeof postgres>;

type SchemaOrgAvailability =
  | 'https://schema.org/InStock'
  | 'https://schema.org/OutOfStock'
  | 'https://schema.org/PreOrder'
  | 'https://schema.org/BackOrder';

export interface SchemaOrgBrand {
  '@type': 'Brand';
  name: string;
}

export interface SchemaOrgMerchantReturnPolicy {
  '@type': 'MerchantReturnPolicy';
  description: string;
  applicableCountry?: string;
}

export interface SchemaOrgOfferShippingDetails {
  '@type': 'OfferShippingDetails';
}

export interface SchemaOrgOffer {
  '@type': 'Offer';
  price: string;
  priceCurrency: string;
  availability?: SchemaOrgAvailability;
  hasMerchantReturnPolicy?: SchemaOrgMerchantReturnPolicy;
  shippingDetails?: SchemaOrgOfferShippingDetails;
}

export interface SchemaOrgProduct {
  '@type': 'Product';
  name: string;
  description?: string;
  image?: string;
  category?: string;
  brand?: SchemaOrgBrand;
  offers?: SchemaOrgOffer[];
}

export interface SchemaOrgJsonLdGraph {
  '@context': 'https://schema.org';
  '@graph': SchemaOrgProduct[];
}

export type SchemaOrgJsonLdPreviewStatus = 'preview_only' | 'blocked';

export interface SchemaOrgJsonLdPreview {
  status: SchemaOrgJsonLdPreviewStatus;
  message: string;
  preview_only: true;
  publication_status: 'not_published';
  schemaorg_publication_enabled: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  live_plural_enabled: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  certification_claims: [];
  generated_at: string;
  jsonld: SchemaOrgJsonLdGraph;
  included_types: Array<'Product' | 'Offer' | 'MerchantReturnPolicy' | 'OfferShippingDetails'>;
  omitted_types: Array<'Product' | 'Offer' | 'MerchantReturnPolicy' | 'OfferShippingDetails'>;
  allowed_capabilities: ['schemaorg_jsonld_preview_read'];
  blocked_capabilities: [
    'schemaorg_publication',
    'public_discovery',
    'checkout_payment_creation',
    'live_payment',
    'live_plural',
    'provider_credentials',
    'production_allowlist',
  ];
  blockers: string[];
  remediation_items: string[];
  source_reference: {
    system: 'grantex';
    canonical_state: 'merchant_catalog_readiness';
    endpoint_template: '/v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview';
    tenant_scoped: true;
  };
  evidence_summary: {
    product_count: number;
    offer_count: number;
    return_policy_count: number;
    shipping_details_count: number;
    omitted_unsafe_field_count: number;
    readiness_state: string;
    read_only: true;
    public_safe: true;
  };
}

export interface SchemaOrgJsonLdPreviewContext {
  merchantEnvironment: 'sandbox' | 'live';
  preview: SchemaOrgJsonLdPreview;
}

interface MerchantRow {
  environment: string | null;
  country_code: string | null;
  sandbox_onboarding_state: string | null;
  disabled_at: Date | string | null;
}

interface ProductVariantRow {
  product_row_id: string;
  title: string | null;
  brand: string | null;
  description: string | null;
  image_url: string | null;
  category_preset: string | null;
  variant_row_id: string | null;
  price_amount: number | string | null;
  currency: string | null;
  availability_status: string | null;
  return_policy_summary: string | null;
}

interface ProductBuild {
  product: SchemaOrgProduct;
  offers: SchemaOrgOffer[];
}

const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const MAX_PRODUCTS = 20;
const MAX_VARIANTS_PER_PRODUCT = 3;
const BLOCKED_CAPABILITIES: SchemaOrgJsonLdPreview['blocked_capabilities'] = [
  'schemaorg_publication',
  'public_discovery',
  'checkout_payment_creation',
  'live_payment',
  'live_plural',
  'provider_credentials',
  'production_allowlist',
];

function publicTextOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPublicSafeText(trimmed) ? trimmed : null;
}

function publicUrlOrNull(value: string | null | undefined): string | null {
  const trimmed = publicTextOrNull(value);
  if (!trimmed || trimmed.length > 512) return null;
  try {
    const url = new URL(trimmed);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function publicCurrencyOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function publicCountryOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null;
}

function readinessStateOrUnknown(value: string | null | undefined): string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unknown';
}

function priceStringOrNull(amount: number | string | null | undefined, currency: string): string | null {
  let minorUnits: number;
  if (typeof amount === 'number' && Number.isInteger(amount) && amount >= 0) {
    minorUnits = amount;
  } else if (typeof amount === 'string' && /^\d+$/.test(amount)) {
    minorUnits = Number.parseInt(amount, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(minorUnits)) return null;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return String(minorUnits);
  return (minorUnits / 100).toFixed(2);
}

function availabilityOrNull(value: string | null | undefined): SchemaOrgAvailability | null {
  switch (value) {
    case 'in_stock':
      return 'https://schema.org/InStock';
    case 'out_of_stock':
      return 'https://schema.org/OutOfStock';
    case 'pre_order':
      return 'https://schema.org/PreOrder';
    case 'back_order':
      return 'https://schema.org/BackOrder';
    default:
      return null;
  }
}

function addUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function buildRemediation(blockers: string[]): string[] {
  const remediation: string[] = [];
  if (blockers.includes('merchant_not_sandbox')) {
    remediation.push('Use a sandbox merchant preview; this adapter does not run against live merchants.');
  }
  if (blockers.includes('schemaorg_product_evidence_missing')) {
    remediation.push('Add at least one public-safe active catalog product before generating JSON-LD preview.');
  }
  if (blockers.includes('schemaorg_offer_evidence_missing')) {
    remediation.push('Add public-safe variant price and currency evidence before including Offer objects.');
  }
  if (blockers.includes('schemaorg_return_policy_evidence_missing')) {
    remediation.push('Add public-safe return policy summaries before including MerchantReturnPolicy objects.');
  }
  if (blockers.includes('schemaorg_shipping_details_evidence_missing')) {
    remediation.push('Add public-safe shipping evidence before including OfferShippingDetails objects.');
  }
  if (blockers.includes('schemaorg_unsafe_fields_omitted')) {
    remediation.push('Remove secrets, provider metadata, raw payloads, production claims, approval claims, or private values from public catalog fields.');
  }
  return remediation;
}

function basePreview(generatedAt: string, readinessState: string): SchemaOrgJsonLdPreview {
  return {
    status: 'blocked',
    message: 'Schema.org JSON-LD preview is blocked until public-safe catalog evidence exists.',
    preview_only: true,
    publication_status: 'not_published',
    schemaorg_publication_enabled: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    live_plural_enabled: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    certification_claims: [],
    generated_at: generatedAt,
    jsonld: { '@context': 'https://schema.org', '@graph': [] },
    included_types: [],
    omitted_types: ['Product', 'Offer', 'MerchantReturnPolicy', 'OfferShippingDetails'],
    allowed_capabilities: ['schemaorg_jsonld_preview_read'],
    blocked_capabilities: BLOCKED_CAPABILITIES,
    blockers: [],
    remediation_items: [],
    source_reference: {
      system: 'grantex',
      canonical_state: 'merchant_catalog_readiness',
      endpoint_template: '/v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview',
      tenant_scoped: true,
    },
    evidence_summary: {
      product_count: 0,
      offer_count: 0,
      return_policy_count: 0,
      shipping_details_count: 0,
      omitted_unsafe_field_count: 0,
      readiness_state: readinessState,
      read_only: true,
      public_safe: true,
    },
  };
}

function buildJsonLdPreview(
  merchant: MerchantRow,
  rows: ProductVariantRow[],
  generatedAt: string,
): SchemaOrgJsonLdPreview {
  const readinessState = readinessStateOrUnknown(merchant.sandbox_onboarding_state);
  const preview = basePreview(generatedAt, readinessState);
  const countryCode = publicCountryOrNull(merchant.country_code);
  const products = new Map<string, ProductBuild>();
  let omittedUnsafeFieldCount = 0;

  for (const row of rows) {
    const productKey = row.product_row_id;
    if (!productKey || (products.size >= MAX_PRODUCTS && !products.has(productKey))) continue;

    let build = products.get(productKey);
    if (!build) {
      const name = publicTextOrNull(row.title);
      if (!name) {
        omittedUnsafeFieldCount += 1;
        continue;
      }
      const product: SchemaOrgProduct = { '@type': 'Product', name };
      const description = publicTextOrNull(row.description);
      if (description) {
        product.description = description;
      } else if (row.description) {
        omittedUnsafeFieldCount += 1;
      }
      const imageUrl = publicUrlOrNull(row.image_url);
      if (imageUrl) {
        product.image = imageUrl;
      } else if (row.image_url) {
        omittedUnsafeFieldCount += 1;
      }
      const category = publicTextOrNull(row.category_preset);
      if (category) {
        product.category = category;
      } else if (row.category_preset) {
        omittedUnsafeFieldCount += 1;
      }
      const brandName = publicTextOrNull(row.brand);
      if (brandName) {
        product.brand = { '@type': 'Brand', name: brandName };
      } else if (row.brand) {
        omittedUnsafeFieldCount += 1;
      }
      build = { product, offers: [] };
      products.set(productKey, build);
    }

    if (!row.variant_row_id || build.offers.length >= MAX_VARIANTS_PER_PRODUCT) continue;
    const currency = publicCurrencyOrNull(row.currency);
    if (!currency) {
      if (row.currency) omittedUnsafeFieldCount += 1;
      continue;
    }
    const price = priceStringOrNull(row.price_amount, currency);
    if (!price) continue;
    const offer: SchemaOrgOffer = { '@type': 'Offer', price, priceCurrency: currency };
    const availability = availabilityOrNull(row.availability_status);
    if (availability) offer.availability = availability;
    const returnPolicy = publicTextOrNull(row.return_policy_summary);
    if (returnPolicy) {
      const policy: SchemaOrgMerchantReturnPolicy = {
        '@type': 'MerchantReturnPolicy',
        description: returnPolicy,
      };
      if (countryCode) policy.applicableCountry = countryCode;
      offer.hasMerchantReturnPolicy = policy;
    } else if (row.return_policy_summary) {
      omittedUnsafeFieldCount += 1;
    }
    build.offers.push(offer);
  }

  const graph = Array.from(products.values()).map((entry) => {
    if (entry.offers.length > 0) entry.product.offers = entry.offers;
    return entry.product;
  });
  const offerCount = graph.reduce((count, product) => count + (product.offers?.length ?? 0), 0);
  const returnPolicyCount = graph.reduce(
    (count, product) => count + (product.offers ?? []).filter((offer) => offer.hasMerchantReturnPolicy).length,
    0,
  );

  preview.jsonld = { '@context': 'https://schema.org', '@graph': graph };
  preview.evidence_summary = {
    product_count: graph.length,
    offer_count: offerCount,
    return_policy_count: returnPolicyCount,
    shipping_details_count: 0,
    omitted_unsafe_field_count: omittedUnsafeFieldCount,
    readiness_state: readinessState,
    read_only: true,
    public_safe: true,
  };
  preview.included_types = [];
  preview.omitted_types = [];
  if (graph.length > 0) addUnique(preview.included_types, 'Product');
  else addUnique(preview.omitted_types, 'Product');
  if (offerCount > 0) addUnique(preview.included_types, 'Offer');
  else addUnique(preview.omitted_types, 'Offer');
  if (returnPolicyCount > 0) addUnique(preview.included_types, 'MerchantReturnPolicy');
  else addUnique(preview.omitted_types, 'MerchantReturnPolicy');
  addUnique(preview.omitted_types, 'OfferShippingDetails');

  if (merchant.environment !== 'sandbox') addUnique(preview.blockers, 'merchant_not_sandbox');
  if (graph.length === 0) addUnique(preview.blockers, 'schemaorg_product_evidence_missing');
  if (offerCount === 0) addUnique(preview.blockers, 'schemaorg_offer_evidence_missing');
  if (returnPolicyCount === 0) addUnique(preview.blockers, 'schemaorg_return_policy_evidence_missing');
  addUnique(preview.blockers, 'schemaorg_shipping_details_evidence_missing');
  if (omittedUnsafeFieldCount > 0) addUnique(preview.blockers, 'schemaorg_unsafe_fields_omitted');
  preview.remediation_items = buildRemediation(preview.blockers);
  preview.status = graph.length > 0 && offerCount > 0 && merchant.environment === 'sandbox'
    ? 'preview_only'
    : 'blocked';
  preview.message = preview.status === 'preview_only'
    ? 'Schema.org JSON-LD preview was generated from public-safe Grantex catalog evidence. It is not published and does not approve production use.'
    : 'Schema.org JSON-LD preview is blocked until public-safe sandbox merchant and catalog evidence exists.';
  return preview;
}

export async function readSchemaOrgJsonLdPreview(
  sql: Sql,
  input: { tenantId: string; merchantId: string; now?: Date },
): Promise<SchemaOrgJsonLdPreviewContext | null> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const merchants = await sql<MerchantRow[]>`
    SELECT environment, country_code, sandbox_onboarding_state, disabled_at
      FROM commerce_merchants
     WHERE id = ${input.merchantId}
       AND tenant_id = ${input.tenantId}
     LIMIT 1
  `;
  const merchant = merchants[0];
  if (!merchant || merchant.disabled_at) return null;

  if (merchant.environment !== 'sandbox') {
    const preview = basePreview(generatedAt, readinessStateOrUnknown(merchant.sandbox_onboarding_state));
    preview.blockers = ['merchant_not_sandbox'];
    preview.remediation_items = buildRemediation(preview.blockers);
    preview.message = 'Schema.org JSON-LD preview is available only for sandbox merchants.';
    return { merchantEnvironment: 'live', preview };
  }

  const rows = await sql<ProductVariantRow[]>`
    SELECT p.id AS product_row_id,
           p.title,
           p.brand,
           p.description,
           p.image_url,
           p.category_preset,
           v.id AS variant_row_id,
           v.price_amount,
           v.currency,
           v.availability_status,
           v.return_policy_summary
      FROM commerce_products p
      LEFT JOIN commerce_product_variants v
        ON v.product_id = p.id
       AND v.tenant_id = p.tenant_id
       AND v.merchant_id = p.merchant_id
       AND v.archived_at IS NULL
     WHERE p.tenant_id = ${input.tenantId}
       AND p.merchant_id = ${input.merchantId}
       AND p.archived_at IS NULL
     ORDER BY p.updated_at DESC, p.id ASC, v.updated_at DESC, v.id ASC
     LIMIT ${MAX_PRODUCTS * MAX_VARIANTS_PER_PRODUCT}
  `;

  return {
    merchantEnvironment: 'sandbox',
    preview: buildJsonLdPreview(merchant, rows, generatedAt),
  };
}
