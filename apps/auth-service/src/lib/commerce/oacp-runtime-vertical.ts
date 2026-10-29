import {
  OACP_ARTIFACT_TTLS_SECONDS,
  type OacpArtifactAuthorityStatus,
  type OacpArtifactEnvelope,
  type OacpArtifactType,
} from './oacp-trust-artifacts.js';
import {
  OACP_JWS_TYP,
  issueOacpArtifact,
  verifyOacpArtifact,
  type OacpSigningKey,
} from './oacp-jws.js';
import {
  MandateCapabilityEvidenceError,
  bindMandateCapabilityEvidence,
  parseMandateCapabilityEvidence,
  type BoundMandateCapabilityEvidence,
  type MandateCapabilityStatus,
} from './mandate-capability-evidence.js';

export const C6Z_ARTIFACT_FAMILIES = [
  'merchant_profile',
  'seller_agent_card',
  'connector_evidence',
  'catalog_snapshot',
  'offer_price_snapshot',
  'inventory_snapshot',
  'policy_scope',
  'public_discovery_state',
  'mandate_capability',
  'protocol_adapter',
  'authority_request_status',
] as const;

export type C6ZArtifactFamily = typeof C6Z_ARTIFACT_FAMILIES[number];

/**
 * Where the catalogue evidence comes from. `shopify` is a merchant's own
 * system of record. `catalog_upload` is a catalogue the merchant uploaded
 * itself: also the merchant's own record, accepted for a tenant on
 * COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS or enrolled with that source, never
 * with `synthetic_data: true`. `synthetic_demo` is an invented demonstration
 * catalogue: accepted only for a tenant on both COMMERCE_C6Z_DEMO_SOURCE_TENANTS
 * and COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS, for a request that says
 * `synthetic_data: true`, and every artifact issued from it says so.
 */
export const C6Z_SOURCE_SYSTEMS = ['shopify', 'synthetic_demo', 'catalog_upload'] as const;

export type C6ZSourceSystem = typeof C6Z_SOURCE_SYSTEMS[number];

export type C6ZAuthorityRequestStatus =
  | 'received'
  | 'pending_sandbox_review'
  | 'rejected'
  | 'artifact_issuance_ready';

export interface C6ZSellerAuthorityRequest {
  request_id?: string | undefined;
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  merchant_display_name: string;
  commerce_categories: string[];
  connector_choice: C6ZSourceSystem;
  connector_mode: 'read_only';
  /** Required `true` with `connector_choice: 'synthetic_demo'`; must not be `true` for `catalog_upload`; not read for `shopify`. */
  synthetic_data?: boolean | undefined;
  requested_authority_scope: string[];
  artifact_cache_scope: {
    tenant_id: string;
    merchant_id: string;
    seller_agent_id: string;
  };
  source_freshness_policy: {
    max_age_seconds: number;
  };
  source_evidence_ref: string;
  source_observed_at: string;
  no_payment_execution: true;
  /** `true` unless the merchant opts in with `public_discovery_requested`. */
  no_public_discovery_enablement?: boolean | undefined;
  /**
   * Merchant opt-in to public discovery (a published `/.well-known/ucp`).
   * Honoured only when OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED is on, the
   * tenant is on the authority service allowlist, and the request carries the
   * namespace / host attestation below; otherwise the artifacts are issued
   * with public discovery disabled, as without the opt-in.
   */
  public_discovery_requested?: boolean | undefined;
  /** Opaque reference to the merchant runtime's namespace-to-host attestation. */
  namespace_attestation_ref?: string | undefined;
  /** The host the profile is served from (lower-case DNS name, no port). */
  serving_host?: string | undefined;
}

export interface C6ZConnectorEvidence {
  evidence_id: string;
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  source_system: C6ZSourceSystem;
  /** Required `true` with `source_system: 'synthetic_demo'`; not read for `shopify`. */
  synthetic_data?: boolean | undefined;
  source_evidence_ref: string;
  source_observed_at: string;
  product_count: number;
  variant_count: number;
  currency?: string | undefined;
  catalog_sample_refs: string[];
  price_snapshot_refs: string[];
  inventory_snapshot_refs: string[];
  no_payment_execution: true;
  no_public_discovery_enablement: true;
}

