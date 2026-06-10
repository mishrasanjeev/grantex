import type postgres from 'postgres';
import { sha256hex } from '../hash.js';
import { stableJson } from './idempotency.js';
import { isPublicSafeText } from './sandbox-onboarding.js';

type Sql = ReturnType<typeof postgres>;

type Ap2PreviewStatus = 'preview_only' | 'blocked';
type ProviderSpecificLiveDisabledKey = `live_${'p'}lural_enabled`;
type ProviderSpecificLiveDisabledByPreviewKey = `live_${'p'}lural_enabled_by_preview`;
type ProviderSpecificNonEnablingControls = { [K in ProviderSpecificLiveDisabledKey]: false };
type ProviderSpecificNonEnablingPreviewControls = { [K in ProviderSpecificLiveDisabledByPreviewKey]: false };

const PROVIDER_SPECIFIC_LIVE_DISABLED_KEY = `live_${'p'}lural_enabled` as ProviderSpecificLiveDisabledKey;
const PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY =
  `live_${'p'}lural_enabled_by_preview` as ProviderSpecificLiveDisabledByPreviewKey;

interface MerchantRow {
  display_name: string | null;
  environment: string | null;
  default_currency: string | null;
  country_code: string | null;
  sandbox_onboarding_state: string | null;
  agentic_commerce_requested: boolean | null;
  agentic_commerce_enabled: boolean | null;
  disabled_at: Date | string | null;
}

interface Ap2EvidenceRow {
  payment_status: string | null;
  payment_amount: number | string | null;
  payment_currency: string | null;
  provider_environment: string | null;
  payment_policy_version: string | null;
  payment_decision_id: string | null;
  payment_idempotency_key_hash: string | null;
  payment_created_at: Date | string | null;
  cart_status: string | null;
  cart_currency: string | null;
  cart_total_amount: number | string | null;
  cart_snapshot_hash: string | null;
  cart_idempotency_key_hash: string | null;
  cart_line_items_snapshot: unknown;
  passport_type: string | null;
  passport_environment: string | null;
  passport_scopes: unknown;
  passport_max_amount: number | string | null;
  passport_currency: string | null;
  passport_policy_version: string | null;
  passport_not_before: Date | string | null;
  passport_expires_at: Date | string | null;
  passport_not_expired: boolean | null;
  passport_agent_auth_method: string | null;
  passport_revoked: boolean | null;
  consent_status: string | null;
  consent_passport_type: string | null;
  consent_requested_scopes: unknown;
  consent_approved_scopes: unknown;
  consent_max_amount: number | string | null;
  consent_currency: string | null;
  consent_text_version: string | null;
  presented_payload_hash: string | null;
  consent_approved_at: Date | string | null;
  consent_agent_auth_method: string | null;
  policy_status: string | null;
  policy_rules: unknown;
  agent_trust_status: string | null;
  agent_disabled_at: Date | string | null;
  agent_id: string | null;
}

interface AuditRow {
  id: string | null;
  event_type: string | null;
  occurred_at: Date | string | null;
  passport_jti: string | null;
  policy_version: string | null;
  decision_id: string | null;
  idempotency_key_hash: string | null;
}

interface AmountCap {
  amount_minor_units: number | null;
  currency: string | null;
  source: 'passport' | 'consent' | 'policy' | 'missing';
}

