import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZIssuanceContext,
  type C6ZSellerAuthorityRequest,
} from '../src/lib/commerce/oacp-runtime-vertical.js';
import { verifyOacpArtifact, type OacpSigningKey } from '../src/lib/commerce/oacp-jws.js';
import { authHeader, buildTestApp } from './helpers.js';
import { seedCommerceContext } from './commerce-helpers.js';

const NOW = '2026-06-14T03:30:00.000Z';
const STATUS_BASE = 'https://issuer.example/status/oacp/oacpl_01J00000000000000000000C6Z';

function memoryContext(): C6ZIssuanceContext & { signer: OacpSigningKey; allocated: string[] } {
  const kid = 'oacp-20260614-00000000000000c6';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const allocated: string[] = [];
  let next = 0;
  return {
    issuer: 'https://issuer.example',
    signer: { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } },
    newArtifactId: () => `oacp_art_01J0000000000000000000${String(next++).padStart(4, '0')}`,
    allocateStatus: async (artifactId) => {
      allocated.push(artifactId);
      return { uri: STATUS_BASE, idx: allocated.length };
    },
    allocated,
  };
}

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

  it('issues ES256-signed OACP artifacts for all C6Z runtime families', async () => {
    const context = memoryContext();
    const result = await issueC6ZInternalOacpArtifacts({
      request: authorityRequest(),
      evidence: connectorEvidence(),
      now_iso: NOW,
      context,
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
      expect(artifact.envelope.issuer).toBe('https://issuer.example');
      expect(artifact.envelope.issuer_key_id).toBe(context.signer.kid);
      expect(artifact.envelope.signature).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]{86}$/);
      expect(artifact.envelope.status?.status_list.uri).toBe(STATUS_BASE);
      expect(artifact.envelope.revocation_status_url).toBe(STATUS_BASE);
      expect(verifyOacpArtifact({
        envelope: artifact.envelope,
        payload: artifact.payload,
        jwks: { keys: [context.signer.publicJwk] },
        now_iso: NOW,
        status: 0,
      })).toMatchObject({ valid: true });
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
          revocation_status_url: STATUS_BASE,
          status_at_issuance: 'not_revoked',
          stale_or_unreachable_behavior: 'treat_as_not_authorized_for_commitment',
        },
        signature_metadata: {
          issuer: 'https://issuer.example',
          issuer_key_id: context.signer.kid,
          algorithm: 'ES256',
          jws_typ: 'oacp-artifact+jws',
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
        mandate_capability_status: 'unverified',
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

  it('binds redacted provider capability evidence into mandate_capability, and says unverified without it (G43)', async () => {
    const placeholderFree = await issueC6ZInternalOacpArtifacts({ request: authorityRequest(), evidence: connectorEvidence(), now_iso: NOW, context: memoryContext() });
    // As signed and stored: absent (undefined) members are not part of the payload.
    const bare = JSON.parse(JSON.stringify(placeholderFree.artifacts.find((a) => a.artifact_family === 'mandate_capability')!.payload)) as Record<string, unknown>;
    // Before G43 this was the placeholder 'provider:mandate_rail:capability:pending:redacted'.
    expect(bare['mandate_capability_status']).toBe('unverified');
    expect(bare).not.toHaveProperty('mandate_capability_ref');
    expect(bare).not.toHaveProperty('mandate_capability_evidence');
    expect(JSON.stringify(placeholderFree.artifacts)).not.toContain('capability:pending');

    const evidence = {
      schema_version: 'oacp.mandate_capability_evidence.v1',
      evidence_id: 'plural_pine_capability_01',
      tenant_id: authorityRequest().tenant_id,
      merchant_id: authorityRequest().merchant_id,
      provider: 'plural_pine',
      provider_environment: 'sandbox',
      result_status: 'available',
      external_validation_performed: true,
      rails: ['plural', 'upi_autopay'],
      caps: [{ rail: 'upi_autopay', max_amount: 1500000, currency: 'INR' }],
      token_types: ['network_token', 'upi_mandate'],
      verified_at: new Date(Date.parse(NOW) - 60_000).toISOString(),
      expires_at: new Date(Date.parse(NOW) + 6 * 3600_000).toISOString(),
      redacted_evidence_ref: 'provider:plural_pine:capability:0123456789abcdef01234567:redacted',
      evidence_hash: 'a'.repeat(64),
    };
    const context = memoryContext();
    const issued = await issueC6ZInternalOacpArtifacts({ request: authorityRequest(), evidence: connectorEvidence(), mandate_capability_evidence: evidence, now_iso: NOW, context });
    expect(issued.status).toBe('artifact_issuance_ready');
    const artifact = issued.artifacts.find((a) => a.artifact_family === 'mandate_capability')!;
    expect(artifact.payload).toMatchObject({
      mandate_capability_status: 'verified',
      mandate_capability_ref: evidence.redacted_evidence_ref,
      mandate_capability_evidence: {
        provider: 'plural_pine', rails: ['plural', 'upi_autopay'], caps: evidence.caps, token_types: evidence.token_types,
        verified_at: evidence.verified_at, evidence_hash: evidence.evidence_hash, evidence_object_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(artifact.verifier_status.valid).toBe(true);

    const unavailable = await issueC6ZInternalOacpArtifacts({
      request: authorityRequest(), evidence: connectorEvidence(), now_iso: NOW, context: memoryContext(),
      mandate_capability_evidence: { ...evidence, result_status: 'blocked_missing_credentials', external_validation_performed: false, rails: [], caps: [] },
    });
    expect(unavailable.artifacts.find((a) => a.artifact_family === 'mandate_capability')!.payload['mandate_capability_status']).toBe('unavailable');

    for (const bad of [
      { ...evidence, client_secret: 'x' },
      { ...evidence, redacted_evidence_ref: 'provider:mandate_rail:capability:pending:redacted' },
      { ...evidence, tenant_id: 'cten_OTHER' },
      { ...evidence, verified_at: new Date(Date.parse(NOW) - 7 * 3600_000).toISOString() },
      { ...evidence, rails: ['wire'] },
      { ...evidence, result_status: 'available', external_validation_performed: false },
    ]) {
      const refused = await issueC6ZInternalOacpArtifacts({ request: authorityRequest(), evidence: connectorEvidence(), mandate_capability_evidence: bad, now_iso: NOW, context: memoryContext() });
      expect(refused).toMatchObject({ status: 'rejected', refusal_code: 'mandate_capability_evidence_invalid', artifacts: [] });
    }
  });

  it('fails closed for stale evidence, missing scope, secrets, raw payloads, and execution targets', async () => {
    const context = memoryContext();
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

    expect(await issueC6ZInternalOacpArtifacts({
      context,
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

    expect(await issueC6ZInternalOacpArtifacts({
      context,
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
    // A refusal signs nothing and takes no status list entry.
    expect(context.allocated).toEqual([]);
  });

  // Issuance through the route, persistence, replay and revocation run against
  // real Postgres in commerce-oacp-artifacts-postgres.integration.test.ts.
  // These cases are refused before the database is touched.

  it('refuses an operator issuing for a tenant other than its own', async () => {
    seedCommerceContext('cten_OTHER');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: authHeader(),
      payload: { request: authorityRequest(), connector_evidence: connectorEvidence() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('tenant_not_allowed');
  });

  it('accepts the authority service token on the OACP routes only', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', 'agenticorg-c6z-fixture-service-key');
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_C6Z');

    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_C6Z',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('invalid_developer_key');

    const replayOtherTenant = await app.inject({
      method: 'GET',
      url: '/v1/commerce/oacp/artifacts?tenant_id=cten_OTHER',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
    });
    expect(replayOtherTenant.statusCode).toBe(403);
    expect(replayOtherTenant.json<{ error: { code: string } }>().error.code).toBe('tenant_not_allowed');

    const keys = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/issuer-keys/rotate',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
    });
    expect(keys.statusCode).toBe(401);
  });

  it('does not register the public OACP status list route unless OACP_STATUS_LIST_PUBLIC_ENABLED is true', async () => {
    const response = await app.inject({ method: 'GET', url: '/status/oacp/oacpl_01J0000000000000000000000Z' });
    // Not a route: the global auth hook answers before any handler.
    expect([401, 404]).toContain(response.statusCode);
    expect(response.headers['content-type']).not.toContain('statuslist+jwt');
  });

  it('rejects the authority service token when the tenant is not explicitly allowlisted', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', 'agenticorg-c6z-fixture-service-key');
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_OTHER');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: { authorization: 'Bearer agenticorg-c6z-fixture-service-key' },
      payload: {
        request: authorityRequest(),
        connector_evidence: connectorEvidence(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('service_tenant_not_allowed');
  });
});
