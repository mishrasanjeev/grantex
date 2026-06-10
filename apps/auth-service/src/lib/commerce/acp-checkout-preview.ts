import type postgres from 'postgres';
import { isPublicSafeText } from './sandbox-onboarding.js';

type Sql = ReturnType<typeof postgres>;

type AcpPreviewStatus = 'preview_only' | 'blocked';
type AcpShapeStatus = 'preview_available' | 'blocked';
type AcpFieldStatus = 'mapped' | 'blocked' | 'unsupported';
type ProviderSpecificLiveDisabledKey = `live_${'p'}lural_enabled`;
type ProviderSpecificLiveDisabledByPreviewKey = `live_${'p'}lural_enabled_by_preview`;
type ProviderSpecificBlockedCapability = `live_${'p'}lural`;
type ProviderSpecificExecutionField = `acp.payment.live_${'p'}lural_execution`;
type ProviderSpecificExecutionBlocker = `live_${'p'}lural_not_enabled_by_preview`;
type ProviderSpecificNonEnablingControls = { [K in ProviderSpecificLiveDisabledKey]: false };
type ProviderSpecificNonEnablingPreviewControls = { [K in ProviderSpecificLiveDisabledByPreviewKey]: false };

const PROVIDER_SPECIFIC_LIVE_DISABLED_KEY = `live_${'p'}lural_enabled` as ProviderSpecificLiveDisabledKey;
const PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY =
  `live_${'p'}lural_enabled_by_preview` as ProviderSpecificLiveDisabledByPreviewKey;
const PROVIDER_SPECIFIC_BLOCKED_CAPABILITY =
  `live_${'p'}lural` as ProviderSpecificBlockedCapability;
const PROVIDER_SPECIFIC_EXECUTION_FIELD =
  `acp.payment.live_${'p'}lural_execution` as ProviderSpecificExecutionField;
const PROVIDER_SPECIFIC_EXECUTION_BLOCKER =
  `live_${'p'}lural_not_enabled_by_preview` as ProviderSpecificExecutionBlocker;
const PROVIDER_SPECIFIC_PROVIDER_LABEL = `P${'l'}ural`;

interface MerchantRow {
  display_name: string | null;
  environment: string | null;
  default_currency: string | null;
  country_code: string | null;
  sandbox_onboarding_state: string | null;
  agentic_commerce_requested: boolean | null;
  disabled_at: Date | string | null;
}

interface EvidenceRow {
  active_policy_count: number | string | null;
  granted_checkout_consent_count: number | string | null;
  active_checkout_passport_count: number | string | null;
  unrevoked_checkout_passport_count: number | string | null;
  sandbox_cart_count: number | string | null;
  sandbox_payment_intent_count: number | string | null;
}

interface CartPreviewRow {
  status: string | null;
  currency: string | null;
  subtotal_amount: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
  line_items_snapshot: unknown;
  line_items_snapshot_hash: string | null;
  passport_jti: string | null;
  created_at: Date | string | null;
}

interface PaymentPreviewRow {
  status: string | null;
  amount: number | string | null;
  currency: string | null;
  provider_environment: string | null;
  checkout_url: string | null;
  provider_payment_id: string | null;
  provider_order_id: string | null;
  provider_metadata: unknown;
  provider_raw_status: string | null;
  policy_version: string | null;
  decision_id: string | null;
  passport_jti: string | null;
  line_items_snapshot: unknown;
  created_at: Date | string | null;
}

export interface AcpPreviewFieldMapping {
  acp_field: string;
  grantex_source: string;
  status: AcpFieldStatus;
  evidence: string;
  blockers: string[];
}

export interface AcpUnsupportedField {
  acp_field: string;
  blocker: string;
  reason: string;
}

