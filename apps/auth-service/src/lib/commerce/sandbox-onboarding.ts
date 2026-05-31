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
  checks: SandboxOnboardingCheck[];
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

export function computeSandboxOnboardingReadiness(
  merchant: SandboxOnboardingMerchant,
  env: NodeJS.ProcessEnv = process.env,
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

  return {
    ready: checks.every((item) => item.status === 'pass'),
    checks,
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