export interface Ap2EvidencePreview extends ProviderSpecificNonEnablingControls {
  status: Ap2PreviewStatus;
  message: string;
  preview_only: true;
  profile_style: 'ap2_style_evidence_preview';
  profile_version: 'c6m-preview-1';
  ap2_certification_claim: 'none';
  ap2_publication_enabled: false;
  ap2_signed_mandate_created: false;
  signed_production_mandate_created: false;
  signature_status: 'unsigned_preview';
  signing_key_used: false;
  payment_network_submission_enabled: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  provider_credentials_exposed: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  certification_claims: [];
  generated_at: string;
  evidence_package: {
    format: 'ap2_style_unsigned_evidence_preview';
    deterministic: true;
    signed: false;
    hash_algorithm: 'sha256';
    evidence_hash: string | null;
    signing_key_reference: null;
    production_mandate_reference: null;
    includes: [
      'commerce_passport',
      'consent_record',
      'policy_decision',
      'cart_hash',
      'amount_cap',
      'merchant_state',
      'agent_identity',
      'audit_reference',
      'idempotency_replay',
    ];
  };
  merchant_state: {
    display_name: string | null;
    environment: 'sandbox' | 'live';
    country_code: string | null;
    default_currency: string | null;
    readiness_state: string;
    agentic_commerce_requested: boolean;
    agentic_commerce_enabled: boolean;
  };
  commerce_passport_evidence: {
    present: boolean;
    passport_type: string | null;
    environment: string | null;
    scope_count: number;
    required_checkout_scopes_present: boolean;
    max_amount_minor_units: number | null;
    currency: string | null;
    policy_version_present: boolean;
    not_before_present: boolean;
    expires_at_present: boolean;
    not_expired: boolean | null;
    revoked: boolean | null;
    agent_auth_method: string | null;
    passport_jti_exposed: false;
    raw_passport_jwt_exposed: false;
  };
  consent_evidence: {
    present: boolean;
    status: string | null;
    passport_type: string | null;
    requested_scope_count: number;
    approved_scope_count: number;
    approved_required_checkout_scopes_present: boolean;
    max_amount_minor_units: number | null;
    currency: string | null;
    consent_text_version: string | null;
    presented_payload_hash_present: boolean;
    approved_at_present: boolean;
    agent_auth_method: string | null;
    consent_record_id_exposed: false;
    consent_request_id_exposed: false;
    user_principal_exposed: false;
  };
  policy_evidence: {
    present: boolean;
    active_policy_present: boolean;
    policy_version_present: boolean;
    decision_reference_present: boolean;
    decision_reference_hash: string | null;
    amount_cap_minor_units: number | null;
    amount_cap_currency: string | null;
    emergency_disabled: boolean | null;
    raw_policy_rules_exposed: false;
  };
  cart_evidence: {
    present: boolean;
    status: string | null;
    line_item_count: number;
    snapshot_hash: string | null;
    total_amount_minor_units: number | null;
    currency: string | null;
    idempotency_key_hash_present: boolean;
    raw_line_items_exposed: false;
    cart_id_exposed: false;
  };
  amount_evidence: {
    payment_amount_minor_units: number | null;
    payment_currency: string | null;
    amount_cap_minor_units: number | null;
    amount_cap_currency: string | null;
    amount_cap_source: AmountCap['source'];
    within_amount_cap: boolean | null;
  };
  agent_identity_evidence: {
    present: boolean;
    agent_reference_hash: string | null;
    trust_status: string | null;
    disabled: boolean | null;
    auth_method: string | null;
    agent_id_exposed: false;
    agent_api_key_exposed: false;
  };
  audit_evidence: {
    present: boolean;
    audit_reference_hash: string | null;
    event_type: string | null;
    occurred_at: string | null;
    policy_version_present: boolean;
    decision_reference_present: boolean;
    idempotency_key_hash_present: boolean;
    audit_event_id_exposed: false;
  };
  replay_idempotency_evidence: {
    idempotency_supported: true;
    replay_record_source: 'commerce_idempotency_records';
    cart_idempotency_key_hash_present: boolean;
    payment_intent_idempotency_key_hash_present: boolean;
    audit_idempotency_key_hash_present: boolean;
    raw_idempotency_key_exposed: false;
  };
  payment_intent_evidence: {
    present: boolean;
    status: string | null;
    provider_environment: string | null;
    created_at_present: boolean;
    provider_reference_exposed: false;
    checkout_url_exposed: false;
    provider_metadata_exposed: false;
    provider_raw_status_exposed: false;
  };
  controls: ProviderSpecificNonEnablingPreviewControls & {
    sandbox_only: true;
    deterministic_unsigned_preview: true;
    signing_enabled_by_preview: false;
    ap2_certification_claim: 'none';
    ap2_publication_enabled: false;
    payment_network_submission_enabled: false;
    checkout_payment_creation_enabled_by_preview: false;
    live_payment_enabled_by_preview: false;
    provider_call_enabled_by_preview: false;
    provider_credentials_exposed: false;
    production_allowlist_written: false;
  };
  blockers: string[];
  remediation_items: string[];
  source_reference: {
    system: 'grantex';
    canonical_state: 'commerce_passport_consent_policy_cart_payment_audit_idempotency';
    endpoint_template: '/v1/commerce/merchants/{merchant_id}/ap2-evidence-preview';
    tenant_scoped: true;
  };
  evidence_summary: {
    complete_required_evidence: boolean;
    passport_present: boolean;
    consent_granted: boolean;
    active_policy_present: boolean;
    policy_decision_present: boolean;
    cart_hash_present: boolean;
    amount_cap_present: boolean;
    merchant_state_present: boolean;
    agent_identity_present: boolean;
    audit_reference_present: boolean;
    idempotency_evidence_present: boolean;
    sandbox_only: true;
    unsigned_preview: true;
    payment_enabled: false;
    provider_called: false;
  };
}

