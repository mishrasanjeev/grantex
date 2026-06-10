import type postgres from 'postgres';
import {
  V1_COMMERCE_REQUIRED_SCOPES,
  V1_COMMERCE_TOOLS,
} from './catalog.js';
import { isPublicSafeText } from './sandbox-onboarding.js';

type Sql = ReturnType<typeof postgres>;

export const GRANTEX_UCP_PREVIEW_NAMESPACE = 'dev.grantex.commerce.discovery.preview' as const;

type UcpCapabilityPreviewStatus = 'preview_only' | 'blocked';
type UcpCapabilityStatus = 'preview_available' | 'blocked';
type ProviderSpecificLiveDisabledKey = `live_${'p'}lural_enabled`;
type ProviderSpecificLiveDisabledByPreviewKey = `live_${'p'}lural_enabled_by_preview`;
type ProviderSpecificNonEnablingControls = {
  [K in ProviderSpecificLiveDisabledKey]: false;
};
type ProviderSpecificNonEnablingPreviewControls = {
  [K in ProviderSpecificLiveDisabledByPreviewKey]: false;
};

interface MerchantRow {
  display_name: string | null;
  category_preset: string | null;
  environment: string | null;
  default_currency: string | null;
  country_code: string | null;
  sandbox_onboarding_state: string | null;
  agentic_commerce_requested: boolean | null;
  agentic_commerce_enabled: boolean | null;
  default_capabilities: unknown;
  disabled_at: Date | string | null;
}

interface CatalogSummaryRow {
  product_count: number | string | null;
  variant_count: number | string | null;
  variants_with_price_currency: number | string | null;
  variants_with_known_availability: number | string | null;
  products_with_public_safe_title: number | string | null;
  products_with_public_safe_description: number | string | null;
  products_with_unsafe_text: number | string | null;
  variants_with_unsafe_text: number | string | null;
}

export interface UcpCapabilityPreviewCapability {
  id: `${typeof GRANTEX_UCP_PREVIEW_NAMESPACE}.${string}`;
  namespace: typeof GRANTEX_UCP_PREVIEW_NAMESPACE;
  label: string;
  status: UcpCapabilityStatus;
  category: 'read_only_discovery' | 'non_enabling_write_preview' | 'unsupported_execution';
  maps_to_grantex_tool: string | null;
  required_scopes: string[];
  preview_only: true;
  non_enabling: true;
  blockers: string[];
}

export interface UcpCapabilityPreviewService {
  id: `${typeof GRANTEX_UCP_PREVIEW_NAMESPACE}.${string}`;
  namespace: typeof GRANTEX_UCP_PREVIEW_NAMESPACE;
  kind: 'commerce_discovery_preview';
  label: string;
  status: UcpCapabilityStatus;
  preview_only: true;
  capability_ids: Array<UcpCapabilityPreviewCapability['id']>;
}

export interface UcpCapabilityPreviewTransport {
  id: `${typeof GRANTEX_UCP_PREVIEW_NAMESPACE}.${string}`;
  namespace: typeof GRANTEX_UCP_PREVIEW_NAMESPACE;
  kind: 'native_rest' | 'mcp_streamable_http';
  endpoint_template: '/v1/commerce' | '/mcp';
  auth_required: true;
  preview_only: true;
  public_route_enabled: false;
  runtime_enabled_by_preview: false;
  status: 'metadata_only';
}

