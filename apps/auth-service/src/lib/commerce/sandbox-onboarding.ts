export const SANDBOX_ONBOARDING_STATES = [
  'draft_created',
  'profile_incomplete',
  'sandbox_ready',
  'submitted_for_review',
  'blocked',
  'not_approved',
  'rollout_not_requested',
] as const;

export type SandboxOnboardingState = typeof SANDBOX_ONBOARDING_STATES[number];

export type SandboxReadinessStatus = 'pass' | 'fail' | 'blocked';
export type CategoryReadinessSeverity = 'required' | 'recommended' | 'blocked';
export type CategoryReadinessItemStatus = 'pass' | 'fail' | 'blocked' | 'not_applicable';

export interface SandboxOnboardingCatalogSummary {
  product_count?: number | string | null;
  variant_count?: number | string | null;
  variants_with_warranty_summary?: number | string | null;
  variants_with_return_policy_summary?: number | string | null;
  variants_with_tax_metadata?: number | string | null;
  variants_with_fresh_inventory?: number | string | null;
  variants_with_known_availability?: number | string | null;
}

export interface SandboxOnboardingMerchant {
  id: string;
  tenant_id: string;
  display_name: string | null;
  category_preset: string | null;
  environment: string | null;
  agentic_commerce_enabled: boolean | null;
  default_currency: string | null;
  country_code: string | null;
  support_email: string | null;
  support_url?: string | null;
  public_discovery_description_draft?: string | null;
  agentic_commerce_requested?: boolean | null;
  sandbox_onboarding_state?: string | null;
  sandbox_onboarding_blocker?: string | null;
  sandbox_onboarding_updated_at?: string | Date | null;
  provider_account_refs?: unknown;
}

export interface CategoryReadinessItem {
  key:
    | 'category_preset_recognized'
    | 'public_display_name_present'
    | 'country_currency_present'
    | 'public_safe_description_present'
    | 'support_contact_present'
    | 'product_data_readiness'
    | 'warranty_summary'
    | 'return_policy_summary'
    | 'tax_gst_metadata'
    | 'inventory_freshness'
    | 'private_artifacts_not_stored'
    | 'no_production_allowlist_config_values'
    | 'no_live_provider_path'
    | 'no_checkout_payment_enablement';
  label: string;
  description: string;
  severity: CategoryReadinessSeverity;
  status: CategoryReadinessItemStatus;
  remediation: string;
}

export interface CategoryReadinessScore {
  passed: number;
  total: number;
  percentage: number;
  required_passed: number;
  required_total: number;
  blocked: number;
}

export interface SandboxCategoryReadiness {
  preset_key: string | null;
  label: string;
  status: SandboxReadinessStatus;
  required_passed: boolean;
  score_percent: number;
  score: CategoryReadinessScore;
  items: CategoryReadinessItem[];
  summary: string;
}

export interface SandboxOnboardingCheck {
  key:
    | 'merchant_profile_present'
    | 'category_preset_selected'
    | 'public_safe_description_present'
    | 'private_artifacts_not_stored'
    | 'no_production_allowlist_config_values'
    | 'no_live_provider_path'
    | 'no_checkout_payment_enablement';
  label: string;
  status: 'pass' | 'blocked';
  detail: string;
}

export interface SandboxOnboardingReadiness {
  ready: boolean;
  status: SandboxReadinessStatus;
  score_percent: number;
  checks: SandboxOnboardingCheck[];
  category_readiness: SandboxCategoryReadiness;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  rollout_status: 'rollout_not_requested';
}

export interface SandboxOnboardingResponse {
  merchant_id: string;
  tenant_id: string;
  display_name: string | null;
  category_preset: string | null;
  country_code: string | null;
  default_currency: string | null;
  support_email: string | null;
  support_url: string | null;
  public_discovery_description_draft: string | null;
  environment: 'sandbox';
  agentic_commerce_requested: boolean;
  agentic_commerce_enabled: boolean;
  sandbox_onboarding_state: SandboxOnboardingState;
  sandbox_onboarding_blocker: string | null;
  sandbox_onboarding_updated_at: string | null;
  readiness: SandboxOnboardingReadiness;
}

const SAFE_SUPPORT_HOST_SUFFIXES = ['.example', '.test', '.invalid', '.localhost'];
const ELECTRONICS_APPLIANCES_PRESET = 'electronics_appliances';
const CATEGORY_LABELS: Record<string, string> = {
  [ELECTRONICS_APPLIANCES_PRESET]: 'Electronics and appliances',
};
const FORBIDDEN_PUBLIC_TEXT = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|jwt|bearer|password|credential|webhook[_-]?secret)\b/i,
  /\b(?:postgres|postgresql|redis):\/\//i,
  /\b(?:checkout|payment|payments|paid|provider|production|live|allowlist|approved|certified|certification|ready)\b/i,
];

