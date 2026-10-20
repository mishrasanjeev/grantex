import { sha256hex } from '../hash.js';
import { canonicalize } from '../evidence/canonical.js';

export const OACP_ARTIFACT_SIGNATURE_PROFILE = {
  payload_format: 'canonical_json',
  signature_format: 'detached_jws',
  canonicalization: 'rfc8785_jcs',
  first_algorithm: 'ES256',
  artifact_container: 'json_object',
  jwt_container_allowed: false,
  cose_first_version: false,
  ad_hoc_signed_json_allowed: false,
} as const;

/** `schema_version` of envelopes signed under the OACP artifact JWS profile v1. */
export const OACP_ARTIFACT_SCHEMA_VERSION = 'oacp.artifact.v1';

export const OACP_ARTIFACT_TYPES = [
  'merchant_capability',
  'seller_agent_capability',
  'catalog_snapshot',
  'offer',
  'price',
  'inventory',
  'policy',
  'public_discovery',
  'mandate_capability',
  'commitment_evidence',
  'revocation',
  'protocol_adapter',
] as const;

export type OacpArtifactType = typeof OACP_ARTIFACT_TYPES[number];

export type OacpRiskTier = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export type OacpOfflineCommitmentAction =
  | 'browse'
  | 'compare'
  | 'draft_cart'
  | 'quote_preview'
  | 'price_lock'
  | 'inventory_hold'
  | 'reservation'
  | 'order_pending_reconciliation'
  | 'payment_intent'
  | 'cancellation'
  | 'refund_request'
  | 'return_authorization'
  | 'support_escalation'
  | 'public_discovery_publish'
  | 'merchant_approval'
  | 'policy_override'
  | 'emergency_disable';

export type OacpCurrency = 'INR' | 'USD';

export interface OacpRiskCap {
  tier: OacpRiskTier;
  amount_minor_units: number | null;
  currency_caps: Partial<Record<OacpCurrency, number>>;
  total_quantity_cap: number | null;
  per_sku_quantity_cap: number | null;
  frequency_cap: string;
  offline_allowed: boolean;
}

export const OACP_FIRST_RELEASE_RISK_CAPS: Record<OacpRiskTier, OacpRiskCap> = {
  informational: {
    tier: 'informational',
    amount_minor_units: null,
    currency_caps: {},
    total_quantity_cap: 100,
    per_sku_quantity_cap: 20,
    frequency_cap: '30 informational requests per buyer-agent/merchant/hour',
    offline_allowed: true,
  },
  low: {
    tier: 'low',
    amount_minor_units: 2500000,
    currency_caps: { INR: 2500000, USD: 30000 },
    total_quantity_cap: 10,
    per_sku_quantity_cap: 5,
    frequency_cap: '10 draft carts or quote previews per buyer-agent/merchant/day',
    offline_allowed: true,
  },
  medium: {
    tier: 'medium',
    amount_minor_units: 1000000,
    currency_caps: { INR: 1000000, USD: 12500 },
    total_quantity_cap: 5,
    per_sku_quantity_cap: 2,
    frequency_cap: '3 active holds or reservations and 6 per buyer-agent/merchant/day',
    offline_allowed: true,
  },
  high: {
    tier: 'high',
    amount_minor_units: 500000,
    currency_caps: { INR: 500000, USD: 6000 },
    total_quantity_cap: 3,
    per_sku_quantity_cap: 1,
    frequency_cap: '2 high-risk offline actions per buyer-agent/merchant/day',
    offline_allowed: true,
  },
  critical: {
    tier: 'critical',
    amount_minor_units: null,
    currency_caps: {},
    total_quantity_cap: null,
    per_sku_quantity_cap: null,
    frequency_cap: 'offline not allowed',
    offline_allowed: false,
  },
};

export const OACP_ARTIFACT_TTLS_SECONDS: Record<OacpArtifactType, number> = {
  merchant_capability: 24 * 60 * 60,
  seller_agent_capability: 6 * 60 * 60,
  catalog_snapshot: 6 * 60 * 60,
  offer: 15 * 60,
  price: 5 * 60,
  inventory: 60,
  policy: 6 * 60 * 60,
  public_discovery: 15 * 60,
  mandate_capability: 2 * 60,
  commitment_evidence: 5 * 60,
  // A revocation artifact stays verifiable for as long as any artifact it
  // names could still be presented (the longest family TTL).
  revocation: 24 * 60 * 60,
  protocol_adapter: 24 * 60 * 60,
};

export const OACP_DYNAMIC_PRICE_TTL_SECONDS = 60;
export const OACP_HIGH_VELOCITY_INVENTORY_TTL_SECONDS = 30;

export const OACP_REVOCATION_SNAPSHOT_MAX_AGE_SECONDS: Record<OacpRiskTier, number | null> = {
  informational: 24 * 60 * 60,
  low: 6 * 60 * 60,
  medium: 15 * 60,
  high: 2 * 60,
  critical: null,
};

export const OACP_REVOCATION_SLA_TARGETS_SECONDS = {
  provider_high_risk: 30,
  merchant_inventory_price: 60,
  merchant_emergency_disable: 30,
  merchant_other_operational: 5 * 60,
  agenticorg_high_critical_cache_purge: 30,
  agenticorg_medium_refresh: 2 * 60,
  grantex_revocation_visible: 30,
  channel_active_transaction_update: 30,
} as const;

export const OACP_CONNECTOR_CREDENTIAL_CUSTODY = {
  preferred: 'merchant_owned_connector_platform',
  second_choice: 'merchant_selected_external_integration_provider_vault',
  fallback: 'agenticorg_encrypted_connector_vault_with_explicit_authorization',
  grantex_raw_connector_credentials_allowed: false,
  buyer_agent_credential_access_allowed: false,
} as const;

export const OACP_FIRST_E2E_BRIDGES = {
  chatgpt_style: 'hosted_openapi_tool_action_bridge',
  claude_code_style: 'mcp_streamable_http_bridge',
  gemini_style: 'a2a_task_bridge_with_openapi_fallback',
  perplexity_style: 'hosted_answer_search_bridge_with_openapi_read_and_commit_preflight',
} as const;