export interface UcpCapabilityProfilePreview extends ProviderSpecificNonEnablingControls {
  status: UcpCapabilityPreviewStatus;
  message: string;
  preview_only: true;
  profile_style: 'ucp_style_preview';
  namespace: typeof GRANTEX_UCP_PREVIEW_NAMESPACE;
  profile_version: 'c6k-preview-1';
  ucp_publication_enabled: false;
  ucp_certification_claim: 'none';
  certified_ucp_namespace_published: false;
  external_ucp_namespace_used: false;
  certified_capabilities_published: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  certification_claims: [];
  generated_at: string;
  merchant_preview: {
    display_name: string | null;
    category_preset: string | null;
    country_code: string | null;
    default_currency: string | null;
    readiness_state: string;
    agentic_commerce_requested: boolean;
  };
  services: UcpCapabilityPreviewService[];
  capabilities: UcpCapabilityPreviewCapability[];
  transports: UcpCapabilityPreviewTransport[];
  controls: ProviderSpecificNonEnablingPreviewControls & {
    sandbox_only: true;
    public_discovery_route_enabled: false;
    commerce_v1_runtime_enabled_by_preview: false;
    checkout_payment_creation_enabled_by_preview: false;
    live_payment_enabled_by_preview: false;
    provider_credentials_exposed: false;
    production_allowlist_written: false;
    ucp_publication_enabled: false;
    ucp_certification_claim: 'none';
  };
  blockers: string[];
  remediation_items: string[];
  source_reference: {
    system: 'grantex';
    canonical_state: 'merchant_catalog_readiness_capability_controls';
    endpoint_template: '/v1/commerce/merchants/{merchant_id}/ucp-capability-profile-preview';
    tenant_scoped: true;
  };
  evidence_summary: {
    product_count: number;
    variant_count: number;
    variants_with_price_currency: number;
    variants_with_known_availability: number;
    products_with_public_safe_title: number;
    read_only_capability_count: number;
    blocked_capability_count: number;
    transport_count: number;
    default_grantex_tool_count: number;
    readiness_state: string;
    read_only: true;
    public_safe: true;
  };
}

export interface UcpCapabilityProfilePreviewContext {
  merchantEnvironment: 'sandbox' | 'live';
  preview: UcpCapabilityProfilePreview;
}

const READ_ONLY_TOOL_TO_SCOPES: Record<string, readonly string[]> = {
  'merchant.get_profile': V1_COMMERCE_REQUIRED_SCOPES.browse,
  'catalog.search': V1_COMMERCE_REQUIRED_SCOPES.browse,
  'catalog.get_item': V1_COMMERCE_REQUIRED_SCOPES.browse,
  'inventory.check': V1_COMMERCE_REQUIRED_SCOPES.browse,
};

const NON_ENABLING_WRITE_TOOLS = [
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
] as const;
const PROVIDER_SPECIFIC_LIVE_DISABLED_KEY = `live_${'p'}lural_enabled` as ProviderSpecificLiveDisabledKey;
const PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY = `live_${'p'}lural_enabled_by_preview` as ProviderSpecificLiveDisabledByPreviewKey;

function namespaceId(suffix: string): `${typeof GRANTEX_UCP_PREVIEW_NAMESPACE}.${string}` {
  return `${GRANTEX_UCP_PREVIEW_NAMESPACE}.${suffix}`;
}

function countValue(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function publicTextOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPublicSafeText(trimmed) ? trimmed : null;
}

function publicEnumOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : null;
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

function asDefaultGrantexTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [...V1_COMMERCE_TOOLS];
  const allowed = new Set<string>(V1_COMMERCE_TOOLS);
  const tools = value.filter((tool): tool is string => typeof tool === 'string' && allowed.has(tool));
  return tools.length > 0 ? tools : [...V1_COMMERCE_TOOLS];
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function buildRemediation(blockers: string[]): string[] {
  const remediation: string[] = [];
  if (blockers.includes('merchant_not_sandbox')) {
    remediation.push('Use a sandbox merchant; UCP-style preview does not run against live merchants.');
  }
  if (blockers.includes('merchant_public_profile_incomplete')) {
    remediation.push('Complete public-safe display name, category, country, and currency evidence.');
  }
  if (blockers.includes('catalog_capability_evidence_missing')) {
    remediation.push('Add public-safe active products and variants before marking catalog discovery capabilities as preview-available.');
  }
  if (blockers.includes('price_or_availability_evidence_missing')) {
    remediation.push('Add variant price, currency, and availability evidence before marking inventory/offer discovery as preview-available.');
  }
  if (blockers.includes('ucp_certification_not_claimed')) {
    remediation.push('Keep UCP-style output in the Grantex-owned preview namespace until separate protocol review exists.');
  }
  if (blockers.includes('public_discovery_not_enabled_by_preview')) {
    remediation.push('Use this authenticated preview endpoint for review; do not enable public discovery from C6K.');
  }
  if (blockers.includes('runtime_execution_not_enabled_by_preview')) {
    remediation.push('Keep checkout, payment, fulfillment, refund, provider, and live paths blocked until separate approvals exist.');
  }
  if (blockers.includes('runtime_execution_flag_enabled')) {
    remediation.push('Disable runtime execution before using this preview as read-only capability review evidence.');
  }
  return remediation;
}