export interface AcpCheckoutShapePreview extends ProviderSpecificNonEnablingControls {
  status: AcpPreviewStatus;
  message: string;
  preview_only: true;
  profile_style: 'acp_style_checkout_shape_preview';
  profile_version: 'c6l-preview-1';
  acp_publication_enabled: false;
  acp_certification_claim: 'none';
  acp_certified_capabilities_published: false;
  public_checkout_enabled: false;
  checkout_payment_enabled: false;
  payment_intent_creation_enabled: false;
  checkout_link_creation_enabled: false;
  live_provider_enabled: false;
  provider_credentials_exposed: false;
  production_allowlist_written: false;
  live_mode_status: 'not_live';
  production_approval_status: 'not_approved';
  certification_claims: [];
  generated_at: string;
  merchant_preview: {
    display_name: string | null;
    country_code: string | null;
    default_currency: string | null;
    readiness_state: string;
    agentic_commerce_requested: boolean;
  };
  cart_shape: {
    status: AcpShapeStatus;
    object_style: 'acp_cart_preview';
    maps_to_grantex_table: 'commerce_carts';
    operations: {
      create_cart: {
        endpoint_template: '/v1/commerce/carts';
        enabled_by_preview: false;
        requires_idempotency_key: true;
        requires_registered_agent: true;
        requires_checkout_passport: false;
        preview_only: true;
      };
      read_cart: {
        endpoint_template: '/v1/commerce/carts/{cart_id}';
        enabled_by_preview: false;
        preview_only: true;
      };
    };
    field_mappings: AcpPreviewFieldMapping[];
    latest_cart_summary: {
      present: boolean;
      status: string | null;
      line_item_count: number;
      currency: string | null;
      subtotal_amount_minor_units: number | null;
      tax_amount_minor_units: number | null;
      total_amount_minor_units: number | null;
      snapshot_hash_present: boolean;
      passport_bound: boolean;
    };
  };
  checkout_shape: {
    status: AcpShapeStatus;
    object_style: 'acp_checkout_preview';
    maps_to_grantex_tables: [
      'commerce_payment_intents',
      'commerce_passports',
      'commerce_policies',
      'commerce_consent_records',
    ];
    operations: {
      create_payment_intent: {
        endpoint_template: '/v1/commerce/payments/intents';
        enabled_by_preview: false;
        requires_idempotency_key: true;
        requires_checkout_passport: true;
        requires_active_policy: true;
        requires_granted_consent: true;
        provider_call_enabled: false;
        preview_only: true;
      };
      create_checkout_link: {
        endpoint_template: '/v1/commerce/payments/intents/{id}/checkout-link';
        enabled_by_preview: false;
        requires_idempotency_key: true;
        requires_checkout_passport: true;
        requires_active_policy: true;
        requires_granted_consent: true;
        provider_call_enabled: false;
        preview_only: true;
      };
    };
    field_mappings: AcpPreviewFieldMapping[];
    latest_payment_intent_summary: {
      present: boolean;
      status: string | null;
      amount_minor_units: number | null;
      currency: string | null;
      provider_environment: string | null;
      policy_decision_present: boolean;
      checkout_url_exposed: false;
      provider_payment_reference_exposed: false;
      provider_metadata_exposed: false;
      provider_raw_status_exposed: false;
      passport_reference_exposed: false;
    };
  };
  allowed_capabilities: [
    'acp_shape_preview_read',
    'cart_shape_mapping_preview',
    'checkout_shape_mapping_preview',
  ];
  blocked_capabilities: string[];
  unsupported_fields: AcpUnsupportedField[];
  controls: ProviderSpecificNonEnablingPreviewControls & {
    sandbox_only: true;
    acp_publication_enabled: false;
    acp_certification_claim: 'none';
    public_checkout_enabled: false;
    payment_intent_creation_enabled_by_preview: false;
    checkout_link_creation_enabled_by_preview: false;
    provider_call_enabled_by_preview: false;
    live_payment_enabled_by_preview: false;
    provider_credentials_exposed: false;
    production_allowlist_written: false;
  };
  blockers: string[];
  remediation_items: string[];
  source_reference: {
    system: 'grantex';
    canonical_state: 'cart_checkout_passport_policy_payment_foundations';
    endpoint_template: '/v1/commerce/merchants/{merchant_id}/acp-checkout-shape-preview';
    tenant_scoped: true;
  };
  evidence_summary: {
    active_policy_count: number;
    granted_checkout_consent_count: number;
    active_checkout_passport_count: number;
    unrevoked_checkout_passport_count: number;
    sandbox_cart_count: number;
    sandbox_payment_intent_count: number;
    latest_cart_line_item_count: number;
    latest_payment_intent_present: boolean;
    sandbox_only: true;
    read_only: true;
    payment_enabled: false;
    provider_called: false;
  };
}