export interface OacpArtifactEnvelope {
  artifact_id: string;
  artifact_type: OacpArtifactType;
  schema_version: string;
  issuer: string;
  issuer_key_id: string;
  subject_type: string;
  subject_id: string;
  tenant_id?: string | undefined;
  merchant_id?: string | undefined;
  buyer_agent_id?: string | undefined;
  seller_agent_id?: string | undefined;
  issued_at: string;
  expires_at: string;
  not_before?: string | undefined;
  source_observed_at?: string | undefined;
  freshness_class: 'fresh' | 'acceptable' | 'stale' | 'unknown';
  /** The https URI of the OACP Token Status List; equals `status.status_list.uri`. */
  revocation_status_url: string;
  /**
   * Token Status List reference (draft-ietf-oauth-status-list §6.2 shape):
   * where this artifact's status is published. Inside the signed envelope.
   */
  status?: OacpStatusReference | undefined;
  policy_version: string;
  adapter_version?: string | undefined;
  evidence_refs: string[];
  payload_hash: string;
  signature_alg: typeof OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm;
  signature: string;
  safety: OacpArtifactSafety;
}

export interface OacpStatusReference {
  status_list: { idx: number; uri: string };
}

export interface OacpArtifactSafety {
  public_safe: boolean;
  contains_private_data: boolean;
  allowed_agent_uses: string[];
  forbidden_agent_uses: string[];
  commitment_allowed: boolean;
  offline_commitment_allowed: boolean;
  requires_online_confirmation: boolean;
  requires_provider_direct_verification: boolean;
  requires_merchant_system_confirmation: boolean;
  stale_behavior: 'refuse_final_commitment' | 'non_binding_only' | 'refuse_all';
  refusal_code_if_invalid: string;
}

export interface OacpArtifactCacheKeyInput {
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  buyer_agent_id: string;
  artifact_type: OacpArtifactType;
  artifact_id: string;
  schema_version: string;
  policy_version: string;
}

export type OacpOfflineCommitmentRefusalCode =
  | 'critical_action_offline_refused'
  | 'artifact_missing_or_invalid'
  | 'artifact_scope_mismatch'
  | 'artifact_expired_or_stale'
  | 'offline_commitment_not_permitted'
  | 'revocation_snapshot_stale'
  | 'risk_cap_exceeded'
  | 'currency_cap_unavailable'
  | 'quantity_cap_exceeded'
  | 'merchant_confirmation_required'
  | 'provider_verification_required'
  | 'unsupported_action';

export interface OacpOfflineCommitmentInput {
  action: OacpOfflineCommitmentAction;
  currency?: string | null | undefined;
  amount_minor_units?: number | null | undefined;
  total_quantity?: number | null | undefined;
  max_quantity_per_sku?: number | null | undefined;
  artifacts_valid: boolean;
  artifacts_scoped_to_all_four: boolean;
  artifacts_allow_offline_commitment: boolean;
  effective_artifact_age_seconds: number;
  effective_artifact_ttl_seconds: number;
  revocation_snapshot_age_seconds: number;
  merchant_confirmation: boolean;
  provider_verification: boolean;
}

export type OacpIssuerKeyState = 'active' | 'retired' | 'revoked';

export interface OacpArtifactScope {
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  buyer_agent_id: string;
}

export type OacpArtifactVerificationRefusalCode =
  | 'artifact_missing_or_invalid'
  | 'artifact_scope_mismatch'
  | 'artifact_not_yet_valid'
  | 'artifact_expired_or_stale'
  | 'artifact_ttl_exceeds_default'
  | 'artifact_revoked'
  | 'artifact_suspended'
  | 'revocation_status_unavailable'
  | 'payload_hash_mismatch'
  | 'signature_missing_or_placeholder'
  | 'signature_algorithm_unsupported'
  | 'issuer_key_untrusted'
  | 'detached_jws_verification_failed';

export type OacpArtifactAuthorityStatus =
  | {
    valid: true;
    status: 'valid';
    artifact_id: string;
    artifact_type: OacpArtifactType;
    cache_key: string | null;
    payload_hash: string;
    expires_at: string;
  }
  | {
    valid: false;
    status: 'refused';
    artifact_id: string | null;
    refusal_code: OacpArtifactVerificationRefusalCode;
    message: string;
  };

export type OacpArtifactSchemaValidationRefusalCode =
  | 'unknown_artifact_type'
  | 'envelope_field_missing'
  | 'scope_field_missing'
  | 'safety_field_missing'
  | 'safety_policy_violation'
  | 'payload_must_be_object'
  | 'payload_field_missing'
  | 'private_or_forbidden_payload_field'
  | 'payload_hash_mismatch'
  | 'signature_missing_or_placeholder'
  | 'signature_algorithm_unsupported'
  | 'artifact_expired_or_stale'
  | 'artifact_not_yet_valid'
  | 'artifact_ttl_exceeds_default'
  | 'protocol_adapter_outlives_references'
  | 'mandate_provider_verification_required'
  | 'public_discovery_offline_change_forbidden'
  | 'commitment_evidence_forbidden_implication';

export type OacpArtifactSchemaValidationResult =
  | {
    valid: true;
    artifact_type: OacpArtifactType;
    schema_version: string;
    required_payload_fields: readonly string[];
  }
  | {
    valid: false;
    artifact_type: string | null;
    refusal_code: OacpArtifactSchemaValidationRefusalCode;
    message: string;
  };

export interface OacpArtifactSchemaDescriptor {
  artifact_type: OacpArtifactType;
  summary: string;
  required_envelope_fields: readonly string[];
  required_payload_fields: readonly string[];
  required_safety_fields: readonly string[];
  requires_tenant_id: boolean;
  requires_merchant_id: boolean;
  requires_seller_agent_id: boolean;
  requires_buyer_agent_id: boolean;
  requires_source_observed_at: boolean;
}