function capability(
  suffix: string,
  label: string,
  status: UcpCapabilityStatus,
  category: UcpCapabilityPreviewCapability['category'],
  mapsToGrantexTool: string | null,
  requiredScopes: readonly string[],
  blockers: string[],
): UcpCapabilityPreviewCapability {
  return {
    id: namespaceId(`capability.${suffix}`),
    namespace: GRANTEX_UCP_PREVIEW_NAMESPACE,
    label,
    status,
    category,
    maps_to_grantex_tool: mapsToGrantexTool,
    required_scopes: [...requiredScopes],
    preview_only: true,
    non_enabling: true,
    blockers,
  };
}

function transport(
  suffix: string,
  kind: UcpCapabilityPreviewTransport['kind'],
  endpointTemplate: UcpCapabilityPreviewTransport['endpoint_template'],
): UcpCapabilityPreviewTransport {
  return {
    id: namespaceId(`transport.${suffix}`),
    namespace: GRANTEX_UCP_PREVIEW_NAMESPACE,
    kind,
    endpoint_template: endpointTemplate,
    auth_required: true,
    preview_only: true,
    public_route_enabled: false,
    runtime_enabled_by_preview: false,
    status: 'metadata_only',
  };
}

function basePreview(generatedAt: string): UcpCapabilityProfilePreview {
  const transports = [
    transport('native_rest', 'native_rest', '/v1/commerce'),
    transport('mcp_streamable_http', 'mcp_streamable_http', '/mcp'),
  ];
  return {
    status: 'blocked',
    message: 'UCP-style capability profile preview is blocked until sandbox merchant evidence exists.',
    preview_only: true,
    profile_style: 'ucp_style_preview',
    namespace: GRANTEX_UCP_PREVIEW_NAMESPACE,
    profile_version: 'c6k-preview-1',
    ucp_publication_enabled: false,
    ucp_certification_claim: 'none',
    certified_ucp_namespace_published: false,
    external_ucp_namespace_used: false,
    certified_capabilities_published: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    certification_claims: [],
    generated_at: generatedAt,
    merchant_preview: {
      display_name: null,
      category_preset: null,
      country_code: null,
      default_currency: null,
      readiness_state: 'unknown',
      agentic_commerce_requested: false,
    },
    services: [],
    capabilities: [],
    transports,
    controls: {
      sandbox_only: true,
      public_discovery_route_enabled: false,
      commerce_v1_runtime_enabled_by_preview: false,
      checkout_payment_creation_enabled_by_preview: false,
      live_payment_enabled_by_preview: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY]: false,
      provider_credentials_exposed: false,
      production_allowlist_written: false,
      ucp_publication_enabled: false,
      ucp_certification_claim: 'none',
    },
    blockers: [],
    remediation_items: [],
    source_reference: {
      system: 'grantex',
      canonical_state: 'merchant_catalog_readiness_capability_controls',
      endpoint_template: '/v1/commerce/merchants/{merchant_id}/ucp-capability-profile-preview',
      tenant_scoped: true,
    },
    evidence_summary: {
      product_count: 0,
      variant_count: 0,
      variants_with_price_currency: 0,
      variants_with_known_availability: 0,
      products_with_public_safe_title: 0,
      read_only_capability_count: 0,
      blocked_capability_count: 0,
      transport_count: transports.length,
      default_grantex_tool_count: 0,
      readiness_state: 'unknown',
      read_only: true,
      public_safe: true,
    },
  };
}

