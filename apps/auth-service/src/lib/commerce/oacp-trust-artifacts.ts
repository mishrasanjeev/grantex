import { sha256hex } from '../hash.js';
import { stableJson } from './idempotency.js';

export const OACP_ARTIFACT_SIGNATURE_PROFILE = {
  payload_format: 'canonical_json',
  signature_format: 'detached_jws',
  canonicalization: 'json_canonicalization_scheme_style',
  first_algorithm: 'ES256',
  artifact_container: 'json_object',
  jwt_container_allowed: false,
  cose_first_version: false,
  ad_hoc_signed_json_allowed: false,
} as const;

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
  revocation: 0,
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
  revocation_status_url: string;
  policy_version: string;
  adapter_version?: string | undefined;
  evidence_refs: string[];
  payload_hash: string;
  signature_alg: typeof OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm;
  signature: string;
  safety: OacpArtifactSafety;
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

export interface OacpIssuerKeyMetadata {
  issuer: string;
  issuer_key_id: string;
  algorithm: typeof OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm;
  state: OacpIssuerKeyState;
  not_before?: string | undefined;
  expires_at?: string | undefined;
}

export interface OacpArtifactScope {
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  buyer_agent_id: string;
}

export interface OacpDetachedJwsSignerInput {
  canonical_payload: string;
  payload_hash: string;
  artifact_id: string;
  issuer: string;
  issuer_key_id: string;
  signature_alg: typeof OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm;
}

export interface OacpDetachedJwsVerifierInput extends OacpDetachedJwsSignerInput {
  signature: string;
}

export type OacpDetachedJwsSigner = (input: OacpDetachedJwsSignerInput) => string;
export type OacpDetachedJwsVerifier = (input: OacpDetachedJwsVerifierInput) => boolean;

export type OacpArtifactVerificationRefusalCode =
  | 'artifact_missing_or_invalid'
  | 'artifact_scope_mismatch'
  | 'artifact_not_yet_valid'
  | 'artifact_expired_or_stale'
  | 'artifact_ttl_exceeds_default'
  | 'artifact_revoked'
  | 'payload_hash_mismatch'
  | 'signature_missing_or_placeholder'
  | 'signature_algorithm_unsupported'
  | 'issuer_key_untrusted'
  | 'issuer_key_inactive'
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

export const OACP_C6W4_PROTOCOL_ADAPTER_SURFACES = [
  'schema_org_jsonld',
  'ucp_capability_profile',
  'acp_commerce_capability',
  'ap2_evidence_intent_summary',
  'a2a_agent_card_task_capability',
  'mcp_tool_resource_capability',
] as const;

export type OacpProtocolAdapterSurface = typeof OACP_C6W4_PROTOCOL_ADAPTER_SURFACES[number];

export type OacpAdapterPreviewRefusalCode =
  | 'unknown_adapter_surface'
  | 'source_artifact_missing'
  | 'source_artifact_invalid'
  | 'source_artifact_expired_or_stale'
  | 'private_or_forbidden_payload_field';

export interface OacpProtocolAdapterDescriptor {
  surface: OacpProtocolAdapterSurface;
  summary: string;
  required_artifact_types: readonly OacpArtifactType[];
  max_ttl_seconds: number;
  blocked_capabilities: readonly string[];
}

export interface OacpProtocolAdapterPreviewInput {
  surface: OacpProtocolAdapterSurface;
  artifacts: readonly OacpArtifactFixture[];
  generated_at: string;
  now_iso?: string | undefined;
}

export type OacpProtocolAdapterPreviewResult =
  | {
    generated: true;
    status: 'preview_only';
    surface: OacpProtocolAdapterSurface;
    adapter_descriptor: OacpProtocolAdapterDescriptor;
    source_artifact_ids: string[];
    source_artifact_families: OacpArtifactType[];
    source_authority: 'grantex_canonical_oacp_artifact_authority';
    generated_at: string;
    expires_at: string;
    max_ttl_seconds: number;
    freshness_tier: OacpArtifactEnvelope['freshness_class'] | 'mixed';
    unsupported_capabilities: string[];
    blocked_capabilities: string[];
    non_authoritative_for_transaction: true;
    no_checkout_payment_enablement: true;
    no_live_provider_enablement: true;
    no_public_discovery_enablement: true;
    surface_payload: Record<string, unknown>;
  }
  | {
    generated: false;
    status: 'refused';
    surface: string;
    refusal_code: OacpAdapterPreviewRefusalCode;
    message: string;
  };

export const OACP_C6W5_NON_BINDING_PREVIEW_ACTIONS = [
  'browse_merchant_profile',
  'inspect_seller_card',
  'compare_catalog_summaries',
  'explain_policy',
  'explain_available_capabilities',
  'show_source_freshness_labels',
  'prepare_buyer_question',
  'prepare_seller_agent_remediation_suggestion',
] as const;

export const OACP_C6W5_COMMITMENT_ADJACENT_ACTIONS = [
  'prepare_draft_quote',
  'prepare_draft_cart',
  'ask_refresh_source_facts',
  'prepare_non_binding_reservation_request',
  'prepare_mandate_capability_check_request',
  'prepare_human_confirmation_prompt',
] as const;

export const OACP_C6W5_COMMITMENT_BOUND_ACTIONS = [
  'price_lock',
  'inventory_hold',
  'reservation',
  'order_placement',
  'payment_intent',
  'mandate_setup_use',
  'cancellation',
  'refund_request',
  'return_authorization',
  'support_escalation_sla_promise',
] as const;

export const OACP_C6W5_ALWAYS_BLOCKED_ACTIONS = [
  'live_payment_execution',
  'live_provider_rail_call',
  'public_discovery_enablement',
  'production_checkout_payment_creation',
  'merchant_private_api_call',
  'provider_private_api_call',
  'protocol_publication_submission',
  'certification_conformance_claim',
  'final_delivery_refund_settlement_payout_promise',
] as const;

export type OacpC6W5NonBindingPreviewAction = typeof OACP_C6W5_NON_BINDING_PREVIEW_ACTIONS[number];
export type OacpC6W5CommitmentAdjacentAction = typeof OACP_C6W5_COMMITMENT_ADJACENT_ACTIONS[number];
export type OacpC6W5CommitmentBoundAction = typeof OACP_C6W5_COMMITMENT_BOUND_ACTIONS[number];
export type OacpC6W5AlwaysBlockedAction = typeof OACP_C6W5_ALWAYS_BLOCKED_ACTIONS[number];
export type OacpC6W5CommitmentBoundaryAction =
  | OacpC6W5NonBindingPreviewAction
  | OacpC6W5CommitmentAdjacentAction
  | OacpC6W5CommitmentBoundAction
  | OacpC6W5AlwaysBlockedAction;
export type OacpC6W5ActionClass =
  | 'non_binding_preview'
  | 'commitment_adjacent'
  | 'commitment_bound'
  | 'always_blocked';
export type OacpC6W5OfflineModeStatus =
  | 'online_policy_available'
  | 'offline_cache_valid'
  | 'offline_prepared_not_executed'
  | 'offline_blocked';

export interface OacpC6W5FreshnessSummary {
  freshness_tier: OacpArtifactEnvelope['freshness_class'] | 'mixed';
  artifact_freshness: Record<string, OacpArtifactEnvelope['freshness_class']>;
  earliest_expires_at: string | null;
}

export interface OacpC6W5CommitmentBoundaryInput {
  action: OacpC6W5CommitmentBoundaryAction;
  artifacts: readonly OacpArtifactFixture[];
  adapter_preview: OacpProtocolAdapterPreviewResult;
  now_iso: string;
  grantex_available: boolean;
  revocation_snapshot_age_seconds?: number | null | undefined;
  currency?: string | null | undefined;
  amount_minor_units?: number | null | undefined;
  total_quantity?: number | null | undefined;
  max_quantity_per_sku?: number | null | undefined;
}

