// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * OACP service-tenant access without a database: the env bootstrap list, the
 * enrolment decision (tenant, revoked, merchant), the in-process cache and
 * its invalidation, body validation, the unverified merchant claim, and the
 * catalogue-upload source in the C6Z vertical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogUploadAllowed,
  decideServiceTenant,
  invalidateServiceTenantAccess,
  parseEnrolServiceTenantBody,
  serviceTenantAccess,
  unverifiedMerchantClaim,
  ServiceTenantEnrolmentError,
  SERVICE_TENANT_ACCESS_TTL_MS,
  type ServiceTenantAccess,
} from '../src/lib/commerce/oacp-service-tenants.js';
import { c6zPublicDiscoveryEligibility, c6zSourceEligibility } from '../src/lib/commerce/oacp-artifact-store.js';
import { validateC6ZSellerAuthorityRequest, type C6ZSellerAuthorityRequest } from '../src/lib/commerce/oacp-runtime-vertical.js';
import { sqlMock } from './helpers.js';

const TENANT = '7d4f8a6e-2b1c-4e9a-9f3d-1a2b3c4d5e6f';

function row(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT, status: 'active', merchant_ids: ['mch_A'], source_systems: ['shopify'], evidence_ref: null,
    enrolled_at: new Date('2026-10-29T00:00:00Z'), updated_at: new Date('2026-10-29T00:00:00Z'),
    revoked_at: null, revoked_reason: null, ...overrides,
  };
}

function access(overrides: Partial<ServiceTenantAccess> = {}): ServiceTenantAccess {
  return { tenant_id: TENANT, env_listed: false, enrolment: null, allowed: false, ...overrides };
}