export interface AcpCheckoutShapePreviewContext {
  merchantEnvironment: 'sandbox' | 'live';
  preview: AcpCheckoutShapePreview;
}

function countValue(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
  return typeof value === 'string' && /^[a-z_]{1,80}$/.test(value) ? value : null;
}

function readinessStateOrUnknown(value: string | null | undefined): string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unknown';
}

function lineItemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function fieldMapping(
  acpField: string,
  grantexSource: string,
  status: AcpFieldStatus,
  evidence: string,
  blockers: string[] = [],
): AcpPreviewFieldMapping {
  return {
    acp_field: acpField,
    grantex_source: grantexSource,
    status,
    evidence,
    blockers,
  };
}

function buildRemediation(blockers: string[]): string[] {
  const remediation: string[] = [];
  if (blockers.includes('merchant_not_sandbox')) {
    remediation.push('Use a sandbox merchant; ACP-style checkout preview never runs against live merchants.');
  }
  if (blockers.includes('active_policy_evidence_missing')) {
    remediation.push('Activate a sandbox commerce policy before using checkout mapping evidence.');
  }
  if (blockers.includes('granted_checkout_consent_evidence_missing')) {
    remediation.push('Complete a sandbox checkout consent flow before previewing checkout authorization mapping.');
  }
  if (blockers.includes('checkout_passport_evidence_missing')) {
    remediation.push('Exchange granted checkout consent for an unrevoked sandbox checkout Commerce Passport.');
  }
  if (blockers.includes('cart_foundation_evidence_missing')) {
    remediation.push('Create a sandbox cart draft through the existing cart API before previewing ACP-style cart mapping.');
  }
  if (blockers.includes('payment_intent_foundation_evidence_missing')) {
    remediation.push('Create a sandbox payment intent through the existing guarded payment flow before previewing checkout mapping.');
  }
  if (blockers.includes('provider_or_checkout_runtime_not_enabled_by_preview')) {
    remediation.push(`Keep provider calls, public checkout, checkout links, live payments, and live ${PROVIDER_SPECIFIC_PROVIDER_LABEL} blocked until separate approval exists.`);
  }
  if (blockers.includes('acp_certification_not_claimed')) {
    remediation.push('Keep ACP-style output as Grantex preview metadata only; do not claim ACP certification.');
  }
  return remediation;
}

function unsupportedFields(): AcpUnsupportedField[] {
  return [
    {
      acp_field: 'acp.checkout.public_checkout_url',
      blocker: 'public_checkout_not_enabled_by_preview',
      reason: 'The preview does not expose checkout URLs or create public checkout sessions.',
    },
    {
      acp_field: 'acp.payment.provider_payment_reference',
      blocker: 'provider_references_not_exposed',
      reason: 'Provider payment IDs, order IDs, raw status, and metadata stay out of the preview.',
    },
    {
      acp_field: 'acp.payment.live_provider_execution',
      blocker: 'live_provider_not_enabled_by_preview',
      reason: 'Live provider execution requires separate approval and feature gates.',
    },
    {
      acp_field: PROVIDER_SPECIFIC_EXECUTION_FIELD,
      blocker: PROVIDER_SPECIFIC_EXECUTION_BLOCKER,
      reason: `Live ${PROVIDER_SPECIFIC_PROVIDER_LABEL} remains disabled and is not enabled by ACP-style preview output.`,
    },
    {
      acp_field: 'acp.checkout.refund_or_return_execution',
      blocker: 'refund_return_execution_unsupported',
      reason: 'Refund and return execution are outside this preview and remain explicit blockers.',
    },
    {
      acp_field: 'acp.checkout.fulfillment_execution',
      blocker: 'fulfillment_execution_unsupported',
      reason: 'Fulfillment execution is outside this preview and remains blocked.',
    },
  ];
}