export interface C6ZIssuedArtifact {
  artifact_family: C6ZArtifactFamily;
  artifact_type: OacpArtifactType;
  envelope: OacpArtifactEnvelope;
  payload: Record<string, unknown>;
  /** The issuer's own check of the signed artifact against its published key. */
  verifier_status: OacpArtifactAuthorityStatus;
}

export interface C6ZIssuanceResult {
  status: C6ZAuthorityRequestStatus;
  request_id: string | null;
  authority_request_ref: string | null;
  artifacts: C6ZIssuedArtifact[];
  refusal_code?: string | undefined;
  message: string;
  allowed_to_execute: false;
  no_payment_execution: true;
  /** false only when the issued `public_discovery_state` artifact enables public discovery. */
  no_public_discovery_enablement: boolean;
  non_authoritative_for_transaction: true;
}

/** Whether issuance may enable public discovery; decided by the store from config. */
export interface C6ZPublicDiscoveryEligibility {
  /** OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED. */
  issuance_enabled: boolean;
  /** The tenant is on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS. */
  tenant_allowlisted: boolean;
}

export type C6ZPublicDiscoveryWithheldReason =
  | 'not_requested'
  | 'issuance_flag_off'
  | 'tenant_not_allowlisted'
  | 'namespace_attestation_missing';

export interface C6ZPublicDiscoveryDecision {
  enabled: boolean;
  withheld_reason: C6ZPublicDiscoveryWithheldReason | null;
  namespace_attestation_ref: string | null;
  serving_host: string | null;
}

/** Which non-Shopify sources a tenant may use; decided by the store from config and enrolment. */
export interface C6ZSourceEligibility {
  /** The tenant is on COMMERCE_C6Z_DEMO_SOURCE_TENANTS and on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS. */
  synthetic_demo_allowed: boolean;
  /** The tenant is on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS or enrolled with `catalog_upload`. Absent: never. */
  catalog_upload_allowed?: boolean | undefined;
}

/**
 * `shopify` as before. `synthetic_demo` only when the request says
 * `synthetic_data: true` and the tenant is eligible; `catalog_upload` only for
 * an eligible tenant and never as synthetic data; absent eligibility, never.
 */
function sourceAccepted(request: C6ZSellerAuthorityRequest, eligibility: C6ZSourceEligibility | undefined): boolean {
  if (request.connector_choice === 'shopify') return true;
  if (request.connector_choice === 'catalog_upload') {
    return request.synthetic_data !== true && eligibility?.catalog_upload_allowed === true;
  }
  return request.connector_choice === 'synthetic_demo'
    && request.synthetic_data === true
    && eligibility?.synthetic_demo_allowed === true;
}

const NAMESPACE_ATTESTATION_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const SERVING_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Public discovery is enabled only for an opted-in request, with the issuance
 * flag on, an allow-listed tenant and both attestation members; otherwise the
 * artifacts say disabled, as before the opt-in existed.
 */
export function decideC6ZPublicDiscovery(
  request: C6ZSellerAuthorityRequest,
  eligibility: C6ZPublicDiscoveryEligibility | undefined,
): C6ZPublicDiscoveryDecision {
  const withheld = (reason: C6ZPublicDiscoveryWithheldReason): C6ZPublicDiscoveryDecision => ({
    enabled: false, withheld_reason: reason, namespace_attestation_ref: null, serving_host: null,
  });
  if (request.public_discovery_requested !== true) return withheld('not_requested');
  if (eligibility?.issuance_enabled !== true) return withheld('issuance_flag_off');
  if (eligibility.tenant_allowlisted !== true) return withheld('tenant_not_allowlisted');
  if (!isNonEmptyString(request.namespace_attestation_ref) || !isNonEmptyString(request.serving_host)) {
    return withheld('namespace_attestation_missing');
  }
  return {
    enabled: true,
    withheld_reason: null,
    namespace_attestation_ref: request.namespace_attestation_ref,
    serving_host: request.serving_host,
  };
}

