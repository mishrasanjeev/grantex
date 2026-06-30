import {
  evaluateInternalOacpArtifactStatus,
  issueInternalOacpArtifact,
  type OacpArtifactEnvelope,
  type OacpArtifactType,
  type OacpIssuerKeyMetadata,
} from './oacp-trust-artifacts.js';

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
  connector_choice: 'shopify';
  connector_mode: 'read_only';
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
  no_public_discovery_enablement: true;
}

export interface C6ZConnectorEvidence {
  evidence_id: string;
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  source_system: 'shopify';
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
  verifier_status: ReturnType<typeof evaluateInternalOacpArtifactStatus>;
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
  no_public_discovery_enablement: true;
  non_authoritative_for_transaction: true;
}

const ISSUER = 'grantex_internal_oacp_authority';
const ISSUER_KEY_ID = 'kid_c6z_internal_demo';
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

function stableId(parts: readonly string[]): string {
  return parts.join(':').replace(/[^a-zA-Z0-9:_-]/g, '_');
}

function revocationStatusUrl(request: C6ZSellerAuthorityRequest): string {
  return `internal:oacp:c6z:revocation:${request.tenant_id}:${request.merchant_id}`;
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
    request.connector_choice !== 'shopify'
    || request.connector_mode !== 'read_only'
    || request.no_payment_execution !== true
    || request.no_public_discovery_enablement !== true
  ) {
    return issueRefusal(
      'rejected',
      'unsupported_or_enabling_authority_request',
      'C6Z accepts Shopify read-only authority requests with non-enablement flags only.',
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

function defaultIssuerKey(nowIso: string): OacpIssuerKeyMetadata {
  return {
    issuer: ISSUER,
    issuer_key_id: ISSUER_KEY_ID,
    algorithm: 'ES256',
    state: 'active',
    not_before: nowIso,
    expires_at: isoAfter(nowIso, 24 * 60 * 60),
  };
}

function payloadForFamily(
  family: C6ZArtifactFamily,
  request: C6ZSellerAuthorityRequest,
  evidence: C6ZConnectorEvidence,
): Record<string, unknown> {
  const ttlSeconds = FAMILY_TTL_SECONDS[family];
  return {
    artifact_family: family,
    tenant_id: request.tenant_id,
    merchant_id: request.merchant_id,
    seller_agent_id: request.seller_agent_id,
    source_system: 'shopify',
    source_evidence_ref: evidence.source_evidence_ref,
    source_observed_at: evidence.source_observed_at,
    source_lineage: {
      source_system: 'shopify',
      connector_mode: 'read_only',
      connector_evidence_id: evidence.evidence_id,
      source_evidence_ref: evidence.source_evidence_ref,
      source_observed_at: evidence.source_observed_at,
      merchant_system_source_of_record: true,
      raw_shopify_payload_stored_by_grantex: false,
      raw_provider_payload_stored_by_grantex: false,
    },
    ttl_seconds: ttlSeconds,
    freshness: {
      source_observed_at: evidence.source_observed_at,
      max_source_age_seconds: MAX_SOURCE_AGE_SECONDS,
      requested_max_age_seconds: request.source_freshness_policy.max_age_seconds,
      status_at_issuance: 'fresh',
      stale_behavior: 'refuse_final_commitment_or_require_refresh',
    },
    revocation_posture: {
      revocation_status_url: revocationStatusUrl(request),
      status_at_issuance: 'not_revoked',
      stale_or_unreachable_behavior: 'treat_as_not_authorized_for_commitment',
    },
    blocked_capabilities: [...BLOCKED_RUNTIME_CAPABILITIES],
    non_sensitive_evidence_refs: nonSensitiveEvidenceRefs(evidence),
    signature_metadata: {
      issuer: ISSUER,
      issuer_key_id: ISSUER_KEY_ID,
      algorithm: 'ES256',
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
    public_discovery_state: family === 'public_discovery_state' ? 'disabled' : undefined,
    public_discovery_publication_allowed: family === 'public_discovery_state' ? false : undefined,
    mandate_capability_status: family === 'mandate_capability' ? 'provider_owned_verification_required' : undefined,
    provider_execution_authority: family === 'mandate_capability' ? 'provider_owned_not_grantex_or_agenticorg' : undefined,
    mandate_capability_ref: family === 'mandate_capability' ? 'provider:mandate_rail:capability:pending:redacted' : undefined,
    offline_pos_confirmation_authority: family === 'mandate_capability'
      ? 'pos_or_payment_provider_callback_required_not_grantex'
      : undefined,
    offline_pos_evidence_ref: family === 'mandate_capability'
      ? 'pos:provider_or_simulator:handoff_or_receipt:pending:redacted'
      : undefined,
    adapter_surfaces: family === 'protocol_adapter'
      ? [
        'schema_org_product_offer_jsonld',
        'ucp_style_capability_profile',
        'acp_style_commerce_interaction',
        'ap2_style_payment_mandate_evidence',
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
    unsupported_capabilities: [...BLOCKED_RUNTIME_CAPABILITIES],
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
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

export function issueC6ZInternalOacpArtifacts(input: {
  request: C6ZSellerAuthorityRequest;
  evidence: C6ZConnectorEvidence;
  now_iso: string;
  issuer_key?: OacpIssuerKeyMetadata | undefined;
}): C6ZIssuanceResult {
  const validation = validateC6ZSellerAuthorityRequest(input.request, input.now_iso);
  if (validation.status !== 'artifact_issuance_ready') return validation;
  if (containsUnsafeValue(input.evidence)) {
    return issueRefusal('rejected', 'private_or_executable_connector_evidence', 'Connector evidence must be redacted before issuance.', input.request);
  }
  if (
    input.evidence.tenant_id !== input.request.tenant_id
    || input.evidence.merchant_id !== input.request.merchant_id
    || input.evidence.seller_agent_id !== input.request.seller_agent_id
    || input.evidence.source_system !== 'shopify'
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

  const issuerKey = input.issuer_key ?? defaultIssuerKey(input.now_iso);
  const artifacts = C6Z_ARTIFACT_FAMILIES.map((family): C6ZIssuedArtifact => {
    const artifactType = FAMILY_TYPE[family];
    const payload = payloadForFamily(family, input.request, input.evidence);
    const envelope = issueInternalOacpArtifact({
      artifact_id: stableId(['c6z', family, input.request.tenant_id, input.request.merchant_id, input.request.seller_agent_id]),
      artifact_type: artifactType,
      issuer: ISSUER,
      issuer_key_id: ISSUER_KEY_ID,
      subject_type: family,
      subject_id: `${input.request.merchant_id}:${input.request.seller_agent_id}`,
      tenant_id: input.request.tenant_id,
      merchant_id: input.request.merchant_id,
      seller_agent_id: input.request.seller_agent_id,
      buyer_agent_id: '',
      issued_at: input.now_iso,
      expires_at: isoAfter(input.now_iso, FAMILY_TTL_SECONDS[family]),
      source_observed_at: input.evidence.source_observed_at,
      policy_version: POLICY_VERSION,
      revocation_status_url: revocationStatusUrl(input.request),
      payload,
      safety: artifactSafety(family),
      issuer_key: issuerKey,
      signDetachedJws: ({ artifact_id, payload_hash }) => `eyJhbGciOiJFUzI1NiJ9..sig_${artifact_id}_${payload_hash.slice(0, 16)}`,
    });
    const verifier_status = evaluateInternalOacpArtifactStatus({
      envelope,
      payload,
      issuer_keys: [issuerKey],
      now_iso: input.now_iso,
      expected_scope: {
        tenant_id: input.request.tenant_id,
        merchant_id: input.request.merchant_id,
        seller_agent_id: input.request.seller_agent_id,
        buyer_agent_id: '',
      },
      verifyDetachedJws: ({ artifact_id, payload_hash, signature }) => signature === `eyJhbGciOiJFUzI1NiJ9..sig_${artifact_id}_${payload_hash.slice(0, 16)}`,
    });
    return {
      artifact_family: family,
      artifact_type: artifactType,
      envelope,
      payload,
      verifier_status,
    };
  });

  if (artifacts.some((artifact) => artifact.verifier_status.valid !== true)) {
    return issueRefusal('rejected', 'issued_artifact_verification_failed', 'Issued C6Z artifacts must verify internally before handoff.', input.request);
  }
  return {
    status: 'artifact_issuance_ready',
    request_id: input.request.request_id ?? null,
    authority_request_ref: canonicalRef(input.request),
    artifacts,
    message: 'Issued internal C6Z OACP artifacts for AgenticOrg cache intake.',
    allowed_to_execute: false,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    non_authoritative_for_transaction: true,
  };
}