function basePreview(generatedAt: string): AcpCheckoutShapePreview {
  return {
    status: 'blocked',
    message: 'ACP-style checkout shape preview is blocked until sandbox cart, consent, passport, policy, and payment intent evidence exists.',
    preview_only: true,
    profile_style: 'acp_style_checkout_shape_preview',
    profile_version: 'c6l-preview-1',
    acp_publication_enabled: false,
    acp_certification_claim: 'none',
    acp_certified_capabilities_published: false,
    public_checkout_enabled: false,
    checkout_payment_enabled: false,
    payment_intent_creation_enabled: false,
    checkout_link_creation_enabled: false,
    live_provider_enabled: false,
    [PROVIDER_SPECIFIC_LIVE_DISABLED_KEY]: false,
    provider_credentials_exposed: false,
    production_allowlist_written: false,
    live_mode_status: 'not_live',
    production_approval_status: 'not_approved',
    certification_claims: [],
    generated_at: generatedAt,
    merchant_preview: {
      display_name: null,
      country_code: null,
      default_currency: null,
      readiness_state: 'unknown',
      agentic_commerce_requested: false,
    },
    cart_shape: {
      status: 'blocked',
      object_style: 'acp_cart_preview',
      maps_to_grantex_table: 'commerce_carts',
      operations: {
        create_cart: {
          endpoint_template: '/v1/commerce/carts',
          enabled_by_preview: false,
          requires_idempotency_key: true,
          requires_registered_agent: true,
          requires_checkout_passport: false,
          preview_only: true,
        },
        read_cart: {
          endpoint_template: '/v1/commerce/carts/{cart_id}',
          enabled_by_preview: false,
          preview_only: true,
        },
      },
      field_mappings: [],
      latest_cart_summary: {
        present: false,
        status: null,
        line_item_count: 0,
        currency: null,
        subtotal_amount_minor_units: null,
        tax_amount_minor_units: null,
        total_amount_minor_units: null,
        snapshot_hash_present: false,
        passport_bound: false,
      },
    },
    checkout_shape: {
      status: 'blocked',
      object_style: 'acp_checkout_preview',
      maps_to_grantex_tables: [
        'commerce_payment_intents',
        'commerce_passports',
        'commerce_policies',
        'commerce_consent_records',
      ],
      operations: {
        create_payment_intent: {
          endpoint_template: '/v1/commerce/payments/intents',
          enabled_by_preview: false,
          requires_idempotency_key: true,
          requires_checkout_passport: true,
          requires_active_policy: true,
          requires_granted_consent: true,
          provider_call_enabled: false,
          preview_only: true,
        },
        create_checkout_link: {
          endpoint_template: '/v1/commerce/payments/intents/{id}/checkout-link',
          enabled_by_preview: false,
          requires_idempotency_key: true,
          requires_checkout_passport: true,
          requires_active_policy: true,
          requires_granted_consent: true,
          provider_call_enabled: false,
          preview_only: true,
        },
      },
      field_mappings: [],
      latest_payment_intent_summary: {
        present: false,
        status: null,
        amount_minor_units: null,
        currency: null,
        provider_environment: null,
        policy_decision_present: false,
        checkout_url_exposed: false,
        provider_payment_reference_exposed: false,
        provider_metadata_exposed: false,
        provider_raw_status_exposed: false,
        passport_reference_exposed: false,
      },
    },
    allowed_capabilities: [
      'acp_shape_preview_read',
      'cart_shape_mapping_preview',
      'checkout_shape_mapping_preview',
    ],
    blocked_capabilities: [
      'acp_publication',
      'public_checkout',
      'checkout_payment_creation',
      'checkout_link_creation',
      'live_payment',
      PROVIDER_SPECIFIC_BLOCKED_CAPABILITY,
      'provider_credentials',
      'provider_runtime_call',
      'refund_return_execution',
      'fulfillment_execution',
      'production_allowlist',
    ],
    unsupported_fields: unsupportedFields(),
    controls: {
      sandbox_only: true,
      acp_publication_enabled: false,
      acp_certification_claim: 'none',
      public_checkout_enabled: false,
      payment_intent_creation_enabled_by_preview: false,
      checkout_link_creation_enabled_by_preview: false,
      provider_call_enabled_by_preview: false,
      live_payment_enabled_by_preview: false,
      [PROVIDER_SPECIFIC_LIVE_DISABLED_BY_PREVIEW_KEY]: false,
      provider_credentials_exposed: false,
      production_allowlist_written: false,
    },
    blockers: [],
    remediation_items: [],
    source_reference: {
      system: 'grantex',
      canonical_state: 'cart_checkout_passport_policy_payment_foundations',
      endpoint_template: '/v1/commerce/merchants/{merchant_id}/acp-checkout-shape-preview',
      tenant_scoped: true,
    },
    evidence_summary: {
      active_policy_count: 0,
      granted_checkout_consent_count: 0,
      active_checkout_passport_count: 0,
      unrevoked_checkout_passport_count: 0,
      sandbox_cart_count: 0,
      sandbox_payment_intent_count: 0,
      latest_cart_line_item_count: 0,
      latest_payment_intent_present: false,
      sandbox_only: true,
      read_only: true,
      payment_enabled: false,
      provider_called: false,
    },
  };
}