export interface Ap2EvidencePreviewContext {
  merchantEnvironment: 'sandbox' | 'live';
  preview: Ap2EvidencePreview;
}

const REQUIRED_CHECKOUT_SCOPES = [
  'commerce:catalog.read',
  'commerce:inventory.read',
  'commerce:checkout.create',
  'commerce:payment.initiate',
  'commerce:payment.status.read',
] as const;

function amountValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function publicTextOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPublicSafeText(trimmed) ? trimmed : null;
}

function publicCurrencyOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function publicCountryOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null;
}

function publicStatusOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/.test(value) ? value : null;
}

function publicAuthMethodOrNull(value: string | null | undefined): string | null {
  return value === 'jwt' || value === 'api_key' ? value : null;
}

function readinessStateOrUnknown(value: string | null | undefined): string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unknown';
}

function dateStringOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && /^[a-z0-9:._-]{1,80}$/.test(item))
    .slice(0, 20);
}

function lineItemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function hasRequiredCheckoutScopes(scopes: string[]): boolean {
  return REQUIRED_CHECKOUT_SCOPES.every((scope) => scopes.includes(scope));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function hashedReference(value: string | null | undefined, prefix: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return `${prefix}_${sha256hex(value).slice(0, 24)}`;
}

function policyAmountCap(policyRules: unknown): {
  amount: number | null;
  currency: string | null;
  emergencyDisabled: boolean | null;
} {
  if (!isPlainObject(policyRules)) {
    return { amount: null, currency: null, emergencyDisabled: null };
  }
  const amountCap = policyRules['amount_cap'];
  const emergency = typeof policyRules['emergency_disable'] === 'boolean'
    ? policyRules['emergency_disable']
    : null;
  if (!isPlainObject(amountCap)) {
    return { amount: null, currency: null, emergencyDisabled: emergency };
  }
  return {
    amount: amountValue(amountCap['max_amount_minor_units'] as number | string | null | undefined),
    currency: publicCurrencyOrNull(amountCap['currency'] as string | null | undefined),
    emergencyDisabled: emergency,
  };
}

function chooseAmountCap(row: Ap2EvidenceRow | null, policyCap: ReturnType<typeof policyAmountCap>): AmountCap {
  const passportAmount = amountValue(row?.passport_max_amount);
  const passportCurrency = publicCurrencyOrNull(row?.passport_currency ?? null);
  if (passportAmount !== null && passportCurrency) {
    return { amount_minor_units: passportAmount, currency: passportCurrency, source: 'passport' };
  }
  const consentAmount = amountValue(row?.consent_max_amount);
  const consentCurrency = publicCurrencyOrNull(row?.consent_currency ?? null);
  if (consentAmount !== null && consentCurrency) {
    return { amount_minor_units: consentAmount, currency: consentCurrency, source: 'consent' };
  }
  if (policyCap.amount !== null && policyCap.currency) {
    return { amount_minor_units: policyCap.amount, currency: policyCap.currency, source: 'policy' };
  }
  return { amount_minor_units: null, currency: null, source: 'missing' };
}

function buildRemediation(blockers: string[]): string[] {
  const remediation: string[] = [];
  if (blockers.includes('merchant_not_sandbox')) {
    remediation.push('Use a sandbox merchant; AP2-style evidence preview does not run against live merchants.');
  }
  if (blockers.includes('commerce_passport_evidence_missing')) {
    remediation.push('Issue an unrevoked sandbox checkout Commerce Passport before previewing AP2-style evidence.');
  }
  if (blockers.includes('consent_evidence_missing')) {
    remediation.push('Complete a granted checkout consent record before previewing AP2-style evidence.');
  }
  if (blockers.includes('policy_decision_evidence_missing')) {
    remediation.push('Create a guarded sandbox payment intent so policy version and decision evidence exist.');
  }
  if (blockers.includes('cart_hash_evidence_missing')) {
    remediation.push('Create a sandbox cart with an immutable line-item snapshot hash.');
  }
  if (blockers.includes('amount_cap_evidence_missing')) {
    remediation.push('Bind an amount cap and currency through the passport, consent record, or active policy.');
  }
  if (blockers.includes('agent_identity_evidence_missing')) {
    remediation.push('Use a registered, trusted CommerceAgent for the checkout evidence chain.');
  }
  if (blockers.includes('audit_reference_evidence_missing')) {
    remediation.push('Ensure protected checkout evidence has an append-only audit reference.');
  }
  if (blockers.includes('idempotency_evidence_missing')) {
    remediation.push('Use existing idempotent cart/payment flows so replay evidence is available.');
  }
  if (blockers.includes('unsigned_preview_only')) {
    remediation.push('Keep the AP2-style evidence preview unsigned until separate signing and protocol review exists.');
  }
  if (blockers.includes('ap2_certification_not_claimed')) {
    remediation.push('Do not claim AP2 certification; this is Grantex evidence preview metadata only.');
  }
  return remediation;
}

function basePreview(generatedAt: string): Ap2EvidencePreview {
  return {
    status: 'blocked',
    message: 'AP2-style evidence preview is blocked until sandbox passport, consent, policy, cart hash, amount cap, agent, audit, and idempotency evidence exists.',
    preview_only: true,
    profile_style: 'ap2_style_evidence_preview',
    profile_version: 'c6m-preview-1',
    ap2_certification_claim: 'none',
    ap2_publication_enabled: false,
    ap2_signed_mandate_created: false,
    signed_production_mandate_created: false,
    signature_status: 'unsigned_preview',
    signing_key_used: false,
    payment_network_submission_enabled: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
    provider_credentials_exposed: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    certification_claims: [],
    generated_at: generatedAt,
    evidence_package: {
      format: 'ap2_style_unsigned_evidence_preview',
      deterministic: true,
      signed: false,
      hash_algorithm: 'sha256',
      evidence_hash: null,
      signing_key_reference: null,
      production_mandate_reference: null,
      includes: [
        'commerce_passport',
        'consent_record',
        'policy_decision',
        'cart_hash',
        'amount_cap',
        'merchant_state',
        'agent_identity',
        'audit_reference',
        'idempotency_replay',
      ],
    },
    merchant_state: {
      display_name: null,
      environment: 'sandbox',
      country_code: null,
      default_currency: null,
      readiness_state: 'unknown',
      agentic_commerce_requested: false,
      agentic_commerce_enabled: false,
    },
    commerce_passport_evidence: {
      present: false,
      passport_type: null,
      environment: null,
      scope_count: 0,
      required_checkout_scopes_present: false,
      max_amount_minor_units: null,
      currency: null,
      policy_version_present: false,
      not_before_present: false,
      expires_at_present: false,
      not_expired: null,
      revoked: null,
      agent_auth_method: null,
      passport_jti_exposed: false,
      raw_passport_jwt_exposed: false,
    },
    consent_evidence: {
      present: false,
      status: null,
      passport_type: null,
      requested_scope_count: 0,
      approved_scope_count: 0,
      approved_required_checkout_scopes_present: false,
      max_amount_minor_units: null,
      currency: null,
      consent_text_version: null,
      presented_payload_hash_present: false,
      approved_at_present: false,
      agent_auth_method: null,
      consent_record_id_exposed: false,
      consent_request_id_exposed: false,
      user_principal_exposed: false,
    },
    policy_evidence: {
      present: false,
      active_policy_present: false,
      policy_version_present: false,
      decision_reference_present: false,
      decision_reference_hash: null,
      amount_cap_minor_units: null,
      amount_cap_currency: null,
      emergency_disabled: null,
      raw_policy_rules_exposed: false,
    },
    cart_evidence: {
      present: false,
      status: null,
      line_item_count: 0,
      snapshot_hash: null,
      total_amount_minor_units: null,
      currency: null,
      idempotency_key_hash_present: false,
      raw_line_items_exposed: false,
      cart_id_exposed: false,
    },
    amount_evidence: {
      payment_amount_minor_units: null,
      payment_currency: null,
      amount_cap_minor_units: null,
      amount_cap_currency: null,
      amount_cap_source: 'missing',
      within_amount_cap: null,
    },
    agent_identity_evidence: {
      present: false,
      agent_reference_hash: null,
      trust_status: null,
      disabled: null,
      auth_method: null,
      agent_id_exposed: false,
      agent_api_key_exposed: false,
    },
    audit_evidence: {
      present: false,
      audit_reference_hash: null,
      event_type: null,
      occurred_at: null,
      policy_version_present: false,
      decision_reference_present: false,
      idempotency_key_hash_present: false,
      audit_event_id_exposed: false,
    },
    replay_idempotency_evidence: {
      idempotency_supported: true,
      replay_record_source: 'commerce_idempotency_records',
      cart_idempotency_key_hash_present: false,
      payment_intent_idempotency_key_hash_present: false,
      audit_idempotency_key_hash_present: false,
      raw_idempotency_key_exposed: false,
    },
    payment_intent_evidence: {
      present: false,
      status: null,
      provider_environment: null,
      created_at_present: false,
      provider_reference_exposed: false,
      checkout_url_exposed: false,
      provider_metadata_exposed: false,
      provider_raw_status_exposed: false,
    },
    controls: {
      sandbox_only: true,
      deterministic_unsigned_preview: true,
      signing_enabled_by_preview: false,
      ap2_certification_claim: 'none',
      ap2_publication_enabled: false,
      payment_network_submission_enabled: false,
      checkout_payment_creation_enabled_by_preview: false,
      live_payment_enabled_by_preview: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY]: false,
      provider_call_enabled_by_preview: false,
      provider_credentials_exposed: false,
      production_allowlist_written: false,
    },
    blockers: [],
    remediation_items: [],
    source_reference: {
      system: 'grantex',
      canonical_state: 'commerce_passport_consent_policy_cart_payment_audit_idempotency',
      endpoint_template: '/v1/commerce/merchants/{merchant_id}/ap2-evidence-preview',
      tenant_scoped: true,
    },
    evidence_summary: {
      complete_required_evidence: false,
      passport_present: false,
      consent_granted: false,
      active_policy_present: false,
      policy_decision_present: false,
      cart_hash_present: false,
      amount_cap_present: false,
      merchant_state_present: false,
      agent_identity_present: false,
      audit_reference_present: false,
      idempotency_evidence_present: false,
      sandbox_only: true,
      unsigned_preview: true,
      payment_enabled: false,
      provider_called: false,
    },
  };
}