const POLICY_VERSION = 'commerce-c6z-internal-runtime-demo';
const MAX_SOURCE_AGE_SECONDS = 15 * 60;
const FAMILY_TYPE: Record<C6ZArtifactFamily, OacpArtifactType> = {
  merchant_profile: 'merchant_capability',
  seller_agent_card: 'seller_agent_capability',
  connector_evidence: 'protocol_adapter',
  catalog_snapshot: 'catalog_snapshot',
  offer_price_snapshot: 'price',
  inventory_snapshot: 'inventory',
  policy_scope: 'policy',
  public_discovery_state: 'public_discovery',
  mandate_capability: 'mandate_capability',
  protocol_adapter: 'protocol_adapter',
  authority_request_status: 'protocol_adapter',
};
const FAMILY_TTL_SECONDS: Record<C6ZArtifactFamily, number> = {
  merchant_profile: 24 * 60 * 60,
  seller_agent_card: 6 * 60 * 60,
  connector_evidence: 15 * 60,
  catalog_snapshot: 6 * 60 * 60,
  offer_price_snapshot: 5 * 60,
  inventory_snapshot: 60,
  policy_scope: 6 * 60 * 60,
  public_discovery_state: 15 * 60,
  mandate_capability: 2 * 60,
  protocol_adapter: 24 * 60 * 60,
  authority_request_status: 15 * 60,
};
const BLOCKED_RUNTIME_CAPABILITIES = [
  'checkout_payment_execution',
  'order_creation',
  'inventory_hold',
  'live_provider_execution',
  'offline_pos_transaction_execution',
  'pos_order_creation',
  'pos_payment_capture',
  'public_discovery_publication',
] as const;
const PRIVATE_VALUE_MARKERS = [
  'access_token',
  'api_key',
  'authorization',
  'bearer ',
  'card_number',
  'credential',
  'customer_email',
  'customer_phone',
  'password',
  'private_key',
  'raw_connector_payload',
  'raw_provider_payload',
  'raw_jwt',
  'secret',
  'token',
  'webhook_secret',
];
const EXECUTION_MARKERS = [
  'checkout.create',
  'payment.create',
  'payment_intent',
  'mandate.create',
  'order.create',
  'inventory_hold',
  'public_discovery.publish',
  'live_provider',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalRef(input: C6ZSellerAuthorityRequest): string {
  return `c6z_authority_request:${input.tenant_id}:${input.merchant_id}:${input.seller_agent_id}`;
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoAfter(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function nonSensitiveEvidenceRefs(evidence: C6ZConnectorEvidence): string[] {
  return [
    evidence.source_evidence_ref,
    ...evidence.catalog_sample_refs,
    ...evidence.price_snapshot_refs,
    ...evidence.inventory_snapshot_refs,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function containsUnsafeValue(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      const normalized = current.toLowerCase();
      if (PRIVATE_VALUE_MARKERS.some((marker) => normalized.includes(marker))) return true;
      if (EXECUTION_MARKERS.some((marker) => normalized.includes(marker))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        const normalizedKey = key.toLowerCase();
        if (PRIVATE_VALUE_MARKERS.some((marker) => normalizedKey.includes(marker))) return true;
        if (EXECUTION_MARKERS.some((marker) => normalizedKey.includes(marker))) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function issueRefusal(
  status: C6ZAuthorityRequestStatus,
  refusalCode: string,
  message: string,
  request?: C6ZSellerAuthorityRequest,
): C6ZIssuanceResult {
  return {
    status,
    request_id: request?.request_id ?? null,
    authority_request_ref: request ? canonicalRef(request) : null,
    artifacts: [],
    refusal_code: refusalCode,
    message,
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    non_authoritative_for_transaction: true,
  };
}

export function validateC6ZSellerAuthorityRequest(
  request: C6ZSellerAuthorityRequest | null | undefined,
  nowIso: string,
  /** Absent: only `shopify` is accepted. */
  sourceEligibility?: C6ZSourceEligibility,
): C6ZIssuanceResult {
  if (!request) {
    return issueRefusal('rejected', 'authority_request_missing', 'AgenticOrg authority request is required.');
  }
  const required = [
    request.tenant_id,
    request.merchant_id,
    request.seller_agent_id,
    request.merchant_display_name,
    request.source_evidence_ref,
    request.source_observed_at,
  ];
  if (!required.every(isNonEmptyString)) {
    return issueRefusal(
      'rejected',
      'authority_scope_missing',
      'Tenant, merchant, seller, display name, source evidence, and source timestamp are required.',
      request,
    );
  }
  if (
    !sourceAccepted(request, sourceEligibility)
    || request.connector_mode !== 'read_only'
    || request.no_payment_execution !== true
    || (request.public_discovery_requested === true
      ? request.no_public_discovery_enablement === true
      : request.no_public_discovery_enablement !== true)
  ) {
    return issueRefusal(
      'rejected',
      'unsupported_or_enabling_authority_request',
      'C6Z accepts read-only authority requests from an accepted catalogue source (Shopify, or an eligible tenant catalogue upload) with non-enablement flags only.',
      request,
    );
  }
  if (
    request.artifact_cache_scope.tenant_id !== request.tenant_id
    || request.artifact_cache_scope.merchant_id !== request.merchant_id
    || request.artifact_cache_scope.seller_agent_id !== request.seller_agent_id
  ) {
    return issueRefusal('rejected', 'artifact_cache_scope_mismatch', 'Artifact cache scope must match authority scope.', request);
  }
  if (
    (request.public_discovery_requested !== undefined && typeof request.public_discovery_requested !== 'boolean')
    || (request.namespace_attestation_ref !== undefined
      && (typeof request.namespace_attestation_ref !== 'string' || !NAMESPACE_ATTESTATION_REF.test(request.namespace_attestation_ref)))
    || (request.serving_host !== undefined
      && (typeof request.serving_host !== 'string' || !SERVING_HOST.test(request.serving_host)))
  ) {
    return issueRefusal('rejected', 'public_discovery_request_invalid',
      'public_discovery_requested must be a boolean, namespace_attestation_ref an opaque reference and serving_host a lower-case DNS name.', request);
  }
  if (request.commerce_categories.length === 0 || request.requested_authority_scope.length === 0) {
    return issueRefusal('pending_sandbox_review', 'authority_scope_incomplete', 'Categories and authority scope are required before issuance.', request);
  }
  if (containsUnsafeValue(request)) {
    return issueRefusal('rejected', 'private_or_executable_authority_request', 'Authority requests must not contain secrets, raw payloads, or execution targets.', request);
  }
  const observed = parseTime(request.source_observed_at);
  const now = parseTime(nowIso);
  if (observed === null || now === null || observed > now || now - observed > MAX_SOURCE_AGE_SECONDS * 1000) {
    return issueRefusal('pending_sandbox_review', 'source_evidence_stale', 'Source evidence must be recent before internal artifact issuance.', request);
  }
  if (
    !Number.isInteger(request.source_freshness_policy.max_age_seconds)
    || request.source_freshness_policy.max_age_seconds <= 0
    || request.source_freshness_policy.max_age_seconds > MAX_SOURCE_AGE_SECONDS
  ) {
    return issueRefusal('pending_sandbox_review', 'source_freshness_policy_invalid', 'Source freshness policy must be bounded for C6Z issuance.', request);
  }
  return {
    status: 'artifact_issuance_ready',
    request_id: request.request_id ?? null,
    authority_request_ref: canonicalRef(request),
    artifacts: [],
    message: 'Authority request is ready for internal C6Z artifact issuance.',
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    non_authoritative_for_transaction: true,
  };
}

/**
 * Where the payload says its facts came from. A Shopify issuance keeps the
 * lineage it always had; a synthetic demo issuance names its real source,
 * says the data is synthetic and that no merchant system of record stands
 * behind it; a catalogue upload names itself and is the merchant's own
 * record (the merchant uploaded it).
 */
function sourceLineage(evidence: C6ZConnectorEvidence): Record<string, unknown> {
  if (evidence.source_system === 'catalog_upload') {
    return {
      source_system: 'catalog_upload',
      connector_mode: 'read_only',
      connector_evidence_id: evidence.evidence_id,
      source_evidence_ref: evidence.source_evidence_ref,
      source_observed_at: evidence.source_observed_at,
      merchant_system_source_of_record: true,
      merchant_supplied_upload: true,
      raw_catalog_upload_stored_by_grantex: false,
      raw_provider_payload_stored_by_grantex: false,
    };
  }
  if (evidence.source_system === 'synthetic_demo') {
    return {
      source_system: 'synthetic_demo',
      synthetic_data: true,
      connector_mode: 'read_only',
      connector_evidence_id: evidence.evidence_id,
      source_evidence_ref: evidence.source_evidence_ref,
      source_observed_at: evidence.source_observed_at,
      merchant_system_source_of_record: false,
      raw_provider_payload_stored_by_grantex: false,
    };
  }
  return {
    source_system: 'shopify',
    connector_mode: 'read_only',
    connector_evidence_id: evidence.evidence_id,
    source_evidence_ref: evidence.source_evidence_ref,
    source_observed_at: evidence.source_observed_at,
    merchant_system_source_of_record: true,
    raw_shopify_payload_stored_by_grantex: false,
    raw_provider_payload_stored_by_grantex: false,
  };
}

function payloadForFamily(
  family: C6ZArtifactFamily,
  request: C6ZSellerAuthorityRequest,
  evidence: C6ZConnectorEvidence,
  signing: { issuer: string; kid: string; status_uri: string },
  publicDiscovery: C6ZPublicDiscoveryDecision,
  capability: { status: MandateCapabilityStatus; evidence: BoundMandateCapabilityEvidence | null },
): Record<string, unknown> {
  const ttlSeconds = FAMILY_TTL_SECONDS[family];
  // Only the enabled public discovery artifact drops public_discovery_publication from its blocked list.
  const discoveryEnabledHere = family === 'public_discovery_state' && publicDiscovery.enabled;
  const blocked = discoveryEnabledHere
    ? BLOCKED_RUNTIME_CAPABILITIES.filter((capability) => capability !== 'public_discovery_publication')
    : [...BLOCKED_RUNTIME_CAPABILITIES];
  return {
    artifact_family: family,
    tenant_id: request.tenant_id,
    merchant_id: request.merchant_id,
    seller_agent_id: request.seller_agent_id,
    source_system: evidence.source_system,
    // Only a synthetic issuance gains the member, so a Shopify payload is byte-identical to before.
    ...(evidence.source_system === 'synthetic_demo' ? { synthetic_data: true } : {}),
    source_evidence_ref: evidence.source_evidence_ref,
    source_observed_at: evidence.source_observed_at,
    source_lineage: sourceLineage(evidence),
    ttl_seconds: ttlSeconds,
    freshness: {
      source_observed_at: evidence.source_observed_at,
      max_source_age_seconds: MAX_SOURCE_AGE_SECONDS,
      requested_max_age_seconds: request.source_freshness_policy.max_age_seconds,
      status_at_issuance: 'fresh',
      stale_behavior: 'refuse_final_commitment_or_require_refresh',
    },
    revocation_posture: {
      revocation_status_url: signing.status_uri,
      status_at_issuance: 'not_revoked',
      stale_or_unreachable_behavior: 'treat_as_not_authorized_for_commitment',
    },
    blocked_capabilities: blocked,
    non_sensitive_evidence_refs: nonSensitiveEvidenceRefs(evidence),
    signature_metadata: {
      issuer: signing.issuer,
      issuer_key_id: signing.kid,
      algorithm: 'ES256',
      jws_typ: OACP_JWS_TYP,
      canonicalization: 'rfc8785',
      payload_hash_algorithm: 'sha256',
      detached_jws_required: true,
      signature_value_in_payload: false,
    },
    merchant_display_name: family === 'merchant_profile' ? request.merchant_display_name : undefined,
    commerce_categories: family === 'merchant_profile' ? request.commerce_categories : undefined,
    product_count: ['catalog_snapshot', 'connector_evidence'].includes(family) ? evidence.product_count : undefined,
    variant_count: ['catalog_snapshot', 'connector_evidence'].includes(family) ? evidence.variant_count : undefined,
    catalog_sample_refs: family === 'catalog_snapshot' ? evidence.catalog_sample_refs : undefined,
    price_snapshot_refs: family === 'offer_price_snapshot' ? evidence.price_snapshot_refs : undefined,
    inventory_snapshot_refs: family === 'inventory_snapshot' ? evidence.inventory_snapshot_refs : undefined,
    requested_authority_scope: family === 'policy_scope' ? request.requested_authority_scope : undefined,
    offline_pos_bridge_boundary: family === 'policy_scope'
      ? 'agenticorg_orchestrates_handoff_pos_or_provider_owns_execution'
      : undefined,
    offline_pos_evidence_refs_allowed: family === 'policy_scope'
      ? true
      : undefined,
    public_discovery_state: family === 'public_discovery_state' ? (publicDiscovery.enabled ? 'enabled' : 'disabled') : undefined,
    public_discovery_publication_allowed: family === 'public_discovery_state' ? publicDiscovery.enabled : undefined,
    // Present only on an opt-in, so a request without one issues exactly the payload it did before.
    public_discovery_requested: family === 'public_discovery_state' && request.public_discovery_requested === true ? true : undefined,
    public_discovery_withheld_reason: family === 'public_discovery_state' && request.public_discovery_requested === true && !publicDiscovery.enabled
      ? publicDiscovery.withheld_reason
      : undefined,
    namespace_attestation_ref: discoveryEnabledHere ? publicDiscovery.namespace_attestation_ref : undefined,
    serving_host: discoveryEnabledHere ? publicDiscovery.serving_host : undefined,
    // G43: the provider capability verifier's redacted evidence, bound as
    // received; without it the artifact says `unverified` and names no ref.
    mandate_capability_status: family === 'mandate_capability' ? capability.status : undefined,
    provider_execution_authority: family === 'mandate_capability' ? 'provider_owned_not_grantex_or_agenticorg' : undefined,
    mandate_capability_ref: family === 'mandate_capability' ? capability.evidence?.redacted_evidence_ref : undefined,
    mandate_capability_evidence: family === 'mandate_capability' ? capability.evidence ?? undefined : undefined,
    offline_pos_confirmation_authority: family === 'mandate_capability'
      ? 'pos_or_payment_provider_callback_required_not_grantex'
      : undefined,
    // No POS handoff or receipt evidence reaches Grantex today: say so instead
    // of naming a reference that looks like evidence.
    offline_pos_evidence_status: family === 'mandate_capability' ? 'unverified' : undefined,
    adapter_surfaces: family === 'protocol_adapter'
      ? [
        'schema_org_product_offer_jsonld',
        'ucp_style_capability_profile',
        'acp_style_commerce_interaction',
        // Signed AP2-mapped mandates exist (POST /v1/commerce/oacp/mandates/*).
        'ap2_payment_mandate',
        'a2a_agent_card_task_metadata',
        'mcp_tool_manifest_resource_metadata',
        'openapi_buyer_safe_bridge_schema',
      ]
      : undefined,
    adapter_claim_boundary: family === 'protocol_adapter'
      ? 'compatibility_mapping_only_no_certification_or_standardization_claim'
      : undefined,
    allowed_protocol_adapters: family === 'protocol_adapter'
      ? ['schema.org', 'ucp_style', 'acp_style', 'ap2_style', 'a2a', 'mcp']
      : undefined,
    adapter_mapping_profile: family === 'protocol_adapter'
      ? {
        canonical_source: 'grantex_signed_oacp_artifacts',
        generated_by: 'agenticorg_runtime_from_cached_artifacts',
        external_certification_status: 'compatibility_mapping_only_not_publicly_certified',
        required_artifact_families: [
          'merchant_profile',
          'seller_agent_card',
          'connector_evidence',
          'catalog_snapshot',
          'offer_price_snapshot',
          'inventory_snapshot',
          'policy_scope',
          'public_discovery_state',
          'mandate_capability',
          'protocol_adapter',
          'authority_request_status',
        ],
        surface_contracts: [
          {
            surface: 'schema_org_product_offer_jsonld',
            source_artifact_families: ['catalog_snapshot', 'offer_price_snapshot', 'inventory_snapshot'],
            prohibited_outputs: ['checkout execution', 'payment execution', 'order creation'],
          },
          {
            surface: 'ucp_style_capability_profile',
            source_artifact_families: ['seller_agent_card', 'policy_scope', 'protocol_adapter'],
            prohibited_outputs: ['capability certification claim', 'public publication claim'],
          },
          {
            surface: 'acp_style_commerce_interaction_profile',
            source_artifact_families: ['policy_scope', 'catalog_snapshot', 'offer_price_snapshot', 'inventory_snapshot'],
            prohibited_outputs: ['final commitment claim', 'stock reservation claim'],
          },
          {
            surface: 'ap2_style_mandate_payment_evidence_profile',
            source_artifact_families: ['mandate_capability', 'policy_scope', 'authority_request_status'],
            prohibited_outputs: ['provider execution claim', 'settled-payment claim', 'POS paid-state claim'],
          },
          {
            surface: 'a2a_agent_card_task_metadata',
            source_artifact_families: ['seller_agent_card', 'protocol_adapter'],
            prohibited_outputs: ['unsupported task execution'],
          },
          {
            surface: 'mcp_tool_manifest_resource_metadata',
            source_artifact_families: ['seller_agent_card', 'catalog_snapshot', 'protocol_adapter'],
            prohibited_outputs: ['write tool exposure'],
          },
          {
            surface: 'openapi_buyer_safe_bridge_schema',
            source_artifact_families: ['seller_agent_card', 'policy_scope', 'protocol_adapter'],
            prohibited_outputs: ['payment, order, or POS operation exposure'],
          },
        ],
        offline_pos_bridge_mapping: {
          source_artifact_families: ['policy_scope', 'catalog_snapshot', 'offer_price_snapshot', 'inventory_snapshot', 'mandate_capability'],
          allowed_refs: ['offline_pos_handoff_packet_ref', 'provider_pos_evidence_ref', 'receipt_evidence_ref'],
          prohibited_outputs: ['POS transaction execution', 'POS payment capture', 'POS order success claim'],
        },
      }
      : undefined,
    authority_request_status: family === 'authority_request_status' ? 'artifact_issuance_ready' : undefined,
    unsupported_capabilities: blocked,
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: !discoveryEnabledHere,
    non_authoritative_for_transaction: true,
  };
}

function artifactSafety(family: C6ZArtifactFamily) {
  return {
    public_safe: true,
    contains_private_data: false,
    allowed_agent_uses: ['browse', 'compare', 'answer_product_question', 'prepare_only'],
    forbidden_agent_uses: [
      'checkout_payment_execution',
      'order_creation',
      'inventory_hold',
      'refund_execution',
      'return_execution',
      'shipping_execution',
      'offline_pos_transaction_execution',
      'pos_order_creation',
      'pos_payment_capture',
      'public_discovery_publication',
    ],
    commitment_allowed: false,
    offline_commitment_allowed: false,
    requires_online_confirmation: true,
    requires_provider_direct_verification: ['policy_scope', 'mandate_capability'].includes(family),
    requires_merchant_system_confirmation: ['offer_price_snapshot', 'inventory_snapshot'].includes(family),
    stale_behavior: 'refuse_final_commitment' as const,
    refusal_code_if_invalid: 'c6z_artifact_invalid',
  };
}

/** What issuance needs from the store: the issuer, its key and status list entries. */
export interface C6ZIssuanceContext {
  /** The Grantex issuer identifier (config JWT_ISSUER). */
  issuer: string;
  signer: OacpSigningKey;
  /** A fresh artifact id. */
  newArtifactId: () => string;
  /** Allocate the artifact's Token Status List entry, in the issuing transaction. */
  allocateStatus: (artifactId: string) => Promise<{ uri: string; idx: number }>;
  /** Absent: public discovery is never enabled. */
  publicDiscovery?: C6ZPublicDiscoveryEligibility;
  /** Absent: the synthetic demo source is never accepted. */
  sourceEligibility?: C6ZSourceEligibility;
}

/**
 * Validate the request and evidence, then issue one ES256-signed artifact per
 * C6Z family, each on the status list. Every artifact is verified against the
 * signer's published key before it is returned; a refusal issues nothing.
 */
export async function issueC6ZInternalOacpArtifacts(input: {
  request: C6ZSellerAuthorityRequest;
  evidence: C6ZConnectorEvidence;
  /** G43: the redacted provider capability evidence (mandate-capability-evidence.ts), or absent. */
  mandate_capability_evidence?: unknown;
  now_iso: string;
  context: C6ZIssuanceContext;
}): Promise<C6ZIssuanceResult> {
  const validation = validateC6ZSellerAuthorityRequest(input.request, input.now_iso, input.context.sourceEligibility);
  if (validation.status !== 'artifact_issuance_ready') return validation;
  if (containsUnsafeValue(input.evidence)) {
    return issueRefusal('rejected', 'private_or_executable_connector_evidence', 'Connector evidence must be redacted before issuance.', input.request);
  }
  if (
    input.evidence.tenant_id !== input.request.tenant_id
    || input.evidence.merchant_id !== input.request.merchant_id
    || input.evidence.seller_agent_id !== input.request.seller_agent_id
    || input.evidence.source_system !== input.request.connector_choice
    || (input.evidence.source_system === 'synthetic_demo' && input.evidence.synthetic_data !== true)
    || (input.evidence.source_system === 'catalog_upload' && input.evidence.synthetic_data === true)
    || input.evidence.no_payment_execution !== true
    || input.evidence.no_public_discovery_enablement !== true
  ) {
    return issueRefusal('rejected', 'connector_evidence_scope_mismatch', 'Connector evidence must match authority scope and stay read-only.', input.request);
  }
  const sourceObserved = parseTime(input.evidence.source_observed_at);
  const now = parseTime(input.now_iso);
  if (sourceObserved === null || now === null || sourceObserved > now || now - sourceObserved > MAX_SOURCE_AGE_SECONDS * 1000) {
    return issueRefusal('pending_sandbox_review', 'connector_evidence_stale', 'Connector evidence is stale for C6Z issuance.', input.request);
  }

  let capability: ReturnType<typeof bindMandateCapabilityEvidence>;
  try {
    capability = bindMandateCapabilityEvidence(input.mandate_capability_evidence === undefined || input.mandate_capability_evidence === null
      ? null
      : parseMandateCapabilityEvidence(input.mandate_capability_evidence, input.request, input.now_iso));
  } catch (err) {
    if (!(err instanceof MandateCapabilityEvidenceError)) throw err;
    return issueRefusal('rejected', 'mandate_capability_evidence_invalid',
      `Mandate capability evidence is invalid (${err.field}): ${err.message}.`, input.request);
  }

  const { issuer, signer } = input.context;
  const publicDiscovery = decideC6ZPublicDiscovery(input.request, input.context.publicDiscovery);
  const jwks = { keys: [signer.publicJwk] };
  const artifacts: C6ZIssuedArtifact[] = [];
  for (const family of C6Z_ARTIFACT_FAMILIES) {
    const artifactType = FAMILY_TYPE[family];
    const artifactId = input.context.newArtifactId();
    const statusList = await input.context.allocateStatus(artifactId);
    const payload = payloadForFamily(family, input.request, input.evidence, {
      issuer,
      kid: signer.kid,
      status_uri: statusList.uri,
    }, publicDiscovery, capability);
    const ttlSeconds = Math.min(FAMILY_TTL_SECONDS[family], OACP_ARTIFACT_TTLS_SECONDS[artifactType]);
    const envelope = issueOacpArtifact({
      artifact_id: artifactId,
      artifact_type: artifactType,
      issuer,
      signer,
      subject_type: family,
      subject_id: `${input.request.merchant_id}:${input.request.seller_agent_id}`,
      tenant_id: input.request.tenant_id,
      merchant_id: input.request.merchant_id,
      seller_agent_id: input.request.seller_agent_id,
      buyer_agent_id: '',
      issued_at: input.now_iso,
      expires_at: isoAfter(input.now_iso, ttlSeconds),
      source_observed_at: input.evidence.source_observed_at,
      policy_version: POLICY_VERSION,
      status_list: statusList,
      evidence_refs: [input.evidence.source_evidence_ref],
      payload,
      safety: artifactSafety(family),
    });
    const verifier_status = verifyOacpArtifact({
      envelope,
      payload,
      jwks,
      now_iso: input.now_iso,
      // Allocated in this transaction a moment ago: VALID.
      status: 0,
      expected_scope: {
        tenant_id: input.request.tenant_id,
        merchant_id: input.request.merchant_id,
        seller_agent_id: input.request.seller_agent_id,
        buyer_agent_id: '',
      },
    });
    artifacts.push({ artifact_family: family, artifact_type: artifactType, envelope, payload, verifier_status });
  }

  if (artifacts.some((artifact) => artifact.verifier_status.valid !== true)) {
    return issueRefusal('rejected', 'issued_artifact_verification_failed', 'Issued C6Z artifacts must verify internally before handoff.', input.request);
  }
  return {
    status: 'artifact_issuance_ready',
    request_id: input.request.request_id ?? null,
    authority_request_ref: canonicalRef(input.request),
    artifacts,
    message: 'Issued ES256-signed C6Z OACP artifacts for AgenticOrg cache intake.',
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: !publicDiscovery.enabled,
    non_authoritative_for_transaction: true,
  };
}