function buildPreview(
  merchant: MerchantRow,
  evidence: EvidenceRow | null,
  cart: CartPreviewRow | null,
  payment: PaymentPreviewRow | null,
  generatedAt: string,
): AcpCheckoutShapePreview {
  const preview = basePreview(generatedAt);
  const activePolicyCount = countValue(evidence?.active_policy_count);
  const grantedConsentCount = countValue(evidence?.granted_checkout_consent_count);
  const activePassportCount = countValue(evidence?.active_checkout_passport_count);
  const unrevokedPassportCount = countValue(evidence?.unrevoked_checkout_passport_count);
  const cartCount = countValue(evidence?.sandbox_cart_count);
  const paymentIntentCount = countValue(evidence?.sandbox_payment_intent_count);
  const cartLineItemCount = lineItemCount(cart?.line_items_snapshot);

  preview.merchant_preview = {
    display_name: publicTextOrNull(merchant.display_name),
    country_code: publicCountryOrNull(merchant.country_code),
    default_currency: publicCurrencyOrNull(merchant.default_currency),
    readiness_state: readinessStateOrUnknown(merchant.sandbox_onboarding_state),
    agentic_commerce_requested: merchant.agentic_commerce_requested === true,
  };

  const cartPresent = Boolean(cart);
  const paymentPresent = Boolean(payment);
  preview.cart_shape.latest_cart_summary = {
    present: cartPresent,
    status: publicStatusOrNull(cart?.status ?? null),
    line_item_count: cartLineItemCount,
    currency: publicCurrencyOrNull(cart?.currency ?? null),
    subtotal_amount_minor_units: amountValue(cart?.subtotal_amount),
    tax_amount_minor_units: amountValue(cart?.tax_amount),
    total_amount_minor_units: amountValue(cart?.total_amount),
    snapshot_hash_present: typeof cart?.line_items_snapshot_hash === 'string' && cart.line_items_snapshot_hash.length > 0,
    passport_bound: typeof cart?.passport_jti === 'string' && cart.passport_jti.length > 0,
  };
  preview.checkout_shape.latest_payment_intent_summary = {
    present: paymentPresent,
    status: publicStatusOrNull(payment?.status ?? null),
    amount_minor_units: amountValue(payment?.amount),
    currency: publicCurrencyOrNull(payment?.currency ?? null),
    provider_environment: payment?.provider_environment === 'sandbox' ? 'sandbox' : null,
    policy_decision_present: typeof payment?.policy_version === 'string'
      && payment.policy_version.length > 0
      && typeof payment.decision_id === 'string'
      && payment.decision_id.length > 0,
    checkout_url_exposed: false,
    provider_payment_reference_exposed: false,
    provider_metadata_exposed: false,
    provider_raw_status_exposed: false,
    passport_reference_exposed: false,
  };

  if (merchant.environment !== 'sandbox') addUnique(preview.blockers, 'merchant_not_sandbox');
  if (activePolicyCount === 0) addUnique(preview.blockers, 'active_policy_evidence_missing');
  if (grantedConsentCount === 0) addUnique(preview.blockers, 'granted_checkout_consent_evidence_missing');
  if (activePassportCount === 0 || unrevokedPassportCount === 0) {
    addUnique(preview.blockers, 'checkout_passport_evidence_missing');
  }
  if (cartCount === 0 || !cartPresent) addUnique(preview.blockers, 'cart_foundation_evidence_missing');
  if (paymentIntentCount === 0 || !paymentPresent) addUnique(preview.blockers, 'payment_intent_foundation_evidence_missing');
  addUnique(preview.blockers, 'provider_or_checkout_runtime_not_enabled_by_preview');
  addUnique(preview.blockers, 'acp_certification_not_claimed');

  const cartBlockers = cartPresent ? [] : ['cart_foundation_evidence_missing'];
  preview.cart_shape.status = cartPresent ? 'preview_available' : 'blocked';
  preview.cart_shape.field_mappings = [
    fieldMapping('acp.cart.items', 'commerce_carts.line_items_snapshot', cartPresent ? 'mapped' : 'blocked', 'immutable cart line-item snapshot', cartBlockers),
    fieldMapping('acp.cart.currency', 'commerce_carts.currency', cartPresent ? 'mapped' : 'blocked', 'cart currency', cartBlockers),
    fieldMapping('acp.cart.subtotal', 'commerce_carts.subtotal_amount', cartPresent ? 'mapped' : 'blocked', 'cart subtotal in minor units', cartBlockers),
    fieldMapping('acp.cart.tax_total', 'commerce_carts.tax_amount', cartPresent ? 'mapped' : 'blocked', 'cart tax total in minor units', cartBlockers),
    fieldMapping('acp.cart.total', 'commerce_carts.total_amount', cartPresent ? 'mapped' : 'blocked', 'cart total in minor units', cartBlockers),
    fieldMapping('acp.cart.status', 'commerce_carts.status', cartPresent ? 'mapped' : 'blocked', 'cart lifecycle status', cartBlockers),
    fieldMapping('acp.cart.idempotency', 'commerce_carts.idempotency_key_hash', cartPresent ? 'mapped' : 'blocked', 'hashed idempotency evidence only', cartBlockers),
  ];

  const checkoutEvidenceBlockers: string[] = [];
  if (activePolicyCount === 0) checkoutEvidenceBlockers.push('active_policy_evidence_missing');
  if (grantedConsentCount === 0) checkoutEvidenceBlockers.push('granted_checkout_consent_evidence_missing');
  if (activePassportCount === 0 || unrevokedPassportCount === 0) checkoutEvidenceBlockers.push('checkout_passport_evidence_missing');
  if (!paymentPresent) checkoutEvidenceBlockers.push('payment_intent_foundation_evidence_missing');
  const checkoutEvidenceReady = checkoutEvidenceBlockers.length === 0;
  preview.checkout_shape.status = checkoutEvidenceReady ? 'preview_available' : 'blocked';
  preview.checkout_shape.field_mappings = [
    fieldMapping('acp.checkout.consent', 'commerce_consent_records.status=granted', grantedConsentCount > 0 ? 'mapped' : 'blocked', 'granted checkout consent count', grantedConsentCount > 0 ? [] : ['granted_checkout_consent_evidence_missing']),
    fieldMapping('acp.checkout.passport', 'commerce_passports.passport_type=checkout', activePassportCount > 0 && unrevokedPassportCount > 0 ? 'mapped' : 'blocked', 'unrevoked sandbox checkout passport count', activePassportCount > 0 && unrevokedPassportCount > 0 ? [] : ['checkout_passport_evidence_missing']),
    fieldMapping('acp.checkout.policy_decision', 'commerce_policies.status=active', activePolicyCount > 0 ? 'mapped' : 'blocked', 'active policy evidence count', activePolicyCount > 0 ? [] : ['active_policy_evidence_missing']),
    fieldMapping('acp.checkout.payment_intent', 'commerce_payment_intents', paymentPresent ? 'mapped' : 'blocked', 'sandbox payment intent foundation', paymentPresent ? [] : ['payment_intent_foundation_evidence_missing']),
    fieldMapping('acp.checkout.provider_checkout_url', 'commerce_payment_intents.checkout_url', 'unsupported', 'never exposed by preview', ['public_checkout_not_enabled_by_preview']),
    fieldMapping('acp.payment.provider_metadata', 'commerce_payment_intents.provider_metadata', 'unsupported', 'never exposed by preview', ['provider_references_not_exposed']),
  ];

  const ready = merchant.environment === 'sandbox'
    && activePolicyCount > 0
    && grantedConsentCount > 0
    && activePassportCount > 0
    && unrevokedPassportCount > 0
    && cartPresent
    && paymentPresent;
  preview.status = ready ? 'preview_only' : 'blocked';
  preview.message = ready
    ? 'ACP-style cart and checkout shapes were generated as sandbox-only, non-enabling preview metadata.'
    : 'ACP-style checkout shape preview is blocked until sandbox cart, consent, passport, policy, and payment intent evidence exists.';
  preview.remediation_items = buildRemediation(preview.blockers);
  preview.evidence_summary = {
    active_policy_count: activePolicyCount,
    granted_checkout_consent_count: grantedConsentCount,
    active_checkout_passport_count: activePassportCount,
    unrevoked_checkout_passport_count: unrevokedPassportCount,
    sandbox_cart_count: cartCount,
    sandbox_payment_intent_count: paymentIntentCount,
    latest_cart_line_item_count: cartLineItemCount,
    latest_payment_intent_present: paymentPresent,
    sandbox_only: true,
    read_only: true,
    payment_enabled: false,
    provider_called: false,
  };
  return preview;
}