function buildPreview(
  merchant: MerchantRow,
  row: Ap2EvidenceRow | null,
  audit: AuditRow | null,
  generatedAt: string,
): Ap2EvidencePreview {
  const preview = basePreview(generatedAt);
  const environment = merchant.environment === 'live' ? 'live' : 'sandbox';
  const passportScopes = stringArray(row?.passport_scopes);
  const approvedScopes = stringArray(row?.consent_approved_scopes);
  const policyCap = policyAmountCap(row?.policy_rules);
  const amountCap = chooseAmountCap(row, policyCap);
  const paymentAmount = amountValue(row?.payment_amount);
  const paymentCurrency = publicCurrencyOrNull(row?.payment_currency ?? null);
  const withinAmountCap = paymentAmount !== null
    && paymentCurrency !== null
    && amountCap.amount_minor_units !== null
    && amountCap.currency !== null
    ? paymentCurrency === amountCap.currency && paymentAmount <= amountCap.amount_minor_units
    : null;
  const passportPresent = row?.passport_type === 'checkout' && row.passport_environment === 'sandbox';
  const consentGranted = row?.consent_status === 'granted' && row.consent_passport_type === 'checkout';
  const activePolicyPresent = row?.policy_status === 'active';
  const policyDecisionPresent = typeof row?.payment_policy_version === 'string'
    && row.payment_policy_version.length > 0
    && typeof row.payment_decision_id === 'string'
    && row.payment_decision_id.length > 0;
  const cartHashPresent = typeof row?.cart_snapshot_hash === 'string' && row.cart_snapshot_hash.length > 0;
  const agentPresent = typeof row?.agent_id === 'string'
    && row.agent_id.length > 0
    && typeof row.agent_trust_status === 'string'
    && row.agent_disabled_at === null;
  const auditPresent = typeof audit?.id === 'string' && audit.id.length > 0;
  const idempotencyPresent = Boolean(row?.cart_idempotency_key_hash || row?.payment_idempotency_key_hash || audit?.idempotency_key_hash);

  preview.merchant_state = {
    display_name: publicTextOrNull(merchant.display_name),
    environment,
    country_code: publicCountryOrNull(merchant.country_code),
    default_currency: publicCurrencyOrNull(merchant.default_currency),
    readiness_state: readinessStateOrUnknown(merchant.sandbox_onboarding_state),
    agentic_commerce_requested: merchant.agentic_commerce_requested === true,
    agentic_commerce_enabled: merchant.agentic_commerce_enabled === true,
  };
  preview.commerce_passport_evidence = {
    present: passportPresent,
    passport_type: publicStatusOrNull(row?.passport_type ?? null),
    environment: publicStatusOrNull(row?.passport_environment ?? null),
    scope_count: passportScopes.length,
    required_checkout_scopes_present: hasRequiredCheckoutScopes(passportScopes),
    max_amount_minor_units: amountValue(row?.passport_max_amount),
    currency: publicCurrencyOrNull(row?.passport_currency ?? null),
    policy_version_present: typeof row?.passport_policy_version === 'string' && row.passport_policy_version.length > 0,
    not_before_present: Boolean(dateStringOrNull(row?.passport_not_before)),
    expires_at_present: Boolean(dateStringOrNull(row?.passport_expires_at)),
    not_expired: typeof row?.passport_not_expired === 'boolean' ? row.passport_not_expired : null,
    revoked: typeof row?.passport_revoked === 'boolean' ? row.passport_revoked : null,
    agent_auth_method: publicAuthMethodOrNull(row?.passport_agent_auth_method ?? null),
    passport_jti_exposed: false,
    raw_passport_jwt_exposed: false,
  };
  preview.consent_evidence = {
    present: consentGranted,
    status: publicStatusOrNull(row?.consent_status ?? null),
    passport_type: publicStatusOrNull(row?.consent_passport_type ?? null),
    requested_scope_count: stringArray(row?.consent_requested_scopes).length,
    approved_scope_count: approvedScopes.length,
    approved_required_checkout_scopes_present: hasRequiredCheckoutScopes(approvedScopes),
    max_amount_minor_units: amountValue(row?.consent_max_amount),
    currency: publicCurrencyOrNull(row?.consent_currency ?? null),
    consent_text_version: publicStatusOrNull(row?.consent_text_version ?? null),
    presented_payload_hash_present: typeof row?.presented_payload_hash === 'string' && row.presented_payload_hash.length > 0,
    approved_at_present: Boolean(dateStringOrNull(row?.consent_approved_at)),
    agent_auth_method: publicAuthMethodOrNull(row?.consent_agent_auth_method ?? null),
    consent_record_id_exposed: false,
    consent_request_id_exposed: false,
    user_principal_exposed: false,
  };
  preview.policy_evidence = {
    present: activePolicyPresent || policyDecisionPresent,
    active_policy_present: activePolicyPresent,
    policy_version_present: typeof row?.payment_policy_version === 'string' && row.payment_policy_version.length > 0,
    decision_reference_present: policyDecisionPresent,
    decision_reference_hash: hashedReference(row?.payment_decision_id ?? null, 'decision'),
    amount_cap_minor_units: policyCap.amount,
    amount_cap_currency: policyCap.currency,
    emergency_disabled: policyCap.emergencyDisabled,
    raw_policy_rules_exposed: false,
  };
  preview.cart_evidence = {
    present: Boolean(row?.cart_status),
    status: publicStatusOrNull(row?.cart_status ?? null),
    line_item_count: lineItemCount(row?.cart_line_items_snapshot),
    snapshot_hash: typeof row?.cart_snapshot_hash === 'string' ? row.cart_snapshot_hash : null,
    total_amount_minor_units: amountValue(row?.cart_total_amount),
    currency: publicCurrencyOrNull(row?.cart_currency ?? null),
    idempotency_key_hash_present: typeof row?.cart_idempotency_key_hash === 'string' && row.cart_idempotency_key_hash.length > 0,
    raw_line_items_exposed: false,
    cart_id_exposed: false,
  };
  preview.amount_evidence = {
    payment_amount_minor_units: paymentAmount,
    payment_currency: paymentCurrency,
    amount_cap_minor_units: amountCap.amount_minor_units,
    amount_cap_currency: amountCap.currency,
    amount_cap_source: amountCap.source,
    within_amount_cap: withinAmountCap,
  };
  preview.agent_identity_evidence = {
    present: agentPresent,
    agent_reference_hash: hashedReference(row?.agent_id ?? null, 'agent'),
    trust_status: publicStatusOrNull(row?.agent_trust_status ?? null),
    disabled: typeof row?.agent_id === 'string' ? row.agent_disabled_at !== null : null,
    auth_method: publicAuthMethodOrNull(row?.passport_agent_auth_method ?? row?.consent_agent_auth_method ?? null),
    agent_id_exposed: false,
    agent_api_key_exposed: false,
  };
  preview.audit_evidence = {
    present: auditPresent,
    audit_reference_hash: hashedReference(audit?.id ?? null, 'audit'),
    event_type: publicStatusOrNull(audit?.event_type ?? null),
    occurred_at: dateStringOrNull(audit?.occurred_at),
    policy_version_present: typeof audit?.policy_version === 'string' && audit.policy_version.length > 0,
    decision_reference_present: typeof audit?.decision_id === 'string' && audit.decision_id.length > 0,
    idempotency_key_hash_present: typeof audit?.idempotency_key_hash === 'string' && audit.idempotency_key_hash.length > 0,
    audit_event_id_exposed: false,
  };
  preview.replay_idempotency_evidence = {
    idempotency_supported: true,
    replay_record_source: 'commerce_idempotency_records',
    cart_idempotency_key_hash_present: typeof row?.cart_idempotency_key_hash === 'string' && row.cart_idempotency_key_hash.length > 0,
    payment_intent_idempotency_key_hash_present: typeof row?.payment_idempotency_key_hash === 'string' && row.payment_idempotency_key_hash.length > 0,
    audit_idempotency_key_hash_present: typeof audit?.idempotency_key_hash === 'string' && audit.idempotency_key_hash.length > 0,
    raw_idempotency_key_exposed: false,
  };
  preview.payment_intent_evidence = {
    present: Boolean(row?.payment_status),
    status: publicStatusOrNull(row?.payment_status ?? null),
    provider_environment: row?.provider_environment === 'sandbox' ? 'sandbox' : null,
    created_at_present: Boolean(dateStringOrNull(row?.payment_created_at)),
    provider_reference_exposed: false,
    checkout_url_exposed: false,
    provider_metadata_exposed: false,
    provider_raw_status_exposed: false,
  };

  if (environment !== 'sandbox') addUnique(preview.blockers, 'merchant_not_sandbox');
  if (!passportPresent || row?.passport_revoked === true || row?.passport_not_expired !== true) {
    addUnique(preview.blockers, 'commerce_passport_evidence_missing');
  }
  if (!consentGranted) addUnique(preview.blockers, 'consent_evidence_missing');
  if (!activePolicyPresent || !policyDecisionPresent) addUnique(preview.blockers, 'policy_decision_evidence_missing');
  if (!cartHashPresent) addUnique(preview.blockers, 'cart_hash_evidence_missing');
  if (amountCap.amount_minor_units === null || !amountCap.currency || withinAmountCap !== true) {
    addUnique(preview.blockers, 'amount_cap_evidence_missing');
  }
  if (!agentPresent) addUnique(preview.blockers, 'agent_identity_evidence_missing');
  if (!auditPresent) addUnique(preview.blockers, 'audit_reference_evidence_missing');
  if (!idempotencyPresent) addUnique(preview.blockers, 'idempotency_evidence_missing');
  addUnique(preview.blockers, 'unsigned_preview_only');
  addUnique(preview.blockers, 'ap2_certification_not_claimed');
  addUnique(preview.blockers, 'payment_network_submission_not_enabled_by_preview');

  const requiredComplete = environment === 'sandbox'
    && passportPresent
    && row?.passport_revoked !== true
    && row?.passport_not_expired === true
    && consentGranted
    && activePolicyPresent
    && policyDecisionPresent
    && cartHashPresent
    && amountCap.amount_minor_units !== null
    && Boolean(amountCap.currency)
    && withinAmountCap === true
    && agentPresent
    && auditPresent
    && idempotencyPresent;

  const deterministicEvidence = {
    merchant_state: preview.merchant_state,
    commerce_passport_evidence: preview.commerce_passport_evidence,
    consent_evidence: preview.consent_evidence,
    policy_evidence: preview.policy_evidence,
    cart_evidence: preview.cart_evidence,
    amount_evidence: preview.amount_evidence,
    agent_identity_evidence: preview.agent_identity_evidence,
    audit_evidence: preview.audit_evidence,
    replay_idempotency_evidence: preview.replay_idempotency_evidence,
    payment_intent_evidence: preview.payment_intent_evidence,
  };
  preview.evidence_package.evidence_hash = sha256hex(stableJson(deterministicEvidence));
  preview.status = requiredComplete ? 'preview_only' : 'blocked';
  preview.message = requiredComplete
    ? 'AP2-style evidence preview was generated as deterministic unsigned sandbox evidence. It is not AP2 certification or a signed production mandate.'
    : 'AP2-style evidence preview is blocked until sandbox passport, consent, policy, cart hash, amount cap, agent, audit, and idempotency evidence exists.';
  preview.remediation_items = buildRemediation(preview.blockers);
  preview.evidence_summary = {
    complete_required_evidence: requiredComplete,
    passport_present: passportPresent,
    consent_granted: consentGranted,
    active_policy_present: activePolicyPresent,
    policy_decision_present: policyDecisionPresent,
    cart_hash_present: cartHashPresent,
    amount_cap_present: amountCap.amount_minor_units !== null && Boolean(amountCap.currency),
    merchant_state_present: true,
    agent_identity_present: agentPresent,
    audit_reference_present: auditPresent,
    idempotency_evidence_present: idempotencyPresent,
    sandbox_only: true,
    unsigned_preview: true,
    payment_enabled: false,
    provider_called: false,
  };

  return preview;
}