function buildPreview(
  merchant: MerchantRow,
  catalog: CatalogSummaryRow | null,
  generatedAt: string,
): UcpCapabilityProfilePreview {
  const preview = basePreview(generatedAt);
  const readinessState = readinessStateOrUnknown(merchant.sandbox_onboarding_state);
  const productCount = countValue(catalog?.product_count);
  const variantCount = countValue(catalog?.variant_count);
  const pricedVariantCount = countValue(catalog?.variants_with_price_currency);
  const availableVariantCount = countValue(catalog?.variants_with_known_availability);
  const safeTitleCount = countValue(catalog?.products_with_public_safe_title);
  const safeDescriptionCount = countValue(catalog?.products_with_public_safe_description);
  const unsafeTextCount = countValue(catalog?.products_with_unsafe_text)
    + countValue(catalog?.variants_with_unsafe_text);
  const defaultTools = asDefaultGrantexTools(merchant.default_capabilities);
  const displayName = publicTextOrNull(merchant.display_name);
  const categoryPreset = publicEnumOrNull(merchant.category_preset);
  const countryCode = publicCountryOrNull(merchant.country_code);
  const defaultCurrency = publicCurrencyOrNull(merchant.default_currency);
  const profileComplete = Boolean(displayName && categoryPreset && countryCode && defaultCurrency);
  const catalogReady = productCount > 0
    && variantCount > 0
    && safeTitleCount >= productCount
    && safeDescriptionCount >= productCount
    && unsafeTextCount === 0;
  const offerReady = variantCount > 0
    && pricedVariantCount >= variantCount
    && availableVariantCount >= variantCount;

  preview.merchant_preview = {
    display_name: displayName,
    category_preset: categoryPreset,
    country_code: countryCode,
    default_currency: defaultCurrency,
    readiness_state: readinessState,
    agentic_commerce_requested: merchant.agentic_commerce_requested === true,
  };

  const profileBlockers = profileComplete ? [] : ['merchant_public_profile_incomplete'];
  const catalogBlockers = catalogReady ? [] : ['catalog_capability_evidence_missing'];
  const offerBlockers = offerReady ? [] : ['price_or_availability_evidence_missing'];
  const alwaysBlocked = [
    'public_discovery_not_enabled_by_preview',
    'runtime_execution_not_enabled_by_preview',
  ];

  const capabilities: UcpCapabilityPreviewCapability[] = [
    capability(
      'merchant_profile.read',
      'Merchant profile read preview',
      profileComplete ? 'preview_available' : 'blocked',
      'read_only_discovery',
      'merchant.get_profile',
      READ_ONLY_TOOL_TO_SCOPES['merchant.get_profile'] ?? [],
      profileBlockers,
    ),
    capability(
      'catalog.search',
      'Catalog search preview',
      catalogReady ? 'preview_available' : 'blocked',
      'read_only_discovery',
      'catalog.search',
      READ_ONLY_TOOL_TO_SCOPES['catalog.search'] ?? [],
      catalogBlockers,
    ),
    capability(
      'catalog.item.read',
      'Catalog item read preview',
      catalogReady ? 'preview_available' : 'blocked',
      'read_only_discovery',
      'catalog.get_item',
      READ_ONLY_TOOL_TO_SCOPES['catalog.get_item'] ?? [],
      catalogBlockers,
    ),
    capability(
      'inventory.availability.read',
      'Inventory availability read preview',
      offerReady ? 'preview_available' : 'blocked',
      'read_only_discovery',
      'inventory.check',
      READ_ONLY_TOOL_TO_SCOPES['inventory.check'] ?? [],
      offerBlockers,
    ),
    ...NON_ENABLING_WRITE_TOOLS.map((tool) => capability(
      tool.replace(/\./g, '_'),
      `${tool} metadata only`,
      'blocked',
      'non_enabling_write_preview',
      tool,
      tool === 'cart.create' ? ['commerce:catalog.read'] : V1_COMMERCE_REQUIRED_SCOPES.checkout,
      alwaysBlocked,
    )),
    capability(
      'fulfillment.execute',
      'Fulfillment execution',
      'blocked',
      'unsupported_execution',
      null,
      [],
      ['runtime_execution_not_enabled_by_preview'],
    ),
    capability(
      'refund.return.execute',
      'Refund and return execution',
      'blocked',
      'unsupported_execution',
      null,
      [],
      ['runtime_execution_not_enabled_by_preview'],
    ),
  ];

  preview.capabilities = capabilities;
  preview.services = [{
    id: namespaceId('service.commerce_discovery'),
    namespace: GRANTEX_UCP_PREVIEW_NAMESPACE,
    kind: 'commerce_discovery_preview',
    label: 'Grantex Commerce discovery capability preview',
    status: capabilities.some((item) => item.status === 'preview_available') ? 'preview_available' : 'blocked',
    preview_only: true,
    capability_ids: capabilities.map((item) => item.id),
  }];

  if (merchant.environment !== 'sandbox') addUnique(preview.blockers, 'merchant_not_sandbox');
  if (!profileComplete) addUnique(preview.blockers, 'merchant_public_profile_incomplete');
  if (!catalogReady) addUnique(preview.blockers, 'catalog_capability_evidence_missing');
  if (!offerReady) addUnique(preview.blockers, 'price_or_availability_evidence_missing');
  if (merchant.agentic_commerce_enabled === true) addUnique(preview.blockers, 'runtime_execution_flag_enabled');
  addUnique(preview.blockers, 'ucp_certification_not_claimed');
  addUnique(preview.blockers, 'public_discovery_not_enabled_by_preview');
  addUnique(preview.blockers, 'runtime_execution_not_enabled_by_preview');
  preview.remediation_items = buildRemediation(preview.blockers);
  preview.status = merchant.environment === 'sandbox' && profileComplete && catalogReady
    ? 'preview_only'
    : 'blocked';
  preview.message = preview.status === 'preview_only'
    ? 'UCP-style capability profile preview was generated in the Grantex-owned namespace. It is metadata only and does not publish or certify UCP capabilities.'
    : 'UCP-style capability profile preview is blocked until sandbox merchant and catalog evidence exists.';
  preview.evidence_summary = {
    product_count: productCount,
    variant_count: variantCount,
    variants_with_price_currency: pricedVariantCount,
    variants_with_known_availability: availableVariantCount,
    products_with_public_safe_title: safeTitleCount,
    read_only_capability_count: capabilities.filter((item) => item.category === 'read_only_discovery' && item.status === 'preview_available').length,
    blocked_capability_count: capabilities.filter((item) => item.status === 'blocked').length,
    transport_count: preview.transports.length,
    default_grantex_tool_count: defaultTools.length,
    readiness_state: readinessState,
    read_only: true,
    public_safe: true,
  };
  return preview;
}

