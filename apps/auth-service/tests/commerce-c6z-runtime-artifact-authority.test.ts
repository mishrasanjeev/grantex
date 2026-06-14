import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      'merchant_profile',
      'offer_price_snapshot',
      'policy_scope',
      'seller_agent_card',
    ]);
    for (const artifact of result.artifacts) {
      expect(artifact.envelope.issuer).toBe('grantex_internal_oacp_authority');
      expect(artifact.envelope.signature).toMatch(/^eyJhbGciOiJFUzI1NiJ9\.\.sig_/);
      expect(artifact.envelope.seller_agent_id).toBe('seller_C6Z');
      expect(artifact.payload).toMatchObject({
        source_system: 'shopify',
        allowed_to_execute: false,
        no_payment_execution: true,
        no_public_discovery_enablement: true,
        non_authoritative_for_transaction: true,
      });
      expect(artifact.verifier_status).toMatchObject({
        valid: true,
        status: 'valid',
      });
    }
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
      artifact_count: 8,
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
});