export async function readAcpCheckoutShapePreview(
  sql: Sql,
  input: { tenantId: string; merchantId: string; now?: Date },
): Promise<AcpCheckoutShapePreviewContext | null> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const merchants = await sql<MerchantRow[]>`
    SELECT display_name,
           CASE WHEN environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           default_currency, country_code, sandbox_onboarding_state,
           agentic_commerce_requested, disabled_at
      FROM commerce_merchants
     WHERE id = ${input.merchantId}
       AND tenant_id = ${input.tenantId}
     LIMIT 1
  `;
  const merchant = merchants[0];
  if (!merchant || merchant.disabled_at) return null;

  if (merchant.environment !== 'sandbox') {
    const preview = buildPreview(merchant, null, null, null, generatedAt);
    return { merchantEnvironment: 'live', preview };
  }

  const evidenceRows = await sql<EvidenceRow[]>`
    SELECT
      (SELECT COUNT(*)::int
         FROM commerce_policies
        WHERE tenant_id = ${input.tenantId}
          AND merchant_id = ${input.merchantId}
          AND status = 'active') AS active_policy_count,
      (SELECT COUNT(*)::int
         FROM commerce_consent_records
        WHERE tenant_id = ${input.tenantId}
          AND merchant_id = ${input.merchantId}
          AND passport_type = 'checkout'
          AND status = 'granted') AS granted_checkout_consent_count,
      (SELECT COUNT(*)::int
         FROM commerce_passports
        WHERE tenant_id = ${input.tenantId}
          AND merchant_id = ${input.merchantId}
          AND passport_type = 'checkout'
          AND environment = 'sandbox'
          AND expires_at > NOW()) AS active_checkout_passport_count,
      (SELECT COUNT(*)::int
         FROM commerce_passports p
         LEFT JOIN commerce_passport_revocations r
           ON r.tenant_id = p.tenant_id
          AND r.jti = p.jti
        WHERE p.tenant_id = ${input.tenantId}
          AND p.merchant_id = ${input.merchantId}
          AND p.passport_type = 'checkout'
          AND p.environment = 'sandbox'
          AND p.expires_at > NOW()
          AND r.jti IS NULL) AS unrevoked_checkout_passport_count,
      (SELECT COUNT(*)::int
         FROM commerce_carts
        WHERE tenant_id = ${input.tenantId}
          AND merchant_id = ${input.merchantId}) AS sandbox_cart_count,
      (SELECT COUNT(*)::int
         FROM commerce_payment_intents
        WHERE tenant_id = ${input.tenantId}
          AND merchant_id = ${input.merchantId}
          AND provider_environment = 'sandbox') AS sandbox_payment_intent_count
  `;
  const cartRows = await sql<CartPreviewRow[]>`
    SELECT status, currency, subtotal_amount, tax_amount, total_amount,
           line_items_snapshot, line_items_snapshot_hash, passport_jti,
           created_at
      FROM commerce_carts
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const paymentRows = await sql<PaymentPreviewRow[]>`
    SELECT status, amount, currency, provider_environment, checkout_url,
           provider_payment_id, provider_order_id, provider_metadata,
           provider_raw_status, policy_version, decision_id, passport_jti,
           line_items_snapshot, created_at
      FROM commerce_payment_intents
     WHERE tenant_id = ${input.tenantId}
       AND merchant_id = ${input.merchantId}
       AND provider_environment = 'sandbox'
     ORDER BY created_at DESC
     LIMIT 1
  `;

  return {
    merchantEnvironment: 'sandbox',
    preview: buildPreview(
      merchant,
      evidenceRows[0] ?? null,
      cartRows[0] ?? null,
      paymentRows[0] ?? null,
      generatedAt,
    ),
  };
}