export function isSandboxOnboardingState(value: unknown): value is SandboxOnboardingState {
  return typeof value === 'string'
    && (SANDBOX_ONBOARDING_STATES as readonly string[]).includes(value);
}

export function isPublicSafeText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000) return false;
  return !FORBIDDEN_PUBLIC_TEXT.some((pattern) => pattern.test(trimmed));
}

export function isSafeSupportEmail(value: string): boolean {
  if (value.length > 254 || /[\r\n\t]/.test(value)) return false;
  const match = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(value);
  if (!match) return false;
  const domain = match[1]!.toLowerCase();
  return SAFE_SUPPORT_HOST_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

export function isSafeSupportUrl(value: string): boolean {
  if (value.length > 512 || FORBIDDEN_PUBLIC_TEXT.some((pattern) => pattern.test(value))) {
    return false;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || SAFE_SUPPORT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function providerRefsEmpty(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function envFlagEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  return String(env[key] ?? '').toLowerCase() === 'true';
}

function envValueSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function countValue(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function check(
  key: SandboxOnboardingCheck['key'],
  label: string,
  pass: boolean,
  passDetail: string,
  blockedDetail: string,
): SandboxOnboardingCheck {
  return {
    key,
    label,
    status: pass ? 'pass' : 'blocked',
    detail: pass ? passDetail : blockedDetail,
  };
}

function categoryItem(
  key: CategoryReadinessItem['key'],
  label: string,
  description: string,
  severity: CategoryReadinessSeverity,
  status: CategoryReadinessItemStatus,
  remediation: string,
): CategoryReadinessItem {
  return { key, label, description, severity, status, remediation };
}

function passFail(pass: boolean): 'pass' | 'fail' {
  return pass ? 'pass' : 'fail';
}

function categoryScore(items: CategoryReadinessItem[]): CategoryReadinessScore {
  const applicable = items.filter((item) => item.status !== 'not_applicable');
  const required = items.filter((item) => item.severity === 'required');
  const passed = applicable.filter((item) => item.status === 'pass').length;
  const total = applicable.length;
  return {
    passed,
    total,
    percentage: total === 0 ? 0 : Math.round((passed / total) * 100),
    required_passed: required.filter((item) => item.status === 'pass').length,
    required_total: required.length,
    blocked: items.filter((item) => item.status === 'blocked').length,
  };
}

export function computeSandboxCategoryReadiness(
  merchant: SandboxOnboardingMerchant,
  catalogSummary: SandboxOnboardingCatalogSummary | null = null,
  env: NodeJS.ProcessEnv = process.env,
): SandboxCategoryReadiness {
  const publicFields = [
    merchant.display_name,
    merchant.support_email,
    merchant.support_url,
    merchant.public_discovery_description_draft,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const description = merchant.public_discovery_description_draft?.trim() ?? '';
  const supportEmailSafe = merchant.support_email === null || merchant.support_email === undefined
    || isSafeSupportEmail(merchant.support_email);
  const supportUrlSafe = merchant.support_url === null || merchant.support_url === undefined
    || isSafeSupportUrl(merchant.support_url);
  const supportContactPresent = Boolean(
    (merchant.support_email && isSafeSupportEmail(merchant.support_email))
    || (merchant.support_url && isSafeSupportUrl(merchant.support_url)),
  );
  const noPrivateArtifacts = publicFields.every(isPublicSafeText) && supportEmailSafe && supportUrlSafe;
  const noProductionConfig = !envFlagEnabled(env, 'COMMERCE_PUBLIC_DISCOVERY_ENABLED')
    && !envValueSet(env, 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST')
    && !envFlagEnabled(env, 'COMMERCE_LIVE_MODE_ENABLED')
    && !envFlagEnabled(env, 'P' + 'LURAL_LIVE_ENABLED');
  const noLiveProvider = merchant.environment === 'sandbox' && providerRefsEmpty(merchant.provider_account_refs);
  const noCheckoutPayment = merchant.agentic_commerce_enabled !== true;
  const preset = merchant.category_preset?.trim() || null;
  const presetRecognized = preset === ELECTRONICS_APPLIANCES_PRESET;
  const productCount = countValue(catalogSummary?.product_count);
  const variantCount = countValue(catalogSummary?.variant_count);
  const warrantyCount = countValue(catalogSummary?.variants_with_warranty_summary);
  const returnPolicyCount = countValue(catalogSummary?.variants_with_return_policy_summary);
  const taxMetadataCount = countValue(catalogSummary?.variants_with_tax_metadata);
  const freshInventoryCount = countValue(catalogSummary?.variants_with_fresh_inventory);
  const knownAvailabilityCount = countValue(catalogSummary?.variants_with_known_availability);
  const hasVariants = variantCount > 0;
  const taxApplicable = merchant.country_code === 'IN';

  const items: CategoryReadinessItem[] = [
    categoryItem(
      'category_preset_recognized',
      'Category preset recognized',
      'The sandbox profile must select the V1 launch preset for category-specific scoring.',
      'required',
      !preset ? 'fail' : presetRecognized ? 'pass' : 'blocked',
      !preset
        ? 'Select the electronics_appliances category preset.'
        : 'Unsupported category preset for C6A. Use electronics_appliances or defer this merchant until the preset is implemented.',
    ),
    categoryItem(
      'public_display_name_present',
      'Public display name present',
      'Agents need a public merchant name for read-only sandbox discovery preview.',
      'required',
      passFail(Boolean(merchant.display_name?.trim())),
      'Add a public-safe display name.',
    ),
    categoryItem(
      'country_currency_present',
      'Country and currency present',
      'Country and default currency anchor category-specific tax and pricing expectations.',
      'required',
      passFail(Boolean(merchant.country_code?.match(/^[A-Z]{2}$/) && merchant.default_currency?.match(/^[A-Z]{3}$/))),
      'Add ISO country and currency values, for example IN and INR in sandbox fixtures.',
    ),
    categoryItem(
      'public_safe_description_present',
      'Public-safe description present',
      'The discovery description draft must avoid payment, provider, launch, approval, or certification claims.',
      'required',
      passFail(description.length > 0 && isPublicSafeText(description)),
      'Add a public-safe sandbox description without payment, provider, live, approval, readiness, or certification claims.',
    ),
    categoryItem(
      'support_contact_present',
      'Support contact present',
      'Sandbox merchants need a repo-safe support email or URL so operators can preview support handoff copy.',
      'required',
      passFail(supportContactPresent),
      'Add a test-safe support email or URL on .example, .test, .invalid, or localhost.',
    ),
    categoryItem(
      'product_data_readiness',
      'Product data readiness',
      'Electronics/appliances preview scoring looks for at least one active product with one purchasable variant.',
      'recommended',
      passFail(productCount > 0 && variantCount > 0),
      'Add at least one sandbox product and variant through the existing catalog APIs. Catalog connector work is deferred.',
    ),
    categoryItem(
      'warranty_summary',
      'Warranty summary',
      'Electronics/appliances variants should expose warranty summary text before agent-facing preview.',
      'recommended',
      passFail(hasVariants && warrantyCount >= variantCount),
      'Add warranty_summary on every active sandbox variant.',
    ),
    categoryItem(
      'return_policy_summary',
      'Return-policy summary',
      'Electronics/appliances variants should expose return-policy summary text before agent-facing preview.',
      'recommended',
      passFail(hasVariants && returnPolicyCount >= variantCount),
      'Add return_policy_summary on every active sandbox variant.',
    ),
    categoryItem(
      'tax_gst_metadata',
      'Tax/GST metadata',
      'India electronics/appliances variants should carry GST, tax-rate, or HSN metadata for operator review.',
      'recommended',
      taxApplicable ? passFail(hasVariants && taxMetadataCount >= variantCount) : 'not_applicable',
      taxApplicable
        ? 'Add GST slab, tax rate, or HSN code metadata on every active sandbox variant.'
        : 'Tax/GST metadata is not applicable for the selected country in this sandbox checklist.',
    ),
    categoryItem(
      'inventory_freshness',
      'Inventory freshness',
      'Inventory readiness checks availability buckets and 24-hour freshness without exposing exact quantities.',
      'recommended',
      passFail(hasVariants && freshInventoryCount >= variantCount && knownAvailabilityCount >= variantCount),
      'Keep variant last_synced_at within 24 hours and avoid unknown availability buckets. Quantity/reservation is deferred.',
    ),
    categoryItem(
      'private_artifacts_not_stored',
      'Private artifacts not stored',
      'Public/runtime fields must not carry private contracts, credentials, tokens, raw payloads, or private contact material.',
      'blocked',
      noPrivateArtifacts ? 'pass' : 'blocked',
      'Remove private details, secrets, credentials, tokens, raw payloads, or unsupported support contact material.',
    ),
    categoryItem(
      'no_production_allowlist_config_values',
      'No production allowlist/config values',
      'Sandbox readiness cannot depend on production discovery, allowlist, live mode, or live provider flags.',
      'blocked',
      noProductionConfig ? 'pass' : 'blocked',
      'Remove public discovery, production allowlist, Commerce live mode, or live provider flags from this context.',
    ),
    categoryItem(
      'no_live_provider_path',
      'No live provider path',
      'Sandbox onboarding cannot carry live environment markers or provider account references.',
      'blocked',
      noLiveProvider ? 'pass' : 'blocked',
      'Keep the merchant sandbox-only with no provider account references.',
    ),
    categoryItem(
      'no_checkout_payment_enablement',
      'No checkout/payment enablement',
      'C6A only scores read-only sandbox preview readiness; checkout/payment execution remains disabled.',
      'blocked',
      noCheckoutPayment ? 'pass' : 'blocked',
      'Disable agentic commerce execution before marking sandbox onboarding ready.',
    ),
  ];

  const score = categoryScore(items);
  const requiredItems = items.filter((item) => item.severity === 'required');
  const requiredPassed = requiredItems.every((item) => item.status === 'pass');
  const blocked = items.some((item) => item.status === 'blocked');
  const status: SandboxReadinessStatus = blocked ? 'blocked' : requiredPassed ? 'pass' : 'fail';
  const label = preset && CATEGORY_LABELS[preset] ? CATEGORY_LABELS[preset] : 'Unsupported category preset';
  return {
    preset_key: preset,
    label,
    status,
    required_passed: requiredPassed,
    score_percent: score.percentage,
    score,
    items,
    summary: status === 'pass'
      ? 'Required sandbox category fields pass. Recommended catalog details may still need completion before later slices.'
      : status === 'blocked'
        ? 'Sandbox category readiness is blocked by unsupported, private, production, live-provider, or checkout/payment state.'
        : 'Required sandbox category fields are incomplete.',
  };
}

export function computeSandboxOnboardingReadiness(
  merchant: SandboxOnboardingMerchant,
  env: NodeJS.ProcessEnv = process.env,
  catalogSummary: SandboxOnboardingCatalogSummary | null = null,
): SandboxOnboardingReadiness {
  const description = merchant.public_discovery_description_draft?.trim() ?? '';
  const publicFields = [
    merchant.display_name,
    merchant.support_email,
    merchant.support_url,
    merchant.public_discovery_description_draft,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const profilePresent = Boolean(
    merchant.display_name?.trim()
    && merchant.country_code?.match(/^[A-Z]{2}$/)
    && merchant.default_currency?.match(/^[A-Z]{3}$/)
    && merchant.environment === 'sandbox',
  );
  const categorySelected = merchant.category_preset === 'electronics_appliances';
  const safeDescriptionPresent = description.length > 0 && isPublicSafeText(description);
  const noPrivateArtifacts = publicFields.every(isPublicSafeText)
    && (merchant.support_email === null || merchant.support_email === undefined
      || isSafeSupportEmail(merchant.support_email))
    && (merchant.support_url === null || merchant.support_url === undefined
      || isSafeSupportUrl(merchant.support_url));
  const noProductionConfig = !envFlagEnabled(env, 'COMMERCE_PUBLIC_DISCOVERY_ENABLED')
    && !envValueSet(env, 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST')
    && !envFlagEnabled(env, 'COMMERCE_LIVE_MODE_ENABLED')
    && !envFlagEnabled(env, 'P' + 'LURAL_LIVE_ENABLED');
  const noLiveProvider = merchant.environment === 'sandbox' && providerRefsEmpty(merchant.provider_account_refs);
  const noCheckoutPayment = merchant.agentic_commerce_enabled !== true;

  const checks: SandboxOnboardingCheck[] = [
    check(
      'merchant_profile_present',
      'Merchant profile present',
      profilePresent,
      'Display name, country, currency, and sandbox marker are present.',
      'Display name, country, currency, and sandbox marker are required.',
    ),
    check(
      'category_preset_selected',
      'Category preset selected',
      categorySelected,
      'The electronics_appliances preset is selected.',
      'Select the V1 electronics_appliances category preset.',
    ),
    check(
      'public_safe_description_present',
      'Public-safe description present',
      safeDescriptionPresent,
      'Description draft is present and avoids rollout, provider, or payment claims.',
      'Add a public-safe description draft with no payment, provider, live, certification, or readiness claims.',
    ),
    check(
      'private_artifacts_not_stored',
      'Private artifacts not stored',
      noPrivateArtifacts,
      'Public fields contain only repo-safe text and test-safe support contact material.',
      'Remove private details, secrets, credentials, tokens, raw payloads, or unsupported support contact material.',
    ),
    check(
      'no_production_allowlist_config_values',
      'No production allowlist/config values',
      noProductionConfig,
      'Public discovery and live-mode config values are absent.',
      'Remove public discovery, production allowlist, Commerce live mode, or live provider flags from this context.',
    ),
    check(
      'no_live_provider_path',
      'No live provider path',
      noLiveProvider,
      'Merchant remains sandbox-only with no provider account references.',
      'Sandbox onboarding cannot carry live environment markers or provider account references.',
    ),
    check(
      'no_checkout_payment_enablement',
      'No checkout/payment enablement',
      noCheckoutPayment,
      'Agentic commerce is requested only; checkout/payment enablement remains false.',
      'Disable agentic commerce execution before marking sandbox onboarding ready.',
    ),
  ];

  const categoryReadiness = computeSandboxCategoryReadiness(merchant, catalogSummary, env);
  const baselineReady = checks.every((item) => item.status === 'pass');
  const ready = baselineReady && categoryReadiness.status === 'pass';
  const status: SandboxReadinessStatus = !baselineReady || categoryReadiness.status === 'blocked'
    ? 'blocked'
    : ready ? 'pass' : 'fail';

  return {
    ready,
    status,
    score_percent: categoryReadiness.score_percent,
    checks,
    category_readiness: categoryReadiness,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    rollout_status: 'rollout_not_requested',
  };
}

export function deriveSandboxOnboardingState(
  current: SandboxOnboardingState,
  readiness: SandboxOnboardingReadiness,
): SandboxOnboardingState {
  if (current === 'submitted_for_review' || current === 'not_approved' || current === 'rollout_not_requested') {
    return current;
  }
  return readiness.ready ? 'sandbox_ready' : 'profile_incomplete';
}

const ALLOWED_TRANSITIONS: Record<SandboxOnboardingState, SandboxOnboardingState[]> = {
  draft_created: ['profile_incomplete', 'sandbox_ready', 'blocked', 'rollout_not_requested'],
  profile_incomplete: ['sandbox_ready', 'blocked', 'rollout_not_requested'],
  sandbox_ready: ['submitted_for_review', 'blocked', 'rollout_not_requested'],
  submitted_for_review: ['blocked', 'not_approved', 'rollout_not_requested'],
  blocked: ['profile_incomplete', 'sandbox_ready', 'not_approved', 'rollout_not_requested'],
  not_approved: ['draft_created', 'profile_incomplete', 'blocked', 'rollout_not_requested'],
  rollout_not_requested: ['draft_created', 'profile_incomplete', 'sandbox_ready', 'submitted_for_review', 'blocked'],
};

export function validateSandboxOnboardingTransition(
  current: SandboxOnboardingState,
  target: SandboxOnboardingState,
  readiness: SandboxOnboardingReadiness,
): string | null {
  if (current === target) return null;
  if (!ALLOWED_TRANSITIONS[current].includes(target)) {
    return `cannot transition sandbox onboarding from ${current} to ${target}`;
  }
  if ((target === 'sandbox_ready' || target === 'submitted_for_review') && !readiness.ready) {
    return 'sandbox onboarding readiness checks must pass before this transition';
  }
  return null;
}

export function toSandboxOnboardingResponse(
  merchant: SandboxOnboardingMerchant,
  readiness = computeSandboxOnboardingReadiness(merchant),
): SandboxOnboardingResponse {
  const state = isSandboxOnboardingState(merchant.sandbox_onboarding_state)
    ? merchant.sandbox_onboarding_state
    : 'draft_created';
  return {
    merchant_id: merchant.id,
    tenant_id: merchant.tenant_id,
    display_name: merchant.display_name ?? null,
    category_preset: merchant.category_preset ?? null,
    country_code: merchant.country_code ?? null,
    default_currency: merchant.default_currency ?? null,
    support_email: merchant.support_email ?? null,
    support_url: merchant.support_url ?? null,
    public_discovery_description_draft: merchant.public_discovery_description_draft ?? null,
    environment: 'sandbox',
    agentic_commerce_requested: merchant.agentic_commerce_requested === true,
    agentic_commerce_enabled: merchant.agentic_commerce_enabled === true,
    sandbox_onboarding_state: state,
    sandbox_onboarding_blocker: merchant.sandbox_onboarding_blocker ?? null,
    sandbox_onboarding_updated_at: merchant.sandbox_onboarding_updated_at
      ? new Date(merchant.sandbox_onboarding_updated_at).toISOString()
      : null,
    readiness,
  };
}
