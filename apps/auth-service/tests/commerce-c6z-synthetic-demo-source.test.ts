// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The synthetic demo source on C6Z issuance: `connector_choice:
 * 'synthetic_demo'` is accepted only for a tenant on both
 * COMMERCE_C6Z_DEMO_SOURCE_TENANTS and COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS,
 * for a request that says `synthetic_data: true`; every artifact then names
 * its real source and says the data is synthetic. Shopify issuance is
 * byte-identical to before. Route-level issuance and refusal recording run
 * against Postgres in commerce-oacp-artifacts-postgres.integration.test.ts.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZIssuanceContext,
  type C6ZPublicDiscoveryEligibility,
  type C6ZSellerAuthorityRequest,
  type C6ZSourceEligibility,
} from '../src/lib/commerce/oacp-runtime-vertical.js';
import { verifyOacpArtifact } from '../src/lib/commerce/oacp-jws.js';
import { renderUcpBusinessProfile } from '../src/lib/commerce/ucp-profile.js';
import { c6zSourceEligibility } from '../src/lib/commerce/oacp-artifact-store.js';

const NOW = '2026-10-21T10:00:00.000Z';
const OBSERVED = '2026-10-21T09:55:00.000Z';
const STATUS_BASE = 'https://issuer.example/status/oacp/oacpl_01J00000000000000000000DMO';
const KID = 'oacp-20261021-00000000000000d0';
const DEMO_ALLOWED: C6ZSourceEligibility = { synthetic_demo_allowed: true };
const DISCOVERY_ELIGIBLE: C6ZPublicDiscoveryEligibility = { issuance_enabled: true, tenant_allowlisted: true };
const SCOPE = { tenant_id: 'cten_DEMO', merchant_id: 'mch_DEMO', seller_agent_id: 'seller_DEMO', buyer_agent_id: '' };

/**
 * SHA-256 of JSON.stringify of the eleven Shopify payloads, in family order,
 * as issued by the code before the synthetic source existed (same fixture,
 * kid, status list and artifact ids): without and with an enabled public
 * discovery opt-in.
 */
const SHOPIFY_PAYLOADS_SHA256 = {
  plain: 'a17e51e8c22d01ea03d3a481f16042c2c0ef42c61e902f314038def65d321618',
  public_discovery_enabled: 'bdf3e3ed307bc3fbc8fd5328e1ab416bca2c9b040dbda88f391beaa63118e7dc',
};

function context(options: {
  publicDiscovery?: C6ZPublicDiscoveryEligibility | undefined;
  sourceEligibility?: C6ZSourceEligibility | undefined;
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const allocated: string[] = [];
  let next = 0;
  const ctx: C6ZIssuanceContext = {
    issuer: 'https://issuer.example',
    signer: { kid: KID, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: KID, alg: 'ES256', use: 'sig' } },
    newArtifactId: () => `oacp_art_01J0000000000000000000${String(next++).padStart(4, '0')}`,
    allocateStatus: async (artifactId) => {
      allocated.push(artifactId);
      return { uri: STATUS_BASE, idx: next };
    },
    ...(options.publicDiscovery ? { publicDiscovery: options.publicDiscovery } : {}),
    ...(options.sourceEligibility ? { sourceEligibility: options.sourceEligibility } : {}),
  };
  return { ctx, allocated };
}

const OPT_IN: Partial<C6ZSellerAuthorityRequest> = {
  public_discovery_requested: true,
  no_public_discovery_enablement: false,
  namespace_attestation_ref: 'agenticorg:namespace_attestation:mch_DEMO:01',
  serving_host: 'shop.merchant.example',
};

function shopifyRequest(overrides: Partial<C6ZSellerAuthorityRequest> = {}): C6ZSellerAuthorityRequest {
  return {
    request_id: 'agenticorg_c6z_req_demo',
    tenant_id: 'cten_DEMO',
    merchant_id: 'mch_DEMO',
    seller_agent_id: 'seller_DEMO',
    merchant_display_name: 'Golden Store',
    commerce_categories: ['home_goods'],
    connector_choice: 'shopify',
    connector_mode: 'read_only',
    requested_authority_scope: ['merchant_profile', 'catalog_snapshot'],
    artifact_cache_scope: { tenant_id: 'cten_DEMO', merchant_id: 'mch_DEMO', seller_agent_id: 'seller_DEMO' },
    source_freshness_policy: { max_age_seconds: 600 },
    source_evidence_ref: 'agenticorg:shopify:evidence:demo_001:redacted',
    source_observed_at: OBSERVED,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

function shopifyEvidence(overrides: Partial<C6ZConnectorEvidence> = {}): C6ZConnectorEvidence {
  return {
    evidence_id: 'shopify_evidence_DEMO',
    tenant_id: 'cten_DEMO',
    merchant_id: 'mch_DEMO',
    seller_agent_id: 'seller_DEMO',
    source_system: 'shopify',
    source_evidence_ref: 'agenticorg:shopify:evidence:demo_001:redacted',
    source_observed_at: OBSERVED,
    product_count: 2,
    variant_count: 3,
    currency: 'INR',
    catalog_sample_refs: ['agenticorg:catalog:item:demo_1:redacted'],
    price_snapshot_refs: ['agenticorg:price:item:demo_1:redacted'],
    inventory_snapshot_refs: ['agenticorg:inventory:item:demo_1:redacted'],
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

function demoRequest(overrides: Partial<C6ZSellerAuthorityRequest> = {}): C6ZSellerAuthorityRequest {
  return shopifyRequest({
    merchant_display_name: 'Synthetic Tea Shop (demo)',
    connector_choice: 'synthetic_demo',
    synthetic_data: true,
    source_evidence_ref: 'agenticorg:synthetic_demo:evidence:demo_001:redacted',
    ...overrides,
  });
}

function demoEvidence(overrides: Partial<C6ZConnectorEvidence> = {}): C6ZConnectorEvidence {
  return shopifyEvidence({
    evidence_id: 'synthetic_demo_evidence_DEMO',
    source_system: 'synthetic_demo',
    synthetic_data: true,
    source_evidence_ref: 'agenticorg:synthetic_demo:evidence:demo_001:redacted',
    ...overrides,
  });
}

function payloadsSha256(payloads: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
}

const UNSUPPORTED = {
  status: 'rejected',
  refusal_code: 'unsupported_or_enabling_authority_request',
  artifacts: [],
  allowed_to_execute: false,
  no_payment_execution: true,
  no_public_discovery_enablement: true,
};

describe('C6Z synthetic demo source', () => {
  it('keeps every Shopify payload byte-identical, with or without demo-source eligibility', async () => {
    for (const sourceEligibility of [undefined, DEMO_ALLOWED, { synthetic_demo_allowed: false }]) {
      const plain = await issueC6ZInternalOacpArtifacts({
        request: shopifyRequest(), evidence: shopifyEvidence(), now_iso: NOW, context: context({ sourceEligibility }).ctx,
      });
      expect(plain.status).toBe('artifact_issuance_ready');
      expect(payloadsSha256(plain.artifacts.map((a) => a.payload))).toBe(SHOPIFY_PAYLOADS_SHA256.plain);

      const discovery = await issueC6ZInternalOacpArtifacts({
        request: shopifyRequest(OPT_IN), evidence: shopifyEvidence(), now_iso: NOW,
        context: context({ publicDiscovery: DISCOVERY_ELIGIBLE, sourceEligibility }).ctx,
      });
      expect(discovery.status).toBe('artifact_issuance_ready');
      expect(payloadsSha256(discovery.artifacts.map((a) => a.payload))).toBe(SHOPIFY_PAYLOADS_SHA256.public_discovery_enabled);
      for (const artifact of [...plain.artifacts, ...discovery.artifacts]) {
        expect(artifact.payload).not.toHaveProperty('synthetic_data');
        expect(artifact.payload['source_lineage']).toMatchObject({ source_system: 'shopify', merchant_system_source_of_record: true });
      }
    }
  });

  it('issues eleven signed artifacts that name the synthetic source and never claim a merchant system of record', async () => {
    const { ctx, allocated } = context({ sourceEligibility: DEMO_ALLOWED });
    const result = await issueC6ZInternalOacpArtifacts({ request: demoRequest(), evidence: demoEvidence(), now_iso: NOW, context: ctx });
    expect(result.status).toBe('artifact_issuance_ready');
    expect(result.artifacts).toHaveLength(11);
    expect(allocated).toHaveLength(11);
    const jwks = { keys: [ctx.signer.publicJwk] };
    for (const artifact of result.artifacts) {
      expect(artifact.verifier_status.valid).toBe(true);
      expect(artifact.payload).toMatchObject({
        source_system: 'synthetic_demo',
        synthetic_data: true,
        allowed_to_execute: false,
        no_payment_execution: true,
        non_authoritative_for_transaction: true,
      });
      expect(artifact.payload['source_lineage']).toEqual({
        source_system: 'synthetic_demo',
        synthetic_data: true,
        connector_mode: 'read_only',
        connector_evidence_id: 'synthetic_demo_evidence_DEMO',
        source_evidence_ref: 'agenticorg:synthetic_demo:evidence:demo_001:redacted',
        source_observed_at: OBSERVED,
        merchant_system_source_of_record: false,
        raw_provider_payload_stored_by_grantex: false,
      });
      // Nothing in the signed artifact names a system the data did not come from.
      expect(JSON.stringify({ envelope: artifact.envelope, payload: artifact.payload }).toLowerCase()).not.toContain('shopify');
      // The synthetic marker is signed: stripping it breaks verification.
      const { synthetic_data: _dropped, ...stripped } = artifact.payload;
      expect(verifyOacpArtifact({ envelope: artifact.envelope, payload: stripped, jwks, now_iso: NOW, status: 0, expected_scope: SCOPE }).valid).toBe(false);
    }
  });

  it('refuses the synthetic source exactly as before unless the request says synthetic_data and the tenant is eligible', async () => {
    const cases: Array<{ request: C6ZSellerAuthorityRequest; eligibility?: C6ZSourceEligibility }> = [
      { request: demoRequest() },
      { request: demoRequest(), eligibility: { synthetic_demo_allowed: false } },
      { request: demoRequest({ synthetic_data: undefined }), eligibility: DEMO_ALLOWED },
      { request: demoRequest({ synthetic_data: false }), eligibility: DEMO_ALLOWED },
      { request: demoRequest({ synthetic_data: 'true' as unknown as boolean }), eligibility: DEMO_ALLOWED },
      { request: demoRequest({ connector_choice: 'woocommerce' as never }), eligibility: DEMO_ALLOWED },
    ];
    for (const { request, eligibility } of cases) {
      const before = validateC6ZSellerAuthorityRequest(shopifyRequest({ connector_choice: 'other' as never }), NOW);
      const validated = validateC6ZSellerAuthorityRequest(request, NOW, eligibility);
      expect(validated).toMatchObject(UNSUPPORTED);
      // Same code and message as an unknown source always got.
      expect(validated.message).toBe(before.message);
      const { ctx, allocated } = context(eligibility ? { sourceEligibility: eligibility } : {});
      expect(await issueC6ZInternalOacpArtifacts({ request, evidence: demoEvidence(), now_iso: NOW, context: ctx })).toMatchObject(UNSUPPORTED);
      expect(allocated).toEqual([]);
    }
  });

  it('refuses evidence whose source does not match the request or is not marked synthetic', async () => {
    const mismatches: Array<{ request: C6ZSellerAuthorityRequest; evidence: C6ZConnectorEvidence }> = [
      { request: demoRequest(), evidence: shopifyEvidence() },
      { request: demoRequest(), evidence: demoEvidence({ synthetic_data: undefined }) },
      { request: demoRequest(), evidence: demoEvidence({ synthetic_data: false }) },
      { request: shopifyRequest(), evidence: demoEvidence() },
    ];
    for (const { request, evidence } of mismatches) {
      const { ctx, allocated } = context({ sourceEligibility: DEMO_ALLOWED });
      expect(await issueC6ZInternalOacpArtifacts({ request, evidence, now_iso: NOW, context: ctx })).toMatchObject({
        status: 'rejected',
        refusal_code: 'connector_evidence_scope_mismatch',
        artifacts: [],
      });
      expect(allocated).toEqual([]);
    }
  });

  it('enables public discovery under the existing opt-in rules and marks the discovery artifact and UCP render synthetic', async () => {
    const { ctx } = context({ publicDiscovery: DISCOVERY_ELIGIBLE, sourceEligibility: DEMO_ALLOWED });
    const result = await issueC6ZInternalOacpArtifacts({ request: demoRequest(OPT_IN), evidence: demoEvidence(), now_iso: NOW, context: ctx });
    expect(result.status).toBe('artifact_issuance_ready');
    expect(result.no_public_discovery_enablement).toBe(false);
    const discovery = result.artifacts.find((a) => a.artifact_family === 'public_discovery_state')!;
    expect(discovery.payload).toMatchObject({
      public_discovery_state: 'enabled',
      public_discovery_publication_allowed: true,
      serving_host: 'shop.merchant.example',
      synthetic_data: true,
      source_system: 'synthetic_demo',
    });

    // Without the issuance flag, the synthetic tenant gets disabled discovery like any other.
    const withheld = await issueC6ZInternalOacpArtifacts({
      request: demoRequest(OPT_IN), evidence: demoEvidence(), now_iso: NOW,
      context: context({ publicDiscovery: { issuance_enabled: false, tenant_allowlisted: true }, sourceEligibility: DEMO_ALLOWED }).ctx,
    });
    expect(withheld.artifacts.find((a) => a.artifact_family === 'public_discovery_state')!.payload).toMatchObject({
      public_discovery_state: 'disabled',
      public_discovery_withheld_reason: 'issuance_flag_off',
      synthetic_data: true,
    });

    const records = (artifacts: typeof result.artifacts) => artifacts.map((a) => ({
      artifact_id: a.envelope.artifact_id, family: a.artifact_family, status: 'issued', expires_at: a.envelope.expires_at, payload: a.payload,
    }));
    const render = (artifacts: typeof result.artifacts) => renderUcpBusinessProfile({
      version: '2026-04-08', artifacts: records(artifacts), served: ['dev.ucp.shopping.catalog.search'],
      rest_endpoint: 'https://shop.merchant.example/ucp', now_iso: NOW,
    });
    const synthetic = render(result.artifacts);
    expect(synthetic.publication_allowed).toBe(true);
    expect(synthetic.synthetic_data).toBe(true);

    const shopify = await issueC6ZInternalOacpArtifacts({
      request: shopifyRequest(OPT_IN), evidence: shopifyEvidence(), now_iso: NOW, context: context({ publicDiscovery: DISCOVERY_ELIGIBLE }).ctx,
    });
    const real = render(shopify.artifacts);
    expect(real.publication_allowed).toBe(true);
    expect(real).not.toHaveProperty('synthetic_data');
  });

  describe('eligibility from configuration', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('needs the tenant on COMMERCE_C6Z_DEMO_SOURCE_TENANTS and on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', () => {
      expect(c6zSourceEligibility('cten_DEMO')).toEqual({ synthetic_demo_allowed: false });
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_A, cten_DEMO');
      expect(c6zSourceEligibility('cten_DEMO').synthetic_demo_allowed).toBe(false);
      vi.stubEnv('COMMERCE_C6Z_DEMO_SOURCE_TENANTS', '');
      expect(c6zSourceEligibility('cten_DEMO').synthetic_demo_allowed).toBe(false);
      vi.stubEnv('COMMERCE_C6Z_DEMO_SOURCE_TENANTS', ' cten_DEMO ,cten_B');
      expect(c6zSourceEligibility('cten_DEMO')).toEqual({ synthetic_demo_allowed: true });
      expect(c6zSourceEligibility('cten_A').synthetic_demo_allowed).toBe(false);
      expect(c6zSourceEligibility('cten_B').synthetic_demo_allowed).toBe(false);
      expect(c6zSourceEligibility(undefined).synthetic_demo_allowed).toBe(false);
      expect(c6zSourceEligibility('').synthetic_demo_allowed).toBe(false);
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_A');
      expect(c6zSourceEligibility('cten_DEMO').synthetic_demo_allowed).toBe(false);
    });
  });
});