export interface OacpC6W5CommitmentBoundaryDecision {
  action: OacpC6W5CommitmentBoundaryAction;
  action_class: OacpC6W5ActionClass;
  allowed_to_preview: boolean;
  allowed_to_prepare: boolean;
  allowed_to_execute: false;
  refusal_or_escalation_reason: string | null;
  required_fresh_artifact_families: OacpArtifactType[];
  source_artifact_ids: string[];
  source_artifact_families: OacpArtifactType[];
  source_authority: 'grantex_canonical_oacp_artifact_authority';
  freshness_summary: OacpC6W5FreshnessSummary;
  risk_tier: OacpRiskTier;
  offline_mode_status: OacpC6W5OfflineModeStatus;
  buyer_safe_message: string;
  blocked_capabilities: string[];
  non_authoritative_for_transaction: true;
  no_checkout_payment_enablement: true;
  no_live_provider_enablement: true;
  no_public_discovery_enablement: true;
}

export const OACP_C6W6_PREPARED_ENVELOPE_KINDS = [
  'buyer_confirmation_request',
  'seller_source_refresh_request',
  'merchant_confirmation_request',
  'mandate_capability_evidence_request',
  'support_escalation_preparation',
] as const;

export type OacpC6W6PreparedEnvelopeKind = typeof OACP_C6W6_PREPARED_ENVELOPE_KINDS[number];

export type OacpC6W6EnvelopeRefusalCode =
  | 'resolver_decision_missing'
  | 'resolver_decision_allows_execution'
  | 'source_artifacts_missing'
  | 'source_freshness_missing_or_stale'
  | 'action_blocked_in_c6w6'
  | 'risk_context_missing_or_ambiguous'
  | 'envelope_kind_action_mismatch'
  | 'private_or_forbidden_envelope_field';

export interface OacpC6W6PreparedEnvelopeInput {
  envelope_kind: OacpC6W6PreparedEnvelopeKind;
  resolver_decision: OacpC6W5CommitmentBoundaryDecision | null;
  created_at: string;
  source_resolver_decision_id?: string | null | undefined;
  evidence_refs?: readonly string[] | undefined;
  unsupported_capabilities?: readonly string[] | undefined;
  amount_minor_units?: number | null | undefined;
  currency?: string | null | undefined;
  total_quantity?: number | null | undefined;
  max_quantity_per_sku?: number | null | undefined;
}

export interface OacpC6W6PreparedCommitmentEnvelope {
  envelope_id: string;
  envelope_kind: OacpC6W6PreparedEnvelopeKind;
  envelope_status: 'prepared_only' | 'blocked';
  created_at: string;
  expires_at: string;
  max_ttl_seconds: number;
  source_resolver_decision_id: string;
  action_class: OacpC6W5ActionClass;
  requested_action: OacpC6W5CommitmentBoundaryAction;
  risk_tier: OacpRiskTier;
  offline_mode_status: OacpC6W5OfflineModeStatus;
  allowed_to_preview: boolean;
  allowed_to_prepare: boolean;
  allowed_to_execute: false;
  prepared_only: true;
  source_artifact_ids: string[];
  source_artifact_families: OacpArtifactType[];
  source_authority: 'grantex_canonical_oacp_artifact_authority';
  required_fresh_artifact_families: OacpArtifactType[];
  freshness_summary: OacpC6W5FreshnessSummary;
  blocked_capabilities: string[];
  unsupported_capabilities: string[];
  buyer_safe_message: string;
  seller_safe_message: string;
  next_human_step: string;
  next_system_step_label: string;
  redacted_evidence_refs: string[];
  non_authoritative_for_transaction: true;
  no_checkout_payment_enablement: true;
  no_live_provider_enablement: true;
  no_public_discovery_enablement: true;
}

export type OacpC6W6PreparedEnvelopeResult =
  | {
    generated: true;
    status: 'prepared_only';
    envelope: OacpC6W6PreparedCommitmentEnvelope;
  }
  | {
    generated: false;
    status: 'blocked';
    refusal_code: OacpC6W6EnvelopeRefusalCode;
    message: string;
    blocked_envelope?: OacpC6W6PreparedCommitmentEnvelope;
  };

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

const C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES = [
  'checkout_create',
  'payment_authorize',
  'payment_capture',
  'refund_execute',
  'settlement_execute',
  'payout_execute',
  'fulfillment_start',
  'merchant_approval',
  'public_discovery_publish',
  'public_discovery_unpublish',
  'live_provider_call',
  'merchant_private_api_call',
] as const;

export const OACP_C6W4_PROTOCOL_ADAPTER_DESCRIPTORS: Record<OacpProtocolAdapterSurface, OacpProtocolAdapterDescriptor> = {
  schema_org_jsonld: {
    surface: 'schema_org_jsonld',
    summary: 'schema.org JSON-LD style internal discovery preview derived from signed OACP artifacts.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'catalog_snapshot', 'policy', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
  ucp_capability_profile: {
    surface: 'ucp_capability_profile',
    summary: 'UCP-style internal capability profile preview derived from signed OACP artifacts.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'policy', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
  acp_commerce_capability: {
    surface: 'acp_commerce_capability',
    summary: 'ACP-style commerce capability shape preview without checkout or payment authority.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'policy', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
  ap2_evidence_intent_summary: {
    surface: 'ap2_evidence_intent_summary',
    summary: 'AP2-style evidence and intent summary preview without mandate or payment execution authority.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'policy', 'commitment_evidence', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
  a2a_agent_card_task_capability: {
    surface: 'a2a_agent_card_task_capability',
    summary: 'A2A-style agent card and task capability preview for read-only agent routing.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'policy', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
  mcp_tool_resource_capability: {
    surface: 'mcp_tool_resource_capability',
    summary: 'MCP-style tool and resource capability preview limited to read-only commerce facts.',
    required_artifact_types: ['merchant_capability', 'seller_agent_capability', 'policy', 'protocol_adapter'],
    max_ttl_seconds: OACP_ARTIFACT_TTLS_SECONDS.protocol_adapter,
    blocked_capabilities: C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES,
  },
};

const C6W5_BASE_PREVIEW_ARTIFACTS: readonly OacpArtifactType[] = [
  'merchant_capability',
  'seller_agent_capability',
  'policy',
  'protocol_adapter',
] as const;

export const OACP_C6W5_REQUIRED_FRESH_ARTIFACT_FAMILIES: Record<
OacpC6W5CommitmentBoundaryAction,
readonly OacpArtifactType[]
> = {
  browse_merchant_profile: C6W5_BASE_PREVIEW_ARTIFACTS,
  inspect_seller_card: C6W5_BASE_PREVIEW_ARTIFACTS,
  compare_catalog_summaries: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'catalog_snapshot'],
  explain_policy: C6W5_BASE_PREVIEW_ARTIFACTS,
  explain_available_capabilities: C6W5_BASE_PREVIEW_ARTIFACTS,
  show_source_freshness_labels: C6W5_BASE_PREVIEW_ARTIFACTS,
  prepare_buyer_question: C6W5_BASE_PREVIEW_ARTIFACTS,
  prepare_seller_agent_remediation_suggestion: C6W5_BASE_PREVIEW_ARTIFACTS,
  prepare_draft_quote: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'catalog_snapshot', 'price'],
  prepare_draft_cart: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'catalog_snapshot', 'price', 'inventory'],
  ask_refresh_source_facts: C6W5_BASE_PREVIEW_ARTIFACTS,
  prepare_non_binding_reservation_request: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'offer', 'inventory'],
  prepare_mandate_capability_check_request: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'mandate_capability'],
  prepare_human_confirmation_prompt: C6W5_BASE_PREVIEW_ARTIFACTS,
  price_lock: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'offer', 'price'],
  inventory_hold: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'inventory'],
  reservation: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'offer', 'inventory'],
  order_placement: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'offer', 'price', 'inventory'],
  payment_intent: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'price', 'mandate_capability'],
  mandate_setup_use: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'mandate_capability'],
  cancellation: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'commitment_evidence'],
  refund_request: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'commitment_evidence'],
  return_authorization: [...C6W5_BASE_PREVIEW_ARTIFACTS, 'commitment_evidence'],
  support_escalation_sla_promise: C6W5_BASE_PREVIEW_ARTIFACTS,
  live_payment_execution: [],
  live_provider_rail_call: [],
  public_discovery_enablement: [],
  production_checkout_payment_creation: [],
  merchant_private_api_call: [],
  provider_private_api_call: [],
  protocol_publication_submission: [],
  certification_conformance_claim: [],
  final_delivery_refund_settlement_payout_promise: [],
};