describe('OACP service-tenant access', () => {
  beforeEach(() => invalidateServiceTenantAccess());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('answers an env-listed tenant from the environment without a query', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', ` cten_ENV , ${TENANT}`);
    const result = await serviceTenantAccess(sqlMock as never, 'cten_ENV');
    expect(result).toMatchObject({ env_listed: true, allowed: true });
    expect(decideServiceTenant(result, 'any_merchant')).toBe('allowed');
    expect(decideServiceTenant(result, null)).toBe('allowed');
    expect((await serviceTenantAccess(sqlMock as never, TENANT)).env_listed).toBe(true);
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it('never queries for a tenant id that is not a UUID', async () => {
    const result = await serviceTenantAccess(sqlMock as never, 'cten_UNKNOWN');
    expect(result).toMatchObject({ env_listed: false, enrolment: null, allowed: false });
    expect(decideServiceTenant(result)).toBe('tenant_not_allowed');
    expect((await serviceTenantAccess(sqlMock as never, undefined)).allowed).toBe(false);
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it('caches an enrolment lookup for the TTL and drops it on invalidation', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T10:00:00Z') });
    sqlMock.unsafe.mockResolvedValue([row()]);
    const first = await serviceTenantAccess(sqlMock as never, TENANT);
    expect(first.allowed).toBe(true);
    await serviceTenantAccess(sqlMock as never, TENANT.toUpperCase());
    expect(sqlMock.unsafe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SERVICE_TENANT_ACCESS_TTL_MS + 1);
    sqlMock.unsafe.mockResolvedValue([row({ status: 'revoked', revoked_at: new Date() })]);
    expect((await serviceTenantAccess(sqlMock as never, TENANT)).allowed).toBe(false);
    expect(sqlMock.unsafe).toHaveBeenCalledTimes(2);
    sqlMock.unsafe.mockResolvedValue([]);
    invalidateServiceTenantAccess(TENANT);
    expect((await serviceTenantAccess(sqlMock as never, TENANT)).enrolment).toBeNull();
    expect(sqlMock.unsafe).toHaveBeenCalledTimes(3);
    sqlMock.unsafe.mockReset();
  });

  it('decides tenant, revocation and merchant for an enrolled tenant', () => {
    const active = { tenant_id: TENANT, status: 'active' as const, merchant_ids: ['mch_A'], source_systems: ['shopify' as const],
      evidence_ref: null, enrolled_at: '', updated_at: '', revoked_at: null, revoked_reason: null };
    const enrolled = access({ enrolment: active, allowed: true });
    expect(decideServiceTenant(enrolled)).toBe('allowed');
    expect(decideServiceTenant(enrolled, 'mch_A')).toBe('allowed');
    expect(decideServiceTenant(enrolled, 'mch_B')).toBe('merchant_not_enrolled');
    expect(decideServiceTenant(enrolled, null)).toBe('merchant_not_enrolled');
    const revoked = access({ enrolment: { ...active, status: 'revoked', revoked_at: 'x' } });
    expect(decideServiceTenant(revoked, 'mch_A')).toBe('tenant_revoked');
    expect(decideServiceTenant(access(), 'mch_A')).toBe('tenant_not_allowed');
    expect(catalogUploadAllowed(enrolled)).toBe(false);
    expect(catalogUploadAllowed(access({ enrolment: { ...active, source_systems: ['catalog_upload'] }, allowed: true }))).toBe(true);
    expect(catalogUploadAllowed(access({ enrolment: { ...active, status: 'revoked', source_systems: ['catalog_upload'] } }))).toBe(false);
    expect(catalogUploadAllowed(access({ env_listed: true, allowed: true }))).toBe(true);
    expect(catalogUploadAllowed(undefined)).toBe(false);
  });

  it('derives source and public-discovery eligibility from the enrolment', () => {
    const enrolment = { tenant_id: TENANT, status: 'active' as const, merchant_ids: ['mch_A'], source_systems: ['catalog_upload' as const],
      evidence_ref: null, enrolled_at: '', updated_at: '', revoked_at: null, revoked_reason: null };
    const enrolled = access({ enrolment, allowed: true });
    expect(c6zSourceEligibility(TENANT, enrolled)).toEqual({ synthetic_demo_allowed: false, catalog_upload_allowed: true });
    // An enrolment never grants the synthetic demo source.
    vi.stubEnv('COMMERCE_C6Z_DEMO_SOURCE_TENANTS', TENANT);
    expect(c6zSourceEligibility(TENANT, enrolled).synthetic_demo_allowed).toBe(false);
    // Access resolved for another tenant is ignored.
    expect(c6zSourceEligibility('cten_OTHER', enrolled).catalog_upload_allowed).toBe(false);
    expect(c6zPublicDiscoveryEligibility(TENANT, enrolled).tenant_allowlisted).toBe(true);
    expect(c6zPublicDiscoveryEligibility(TENANT, access({ enrolment: { ...enrolment, status: 'revoked' } })).tenant_allowlisted).toBe(false);
    expect(c6zPublicDiscoveryEligibility(TENANT).tenant_allowlisted).toBe(false);
  });

  it('validates enrolment bodies', () => {
    expect(parseEnrolServiceTenantBody({ tenant_id: TENANT.toUpperCase(), merchant_id: 'mch_A', source_system: 'catalog_upload' }))
      .toEqual({ tenant_id: TENANT, merchant_id: 'mch_A', source_system: 'catalog_upload', evidence_ref: null });
    const bad: unknown[] = [
      null, [], 'x',
      { tenant_id: 'not-a-uuid', merchant_id: 'mch_A', source_system: 'shopify' },
      { tenant_id: TENANT, merchant_id: '', source_system: 'shopify' },
      { tenant_id: TENANT, merchant_id: 'a'.repeat(129), source_system: 'shopify' },
      { tenant_id: TENANT, merchant_id: 'mch_A', source_system: 'synthetic_demo' },
      { tenant_id: TENANT, merchant_id: 'mch_A', source_system: 'shopify', evidence_ref: 7 },
      { tenant_id: TENANT, merchant_id: 'mch_A', source_system: 'shopify', other: 1 },
    ];
    for (const body of bad) {
      expect(() => parseEnrolServiceTenantBody(body)).toThrow(ServiceTenantEnrolmentError);
    }
  });

  it('reads the merchant claim of a compact JWT without trusting it', () => {
    const jwt = (claims: unknown) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    expect(unverifiedMerchantClaim(jwt({ merchant_id: 'mch_A' }))).toBe('mch_A');
    expect(unverifiedMerchantClaim(jwt({ merchant_id: 7 }))).toBeNull();
    expect(unverifiedMerchantClaim('not-a-jwt')).toBeNull();
    expect(unverifiedMerchantClaim('a.%%%.c')).toBeNull();
    expect(unverifiedMerchantClaim(undefined)).toBeNull();
  });
});

describe('C6Z catalogue upload source', () => {
  const now = new Date().toISOString();
  const request = (overrides: Partial<C6ZSellerAuthorityRequest> = {}): C6ZSellerAuthorityRequest => ({
    tenant_id: TENANT, merchant_id: 'mch_A', seller_agent_id: 'seller_A', merchant_display_name: 'Store',
    commerce_categories: ['home_goods'], connector_choice: 'catalog_upload', connector_mode: 'read_only',
    requested_authority_scope: ['catalog_snapshot'],
    artifact_cache_scope: { tenant_id: TENANT, merchant_id: 'mch_A', seller_agent_id: 'seller_A' },
    source_freshness_policy: { max_age_seconds: 600 }, source_evidence_ref: 'agenticorg:upload:1:redacted',
    source_observed_at: new Date(Date.now() - 60_000).toISOString(), no_payment_execution: true,
    no_public_discovery_enablement: true, ...overrides,
  });

  it('is refused without eligibility and accepted with it, never as synthetic data', () => {
    expect(validateC6ZSellerAuthorityRequest(request(), now).refusal_code).toBe('unsupported_or_enabling_authority_request');
    expect(validateC6ZSellerAuthorityRequest(request(), now, { synthetic_demo_allowed: true }).refusal_code)
      .toBe('unsupported_or_enabling_authority_request');
    expect(validateC6ZSellerAuthorityRequest(request(), now, { synthetic_demo_allowed: false, catalog_upload_allowed: true }).status)
      .toBe('artifact_issuance_ready');
    expect(validateC6ZSellerAuthorityRequest(request({ synthetic_data: true }), now,
      { synthetic_demo_allowed: true, catalog_upload_allowed: true }).refusal_code).toBe('unsupported_or_enabling_authority_request');
  });
});