export async function readUcpCapabilityProfilePreview(
  sql: Sql,
  input: { tenantId: string; merchantId: string; now?: Date },
): Promise<UcpCapabilityProfilePreviewContext | null> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const merchants = await sql<MerchantRow[]>`
    SELECT m.display_name, m.category_preset,
           CASE WHEN m.environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           m.default_currency, m.country_code,
           m.sandbox_onboarding_state, m.agentic_commerce_requested,
           m.agentic_commerce_enabled, cp.default_capabilities,
           m.disabled_at
      FROM commerce_merchants m
      LEFT JOIN commerce_category_presets cp
        ON cp.preset_key = m.category_preset
     WHERE m.id = ${input.merchantId}
       AND m.tenant_id = ${input.tenantId}
     LIMIT 1
  `;
  const merchant = merchants[0];
  if (!merchant || merchant.disabled_at) return null;

  if (merchant.environment !== 'sandbox') {
    const preview = buildPreview(merchant, null, generatedAt);
    return { merchantEnvironment: 'live', preview };
  }

  const rows = await sql<CatalogSummaryRow[]>`
    SELECT COUNT(DISTINCT p.id)::int AS product_count,
           COUNT(v.id)::int AS variant_count,
           COUNT(v.id) FILTER (
             WHERE v.price_amount IS NOT NULL
               AND v.currency IS NOT NULL
               AND v.currency ~ '^[A-Z]{3}$'
          )::int AS variants_with_price_currency,
          COUNT(v.id) FILTER (
             WHERE v.availability_status <> 'unknown'
           )::int AS variants_with_known_availability,
           COUNT(DISTINCT p.id) FILTER (
             WHERE p.title IS NOT NULL
               AND btrim(p.title) <> ''
               AND NOT (
                 p.title ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
               )
           )::int AS products_with_public_safe_title,
           COUNT(DISTINCT p.id) FILTER (
             WHERE p.description IS NOT NULL
               AND btrim(p.description) <> ''
               AND NOT (
                 p.description ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
               )
           )::int AS products_with_public_safe_description,
           COUNT(DISTINCT p.id) FILTER (
             WHERE p.title ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(p.brand, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(p.description, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(p.image_url, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
           )::int AS products_with_unsafe_text,
           COUNT(v.id) FILTER (
             WHERE COALESCE(v.sku, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(v.parent_sku, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(v.model, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(v.variant_title, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(v.warranty_summary, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
                OR COALESCE(v.return_policy_summary, '') ~* '-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres://|postgresql://|redis://|\\m(api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret|checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\\M'
           )::int AS variants_with_unsafe_text
      FROM commerce_products p
      LEFT JOIN commerce_product_variants v
        ON v.product_id = p.id
       AND v.tenant_id = p.tenant_id
       AND v.merchant_id = p.merchant_id
       AND v.archived_at IS NULL
     WHERE p.tenant_id = ${input.tenantId}
       AND p.merchant_id = ${input.merchantId}
       AND p.archived_at IS NULL
  `;

  return {
    merchantEnvironment: 'sandbox',
    preview: buildPreview(merchant, rows[0] ?? null, generatedAt),
  };
}
