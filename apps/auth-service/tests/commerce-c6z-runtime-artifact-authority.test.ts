import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZSellerAuthorityRequest,
} from '../src/lib/commerce/oacp-runtime-vertical.js';
import { authHeader, buildTestApp } from './helpers.js';
import { seedCommerceContext } from './commerce-helpers.js';

const NOW = '2026-06-14T03:30:00.000Z';

function authorityRequest(overrides: Partial<C6ZSellerAuthorityRequest> = {}): C6ZSellerAuthorityRequest {
  return {
    request_id: 'agenticorg_c6z_req_001',
    tenant_id: 'cten_C6Z',
    merchant_id: 'mch_C6Z',
    seller_agent_id: 'seller_C6Z',
    merchant_display_name: 'C6Z Demo Store',
    commerce_categories: ['home_goods'],
    connector_choice: 'shopify',
    connector_mode: 'read_only',
    requested_authority_scope: ['merchant_profile', 'catalog_snapshot', 'price_snapshot', 'inventory_snapshot'],
    artifact_cache_scope: {
      tenant_id: 'cten_C6Z',
      merchant_id: 'mch_C6Z',
      seller_agent_id: 'seller_C6Z',
    },
    source_freshness_policy: {
      max_age_seconds: 600,
    },
    source_evidence_ref: 'agenticorg:shopify:evidence:c6z_001:redacted',
    source_observed_at: '2026-06-14T03:25:00.000Z',
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

function connectorEvidence(overrides: Partial<C6ZConnectorEvidence> = {}): C6ZConnectorEvidence {
  return {
    evidence_id: 'shopify_evidence_C6Z',
    tenant_id: 'cten_C6Z',
    merchant_id: 'mch_C6Z',
    seller_agent_id: 'seller_C6Z',
    source_system: 'shopify',
    source_evidence_ref: 'agenticorg:shopify:evidence:c6z_001:redacted',
    source_observed_at: '2026-06-14T03:25:00.000Z',
    product_count: 2,
    variant_count: 3,
    currency: 'INR',
    catalog_sample_refs: ['agenticorg:catalog:item:c6z_1:redacted'],
    price_snapshot_refs: ['agenticorg:price:item:c6z_1:redacted'],
    inventory_snapshot_refs: ['agenticorg:inventory:item:c6z_1:redacted'],
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

describe('C6Z Grantex runtime artifact authority', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('validates AgenticOrg seller onboarding authority requests without becoming the runtime path', () => {
    const result = validateC6ZSellerAuthorityRequest(authorityRequest(), NOW);

    expect(result).toMatchObject({
      status: 'artifact_issuance_ready',
      allowed_to_execute: false,
      no_payment_execution: true,
      no_public_discovery_enablement: true,
      non_authoritative_for_transaction: true,
    });
    expect(result.authority_request_ref).toContain('cten_C6Z:mch_C6Z:seller_C6Z');
  });

  it('issues internally signed OACP artifacts for all C6Z runtime families', () => {
    const result = issueC6ZInternalOacpArtifacts({
      request: authorityRequest(),
      evidence: connectorEvidence(),
      now_iso: NOW,
    });

    expect(result.status).toBe('artifact_issuance_ready');
    expect(result.allowed_to_execute).toBe(false);
    expect(result.artifacts.map((artifact) => artifact.artifact_family).sort()).toEqual([
      'authority_request_status',
      'catalog_snapshot',
      'connector_evidence',
      'inventory_snapshot',
      'mandate_capability',
      'merchant_profile',
      'offer_price_snapshot',
      'policy_scope',
      'protocol_adapter',
      'public_discovery_state',
      'seller_agent_card',
    ]);
    for (const artifact of result.artifacts) {
      expect(artifact.envelope.issuer).toBe('grantex_internal_oacp_authority');
      expect(artifact.envelope.signature).toMatch(/^eyJhbGciOiJFUzI1NiJ9\.\.sig_/);
      expect(artifact.envelope.seller_agent_id).toBe('seller_C6Z');
      expect(artifact.payload).toMatchObject({
        source_system: 'shopify',
        source_lineage: {
          source_system: 'shopify',
          connector_mode: 'read_only',
          connector_evidence_id: 'shopify_evidence_C6Z',
          raw_shopify_payload_stored_by_grantex: false,
          raw_provider_payload_stored_by_grantex: false,
        },
        freshness: {
          source_observed_at: '2026-06-14T03:25:00.000Z',
          status_at_issuance: 'fresh',
          stale_behavior: 'refuse_final_commitment_or_require_refresh',
        },
        revocation_posture: {
          revocation_status_url: 'internal:oacp:c6z:revocation:cten_C6Z:mch_C6Z',
          status_at_issuance: 'not_revoked',
          stale_or_unreachable_behavior: 'treat_as_not_authorized_for_commitment',
        },
        signature_metadata: {
          issuer: 'grantex_internal_oacp_authority',
          issuer_key_id: 'kid_c6z_internal_demo',
          algorithm: 'ES256',
          payload_hash_algorithm: 'sha256',
          detached_jws_required: true,
          signature_value_in_payload: false,
        },
        allowed_to_execute: false,
        no_payment_execution: true,
        no_public_discovery_enablement: true,
        non_authoritative_for_transaction: true,
      });
      expect(artifact.payload.ttl_seconds).toBeGreaterThan(0);
      expect(artifact.payload.non_sensitive_evidence_refs).toEqual(expect.arrayContaining([
        'agenticorg:shopify:evidence:c6z_001:redacted',
      ]));
      expect(artifact.payload.blocked_capabilities).toEqual(expect.arrayContaining([
        'checkout_payment_execution',
        'offline_pos_transaction_execution',
        'pos_payment_capture',
      ]));
      expect(artifact.verifier_status).toMatchObject({
        valid: true,
        status: 'valid',
      });
    }
    expect(result.artifacts.find((artifact) => artifact.artifact_family === 'public_discovery_state')?.payload)
      .toMatchObject({
        public_discovery_state: 'disabled',
        public_discovery_publication_allowed: false,
      });
    expect(result.artifacts.find((artifact) => artifact.artifact_family === 'mandate_capability')?.payload)
      .toMatchObject({
        mandate_capability_status: 'provider_owned_verification_required',
        provider_execution_authority: 'provider_owned_not_grantex_or_agenticorg',
        offline_pos_confirmation_authority: 'pos_or_payment_provider_callback_required_not_grantex',
      });
    expect(result.artifacts.find((artifact) => artifact.artifact_family === 'policy_scope')?.payload)
      .toMatchObject({
        offline_pos_bridge_boundary: 'agenticorg_orchestrates_handoff_pos_or_provider_owns_execution',
        offline_pos_evidence_refs_allowed: true,
      });
    expect(result.artifacts.find((artifact) => artifact.artifact_family === 'protocol_adapter')?.payload)
      .toMatchObject({
        adapter_claim_boundary: 'compatibility_mapping_only_no_certification_or_standardization_claim',
        adapter_mapping_profile: {
          canonical_source: 'grantex_signed_oacp_artifacts',
          generated_by: 'agenticorg_runtime_from_cached_artifacts',
          external_certification_status: 'compatibility_mapping_only_not_publicly_certified',
          offline_pos_bridge_mapping: {
            prohibited_outputs: expect.arrayContaining(['POS transaction execution', 'POS payment capture', 'POS order success claim']),
          },
        },
        unsupported_capabilities: expect.arrayContaining([
          'offline_pos_transaction_execution',
          'pos_order_creation',
          'pos_payment_capture',
        ]),
      });
    expect(
      result.artifacts.find((artifact) => artifact.artifact_family === 'protocol_adapter')
        ?.payload.adapter_mapping_profile,
    ).toMatchObject({
      surface_contracts: expect.arrayContaining([
        expect.objectContaining({ surface: 'schema_org_product_offer_jsonld' }),
        expect.objectContaining({ surface: 'openapi_buyer_safe_bridge_schema' }),
        expect.objectContaining({
          surface: 'ap2_style_mandate_payment_evidence_profile',
          prohibited_outputs: expect.arrayContaining(['POS paid-state claim']),
        }),
      ]),
    });
  });

  it('fails closed for stale evidence, missing scope, secrets, raw payloads, and execution targets', () => {
    expect(validateC6ZSellerAuthorityRequest(
      authorityRequest({ source_observed_at: '2026-06-14T03:00:00.000Z' }),
      NOW,
    )).toMatchObject({
      status: 'pending_sandbox_review',
      refusal_code: 'source_evidence_stale',
      allowed_to_execute: false,
    });

    expect(validateC6ZSellerAuthorityRequest(
      authorityRequest({
        artifact_cache_scope: {
          tenant_id: 'cten_C6Z',
          merchant_id: 'other_merchant',
          seller_agent_id: 'seller_C6Z',
        },
      }),
      NOW,
    )).toMatchObject({
      status: 'rejected',
      refusal_code: 'artifact_cache_scope_mismatch',
    });

    expect(issueC6ZInternalOacpArtifacts({
      request: authorityRequest(),
      evidence: {
        ...connectorEvidence(),
        catalog_sample_refs: ['raw_connector_payload:shopify'],
      },
      now_iso: NOW,
    })).toMatchObject({
      status: 'rejected',
      refusal_code: 'private_or_executable_connector_evidence',
      allowed_to_execute: false,
    });

    expect(issueC6ZInternalOacpArtifacts({
      request: authorityRequest(),
      evidence: {
        ...connectorEvidence(),
        inventory_snapshot_refs: ['raw_provider_payload:provider'],
      },
      now_iso: NOW,
    })).toMatchObject({
      status: 'rejected',
      refusal_code: 'private_or_executable_connector_evidence',
      allowed_to_execute: false,
    });

    expect(validateC6ZSellerAuthorityRequest(
      authorityRequest({ requested_authority_scope: ['checkout.create'] }),
      NOW,
    )).toMatchObject({
      status: 'rejected',
      refusal_code: 'private_or_executable_authority_request',
    });
  });

  it('exposes an internal authority issuance endpoint under commerce auth', async () => {
    seedCommerceContext('cten_C6Z');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: authHeader(),
      payload: {
        now_iso: NOW,
        request: authorityRequest(),
        connector_evidence: connectorEvidence(),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      route_kind: 'grantex_internal_c6z_authority_request',
      status: 'artifact_issuance_ready',
      artifact_count: 11,
      allowed_to_execute: false,
      no_payment_execution: true,
      no_public_discovery_enablement: true,
    });
    expect(body.artifacts[0].envelope.tenant_id).toBe('cten_C6Z');
  });

  it('receives valid intake requests without issuing artifacts until connector evidence is present', async () => {
    seedCommerceContext('cten_C6Z');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: authHeader(),
      payload: {
        now_iso: NOW,
        request: authorityRequest(),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      route_kind: 'grantex_internal_c6z_authority_request',
      status: 'received',
      artifact_issuance_attempted: false,
      artifacts: [],
      allowed_to_execute: false,
      no_payment_execution: true,
      no_public_discovery_enablement: true,
    });
  });

  it('accepts a tenant-allowlisted AgenticOrg authority service token for this endpoint only', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', 'agenticorg-c6z-fixture-service-key');
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_C6Z');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
      payload: {
        now_iso: NOW,
        request: authorityRequest(),
        connector_evidence: connectorEvidence(),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      route_kind: 'grantex_internal_c6z_authority_request',
      status: 'artifact_issuance_ready',
      artifact_count: 11,
      allowed_to_execute: false,
    });

    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_C6Z',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('invalid_developer_key');
  });

  it('rejects the authority service token when the tenant is not explicitly allowlisted', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', 'agenticorg-c6z-fixture-service-key');
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_OTHER');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
      payload: {
        now_iso: NOW,
        request: authorityRequest(),
        connector_evidence: connectorEvidence(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('service_tenant_not_allowed');
  });
});