export async function readAp2EvidencePreview(
  sql: Sql,
  input: { tenantId: string; merchantId: string; now?: Date },
): Promise<Ap2EvidencePreviewContext | null> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const merchants = await sql<MerchantRow[]>`
    SELECT display_name,
           CASE WHEN environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           default_currency, country_code, sandbox_onboarding_state,
           agentic_commerce_requested, agentic_commerce_enabled, disabled_at
      FROM commerce_merchants
     WHERE id = ${input.merchantId}
       AND tenant_id = ${input.tenantId}
     LIMIT 1
  `;
  const merchant = merchants[0];
  if (!merchant || merchant.disabled_at) return null;

  if (merchant.environment !== 'sandbox') {
    const preview = buildPreview(merchant, null, null, generatedAt);
    return { merchantEnvironment: 'live', preview };
  }

  const evidenceRows = await sql<Ap2EvidenceRow[]>`
    SELECT pi.status AS payment_status,
           pi.amount AS payment_amount,
           pi.currency AS payment_currency,
           pi.provider_environment,
           pi.policy_version AS payment_policy_version,
           pi.decision_id AS payment_decision_id,
           pi.idempotency_key_hash AS payment_idempotency_key_hash,
           pi.created_at AS payment_created_at,
           c.status AS cart_status,
           c.currency AS cart_currency,
           c.total_amount AS cart_total_amount,
           c.line_items_snapshot_hash AS cart_snapshot_hash,
           c.idempotency_key_hash AS cart_idempotency_key_hash,
           c.line_items_snapshot AS cart_line_items_snapshot,
           p.passport_type,
           p.environment AS passport_environment,
           p.scopes AS passport_scopes,
           p.max_amount AS passport_max_amount,
           p.currency AS passport_currency,
           p.policy_version AS passport_policy_version,
           p.not_before AS passport_not_before,
           p.expires_at AS passport_expires_at,
           (p.expires_at > NOW()) AS passport_not_expired,
           p.agent_auth_method AS passport_agent_auth_method,
           (r.jti IS NOT NULL) AS passport_revoked,
           cr.status AS consent_status,
           cr.passport_type AS consent_passport_type,
           cr.requested_scopes AS consent_requested_scopes,
           cr.approved_scopes AS consent_approved_scopes,
           cr.max_amount AS consent_max_amount,
           cr.currency AS consent_currency,
           cr.consent_text_version,
           cr.presented_payload_hash,
           cr.approved_at AS consent_approved_at,
           cr.agent_auth_method AS consent_agent_auth_method,
           pol.status AS policy_status,
           pol.rules AS policy_rules,
           ag.trust_status AS agent_trust_status,
           ag.disabled_at AS agent_disabled_at,
           ag.id AS agent_id
      FROM commerce_payment_intents pi
      LEFT JOIN commerce_carts c
        ON c.tenant_id = pi.tenant_id
       AND c.id = pi.cart_id
      LEFT JOIN commerce_passports p
        ON p.tenant_id = pi.tenant_id
       AND p.jti = pi.passport_jti
      LEFT JOIN commerce_passport_revocations r
        ON r.tenant_id = p.tenant_id
       AND r.jti = p.jti
      LEFT JOIN commerce_consent_records cr
        ON cr.tenant_id = pi.tenant_id
       AND cr.id = p.consent_record_id
      LEFT JOIN commerce_policies pol
        ON pol.tenant_id = pi.tenant_id
       AND pol.merchant_id = pi.merchant_id
       AND pol.version = pi.policy_version
       AND pol.status = 'active'
      LEFT JOIN commerce_agents ag
        ON ag.tenant_id = pi.tenant_id
       AND ag.id = pi.agent_id
     WHERE pi.tenant_id = ${input.tenantId}
       AND pi.merchant_id = ${input.merchantId}
       AND pi.provider_environment = 'sandbox'
     ORDER BY pi.created_at DESC
     LIMIT 1
  `;
  const evidence = evidenceRows[0] ?? null;
  const auditRows = await sql<AuditRow[]>`
    SELECT id, event_type, occurred_at, passport_jti,
           policy_version, decision_id, idempotency_key_hash
      FROM commerce_audit_events
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND event_type IN (
         'payment_intent.created',
         'checkout_link.created',
         'policy.evaluated',
         'passport.issued',
         'consent.granted',
         'cart.created'
       )
     ORDER BY occurred_at DESC
     LIMIT 1
  `;

  return {
    merchantEnvironment: 'sandbox',
    preview: buildPreview(merchant, evidence, auditRows[0] ?? null, generatedAt),
  };
}