export const OACP_C6W5_ACTION_RISK_TIERS: Record<OacpC6W5CommitmentBoundaryAction, OacpRiskTier> = {
  browse_merchant_profile: 'informational',
  inspect_seller_card: 'informational',
  compare_catalog_summaries: 'informational',
  explain_policy: 'informational',
  explain_available_capabilities: 'informational',
  show_source_freshness_labels: 'informational',
  prepare_buyer_question: 'informational',
  prepare_seller_agent_remediation_suggestion: 'informational',
  prepare_draft_quote: 'low',
  prepare_draft_cart: 'low',
  ask_refresh_source_facts: 'low',
  prepare_non_binding_reservation_request: 'low',
  prepare_mandate_capability_check_request: 'low',
  prepare_human_confirmation_prompt: 'low',
  price_lock: 'medium',
  inventory_hold: 'medium',
  reservation: 'medium',
  order_placement: 'high',
  payment_intent: 'high',
  mandate_setup_use: 'high',
  cancellation: 'high',
  refund_request: 'high',
  return_authorization: 'high',
  support_escalation_sla_promise: 'medium',
  live_payment_execution: 'critical',
  live_provider_rail_call: 'critical',
  public_discovery_enablement: 'critical',
  production_checkout_payment_creation: 'critical',
  merchant_private_api_call: 'critical',
  provider_private_api_call: 'critical',
  protocol_publication_submission: 'critical',
  certification_conformance_claim: 'critical',
  final_delivery_refund_settlement_payout_promise: 'critical',
};

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

function artifactRefusal(
  artifact_id: string | null,
  refusal_code: OacpArtifactVerificationRefusalCode,
  message: string,
): OacpArtifactAuthorityStatus {
  return {
    valid: false,
    status: 'refused',
    artifact_id,
    refusal_code,
    message,
  };
}

function arrayIncludes(values: readonly string[] | undefined, value: string): boolean {
  return values !== undefined && values.includes(value);
}

function isDetachedJws(signature: string): boolean {
  if (signature === 'detached_jws_required_before_publication') return false;
  const parts = signature.split('.');
  const protectedHeader = parts[0] ?? '';
  const detachedPayload = parts[1] ?? null;
  const signatureValue = parts[2] ?? '';
  return parts.length === 3 && protectedHeader.length > 0 && detachedPayload === '' && signatureValue.length > 0;
}

function scopeMatches(envelope: OacpArtifactEnvelope, expected: OacpArtifactScope | undefined): boolean {
  if (!expected) return true;
  return envelope.tenant_id === expected.tenant_id
    && envelope.merchant_id === expected.merchant_id
    && envelope.seller_agent_id === expected.seller_agent_id
    && envelope.buyer_agent_id === expected.buyer_agent_id;
}

function findIssuerKey(
  envelope: OacpArtifactEnvelope,
  issuerKeys: readonly OacpIssuerKeyMetadata[],
): OacpIssuerKeyMetadata | null {
  return issuerKeys.find((key) => (
    key.issuer === envelope.issuer
    && key.issuer_key_id === envelope.issuer_key_id
    && key.algorithm === envelope.signature_alg
  )) ?? null;
}

