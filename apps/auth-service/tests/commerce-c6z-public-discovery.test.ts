/**
 * Public discovery opt-in on C6Z issuance (G17 enabler): `public_discovery_state`
 * is `enabled` only for an opted-in request with OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED
 * on, an allow-listed tenant and a namespace / host attestation, which the
 * signed artifact binds; otherwise issuance is exactly as before.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideC6ZPublicDiscovery,
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZIssuanceContext,
  type C6ZPublicDiscoveryEligibility,
  type C6ZSellerAuthorityRequest,
} from '../src/lib/commerce/oacp-runtime-vertical.js';
import { verifyOacpArtifact } from '../src/lib/commerce/oacp-jws.js';
import { renderUcpBusinessProfile } from '../src/lib/commerce/ucp-profile.js';
import { c6zPublicDiscoveryEligibility } from '../src/lib/commerce/oacp-artifact-store.js';

const NOW = '2026-10-20T10:00:00.000Z';
const STATUS_BASE = 'https://issuer.example/status/oacp/oacpl_01J00000000000000000000PDS';
const ELIGIBLE: C6ZPublicDiscoveryEligibility = { issuance_enabled: true, tenant_allowlisted: true };

function context(publicDiscovery?: C6ZPublicDiscoveryEligibility): C6ZIssuanceContext {
  const kid = 'oacp-20261020-000000000000pds0';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  let next = 0;
  return {
    issuer: 'https://issuer.example',
    signer: { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } },
    newArtifactId: () => `oacp_art_01J0000000000000000000${String(next++).padStart(4, '0')}`,
    allocateStatus: async () => ({ uri: STATUS_BASE, idx: next }),
    ...(publicDiscovery ? { publicDiscovery } : {}),
  };
}

function request(overrides: Partial<C6ZSellerAuthorityRequest> = {}): C6ZSellerAuthorityRequest {
  return {
    request_id: 'agenticorg_c6z_req_pds',
    tenant_id: 'cten_PDS',
    merchant_id: 'mch_PDS',
    seller_agent_id: 'seller_PDS',
    merchant_display_name: 'Discovery Demo Store',
    commerce_categories: ['home_goods'],
    connector_choice: 'shopify',
    connector_mode: 'read_only',
    requested_authority_scope: ['merchant_profile', 'catalog_snapshot'],
    artifact_cache_scope: { tenant_id: 'cten_PDS', merchant_id: 'mch_PDS', seller_agent_id: 'seller_PDS' },
    source_freshness_policy: { max_age_seconds: 600 },
    source_evidence_ref: 'agenticorg:shopify:evidence:pds_001:redacted',
    source_observed_at: '2026-10-20T09:55:00.000Z',
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

const OPT_IN: Partial<C6ZSellerAuthorityRequest> = {
  public_discovery_requested: true,
  no_public_discovery_enablement: false,
  namespace_attestation_ref: 'agenticorg:namespace_attestation:mch_PDS:01',
  serving_host: 'shop.merchant.example',
};

function evidence(): C6ZConnectorEvidence {
  return {
    evidence_id: 'shopify_evidence_PDS',
    tenant_id: 'cten_PDS',
    merchant_id: 'mch_PDS',
    seller_agent_id: 'seller_PDS',
    source_system: 'shopify',
    source_evidence_ref: 'agenticorg:shopify:evidence:pds_001:redacted',
    source_observed_at: '2026-10-20T09:55:00.000Z',
    product_count: 2,
    variant_count: 3,
    currency: 'INR',
    catalog_sample_refs: ['agenticorg:catalog:item:pds_1:redacted'],
    price_snapshot_refs: ['agenticorg:price:item:pds_1:redacted'],
    inventory_snapshot_refs: ['agenticorg:inventory:item:pds_1:redacted'],
    no_payment_execution: true,
    no_public_discovery_enablement: true,
  };
}

async function issue(req: C6ZSellerAuthorityRequest, eligibility?: C6ZPublicDiscoveryEligibility) {
  const ctx = context(eligibility);
  const result = await issueC6ZInternalOacpArtifacts({ request: req, evidence: evidence(), now_iso: NOW, context: ctx });
  expect(result.status).toBe('artifact_issuance_ready');
  return { result, ctx };
}

function discoveryArtifact(result: Awaited<ReturnType<typeof issue>>['result']) {
  return result.artifacts.find((artifact) => artifact.artifact_family === 'public_discovery_state')!;
}

describe('C6Z public discovery opt-in', () => {
  it('enables and binds the attestation when opted in, flag on, tenant allow-listed and attested', async () => {
    const { result, ctx } = await issue(request(OPT_IN), ELIGIBLE);
    expect(result.no_public_discovery_enablement).toBe(false);
    expect(result.no_payment_execution).toBe(true);
    const artifact = discoveryArtifact(result);
    expect(artifact.payload).toMatchObject({
      public_discovery_state: 'enabled',
      public_discovery_publication_allowed: true,
      public_discovery_requested: true,
      namespace_attestation_ref: 'agenticorg:namespace_attestation:mch_PDS:01',
      serving_host: 'shop.merchant.example',
      no_public_discovery_enablement: false,
      no_payment_execution: true,
    });
    expect(artifact.payload['public_discovery_withheld_reason']).toBeUndefined();
    expect(artifact.payload['blocked_capabilities']).not.toContain('public_discovery_publication');
    expect(artifact.payload['unsupported_capabilities']).not.toContain('public_discovery_publication');
    expect(artifact.payload['blocked_capabilities']).toContain('checkout_payment_execution');
    // Signed: a changed host or attestation no longer verifies.
    const jwks = { keys: [ctx.signer.publicJwk] };
    const scope = { tenant_id: 'cten_PDS', merchant_id: 'mch_PDS', seller_agent_id: 'seller_PDS', buyer_agent_id: '' };
    expect(verifyOacpArtifact({ envelope: artifact.envelope, payload: artifact.payload, jwks, now_iso: NOW, status: 0, expected_scope: scope }).valid).toBe(true);
    expect(verifyOacpArtifact({
      envelope: artifact.envelope, payload: { ...artifact.payload, serving_host: 'evil.example' }, jwks, now_iso: NOW, status: 0, expected_scope: scope,
    }).valid).toBe(false);
    // Every other family keeps public discovery blocked.
    for (const other of result.artifacts.filter((a) => a.artifact_family !== 'public_discovery_state')) {
      expect(other.payload['blocked_capabilities']).toContain('public_discovery_publication');
      expect(other.payload['no_public_discovery_enablement']).toBe(true);
      expect(other.payload['serving_host']).toBeUndefined();
    }
  });

  it.each([
    ['flag off', OPT_IN, { issuance_enabled: false, tenant_allowlisted: true }, 'issuance_flag_off'],
    ['no eligibility context', OPT_IN, undefined, 'issuance_flag_off'],
    ['tenant not allow-listed', OPT_IN, { issuance_enabled: true, tenant_allowlisted: false }, 'tenant_not_allowlisted'],
    ['attestation ref missing', { ...OPT_IN, namespace_attestation_ref: undefined }, ELIGIBLE, 'namespace_attestation_missing'],
    ['serving host missing', { ...OPT_IN, serving_host: undefined }, ELIGIBLE, 'namespace_attestation_missing'],
  ] as const)('stays disabled as today when %s', async (_name, overrides, eligibility, reason) => {
    const { result } = await issue(request(overrides as Partial<C6ZSellerAuthorityRequest>), eligibility as C6ZPublicDiscoveryEligibility | undefined);
    expect(result.no_public_discovery_enablement).toBe(true);
    const artifact = discoveryArtifact(result);
    expect(artifact.payload).toMatchObject({
      public_discovery_state: 'disabled',
      public_discovery_publication_allowed: false,
      public_discovery_withheld_reason: reason,
      no_public_discovery_enablement: true,
    });
    expect(artifact.payload['serving_host']).toBeUndefined();
    expect(artifact.payload['namespace_attestation_ref']).toBeUndefined();
    expect(artifact.payload['blocked_capabilities']).toContain('public_discovery_publication');
  });

  it('issues exactly the pre-opt-in payload when the request does not opt in', async () => {
    const { result } = await issue(request(), ELIGIBLE);
    const payload = discoveryArtifact(result).payload;
    expect(payload).toMatchObject({ public_discovery_state: 'disabled', public_discovery_publication_allowed: false, no_public_discovery_enablement: true });
    for (const key of ['public_discovery_requested', 'public_discovery_withheld_reason', 'serving_host', 'namespace_attestation_ref']) {
      expect(payload[key]).toBeUndefined();
    }
    expect(result.no_public_discovery_enablement).toBe(true);
  });

  it('keeps no_payment_execution mandatory and refuses contradictory or malformed opt-ins', () => {
    const refused = (overrides: Record<string, unknown>) =>
      validateC6ZSellerAuthorityRequest(request(overrides as Partial<C6ZSellerAuthorityRequest>), NOW);
    expect(refused({ ...OPT_IN, no_payment_execution: false })).toMatchObject({ status: 'rejected', refusal_code: 'unsupported_or_enabling_authority_request' });
    expect(refused({ ...OPT_IN, no_public_discovery_enablement: true })).toMatchObject({ refusal_code: 'unsupported_or_enabling_authority_request' });
    expect(refused({ no_public_discovery_enablement: false })).toMatchObject({ refusal_code: 'unsupported_or_enabling_authority_request' });
    expect(refused({ ...OPT_IN, public_discovery_requested: 'yes' })).toMatchObject({ refusal_code: 'unsupported_or_enabling_authority_request' });
    expect(refused({ ...OPT_IN, serving_host: 'Shop.Merchant.Example:443' })).toMatchObject({ refusal_code: 'public_discovery_request_invalid' });
    expect(refused({ ...OPT_IN, namespace_attestation_ref: 'has space' })).toMatchObject({ refusal_code: 'public_discovery_request_invalid' });
    expect(refused(OPT_IN)).toMatchObject({ status: 'artifact_issuance_ready' });
  });

  it('decides eligibility in a fixed order', () => {
    expect(decideC6ZPublicDiscovery(request(OPT_IN), ELIGIBLE)).toEqual({
      enabled: true, withheld_reason: null,
      namespace_attestation_ref: 'agenticorg:namespace_attestation:mch_PDS:01', serving_host: 'shop.merchant.example',
    });
    expect(decideC6ZPublicDiscovery(request({ ...OPT_IN, serving_host: undefined }), { issuance_enabled: false, tenant_allowlisted: false }).withheld_reason)
      .toBe('issuance_flag_off');
  });

  it('feeds ucp-profile publication_allowed only for the attested host', async () => {
    const records = async (eligibility?: C6ZPublicDiscoveryEligibility) => (await issue(request(OPT_IN), eligibility)).result.artifacts
      .map((a) => ({ artifact_id: a.envelope.artifact_id, family: a.artifact_family, status: 'issued', expires_at: a.envelope.expires_at, payload: a.payload }));
    const render = async (endpoint: string, eligibility?: C6ZPublicDiscoveryEligibility) => renderUcpBusinessProfile({
      version: '2026-04-08', artifacts: await records(eligibility), served: ['dev.ucp.shopping.catalog.search'],
      rest_endpoint: endpoint, now_iso: NOW,
    });
    expect((await render('https://shop.merchant.example/ucp', ELIGIBLE)).publication_allowed).toBe(true);
    expect((await render('https://other.merchant.example/ucp', ELIGIBLE)).publication_allowed).toBe(false);
    expect((await render('https://shop.merchant.example/ucp')).publication_allowed).toBe(false);
  });

  describe('eligibility from configuration', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('needs OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED=true and the tenant on the service allowlist', () => {
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_A, cten_PDS');
      expect(c6zPublicDiscoveryEligibility('cten_PDS')).toEqual({ issuance_enabled: false, tenant_allowlisted: true });
      vi.stubEnv('OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED', 'true');
      expect(c6zPublicDiscoveryEligibility('cten_PDS')).toEqual({ issuance_enabled: true, tenant_allowlisted: true });
      expect(c6zPublicDiscoveryEligibility('cten_OTHER').tenant_allowlisted).toBe(false);
      vi.stubEnv('OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED', '1');
      expect(c6zPublicDiscoveryEligibility('cten_PDS').issuance_enabled).toBe(false);
    });
  });
});