export interface OacpArtifactFixture {
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface OacpBlockedArtifactFixture {
  expected_refusal_code: OacpArtifactSchemaValidationRefusalCode;
  fixture: OacpArtifactFixture;
}

export type OacpOfflineCommitmentDecision =
  | {
    allowed: true;
    tier: OacpRiskTier;
    action: OacpOfflineCommitmentAction;
    evidence_required: Array<'merchant_confirmation' | 'provider_verification' | 'grantex_reconciliation'>;
  }
  | {
    allowed: false;
    tier: OacpRiskTier;
    action: OacpOfflineCommitmentAction;
    refusal_code: OacpOfflineCommitmentRefusalCode;
    message: string;
  };

const ACTION_RISK_TIERS: Record<OacpOfflineCommitmentAction, OacpRiskTier> = {
  browse: 'informational',
  compare: 'informational',
  draft_cart: 'low',
  quote_preview: 'low',
  price_lock: 'medium',
  inventory_hold: 'medium',
  reservation: 'medium',
  order_pending_reconciliation: 'high',
  payment_intent: 'high',
  cancellation: 'high',
  refund_request: 'high',
  return_authorization: 'high',
  support_escalation: 'medium',
  public_discovery_publish: 'critical',
  merchant_approval: 'critical',
  policy_override: 'critical',
  emergency_disable: 'critical',
};

const MERCHANT_CONFIRMATION_ACTIONS = new Set<OacpOfflineCommitmentAction>([
  'price_lock',
  'inventory_hold',
  'reservation',
  'order_pending_reconciliation',
  'cancellation',
  'refund_request',
  'return_authorization',
  'support_escalation',
]);

const PROVIDER_VERIFICATION_ACTIONS = new Set<OacpOfflineCommitmentAction>([
  'payment_intent',
]);

const FORBIDDEN_ARTIFACT_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bank_account',
  'card_number',
  'checkout_payment_enabled',
  'credential',
  'credentials',
  'customer_identifier',
  'live_payment_enabled',
  'live_provider_enabled',
  'merchant_private_api_key',
  'merchant_private_api_url',
  'password',
  'private_key',
  'production_allowlist',
  'public_discovery_enabled',
  'raw_connector_payload',
  'raw_jwt',
  'raw_provider_payload',
  'secret',
  'token',
  'webhook_secret',
]);

const OACP_REQUIRED_ENVELOPE_FIELDS = [
  'artifact_id',
  'artifact_type',
  'schema_version',
  'issuer',
  'issuer_key_id',
  'subject_type',
  'subject_id',
  'issued_at',
  'expires_at',
  'freshness_class',
  'revocation_status_url',
  'policy_version',
  'evidence_refs',
  'payload_hash',
  'signature_alg',
  'signature',
  'safety',
] as const;

const OACP_REQUIRED_SAFETY_FIELDS = [
  'public_safe',
  'contains_private_data',
  'allowed_agent_uses',
  'forbidden_agent_uses',
  'commitment_allowed',
  'offline_commitment_allowed',
  'requires_online_confirmation',
  'requires_provider_direct_verification',
  'requires_merchant_system_confirmation',
  'stale_behavior',
  'refusal_code_if_invalid',
] as const;