export function canonicalizeOacpPayload(payload: unknown): string {
  return stableJson(payload);
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

function adapterPreviewRefusal(
  surface: string,
  refusal_code: OacpAdapterPreviewRefusalCode,
  message: string,
): OacpProtocolAdapterPreviewResult {
  return {
    generated: false,
    status: 'refused',
    surface,
    refusal_code,
    message,
  };
}

function isOacpProtocolAdapterSurface(value: string): value is OacpProtocolAdapterSurface {
  return (OACP_C6W4_PROTOCOL_ADAPTER_SURFACES as readonly string[]).includes(value);
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function artifactTypeFromFixture(fixture: OacpArtifactFixture): OacpArtifactType | null {
  const artifactType = fixture.envelope.artifact_type;
  return typeof artifactType === 'string' && isOacpArtifactType(artifactType) ? artifactType : null;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildSourceArtifactIndex(artifacts: readonly OacpArtifactFixture[]): Map<OacpArtifactType, OacpArtifactFixture> {
  const index = new Map<OacpArtifactType, OacpArtifactFixture>();
  for (const artifact of artifacts) {
    const artifactType = artifactTypeFromFixture(artifact);
    if (artifactType !== null && !index.has(artifactType)) {
      index.set(artifactType, artifact);
    }
  }
  return index;
}

function sourceArtifactId(fixture: OacpArtifactFixture | undefined): string | null {
  return fixture && typeof fixture.envelope.artifact_id === 'string' ? fixture.envelope.artifact_id : null;
}

function freshnessTierForArtifacts(artifacts: readonly OacpArtifactFixture[]): OacpArtifactEnvelope['freshness_class'] | 'mixed' {
  const freshness = new Set(
    artifacts
      .map((artifact) => artifact.envelope.freshness_class)
      .filter((value): value is OacpArtifactEnvelope['freshness_class'] => (
        value === 'fresh' || value === 'acceptable' || value === 'stale' || value === 'unknown'
      )),
  );
  const onlyFreshness = [...freshness][0];
  return freshness.size === 1 && onlyFreshness !== undefined ? onlyFreshness : 'mixed';
}

function unsupportedCapabilitiesForArtifacts(
  descriptor: OacpProtocolAdapterDescriptor,
  artifacts: readonly OacpArtifactFixture[],
): string[] {
  const capabilities = new Set<string>(descriptor.blocked_capabilities);
  for (const artifact of artifacts) {
    const safety = asRecord(artifact.envelope.safety);
    for (const item of stringArrayValue(safety?.forbidden_agent_uses)) {
      capabilities.add(item);
    }
  }
  return [...capabilities].sort();
}

function buildPreviewSourceRefs(artifacts: readonly OacpArtifactFixture[]): Array<Record<string, unknown>> {
  return artifacts.map((artifact) => ({
    artifact_id: artifact.envelope.artifact_id,
    artifact_type: artifact.envelope.artifact_type,
    issuer: artifact.envelope.issuer,
    policy_version: artifact.envelope.policy_version,
    freshness_class: artifact.envelope.freshness_class,
    expires_at: artifact.envelope.expires_at,
    evidence_refs: stringArrayValue(artifact.envelope.evidence_refs),
  }));
}

function buildC6W4SurfacePayload(
  surface: OacpProtocolAdapterSurface,
  byType: Map<OacpArtifactType, OacpArtifactFixture>,
  sourceArtifacts: readonly OacpArtifactFixture[],
  unsupportedCapabilities: readonly string[],
): Record<string, unknown> {
  const merchant = byType.get('merchant_capability')?.payload ?? {};
  const seller = byType.get('seller_agent_capability')?.payload ?? {};
  const catalog = byType.get('catalog_snapshot')?.payload ?? {};
  const policy = byType.get('policy')?.payload ?? {};
  const price = byType.get('price');
  const inventory = byType.get('inventory');
  const commitment = byType.get('commitment_evidence');
  const source_refs = buildPreviewSourceRefs(sourceArtifacts);
  const merchantName = stringValue(merchant, 'merchant_display_name') ?? 'Synthetic OACP merchant';
  const sellerAgentId = stringValue(seller, 'seller_agent_id') ?? 'seller_agent_unknown';
  const supportedTasks = stringArrayValue(seller.supported_tasks);
  const publicClaimLimits = stringArrayValue(seller.public_claim_limits);
  const basePayload = {
    preview_only: true,
    internal_only: true,
    non_publication: true,
    non_certifying: true,
    source_refs,
    unsupported_capabilities: unsupportedCapabilities,
  };

  if (surface === 'schema_org_jsonld') {
    return {
      ...basePayload,
      '@context': 'https://schema.org',
      '@type': 'OfferCatalog',
      name: merchantName,
      itemListElement: stringArrayValue(catalog.product_refs).map((productId) => ({
        '@type': 'Product',
        productID: productId,
        name: productId,
        offers: {
          '@type': 'Offer',
          availability: 'PreviewOnly',
          priceSpecification: 'NonFinalPreview',
        },
      })),
      final_price_inventory_or_delivery_promise: false,
    };
  }

  if (surface === 'ucp_capability_profile') {
    return {
      ...basePayload,
      profile_kind: 'ucp_style_internal_capability_preview',
      merchant_display_name: merchantName,
      read_capabilities: ['merchant_profile.read', 'catalog.preview', 'policy.summary'],
      unsupported_write_capabilities: unsupportedCapabilities,
      public_claim_limits: publicClaimLimits,
    };
  }

  if (surface === 'acp_commerce_capability') {
    return {
      ...basePayload,
      shape_kind: 'acp_style_commerce_capability_preview',
      seller_agent_id: sellerAgentId,
      supported_non_binding_tasks: supportedTasks,
      checkout_or_payment_authority: false,
      policy_summary_refs: {
        return_policy_summary: stringValue(policy, 'return_policy_summary'),
        fulfillment_policy_summary: stringValue(policy, 'fulfillment_policy_summary'),
      },
    };
  }

  if (surface === 'ap2_evidence_intent_summary') {
    return {
      ...basePayload,
      summary_kind: 'ap2_style_evidence_intent_preview',
      intent_status: 'non_binding_preview_only',
      commitment_ref: sourceArtifactId(commitment) ?? null,
      payment_or_mandate_authorization: false,
      evidence_refs: source_refs.flatMap((ref) => stringArrayValue(ref.evidence_refs)),
    };
  }

  if (surface === 'a2a_agent_card_task_capability') {
    return {
      ...basePayload,
      card_kind: 'a2a_style_agent_card_preview',
      agent_id: sellerAgentId,
      display_name: merchantName,
      tasks: supportedTasks.map((task) => ({
        task,
        mode: 'non_binding_preview',
        transaction_authority: false,
      })),
    };
  }

  return {
    ...basePayload,
    capability_kind: 'mcp_style_tool_resource_preview',
    tools: [
      { name: 'oacp.preview.merchant.read', write: false, source_required: true },
      { name: 'oacp.preview.policy.read', write: false, source_required: true },
    ],
    resources: [
      { uri_template: 'oacp-preview://merchant/{merchant_id}', source_required: true },
      { uri_template: 'oacp-preview://policy/{merchant_id}', source_required: true },
    ],
    write_tools: [],
    non_final_price_preview: price ? {
      source_artifact_id: sourceArtifactId(price),
      product_id: stringValue(price.payload, 'product_id'),
      variant_id: stringValue(price.payload, 'variant_id'),
      currency: stringValue(price.payload, 'currency'),
      amount_minor_units: numberValue(price.payload, 'amount_minor_units'),
      final_price_promise: false,
    } : null,
    non_final_inventory_preview: inventory ? {
      source_artifact_id: sourceArtifactId(inventory),
      product_id: stringValue(inventory.payload, 'product_id'),
      availability_state: stringValue(inventory.payload, 'availability_state'),
      hold_or_delivery_promise: false,
    } : null,
  };
}

export function buildOacpC6W4ProtocolAdapterPreview(
  input: OacpProtocolAdapterPreviewInput,
): OacpProtocolAdapterPreviewResult {
  if (!isOacpProtocolAdapterSurface(input.surface)) {
    return adapterPreviewRefusal(input.surface, 'unknown_adapter_surface', 'Unknown adapter preview surface.');
  }
  const descriptor = OACP_C6W4_PROTOCOL_ADAPTER_DESCRIPTORS[input.surface];
  const byType = buildSourceArtifactIndex(input.artifacts);
  for (const artifactType of descriptor.required_artifact_types) {
    if (!byType.has(artifactType)) {
      return adapterPreviewRefusal(input.surface, 'source_artifact_missing', `Missing required source artifact: ${artifactType}.`);
    }
  }

  const generatedMillis = parseIsoMillis(input.generated_at);
  if (generatedMillis === null) {
    return adapterPreviewRefusal(input.surface, 'source_artifact_invalid', 'generated_at must be a valid ISO timestamp.');
  }

  const sourceArtifacts = input.artifacts.filter((artifact) => artifactTypeFromFixture(artifact) !== null);
  const validationNow = input.now_iso ?? input.generated_at;
  for (const artifact of sourceArtifacts) {
    const validation = validateOacpArtifactSchema({
      envelope: artifact.envelope,
      payload: artifact.payload,
      now_iso: validationNow,
    });
    if (!validation.valid) {
      const refusal = validation.refusal_code === 'private_or_forbidden_payload_field'
        ? 'private_or_forbidden_payload_field'
        : validation.refusal_code === 'artifact_expired_or_stale'
          ? 'source_artifact_expired_or_stale'
          : 'source_artifact_invalid';
      return adapterPreviewRefusal(input.surface, refusal, validation.message);
    }
  }

  const expiresMillis = sourceArtifacts
    .map((artifact) => parseIsoMillis(typeof artifact.envelope.expires_at === 'string' ? artifact.envelope.expires_at : undefined))
    .filter((value): value is number => value !== null);
  if (expiresMillis.length !== sourceArtifacts.length) {
    return adapterPreviewRefusal(input.surface, 'source_artifact_invalid', 'Every source artifact must have a valid expiry.');
  }
  const earliestExpiryMillis = Math.min(...expiresMillis);
  const ttlSeconds = Math.floor((earliestExpiryMillis - generatedMillis) / 1000);
  if (ttlSeconds <= 0) {
    return adapterPreviewRefusal(input.surface, 'source_artifact_expired_or_stale', 'Adapter preview cannot outlive source artifacts.');
  }

  const boundedTtlSeconds = Math.min(ttlSeconds, descriptor.max_ttl_seconds);
  const boundedExpiresAt = new Date(generatedMillis + boundedTtlSeconds * 1000).toISOString();
  const unsupportedCapabilities = unsupportedCapabilitiesForArtifacts(descriptor, sourceArtifacts);

  return {
    generated: true,
    status: 'preview_only',
    surface: input.surface,
    adapter_descriptor: descriptor,
    source_artifact_ids: sourceArtifacts.map((artifact) => String(artifact.envelope.artifact_id)),
    source_artifact_families: sourceArtifacts.map((artifact) => artifactTypeFromFixture(artifact)).filter((value): value is OacpArtifactType => value !== null),
    source_authority: 'grantex_canonical_oacp_artifact_authority',
    generated_at: input.generated_at,
    expires_at: boundedExpiresAt,
    max_ttl_seconds: boundedTtlSeconds,
    freshness_tier: freshnessTierForArtifacts(sourceArtifacts),
    unsupported_capabilities: unsupportedCapabilities,
    blocked_capabilities: unsupportedCapabilities,
    non_authoritative_for_transaction: true,
    no_checkout_payment_enablement: true,
    no_live_provider_enablement: true,
    no_public_discovery_enablement: true,
    surface_payload: buildC6W4SurfacePayload(input.surface, byType, sourceArtifacts, unsupportedCapabilities),
  };
}

function c6w5ActionClass(action: OacpC6W5CommitmentBoundaryAction): OacpC6W5ActionClass {
  if ((OACP_C6W5_NON_BINDING_PREVIEW_ACTIONS as readonly string[]).includes(action)) return 'non_binding_preview';
  if ((OACP_C6W5_COMMITMENT_ADJACENT_ACTIONS as readonly string[]).includes(action)) return 'commitment_adjacent';
  if ((OACP_C6W5_COMMITMENT_BOUND_ACTIONS as readonly string[]).includes(action)) return 'commitment_bound';
  return 'always_blocked';
}

function c6w5BlockedCapabilities(preview: OacpProtocolAdapterPreviewResult): string[] {
  const blocked = new Set<string>(C6W4_COMMON_BLOCKED_ADAPTER_CAPABILITIES);
  if (preview.generated) {
    for (const capability of preview.blocked_capabilities) blocked.add(capability);
    for (const capability of preview.unsupported_capabilities) blocked.add(capability);
  }
  for (const action of OACP_C6W5_ALWAYS_BLOCKED_ACTIONS) blocked.add(action);
  return [...blocked].sort();
}

function c6w5FreshnessSummary(artifacts: readonly OacpArtifactFixture[]): OacpC6W5FreshnessSummary {
  const artifact_freshness: Record<string, OacpArtifactEnvelope['freshness_class']> = {};
  const expiresMillis: number[] = [];
  for (const artifact of artifacts) {
    const freshness = artifact.envelope.freshness_class;
    if (freshness === 'fresh' || freshness === 'acceptable' || freshness === 'stale' || freshness === 'unknown') {
      artifact_freshness[String(artifact.envelope.artifact_id)] = freshness;
    }
    const expiresAt = parseIsoMillis(typeof artifact.envelope.expires_at === 'string' ? artifact.envelope.expires_at : undefined);
    if (expiresAt !== null) expiresMillis.push(expiresAt);
  }
  return {
    freshness_tier: freshnessTierForArtifacts(artifacts),
    artifact_freshness,
    earliest_expires_at: expiresMillis.length > 0 ? new Date(Math.min(...expiresMillis)).toISOString() : null,
  };
}

function c6w5Decision(input: {
  action: OacpC6W5CommitmentBoundaryAction;
  action_class: OacpC6W5ActionClass;
  allowed_to_preview: boolean;
  allowed_to_prepare: boolean;
  reason: string | null;
  required: readonly OacpArtifactType[];
  source_artifacts: readonly OacpArtifactFixture[];
  risk_tier: OacpRiskTier;
  offline_mode_status: OacpC6W5OfflineModeStatus;
  buyer_safe_message: string;
  blocked_capabilities: readonly string[];
}): OacpC6W5CommitmentBoundaryDecision {
  return {
    action: input.action,
    action_class: input.action_class,
    allowed_to_preview: input.allowed_to_preview,
    allowed_to_prepare: input.allowed_to_prepare,
    allowed_to_execute: false,
    refusal_or_escalation_reason: input.reason,
    required_fresh_artifact_families: [...input.required],
    source_artifact_ids: input.source_artifacts.map((artifact) => String(artifact.envelope.artifact_id)),
    source_artifact_families: input.source_artifacts
      .map((artifact) => artifactTypeFromFixture(artifact))
      .filter((value): value is OacpArtifactType => value !== null),
    source_authority: 'grantex_canonical_oacp_artifact_authority',
    freshness_summary: c6w5FreshnessSummary(input.source_artifacts),
    risk_tier: input.risk_tier,
    offline_mode_status: input.offline_mode_status,
    buyer_safe_message: input.buyer_safe_message,
    blocked_capabilities: [...input.blocked_capabilities],
    non_authoritative_for_transaction: true,
    no_checkout_payment_enablement: true,
    no_live_provider_enablement: true,
    no_public_discovery_enablement: true,
  };
}

function c6w5RequiresRiskContext(action: OacpC6W5CommitmentBoundaryAction, actionClass: OacpC6W5ActionClass): boolean {
  if (actionClass === 'non_binding_preview' || actionClass === 'always_blocked') return false;
  return action !== 'ask_refresh_source_facts'
    && action !== 'prepare_human_confirmation_prompt'
    && action !== 'prepare_mandate_capability_check_request';
}

function c6w5RiskContextReason(input: OacpC6W5CommitmentBoundaryInput, riskTier: OacpRiskTier): string | null {
  if (
    !isKnownCurrency(input.currency)
    || input.amount_minor_units === null
    || input.amount_minor_units === undefined
    || input.amount_minor_units < 0
    || input.total_quantity === null
    || input.total_quantity === undefined
    || input.total_quantity <= 0
  ) {
    return 'risk_context_missing_or_ambiguous';
  }
  const amountCap = amountCapForCurrency(riskTier, input.currency);
  if (amountCap === null || input.amount_minor_units > amountCap) return 'risk_cap_exceeded';
  const cap = OACP_FIRST_RELEASE_RISK_CAPS[riskTier];
  if (cap.total_quantity_cap !== null && input.total_quantity > cap.total_quantity_cap) return 'quantity_cap_exceeded';
  if (
    input.max_quantity_per_sku !== null
    && input.max_quantity_per_sku !== undefined
    && cap.per_sku_quantity_cap !== null
    && input.max_quantity_per_sku > cap.per_sku_quantity_cap
  ) {
    return 'quantity_cap_exceeded';
  }
  return null;
}

export function evaluateOacpC6W5CommitmentBoundaryMetadata(
  input: OacpC6W5CommitmentBoundaryInput,
): OacpC6W5CommitmentBoundaryDecision {
  const actionClass = c6w5ActionClass(input.action);
  const riskTier = OACP_C6W5_ACTION_RISK_TIERS[input.action];
  const required = OACP_C6W5_REQUIRED_FRESH_ARTIFACT_FAMILIES[input.action];
  const blockedCapabilities = c6w5BlockedCapabilities(input.adapter_preview);
  const sourceArtifacts = input.artifacts.filter((artifact) => artifactTypeFromFixture(artifact) !== null);
  const byType = buildSourceArtifactIndex(sourceArtifacts);
  const baseOfflineStatus: OacpC6W5OfflineModeStatus = input.grantex_available
    ? 'online_policy_available'
    : actionClass === 'commitment_bound'
      ? 'offline_prepared_not_executed'
      : 'offline_cache_valid';

  if (actionClass === 'always_blocked') {
    return c6w5Decision({
      action: input.action,
      action_class: actionClass,
      allowed_to_preview: false,
      allowed_to_prepare: false,
      reason: 'blocked_in_c6w5',
      required,
      source_artifacts: sourceArtifacts,
      risk_tier: riskTier,
      offline_mode_status: 'offline_blocked',
      buyer_safe_message: 'This C6W5 action is blocked and cannot be prepared or executed from adapter previews.',
      blocked_capabilities: blockedCapabilities,
    });
  }

  if (!input.adapter_preview.generated || input.adapter_preview.status !== 'preview_only') {
    return c6w5Decision({
      action: input.action,
      action_class: actionClass,
      allowed_to_preview: false,
      allowed_to_prepare: false,
      reason: 'adapter_preview_invalid',
      required,
      source_artifacts: sourceArtifacts,
      risk_tier: riskTier,
      offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
      buyer_safe_message: 'Adapter preview metadata is invalid, so C6W5 refuses the boundary decision.',
      blocked_capabilities: blockedCapabilities,
    });
  }

  const previewExpiresAt = parseIsoMillis(input.adapter_preview.expires_at);
  const nowMillis = parseIsoMillis(input.now_iso);
  if (
    nowMillis === null
    || previewExpiresAt === null
    || nowMillis > previewExpiresAt
    || input.adapter_preview.non_authoritative_for_transaction !== true
    || input.adapter_preview.no_checkout_payment_enablement !== true
    || input.adapter_preview.no_live_provider_enablement !== true
    || input.adapter_preview.no_public_discovery_enablement !== true
  ) {
    return c6w5Decision({
      action: input.action,
      action_class: actionClass,
      allowed_to_preview: false,
      allowed_to_prepare: false,
      reason: 'adapter_preview_missing_safety_or_freshness',
      required,
      source_artifacts: sourceArtifacts,
      risk_tier: riskTier,
      offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
      buyer_safe_message: 'Adapter previews cannot override missing safety flags or expired metadata.',
      blocked_capabilities: blockedCapabilities,
    });
  }

  const missing = required.filter((artifactType) => !byType.has(artifactType));
  if (missing.length > 0) {
    return c6w5Decision({
      action: input.action,
      action_class: actionClass,
      allowed_to_preview: actionClass === 'non_binding_preview',
      allowed_to_prepare: false,
      reason: `required_artifact_missing:${missing.join(',')}`,
      required,
      source_artifacts: sourceArtifacts,
      risk_tier: riskTier,
      offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
      buyer_safe_message: 'Required source artifacts are missing, so the action can only remain non-executing.',
      blocked_capabilities: blockedCapabilities,
    });
  }

  const requiredArtifacts = required
    .map((artifactType) => byType.get(artifactType))
    .filter((artifact): artifact is OacpArtifactFixture => artifact !== undefined);
  for (const artifact of requiredArtifacts) {
    const validation = validateOacpArtifactSchema({
      envelope: artifact.envelope,
      payload: artifact.payload,
      now_iso: input.now_iso,
    });
    if (!validation.valid) {
      return c6w5Decision({
        action: input.action,
        action_class: actionClass,
        allowed_to_preview: false,
        allowed_to_prepare: false,
        reason: validation.refusal_code,
        required,
        source_artifacts: requiredArtifacts,
        risk_tier: riskTier,
        offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
        buyer_safe_message: 'A required OACP artifact is invalid, stale, revoked, or ambiguous.',
        blocked_capabilities: blockedCapabilities,
      });
    }
    const freshness = artifact.envelope.freshness_class;
    if (
      freshness === 'stale'
      || freshness === 'unknown'
      || (actionClass !== 'non_binding_preview' && freshness !== 'fresh')
    ) {
      return c6w5Decision({
        action: input.action,
        action_class: actionClass,
        allowed_to_preview: actionClass === 'non_binding_preview',
        allowed_to_prepare: false,
        reason: 'artifact_freshness_missing_stale_or_ambiguous',
        required,
        source_artifacts: requiredArtifacts,
        risk_tier: riskTier,
        offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
        buyer_safe_message: 'Source facts must be fresh enough before a commitment-bound request is prepared.',
        blocked_capabilities: blockedCapabilities,
      });
    }
  }

  const revocationMaxAge = OACP_REVOCATION_SNAPSHOT_MAX_AGE_SECONDS[riskTier];
  if (
    actionClass !== 'non_binding_preview'
    && (
      input.revocation_snapshot_age_seconds === null
      || input.revocation_snapshot_age_seconds === undefined
      || revocationMaxAge === null
      || input.revocation_snapshot_age_seconds > revocationMaxAge
    )
  ) {
    return c6w5Decision({
      action: input.action,
      action_class: actionClass,
      allowed_to_preview: true,
      allowed_to_prepare: false,
      reason: 'revocation_snapshot_missing_or_stale',
      required,
      source_artifacts: requiredArtifacts,
      risk_tier: riskTier,
      offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
      buyer_safe_message: 'The local revocation posture is too stale for a commitment-bound preparation.',
      blocked_capabilities: blockedCapabilities,
    });
  }

  if (c6w5RequiresRiskContext(input.action, actionClass)) {
    const riskReason = c6w5RiskContextReason(input, riskTier);
    if (riskReason !== null) {
      return c6w5Decision({
        action: input.action,
        action_class: actionClass,
        allowed_to_preview: true,
        allowed_to_prepare: false,
        reason: riskReason,
        required,
        source_artifacts: requiredArtifacts,
        risk_tier: riskTier,
        offline_mode_status: input.grantex_available ? 'online_policy_available' : 'offline_blocked',
        buyer_safe_message: 'Amount, currency, or quantity is missing or outside the conservative C6W5 risk caps.',
        blocked_capabilities: blockedCapabilities,
      });
    }
  }

  const allowedToPrepare = actionClass !== 'non_binding_preview';
  const buyerSafeMessage = actionClass === 'non_binding_preview'
    ? 'Preview can continue from sourced OACP artifacts; this is not purchase approval.'
    : actionClass === 'commitment_adjacent'
      ? 'Prepared request only; no checkout, payment, provider call, or merchant private API call is executed.'
      : 'Prepared, not executed. C6W5 does not grant transaction authority from adapter previews.';

  return c6w5Decision({
    action: input.action,
    action_class: actionClass,
    allowed_to_preview: true,
    allowed_to_prepare: allowedToPrepare,
    reason: actionClass === 'commitment_bound' ? 'prepared_not_executed_c6w5' : null,
    required,
    source_artifacts: requiredArtifacts,
    risk_tier: riskTier,
    offline_mode_status: baseOfflineStatus,
    buyer_safe_message: buyerSafeMessage,
    blocked_capabilities: blockedCapabilities,
  });
}

const C6W6_ENVELOPE_TTL_SECONDS: Record<OacpC6W6PreparedEnvelopeKind, number> = {
  buyer_confirmation_request: 15 * 60,
  seller_source_refresh_request: 30 * 60,
  merchant_confirmation_request: 10 * 60,
  mandate_capability_evidence_request: 2 * 60,
  support_escalation_preparation: 10 * 60,
};

const C6W6_MERCHANT_CONFIRMATION_ACTIONS = new Set<OacpC6W5CommitmentBoundaryAction>([
  'price_lock',
  'inventory_hold',
  'reservation',
  'order_placement',
]);

const C6W6_MANDATE_EVIDENCE_ACTIONS = new Set<OacpC6W5CommitmentBoundaryAction>([
  'payment_intent',
  'mandate_setup_use',
  'prepare_mandate_capability_check_request',
]);

const C6W6_SUPPORT_PREPARATION_ACTIONS = new Set<OacpC6W5CommitmentBoundaryAction>([
  'support_escalation_sla_promise',
  'refund_request',
  'return_authorization',
  'cancellation',
]);

const C6W6_PRIVATE_VALUE_PATTERN = /(https?:\/\/|postgres:\/\/|redis:\/\/|mongodb:\/\/|private[_-]?key|raw[_-]?jwt|access[_-]?token|api[_-]?key|password|secret|credential|allowlist)/i;

function c6w6ResolverDecisionId(decision: OacpC6W5CommitmentBoundaryDecision): string {
  return `oacp_c6w5_decision_${sha256hex(stableJson({
    action: decision.action,
    action_class: decision.action_class,
    source_artifact_ids: decision.source_artifact_ids,
    required_fresh_artifact_families: decision.required_fresh_artifact_families,
    freshness_summary: decision.freshness_summary,
    risk_tier: decision.risk_tier,
    offline_mode_status: decision.offline_mode_status,
  })).slice(0, 20)}`;
}

function c6w6RedactedEvidenceRefs(evidenceRefs: readonly string[] | undefined): string[] {
  return [...new Set((evidenceRefs ?? [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => (C6W6_PRIVATE_VALUE_PATTERN.test(value) ? 'redacted_private_evidence_ref' : value)))]
    .slice(0, 20);
}

function c6w6ExpiresAt(input: {
  kind: OacpC6W6PreparedEnvelopeKind;
  created_at: string;
  decision: OacpC6W5CommitmentBoundaryDecision;
}): { expires_at: string; max_ttl_seconds: number } | null {
  const createdMillis = parseIsoMillis(input.created_at);
  if (createdMillis === null) return null;
  const defaultTtl = C6W6_ENVELOPE_TTL_SECONDS[input.kind];
  const earliestSourceExpiry = parseIsoMillis(input.decision.freshness_summary.earliest_expires_at ?? undefined);
  const defaultExpiry = createdMillis + defaultTtl * 1000;
  const expiresMillis = earliestSourceExpiry === null ? defaultExpiry : Math.min(defaultExpiry, earliestSourceExpiry);
  if (expiresMillis <= createdMillis) return null;
  return {
    expires_at: new Date(expiresMillis).toISOString(),
    max_ttl_seconds: Math.floor((expiresMillis - createdMillis) / 1000),
  };
}

function c6w6KindMatchesDecision(
  kind: OacpC6W6PreparedEnvelopeKind,
  decision: OacpC6W5CommitmentBoundaryDecision,
): boolean {
  if (kind === 'seller_source_refresh_request') return decision.action_class !== 'always_blocked';
  if (kind === 'buyer_confirmation_request') return decision.allowed_to_prepare;
  if (kind === 'merchant_confirmation_request') return decision.allowed_to_prepare && C6W6_MERCHANT_CONFIRMATION_ACTIONS.has(decision.action);
  if (kind === 'mandate_capability_evidence_request') return decision.allowed_to_prepare && C6W6_MANDATE_EVIDENCE_ACTIONS.has(decision.action);
  return decision.allowed_to_prepare && C6W6_SUPPORT_PREPARATION_ACTIONS.has(decision.action);
}

function c6w6NeedsRiskContext(
  kind: OacpC6W6PreparedEnvelopeKind,
  decision: OacpC6W5CommitmentBoundaryDecision,
): boolean {
  return kind !== 'seller_source_refresh_request' && decision.action_class === 'commitment_bound';
}

function c6w6RiskContextMissing(input: OacpC6W6PreparedEnvelopeInput, decision: OacpC6W5CommitmentBoundaryDecision): boolean {
  if (!c6w6NeedsRiskContext(input.envelope_kind, decision)) return false;
  return !isKnownCurrency(input.currency)
    || input.amount_minor_units === null
    || input.amount_minor_units === undefined
    || input.amount_minor_units < 0
    || input.total_quantity === null
    || input.total_quantity === undefined
    || input.total_quantity <= 0;
}

function c6w6NextHumanStep(kind: OacpC6W6PreparedEnvelopeKind, decision: OacpC6W5CommitmentBoundaryDecision): string {
  if (kind === 'buyer_confirmation_request') return `Review sourced ${decision.action} preparation and confirm whether a non-executing request should be sent.`;
  if (kind === 'seller_source_refresh_request') return 'Ask the seller agent or source owner to refresh stale or missing source facts before preparation continues.';
  if (kind === 'merchant_confirmation_request') return `Ask the merchant source owner to confirm ${decision.action} facts before any execution path exists.`;
  if (kind === 'mandate_capability_evidence_request') return 'Ask for provider-owned mandate capability evidence to be supplied as cached evidence only.';
  return 'Prepare a support escalation note without promising SLA, refund, return, replacement, or settlement outcome.';
}

function c6w6NextSystemStepLabel(kind: OacpC6W6PreparedEnvelopeKind): string {
  if (kind === 'buyer_confirmation_request') return 'local_human_confirmation_handoff';
  if (kind === 'seller_source_refresh_request') return 'seller_source_refresh_handoff_label';
  if (kind === 'merchant_confirmation_request') return 'merchant_source_confirmation_handoff_label';
  if (kind === 'mandate_capability_evidence_request') return 'mandate_evidence_preparation_handoff_label';
  return 'support_escalation_preparation_handoff_label';
}

function c6w6SellerSafeMessage(kind: OacpC6W6PreparedEnvelopeKind, decision: OacpC6W5CommitmentBoundaryDecision): string {
  if (kind === 'seller_source_refresh_request') {
    return `Refresh requested for ${decision.required_fresh_artifact_families.join(', ') || 'source'} facts; do not include private credentials or raw payloads.`;
  }
  if (kind === 'merchant_confirmation_request') return 'Merchant confirmation is prepared as evidence-only text; no order, hold, checkout, or payment is created.';
  if (kind === 'mandate_capability_evidence_request') return 'Mandate capability evidence is requested as cached evidence only; no provider rail is called.';
  if (kind === 'support_escalation_preparation') return 'Support escalation is non-binding and must not promise SLA, refund, return, replacement, settlement, or payout.';
  return 'Buyer confirmation is local and non-executing; seller cards and adapter previews are not transaction authority.';
}

function c6w6EnvelopeId(input: {
  kind: OacpC6W6PreparedEnvelopeKind;
  created_at: string;
  decision_id: string;
  requested_action: OacpC6W5CommitmentBoundaryAction;
}): string {
  return `oacp_c6w6_envelope_${sha256hex(stableJson(input)).slice(0, 20)}`;
}

function c6w6PreparedEnvelope(input: {
  kind: OacpC6W6PreparedEnvelopeKind;
  created_at: string;
  decision_id: string;
  decision: OacpC6W5CommitmentBoundaryDecision;
  status: 'prepared_only' | 'blocked';
  expires_at: string;
  max_ttl_seconds: number;
  redacted_evidence_refs: string[];
  unsupported_capabilities: string[];
}): OacpC6W6PreparedCommitmentEnvelope {
  return {
    envelope_id: c6w6EnvelopeId({
      kind: input.kind,
      created_at: input.created_at,
      decision_id: input.decision_id,
      requested_action: input.decision.action,
    }),
    envelope_kind: input.kind,
    envelope_status: input.status,
    created_at: input.created_at,
    expires_at: input.expires_at,
    max_ttl_seconds: input.max_ttl_seconds,
    source_resolver_decision_id: input.decision_id,
    action_class: input.decision.action_class,
    requested_action: input.decision.action,
    risk_tier: input.decision.risk_tier,
    offline_mode_status: input.decision.offline_mode_status,
    allowed_to_preview: input.status === 'prepared_only' && input.decision.allowed_to_preview,
    allowed_to_prepare: input.status === 'prepared_only' && input.decision.allowed_to_prepare,
    allowed_to_execute: false,
    prepared_only: true,
    source_artifact_ids: [...input.decision.source_artifact_ids],
    source_artifact_families: [...input.decision.source_artifact_families],
    source_authority: input.decision.source_authority,
    required_fresh_artifact_families: [...input.decision.required_fresh_artifact_families],
    freshness_summary: input.decision.freshness_summary,
    blocked_capabilities: [...input.decision.blocked_capabilities],
    unsupported_capabilities: input.unsupported_capabilities,
    buyer_safe_message: input.decision.buyer_safe_message,
    seller_safe_message: c6w6SellerSafeMessage(input.kind, input.decision),
    next_human_step: c6w6NextHumanStep(input.kind, input.decision),
    next_system_step_label: c6w6NextSystemStepLabel(input.kind),
    redacted_evidence_refs: input.redacted_evidence_refs,
    non_authoritative_for_transaction: true,
    no_checkout_payment_enablement: true,
    no_live_provider_enablement: true,
    no_public_discovery_enablement: true,
  };
}

function c6w6Refusal(
  refusal_code: OacpC6W6EnvelopeRefusalCode,
  message: string,
  blocked_envelope?: OacpC6W6PreparedCommitmentEnvelope,
): OacpC6W6PreparedEnvelopeResult {
  return blocked_envelope === undefined
    ? { generated: false, status: 'blocked', refusal_code, message }
    : { generated: false, status: 'blocked', refusal_code, message, blocked_envelope };
}

export function prepareOacpC6W6CommitmentRequestEnvelope(
  input: OacpC6W6PreparedEnvelopeInput,
): OacpC6W6PreparedEnvelopeResult {
  if (input.resolver_decision === null) {
    return c6w6Refusal('resolver_decision_missing', 'C6W6 requires a C6W5 resolver decision before preparing an envelope.');
  }

  const decision = input.resolver_decision;
  const decisionId = input.source_resolver_decision_id ?? c6w6ResolverDecisionId(decision);
  const ttl = c6w6ExpiresAt({ kind: input.envelope_kind, created_at: input.created_at, decision });
  const redactedEvidenceRefs = c6w6RedactedEvidenceRefs(input.evidence_refs);
  const unsupportedCapabilities = [...new Set(input.unsupported_capabilities ?? [])].sort();
  const blockedEnvelope = ttl === null
    ? undefined
    : c6w6PreparedEnvelope({
      kind: input.envelope_kind,
      created_at: input.created_at,
      decision_id: decisionId,
      decision,
      status: 'blocked',
      expires_at: ttl.expires_at,
      max_ttl_seconds: ttl.max_ttl_seconds,
      redacted_evidence_refs: redactedEvidenceRefs,
      unsupported_capabilities: unsupportedCapabilities,
    });

  if (decision.allowed_to_execute !== false) {
    return c6w6Refusal('resolver_decision_allows_execution', 'C6W6 cannot prepare envelopes from executable decisions.', blockedEnvelope);
  }
  if (decision.source_artifact_ids.length === 0 || decision.source_artifact_families.length === 0) {
    return c6w6Refusal('source_artifacts_missing', 'C6W6 requires source artifact references for prepared handoff envelopes.', blockedEnvelope);
  }
  if (decision.action_class === 'always_blocked') {
    return c6w6Refusal('action_blocked_in_c6w6', 'Always-blocked actions cannot produce prepared C6W6 envelopes.', blockedEnvelope);
  }
  if (
    decision.freshness_summary.earliest_expires_at === null
    || decision.freshness_summary.freshness_tier === 'stale'
    || decision.freshness_summary.freshness_tier === 'unknown'
  ) {
    return c6w6Refusal('source_freshness_missing_or_stale', 'Prepared envelopes require source freshness and TTL metadata.', blockedEnvelope);
  }
  if (ttl === null) {
    return c6w6Refusal('source_freshness_missing_or_stale', 'Prepared envelope TTL cannot outlive source artifact freshness.');
  }
  if (!c6w6KindMatchesDecision(input.envelope_kind, decision)) {
    return c6w6Refusal('envelope_kind_action_mismatch', 'Envelope kind does not match the C6W5 action class or requested action.', blockedEnvelope);
  }
  if (c6w6RiskContextMissing(input, decision)) {
    return c6w6Refusal('risk_context_missing_or_ambiguous', 'Commitment-bound envelopes require amount, currency, and quantity context.', blockedEnvelope);
  }

  const envelope = c6w6PreparedEnvelope({
    kind: input.envelope_kind,
    created_at: input.created_at,
    decision_id: decisionId,
    decision,
    status: 'prepared_only',
    expires_at: ttl.expires_at,
    max_ttl_seconds: ttl.max_ttl_seconds,
    redacted_evidence_refs: redactedEvidenceRefs,
    unsupported_capabilities: unsupportedCapabilities,
  });

  try {
    assertNoForbiddenOacpArtifactFields(envelope);
  } catch {
    return c6w6Refusal('private_or_forbidden_envelope_field', 'Prepared envelope contains forbidden private or enabling fields.', blockedEnvelope);
  }

  return { generated: true, status: 'prepared_only', envelope };
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
  revocation_status_url: string;
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
    schema_version: 'oacp.internal.v1',
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
    revocation_status_url: input.revocation_status_url,
    policy_version: input.policy_version,
    evidence_refs: [],
    payload_hash: hashOacpPayload(input.payload),
    signature_alg: OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm,
    signature: 'detached_jws_required_before_publication',
    safety: input.safety,
  };
}

export function issueInternalOacpArtifact(input: {
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
  revocation_status_url: string;
  payload: unknown;
  safety: OacpArtifactSafety;
  issuer_key: OacpIssuerKeyMetadata;
  signDetachedJws: OacpDetachedJwsSigner;
}): OacpArtifactEnvelope {
  if (input.issuer_key.state !== 'active') {
    throw new Error('OACP artifact issuance requires an active issuer key');
  }
  if (
    input.issuer_key.issuer !== input.issuer
    || input.issuer_key.issuer_key_id !== input.issuer_key_id
    || input.issuer_key.algorithm !== OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm
  ) {
    throw new Error('OACP artifact issuer key metadata does not match envelope issuer fields');
  }

  const envelope = buildUnsignedOacpArtifactEnvelope(input);
  const issuedMillis = parseIsoMillis(envelope.issued_at);
  const expiresMillis = parseIsoMillis(envelope.expires_at);
  const maxTtlSeconds = OACP_ARTIFACT_TTLS_SECONDS[envelope.artifact_type];
  if (
    issuedMillis === null
    || expiresMillis === null
    || expiresMillis < issuedMillis
    || Math.floor((expiresMillis - issuedMillis) / 1000) > maxTtlSeconds
  ) {
    throw new Error('OACP artifact TTL must be valid and no longer than the pinned default');
  }

  const canonicalPayload = canonicalizeOacpPayload(input.payload);
  const signature = input.signDetachedJws({
    canonical_payload: canonicalPayload,
    payload_hash: envelope.payload_hash,
    artifact_id: envelope.artifact_id,
    issuer: envelope.issuer,
    issuer_key_id: envelope.issuer_key_id,
    signature_alg: envelope.signature_alg,
  });

  if (!isDetachedJws(signature)) {
    throw new Error('OACP artifact issuance requires a detached JWS signature');
  }

  return {
    ...envelope,
    signature,
  };
}

export function evaluateInternalOacpArtifactStatus(input: {
  envelope: OacpArtifactEnvelope;
  payload: unknown;
  issuer_keys: readonly OacpIssuerKeyMetadata[];
  now_iso: string;
  verifyDetachedJws: OacpDetachedJwsVerifier;
  expected_scope?: OacpArtifactScope | undefined;
  revoked_artifact_ids?: readonly string[] | undefined;
  revoked_subject_ids?: readonly string[] | undefined;
}): OacpArtifactAuthorityStatus {
  const artifactId = input.envelope.artifact_id || null;
  try {
    assertNoForbiddenOacpArtifactFields(input.payload);
  } catch {
    return artifactRefusal(artifactId, 'artifact_missing_or_invalid', 'Payload contains private or enabling fields.');
  }

  if (!input.envelope.safety.public_safe || input.envelope.safety.contains_private_data) {
    return artifactRefusal(artifactId, 'artifact_missing_or_invalid', 'Artifact safety metadata is not public-safe.');
  }

  const nowMillis = parseIsoMillis(input.now_iso);
  const issuedMillis = parseIsoMillis(input.envelope.issued_at);
  const expiresMillis = parseIsoMillis(input.envelope.expires_at);
  const notBeforeMillis = parseIsoMillis(input.envelope.not_before);
  if (nowMillis === null || issuedMillis === null || expiresMillis === null) {
    return artifactRefusal(artifactId, 'artifact_missing_or_invalid', 'Artifact contains invalid timestamps.');
  }

  if (notBeforeMillis !== null && nowMillis < notBeforeMillis) {
    return artifactRefusal(artifactId, 'artifact_not_yet_valid', 'Artifact is not yet valid.');
  }
  if (nowMillis > expiresMillis) {
    return artifactRefusal(artifactId, 'artifact_expired_or_stale', 'Artifact has expired.');
  }

  const defaultTtlSeconds = OACP_ARTIFACT_TTLS_SECONDS[input.envelope.artifact_type];
  const actualTtlSeconds = Math.floor((expiresMillis - issuedMillis) / 1000);
  if (actualTtlSeconds < 0 || actualTtlSeconds > defaultTtlSeconds) {
    return artifactRefusal(artifactId, 'artifact_ttl_exceeds_default', 'Artifact TTL exceeds the pinned default.');
  }

  if (input.envelope.signature_alg !== OACP_ARTIFACT_SIGNATURE_PROFILE.first_algorithm) {
    return artifactRefusal(artifactId, 'signature_algorithm_unsupported', 'Artifact signature algorithm is unsupported.');
  }
  if (!isDetachedJws(input.envelope.signature)) {
    return artifactRefusal(artifactId, 'signature_missing_or_placeholder', 'Artifact is missing a detached JWS signature.');
  }

  const canonicalPayload = canonicalizeOacpPayload(input.payload);
  const payloadHash = sha256hex(canonicalPayload);
  if (payloadHash !== input.envelope.payload_hash) {
    return artifactRefusal(artifactId, 'payload_hash_mismatch', 'Artifact payload hash does not match payload.');
  }

  const issuerKey = findIssuerKey(input.envelope, input.issuer_keys);
  if (issuerKey === null) {
    return artifactRefusal(artifactId, 'issuer_key_untrusted', 'Artifact issuer key is not trusted.');
  }
  const keyNotBeforeMillis = parseIsoMillis(issuerKey.not_before);
  const keyExpiresMillis = parseIsoMillis(issuerKey.expires_at);
  if (
    issuerKey.state !== 'active'
    || (keyNotBeforeMillis !== null && nowMillis < keyNotBeforeMillis)
    || (keyExpiresMillis !== null && nowMillis > keyExpiresMillis)
  ) {
    return artifactRefusal(artifactId, 'issuer_key_inactive', 'Artifact issuer key is not active.');
  }

  if (!scopeMatches(input.envelope, input.expected_scope)) {
    return artifactRefusal(artifactId, 'artifact_scope_mismatch', 'Artifact is outside the expected tenant/merchant/agent scope.');
  }
  if (
    arrayIncludes(input.revoked_artifact_ids, input.envelope.artifact_id)
    || arrayIncludes(input.revoked_subject_ids, input.envelope.subject_id)
  ) {
    return artifactRefusal(artifactId, 'artifact_revoked', 'Artifact or subject is revoked.');
  }

  const signatureOk = input.verifyDetachedJws({
    canonical_payload: canonicalPayload,
    payload_hash: input.envelope.payload_hash,
    artifact_id: input.envelope.artifact_id,
    issuer: input.envelope.issuer,
    issuer_key_id: input.envelope.issuer_key_id,
    signature_alg: input.envelope.signature_alg,
    signature: input.envelope.signature,
  });
  if (!signatureOk) {
    return artifactRefusal(artifactId, 'detached_jws_verification_failed', 'Detached JWS verification failed.');
  }

  return {
    valid: true,
    status: 'valid',
    artifact_id: input.envelope.artifact_id,
    artifact_type: input.envelope.artifact_type,
    cache_key: input.envelope.tenant_id && input.envelope.merchant_id && input.envelope.seller_agent_id && input.envelope.buyer_agent_id
      ? buildOacpArtifactCacheKey({
        tenant_id: input.envelope.tenant_id,
        merchant_id: input.envelope.merchant_id,
        seller_agent_id: input.envelope.seller_agent_id,
        buyer_agent_id: input.envelope.buyer_agent_id,
        artifact_type: input.envelope.artifact_type,
        artifact_id: input.envelope.artifact_id,
        schema_version: input.envelope.schema_version,
        policy_version: input.envelope.policy_version,
      })
      : null,
    payload_hash: input.envelope.payload_hash,
    expires_at: input.envelope.expires_at,
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