export const OACP_ARTIFACT_SCHEMA_DESCRIPTORS: Record<OacpArtifactType, OacpArtifactSchemaDescriptor> = {
  merchant_capability: {
    artifact_type: 'merchant_capability',
    summary: 'Public-safe merchant commerce eligibility, policy, and capability summary.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'merchant_display_name',
      'merchant_category',
      'supported_countries',
      'supported_currencies',
      'commerce_status',
      'public_discovery_state',
      'source_evidence_refs',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: false,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
  seller_agent_capability: {
    artifact_type: 'seller_agent_capability',
    summary: 'Seller agent public card capability summary anchored to Grantex authority artifacts.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'seller_agent_id',
      'merchant_id',
      'agent_runtime',
      'supported_channels',
      'supported_tasks',
      'forbidden_tasks',
      'public_claim_limits',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
  catalog_snapshot: {
    artifact_type: 'catalog_snapshot',
    summary: 'Buyer-safe catalog browse and comparison snapshot.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'catalog_snapshot_id',
      'product_refs',
      'category_refs',
      'source_system_refs',
      'private_field_redaction_status',
      'sample_count',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
  offer: {
    artifact_type: 'offer',
    summary: 'Buyer-safe offer terms and quote/lock posture.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'offer_id',
      'product_id',
      'variant_id',
      'currency',
      'offer_valid_from',
      'offer_valid_until',
      'price_lock_allowed',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: true,
    requires_source_observed_at: true,
  },
  price: {
    artifact_type: 'price',
    summary: 'Buyer-safe price fact with short freshness window.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'product_id',
      'variant_id',
      'amount_minor_units',
      'currency',
      'price_source',
      'price_valid_until',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: true,
    requires_source_observed_at: true,
  },
  inventory: {
    artifact_type: 'inventory',
    summary: 'Buyer-safe inventory freshness fact with bucketed availability.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'product_id',
      'variant_id',
      'availability_state',
      'quantity_bucket',
      'hold_allowed',
      'stale_inventory_refusal',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: true,
    requires_source_observed_at: true,
  },
  policy: {
    artifact_type: 'policy',
    summary: 'Buyer-safe merchant policy summary for returns, warranty, fulfillment, and support.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'return_policy_summary',
      'warranty_policy_summary',
      'fulfillment_policy_summary',
      'cancellation_policy_summary',
      'support_policy_summary',
      'jurisdiction_scope',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
  public_discovery: {
    artifact_type: 'public_discovery',
    summary: 'Read/display-only public discovery state. Publish/unpublish is never allowed offline.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'discovery_state',
      'allowed_surfaces',
      'blocked_surfaces',
      'display_name',
      'public_description',
      'allowed_protocol_adapters',
      'publish_offline_allowed',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
  mandate_capability: {
    artifact_type: 'mandate_capability',
    summary: 'Non-sensitive evidence that a provider-owned mandate or payment capability exists.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'provider_key',
      'rail_type',
      'jurisdiction',
      'mandate_capability_ref',
      'buyer_agent_id',
      'merchant_scope',
      'max_amount',
      'currency',
      'verification_mode',
      'provider_direct_verification_required',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: true,
    requires_source_observed_at: true,
  },
  commitment_evidence: {
    artifact_type: 'commitment_evidence',
    summary: 'Evidence that a final commitment boundary was checked or refused.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'commitment_id',
      'commitment_type',
      'buyer_agent_id',
      'seller_agent_id',
      'merchant_id',
      'artifact_refs_used',
      'policy_decision',
      'offline_commitment_mode',
      'forbidden_execution_claims',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: true,
    requires_source_observed_at: true,
  },
  revocation: {
    artifact_type: 'revocation',
    summary: 'Signed revocation snapshot for local fail-closed cache behavior.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'revocation_list_id',
      'revoked_artifact_ids',
      'revoked_subject_ids',
      'reason_codes',
      'effective_at',
      'emergency_disable',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: false,
    requires_seller_agent_id: false,
    requires_buyer_agent_id: false,
    requires_source_observed_at: false,
  },
  protocol_adapter: {
    artifact_type: 'protocol_adapter',
    summary: 'Internal adapter preview metadata generated from signed Grantex artifacts.',
    required_envelope_fields: OACP_REQUIRED_ENVELOPE_FIELDS,
    required_payload_fields: [
      'adapter_type',
      'adapter_version',
      'referenced_artifact_ids',
      'referenced_artifact_expires_at',
      'generated_from_artifact_hashes',
      'public_claim_limits',
    ],
    required_safety_fields: OACP_REQUIRED_SAFETY_FIELDS,
    requires_tenant_id: true,
    requires_merchant_id: true,
    requires_seller_agent_id: true,
    requires_buyer_agent_id: false,
    requires_source_observed_at: true,
  },
};

const C6W3_BASE_ISSUED_AT = '2026-06-11T00:00:00.000Z';
const C6W3_BASE_SCOPE = {
  tenant_id: 'cten_C6W3',
  merchant_id: 'mch_C6W3',
  seller_agent_id: 'seller_C6W3',
  buyer_agent_id: 'buyer_C6W3',
} as const;

const COMMITMENT_EVIDENCE_FORBIDDEN_TYPES = new Set([
  'payment_capture',
  'refund_execution',
  'settlement',
  'payout',
  'fulfillment_start',
  'merchant_approval',
]);

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function refusal(
  action: OacpOfflineCommitmentAction,
  tier: OacpRiskTier,
  refusal_code: OacpOfflineCommitmentRefusalCode,
  message: string,
): OacpOfflineCommitmentDecision {
  return {
    allowed: false,
    action,
    tier,
    refusal_code,
    message,
  };
}

function isKnownCurrency(value: string | null | undefined): value is OacpCurrency {
  return value === 'INR' || value === 'USD';
}

function amountCapForCurrency(tier: OacpRiskTier, currency: string | null | undefined): number | null {
  if (!isKnownCurrency(currency)) return null;
  return OACP_FIRST_RELEASE_RISK_CAPS[tier].currency_caps[currency] ?? null;
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function isDetachedJws(signature: string): boolean {
  if (signature === 'detached_jws_required_before_publication') return false;
  const parts = signature.split('.');
  const protectedHeader = parts[0] ?? '';
  const detachedPayload = parts[1] ?? null;
  const signatureValue = parts[2] ?? '';
  return parts.length === 3 && protectedHeader.length > 0 && detachedPayload === '' && signatureValue.length > 0;
}

/**
 * Removes members whose value is `undefined`, recursively. Payload builders
 * use `undefined` for an absent member; RFC 8785 has no `undefined`, and
 * `canonicalize` refuses it rather than guessing. Array elements are kept as
 * they are, so an `undefined` element still fails canonicalization.
 */
export function stripUndefinedMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedMembers);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // defineProperty, not assignment: a member named `__proto__` (JSON.parse
    // makes it an own property) must stay a member, not replace the
    // prototype of `out` and vanish from the canonical form.
    if (child !== undefined) {
      Object.defineProperty(out, key, {
        value: stripUndefinedMembers(child), enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return out;
}

/**
 * The RFC 8785 (JCS) canonical JSON of an OACP payload or envelope, after
 * absent (`undefined`) members are removed. Python verifiers produce the same
 * bytes with `json.dumps(v, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for OACP values (no floats). This replaced an
 * order based on `localeCompare`, which is not RFC 8785 and disagreed with
 * Python for member names such as `a_b`/`ab` or upper-case first letters.
 */
export function canonicalizeOacpPayload(payload: unknown): string {
  return canonicalize(stripUndefinedMembers(payload));
}

export function hashOacpPayload(payload: unknown): string {
  return sha256hex(canonicalizeOacpPayload(payload));
}

export function buildOacpArtifactCacheKey(input: OacpArtifactCacheKeyInput): string {
  return [
    input.tenant_id,
    input.merchant_id,
    input.seller_agent_id,
    input.buyer_agent_id,
    input.artifact_type,
    input.artifact_id,
    input.schema_version,
    input.policy_version,
  ].join(':');
}

function isoAfterBase(seconds: number): string {
  return new Date(Date.parse(C6W3_BASE_ISSUED_AT) + seconds * 1000).toISOString();
}

function isOacpArtifactType(value: string | null): value is OacpArtifactType {
  return value !== null && (OACP_ARTIFACT_TYPES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function missingFields(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => record[field] === undefined || record[field] === null);
}

function schemaRefusal(
  artifact_type: string | null,
  refusal_code: OacpArtifactSchemaValidationRefusalCode,
  message: string,
): OacpArtifactSchemaValidationResult {
  return {
    valid: false,
    artifact_type,
    refusal_code,
    message,
  };
}

function ttlForFixture(artifactType: OacpArtifactType): number {
  if (artifactType === 'revocation') return 0;
  if (artifactType === 'mandate_capability') return 120;
  return Math.min(OACP_ARTIFACT_TTLS_SECONDS[artifactType], 300);
}

function safetyForFixture(artifactType: OacpArtifactType): OacpArtifactSafety {
  const base: OacpArtifactSafety = {
    public_safe: true,
    contains_private_data: false,
    allowed_agent_uses: ['browse', 'compare'],
    forbidden_agent_uses: ['payment_capture', 'refund_execution', 'settlement', 'payout'],
    commitment_allowed: false,
    offline_commitment_allowed: false,
    requires_online_confirmation: true,
    requires_provider_direct_verification: false,
    requires_merchant_system_confirmation: false,
    stale_behavior: 'non_binding_only',
    refusal_code_if_invalid: 'artifact_invalid',
  };

  if (['offer', 'price', 'inventory'].includes(artifactType)) {
    return {
      ...base,
      allowed_agent_uses: ['quote_preview', 'price_lock', 'inventory_hold'],
      commitment_allowed: true,
      requires_merchant_system_confirmation: true,
      stale_behavior: 'refuse_final_commitment',
    };
  }
  if (artifactType === 'mandate_capability') {
    return {
      ...base,
      allowed_agent_uses: ['payment_intent'],
      commitment_allowed: true,
      requires_provider_direct_verification: true,
      stale_behavior: 'refuse_final_commitment',
    };
  }
  if (artifactType === 'commitment_evidence') {
    return {
      ...base,
      allowed_agent_uses: ['audit', 'reconciliation'],
      stale_behavior: 'refuse_final_commitment',
    };
  }
  if (artifactType === 'public_discovery') {
    return {
      ...base,
      allowed_agent_uses: ['discovery_display'],
      forbidden_agent_uses: ['public_discovery_publish', 'public_discovery_unpublish'],
      requires_online_confirmation: true,
      stale_behavior: 'non_binding_only',
    };
  }
  if (artifactType === 'seller_agent_capability' || artifactType === 'protocol_adapter') {
    return {
      ...base,
      forbidden_agent_uses: ['order_creation', 'payment_intent', 'merchant_approval'],
    };
  }
  return base;
}

function payloadForFixture(artifactType: OacpArtifactType): Record<string, unknown> {
  switch (artifactType) {
    case 'merchant_capability':
      return {
        merchant_display_name: 'Synthetic Merchant C6W3',
        merchant_category: 'test_category',
        supported_countries: ['IN'],
        supported_currencies: ['INR'],
        commerce_status: 'internal_review_only',
        public_discovery_state: 'disabled',
        source_evidence_refs: ['evidence_C6W3_merchant'],
      };
    case 'seller_agent_capability':
      return {
        seller_agent_id: C6W3_BASE_SCOPE.seller_agent_id,
        merchant_id: C6W3_BASE_SCOPE.merchant_id,
        agent_runtime: 'agenticorg_internal',
        supported_channels: ['internal_test'],
        supported_tasks: ['answer_policy_question', 'prepare_quote_preview'],
        forbidden_tasks: ['payment_capture', 'merchant_approval'],
        public_claim_limits: ['no_payment_authority', 'no_public_launch_claim'],
      };
    case 'catalog_snapshot':
      return {
        catalog_snapshot_id: 'catalog_C6W3',
        product_refs: ['prod_C6W3_1'],
        category_refs: ['cat_C6W3_test'],
        source_system_refs: ['source_ref_C6W3_redacted'],
        private_field_redaction_status: 'redacted',
        sample_count: 1,
      };
    case 'offer':
      return {
        offer_id: 'offer_C6W3',
        product_id: 'prod_C6W3_1',
        variant_id: 'variant_C6W3_1',
        currency: 'INR',
        offer_valid_from: C6W3_BASE_ISSUED_AT,
        offer_valid_until: isoAfterBase(300),
        price_lock_allowed: true,
      };
    case 'price':
      return {
        product_id: 'prod_C6W3_1',
        variant_id: 'variant_C6W3_1',
        amount_minor_units: 99900,
        currency: 'INR',
        price_source: 'redacted_source_snapshot',
        price_valid_until: isoAfterBase(300),
      };
    case 'inventory':
      return {
        product_id: 'prod_C6W3_1',
        variant_id: 'variant_C6W3_1',
        availability_state: 'available',
        quantity_bucket: 'low',
        hold_allowed: true,
        stale_inventory_refusal: 'inventory_stale',
      };
    case 'policy':
      return {
        return_policy_summary: 'Synthetic 7 day return window for internal tests.',
        warranty_policy_summary: 'Synthetic limited warranty summary.',
        fulfillment_policy_summary: 'Synthetic dispatch estimate.',
        cancellation_policy_summary: 'Synthetic cancellation before dispatch.',
        support_policy_summary: 'Synthetic support queue only.',
        jurisdiction_scope: ['IN'],
      };
    case 'public_discovery':
      return {
        discovery_state: 'disabled',
        allowed_surfaces: [],
        blocked_surfaces: ['public_search'],
        display_name: 'Synthetic Merchant C6W3',
        public_description: 'Synthetic internal-only merchant description.',
        allowed_protocol_adapters: [],
        publish_offline_allowed: false,
      };
    case 'mandate_capability':
      return {
        provider_key: 'provider_stub_c6w3',
        rail_type: 'sandbox_reference_only',
        jurisdiction: 'IN',
        mandate_capability_ref: 'mandate_ref_C6W3_hash_only',
        buyer_agent_id: C6W3_BASE_SCOPE.buyer_agent_id,
        merchant_scope: [C6W3_BASE_SCOPE.merchant_id],
        max_amount: 500000,
        currency: 'INR',
        verification_mode: 'provider_direct_verification_required',
        provider_direct_verification_required: true,
      };
    case 'commitment_evidence':
      return {
        commitment_id: 'commitment_C6W3',
        commitment_type: 'price_lock',
        buyer_agent_id: C6W3_BASE_SCOPE.buyer_agent_id,
        seller_agent_id: C6W3_BASE_SCOPE.seller_agent_id,
        merchant_id: C6W3_BASE_SCOPE.merchant_id,
        artifact_refs_used: ['price_C6W3'],
        policy_decision: 'allowed_internal_only',
        offline_commitment_mode: false,
        forbidden_execution_claims: [],
      };
    case 'revocation':
      return {
        revocation_list_id: 'revocation_C6W3',
        revoked_artifact_ids: [],
        revoked_subject_ids: [],
        reason_codes: [],
        effective_at: C6W3_BASE_ISSUED_AT,
        emergency_disable: false,
      };
    case 'protocol_adapter':
      return {
        adapter_type: 'schema_org_preview',
        adapter_version: 'adapter_C6W3',
        referenced_artifact_ids: ['merchant_capability_C6W3', 'price_C6W3'],
        referenced_artifact_expires_at: [isoAfterBase(300)],
        generated_from_artifact_hashes: ['hash_C6W3_redacted'],
        public_claim_limits: ['internal_preview_only', 'not_public_ready'],
      };
  }
}

function makeC6W3Fixture(artifactType: OacpArtifactType): OacpArtifactFixture {
  const descriptor = OACP_ARTIFACT_SCHEMA_DESCRIPTORS[artifactType];
  const payload = payloadForFixture(artifactType);
  const expiresAt = isoAfterBase(ttlForFixture(artifactType));
  const envelope: Record<string, unknown> = {
    artifact_id: `${artifactType}_C6W3`,
    artifact_type: artifactType,
    schema_version: 'oacp.internal.v1',
    issuer: 'grantex',
    issuer_key_id: 'kid_C6W3_stub',
    subject_type: artifactType,
    subject_id: `subject_${artifactType}_C6W3`,
    tenant_id: C6W3_BASE_SCOPE.tenant_id,
    issued_at: C6W3_BASE_ISSUED_AT,
    expires_at: expiresAt,
    freshness_class: 'fresh',
    revocation_status_url: `https://grantex.example.invalid/oacp/revocations/${artifactType}_C6W3`,
    policy_version: 'policy_C6W3',
    evidence_refs: [`evidence_${artifactType}_C6W3`],
    payload_hash: hashOacpPayload(payload),
    signature_alg: OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm,
    signature: `eyJhbGciOiJFUzI1NiJ9..sig_${artifactType}_C6W3`,
    safety: safetyForFixture(artifactType),
  };

  if (descriptor.requires_merchant_id) envelope.merchant_id = C6W3_BASE_SCOPE.merchant_id;
  if (descriptor.requires_seller_agent_id) envelope.seller_agent_id = C6W3_BASE_SCOPE.seller_agent_id;
  if (descriptor.requires_buyer_agent_id) envelope.buyer_agent_id = C6W3_BASE_SCOPE.buyer_agent_id;
  if (descriptor.requires_source_observed_at) envelope.source_observed_at = C6W3_BASE_ISSUED_AT;

  return { envelope, payload };
}

function makeBlockedC6W3Fixture(artifactType: OacpArtifactType): OacpBlockedArtifactFixture {
  const descriptor = OACP_ARTIFACT_SCHEMA_DESCRIPTORS[artifactType];
  const fixture = makeC6W3Fixture(artifactType);
  const payload = { ...fixture.payload };
  delete payload[descriptor.required_payload_fields[0] ?? 'missing'];
  return {
    expected_refusal_code: 'payload_field_missing',
    fixture: {
      envelope: {
        ...fixture.envelope,
        payload_hash: hashOacpPayload(payload),
      },
      payload,
    },
  };
}

export const OACP_C6W3_VALID_ARTIFACT_FIXTURES = Object.fromEntries(
  OACP_ARTIFACT_TYPES.map((artifactType) => [artifactType, makeC6W3Fixture(artifactType)]),
) as Record<OacpArtifactType, OacpArtifactFixture>;

export const OACP_C6W3_BLOCKED_ARTIFACT_FIXTURES = Object.fromEntries(
  OACP_ARTIFACT_TYPES.map((artifactType) => [artifactType, makeBlockedC6W3Fixture(artifactType)]),
) as Record<OacpArtifactType, OacpBlockedArtifactFixture>;

export function validateOacpArtifactSchema(input: {
  envelope: unknown;
  payload: unknown;
  now_iso?: string | undefined;
}): OacpArtifactSchemaValidationResult {
  const envelope = asRecord(input.envelope);
  if (envelope === null) {
    return schemaRefusal(null, 'envelope_field_missing', 'Artifact envelope must be an object.');
  }

  const artifactTypeValue = typeof envelope.artifact_type === 'string' ? envelope.artifact_type : null;
  if (!isOacpArtifactType(artifactTypeValue)) {
    return schemaRefusal(artifactTypeValue, 'unknown_artifact_type', 'Unknown OACP artifact type.');
  }
  const descriptor = OACP_ARTIFACT_SCHEMA_DESCRIPTORS[artifactTypeValue];

  const missingEnvelope = missingFields(envelope, descriptor.required_envelope_fields);
  if (missingEnvelope.length > 0) {
    return schemaRefusal(artifactTypeValue, 'envelope_field_missing', `Missing envelope fields: ${missingEnvelope.join(', ')}`);
  }
  if (descriptor.requires_tenant_id && envelope.tenant_id === undefined) {
    return schemaRefusal(artifactTypeValue, 'scope_field_missing', 'tenant_id is required for this artifact family.');
  }
  if (descriptor.requires_merchant_id && envelope.merchant_id === undefined) {
    return schemaRefusal(artifactTypeValue, 'scope_field_missing', 'merchant_id is required for this artifact family.');
  }
  if (descriptor.requires_seller_agent_id && envelope.seller_agent_id === undefined) {
    return schemaRefusal(artifactTypeValue, 'scope_field_missing', 'seller_agent_id is required for this artifact family.');
  }
  if (descriptor.requires_buyer_agent_id && envelope.buyer_agent_id === undefined) {
    return schemaRefusal(artifactTypeValue, 'scope_field_missing', 'buyer_agent_id is required for this artifact family.');
  }
  if (descriptor.requires_source_observed_at && envelope.source_observed_at === undefined) {
    return schemaRefusal(artifactTypeValue, 'envelope_field_missing', 'source_observed_at is required for this artifact family.');
  }

  const safety = asRecord(envelope.safety);
  if (safety === null) {
    return schemaRefusal(artifactTypeValue, 'safety_field_missing', 'Artifact safety metadata must be present.');
  }
  const missingSafety = missingFields(safety, descriptor.required_safety_fields);
  if (missingSafety.length > 0) {
    return schemaRefusal(artifactTypeValue, 'safety_field_missing', `Missing safety fields: ${missingSafety.join(', ')}`);
  }
  if (safety.public_safe !== true || safety.contains_private_data !== false) {
    return schemaRefusal(artifactTypeValue, 'safety_policy_violation', 'Artifact safety metadata must be public-safe.');
  }

  const payload = asRecord(input.payload);
  if (payload === null) {
    return schemaRefusal(artifactTypeValue, 'payload_must_be_object', 'Artifact payload must be an object.');
  }
  try {
    assertNoForbiddenOacpArtifactFields(payload);
  } catch {
    return schemaRefusal(artifactTypeValue, 'private_or_forbidden_payload_field', 'Payload contains private, raw, credential, or enabling fields.');
  }

  const missingPayload = missingFields(payload, descriptor.required_payload_fields);
  if (missingPayload.length > 0) {
    return schemaRefusal(artifactTypeValue, 'payload_field_missing', `Missing payload fields: ${missingPayload.join(', ')}`);
  }

  if (envelope.signature_alg !== OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm) {
    return schemaRefusal(artifactTypeValue, 'signature_algorithm_unsupported', 'Artifact signature algorithm is unsupported.');
  }
  if (typeof envelope.signature !== 'string' || !isDetachedJws(envelope.signature)) {
    return schemaRefusal(artifactTypeValue, 'signature_missing_or_placeholder', 'Artifact must carry a detached JWS signature.');
  }
  if (envelope.payload_hash !== hashOacpPayload(payload)) {
    return schemaRefusal(artifactTypeValue, 'payload_hash_mismatch', 'Envelope payload_hash must match the canonical payload.');
  }

  const issuedMillis = parseIsoMillis(typeof envelope.issued_at === 'string' ? envelope.issued_at : undefined);
  const expiresMillis = parseIsoMillis(typeof envelope.expires_at === 'string' ? envelope.expires_at : undefined);
  if (issuedMillis === null || expiresMillis === null) {
    return schemaRefusal(artifactTypeValue, 'envelope_field_missing', 'Artifact timestamps are invalid.');
  }
  const defaultTtl = OACP_ARTIFACT_TTLS_SECONDS[artifactTypeValue];
  if (expiresMillis < issuedMillis || Math.floor((expiresMillis - issuedMillis) / 1000) > defaultTtl) {
    return schemaRefusal(artifactTypeValue, 'artifact_ttl_exceeds_default', 'Artifact TTL exceeds the pinned default.');
  }

  const nowMillis = parseIsoMillis(input.now_iso);
  const notBeforeMillis = parseIsoMillis(typeof envelope.not_before === 'string' ? envelope.not_before : undefined);
  if (nowMillis !== null) {
    if (notBeforeMillis !== null && nowMillis < notBeforeMillis) {
      return schemaRefusal(artifactTypeValue, 'artifact_not_yet_valid', 'Artifact is not yet valid.');
    }
    if (nowMillis > expiresMillis) {
      return schemaRefusal(artifactTypeValue, 'artifact_expired_or_stale', 'Artifact has expired.');
    }
  }

  if (artifactTypeValue === 'protocol_adapter') {
    const referencedExpiry = Array.isArray(payload.referenced_artifact_expires_at)
      ? payload.referenced_artifact_expires_at
      : [];
    const referencedMillis = referencedExpiry
      .map((value) => (typeof value === 'string' ? parseIsoMillis(value) : null))
      .filter((value): value is number => value !== null);
    const earliestReferenced = referencedMillis.length > 0 ? Math.min(...referencedMillis) : null;
    if (earliestReferenced === null || expiresMillis > earliestReferenced) {
      return schemaRefusal(artifactTypeValue, 'protocol_adapter_outlives_references', 'Protocol adapter outlives referenced artifacts.');
    }
  }

  if (
    artifactTypeValue === 'mandate_capability'
    && (payload.provider_direct_verification_required !== true || safety.requires_provider_direct_verification !== true)
  ) {
    return schemaRefusal(artifactTypeValue, 'mandate_provider_verification_required', 'Mandate capability requires direct provider verification.');
  }

  if (
    artifactTypeValue === 'public_discovery'
    && (payload.publish_offline_allowed !== false || safety.offline_commitment_allowed !== false)
  ) {
    return schemaRefusal(artifactTypeValue, 'public_discovery_offline_change_forbidden', 'Public discovery publish or unpublish is not allowed offline.');
  }

  if (
    artifactTypeValue === 'commitment_evidence'
    && (
      (typeof payload.commitment_type === 'string' && COMMITMENT_EVIDENCE_FORBIDDEN_TYPES.has(payload.commitment_type))
      || (Array.isArray(payload.forbidden_execution_claims) && payload.forbidden_execution_claims.length > 0)
    )
  ) {
    return schemaRefusal(artifactTypeValue, 'commitment_evidence_forbidden_implication', 'Commitment evidence cannot imply execution authority.');
  }

  return {
    valid: true,
    artifact_type: artifactTypeValue,
    schema_version: String(envelope.schema_version),
    required_payload_fields: descriptor.required_payload_fields,
  };
}

export function assertNoForbiddenOacpArtifactFields(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (FORBIDDEN_ARTIFACT_KEYS.has(normalizeKey(key))) {
          throw new Error(`OACP artifact cannot contain private or enabling field: ${key}`);
        }
        stack.push(child);
      }
    }
  }
}

export function buildUnsignedOacpArtifactEnvelope(input: {
  artifact_id: string;
  artifact_type: OacpArtifactType;
  issuer: string;
  issuer_key_id: string;
  subject_type: string;
  subject_id: string;
  tenant_id?: string | undefined;
  merchant_id?: string | undefined;
  buyer_agent_id?: string | undefined;
  seller_agent_id?: string | undefined;
  issued_at: string;
  expires_at: string;
  source_observed_at?: string | undefined;
  policy_version: string;
  /** Where the artifact's status is published; sets `status` and `revocation_status_url`. */
  status_list?: { idx: number; uri: string } | undefined;
  /** Only when there is no status list entry (an unsigned preview). */
  revocation_status_url?: string | undefined;
  evidence_refs?: string[] | undefined;
  payload: unknown;
  safety: OacpArtifactSafety;
}): OacpArtifactEnvelope {
  assertNoForbiddenOacpArtifactFields(input.payload);
  if (!input.safety.public_safe || input.safety.contains_private_data) {
    throw new Error('OACP artifact envelope requires public-safe payloads without private data');
  }
  return {
    artifact_id: input.artifact_id,
    artifact_type: input.artifact_type,
    schema_version: OACP_ARTIFACT_SCHEMA_VERSION,
    issuer: input.issuer,
    issuer_key_id: input.issuer_key_id,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    tenant_id: input.tenant_id,
    merchant_id: input.merchant_id,
    buyer_agent_id: input.buyer_agent_id,
    seller_agent_id: input.seller_agent_id,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    source_observed_at: input.source_observed_at,
    freshness_class: 'fresh',
    revocation_status_url: input.status_list?.uri ?? input.revocation_status_url ?? '',
    status: input.status_list
      ? { status_list: { idx: input.status_list.idx, uri: input.status_list.uri } }
      : undefined,
    policy_version: input.policy_version,
    evidence_refs: input.evidence_refs ?? [],
    payload_hash: hashOacpPayload(input.payload),
    signature_alg: OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm,
    signature: 'detached_jws_required_before_publication',
    safety: input.safety,
  };
}

export function riskTierForOacpOfflineAction(action: OacpOfflineCommitmentAction): OacpRiskTier {
  return ACTION_RISK_TIERS[action] ?? 'critical';
}

export function evaluateOacpOfflineCommitment(
  input: OacpOfflineCommitmentInput,
): OacpOfflineCommitmentDecision {
  const tier = riskTierForOacpOfflineAction(input.action);
  const cap = OACP_FIRST_RELEASE_RISK_CAPS[tier];
  if (!cap.offline_allowed) {
    return refusal(input.action, tier, 'critical_action_offline_refused', 'Critical authority actions are not allowed offline.');
  }
  if (!input.artifacts_valid) {
    return refusal(input.action, tier, 'artifact_missing_or_invalid', 'Required OACP artifacts are missing, revoked, ambiguous, or invalid.');
  }
  if (!input.artifacts_scoped_to_all_four) {
    return refusal(input.action, tier, 'artifact_scope_mismatch', 'Artifacts must be scoped to tenant, merchant, seller agent, and buyer agent.');
  }
  if (!input.artifacts_allow_offline_commitment) {
    return refusal(input.action, tier, 'offline_commitment_not_permitted', 'Artifacts do not permit offline commitment for this action.');
  }
  if (input.effective_artifact_age_seconds > input.effective_artifact_ttl_seconds) {
    return refusal(input.action, tier, 'artifact_expired_or_stale', 'The effective artifact TTL has expired.');
  }
  const revocationMaxAge = OACP_REVOCATION_SNAPSHOT_MAX_AGE_SECONDS[tier];
  if (revocationMaxAge === null || input.revocation_snapshot_age_seconds > revocationMaxAge) {
    return refusal(input.action, tier, 'revocation_snapshot_stale', 'The local revocation snapshot is too stale for this action.');
  }

  if (input.amount_minor_units !== null && input.amount_minor_units !== undefined) {
    const amountCap = amountCapForCurrency(tier, input.currency);
    if (amountCap === null) {
      return refusal(input.action, tier, 'currency_cap_unavailable', 'No approved offline commitment cap exists for this currency.');
    }
    if (input.amount_minor_units > amountCap) {
      return refusal(input.action, tier, 'risk_cap_exceeded', 'Requested amount exceeds the first-release offline commitment cap.');
    }
  }

  if (
    cap.total_quantity_cap !== null
    && input.total_quantity !== null
    && input.total_quantity !== undefined
    && input.total_quantity > cap.total_quantity_cap
  ) {
    return refusal(input.action, tier, 'quantity_cap_exceeded', 'Requested quantity exceeds the first-release offline commitment cap.');
  }

  if (
    cap.per_sku_quantity_cap !== null
    && input.max_quantity_per_sku !== null
    && input.max_quantity_per_sku !== undefined
    && input.max_quantity_per_sku > cap.per_sku_quantity_cap
  ) {
    return refusal(input.action, tier, 'quantity_cap_exceeded', 'Requested per-SKU quantity exceeds the first-release offline commitment cap.');
  }

  if (MERCHANT_CONFIRMATION_ACTIONS.has(input.action) && !input.merchant_confirmation) {
    return refusal(input.action, tier, 'merchant_confirmation_required', 'Merchant/source confirmation is required for this offline commitment.');
  }

  if (PROVIDER_VERIFICATION_ACTIONS.has(input.action) && !input.provider_verification) {
    return refusal(input.action, tier, 'provider_verification_required', 'Provider verification is required for this offline commitment.');
  }

  const evidence_required: Array<'merchant_confirmation' | 'provider_verification' | 'grantex_reconciliation'> = ['grantex_reconciliation'];
  if (MERCHANT_CONFIRMATION_ACTIONS.has(input.action)) evidence_required.unshift('merchant_confirmation');
  if (PROVIDER_VERIFICATION_ACTIONS.has(input.action)) evidence_required.unshift('provider_verification');

  return {
    allowed: true,
    action: input.action,
    tier,
    evidence_required,
  };
}
