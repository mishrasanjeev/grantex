import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeader,
  sqlMock,
  TEST_DEVELOPER,
  buildTestApp,
} from './helpers.js';
import {
  seedCommerceContext,
  seedCommerceContextNoMapping,
  seedCommerceContextDisabledTenant,
  TEST_COMMERCE_TENANT_ID,
} from './commerce-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Tenant resolution — mapped developer (active tenant)', () => {
  it('resolves the mapped tenant and proceeds to the route handler', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      id: 'mch_OK',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      legal_name: 'Acme',
      display_name: 'Acme',
      category_preset: 'electronics_appliances',
      verification_status: 'unverified',
      environment: 'sandbox',
      agentic_commerce_enabled: false,
      default_currency: 'INR',
      country_code: 'IN',
      support_email: null,
      disabled_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_OK',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { tenant_id: string } }>().data.tenant_id)
      .toBe(TEST_COMMERCE_TENANT_ID);
  });
});

describe('Tenant resolution — unmapped developer', () => {
  it('returns 422 tenant_not_provisioned with remediation when auto-tenant is OFF (default)', async () => {
    // Default vitest env does not set COMMERCE_ALLOW_AUTO_TENANT, so the
    // staging/production posture (explicit provisioning required) is in
    // effect. No need to stub anything off.
    seedCommerceContextNoMapping();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_DOES_NOT_MATTER',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{
      error: { code: string; message: string; remediation: string; retryable: boolean }
    }>();
    expect(body.error.code).toBe('tenant_not_provisioned');
    expect(body.error.retryable).toBe(false);
    expect(body.error.remediation).toMatch(/POST \/v1\/commerce\/tenants/);
    expect(body.error.remediation).toMatch(/POST \/v1\/commerce\/developer-tenants/);
  });

  it('does NOT touch the database beyond the resolver lookup when 422-ing', async () => {
    seedCommerceContextNoMapping();
    sqlMock.mockClear();
    seedCommerceContextNoMapping();

    await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: authHeader(),
    });

    // Two SQL calls expected: authPlugin developer SELECT + resolver join.
    // Crucially, NO INSERT into commerce_tenants or commerce_developer_tenants.
    expect(sqlMock).toHaveBeenCalledTimes(2);
    const insertedAnyTenant = sqlMock.mock.calls.some((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string'
        && /INSERT INTO commerce_(tenants|developer_tenants)/i.test(s));
    });
    expect(insertedAnyTenant).toBe(false);
  });
});

describe('Tenant resolution — auto-provision (test/sandbox only)', () => {
  it('auto-provisions a tenant when COMMERCE_ALLOW_AUTO_TENANT=true', async () => {
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);  // authPlugin
    sqlMock.mockResolvedValueOnce([]);                // resolver: no mapping
    sqlMock.mockResolvedValueOnce([]);                // resolver re-check inside auto-provision: still none
    sqlMock.mockResolvedValueOnce([]);                // INSERT commerce_tenants (begin)
    sqlMock.mockResolvedValueOnce([]);                // INSERT commerce_developer_tenants
    sqlMock.mockResolvedValueOnce([]);                // route SQL: merchant lookup (returns empty -> 404)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: authHeader(),
    });
    // The auto-provision path completes; the route then 404s because no
    // merchant exists. Importantly NOT 422.
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');

    // Confirm the tenant INSERTs actually fired.
    const insertedTenants = sqlMock.mock.calls.some((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string'
        && /INSERT INTO commerce_tenants/i.test(s));
    });
    const insertedMapping = sqlMock.mock.calls.some((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string'
        && /INSERT INTO commerce_developer_tenants/i.test(s));
    });
    expect(insertedTenants).toBe(true);
    expect(insertedMapping).toBe(true);
  });

  it('refuses to auto-provision when flag is unset (defense in depth at the lib layer)', async () => {
    const { resolveOrCreateTenantForDeveloper } = await import('../src/lib/commerce/tenant.js');
    // Flag not stubbed — should be undefined/empty.
    await expect(
      resolveOrCreateTenantForDeveloper(sqlMock as unknown as never, 'dev_X', 'X'),
    ).rejects.toThrow(/auto-provisioning is disabled/i);
  });
});

describe('Tenant resolution — production guard (NODE_ENV=production)', () => {
  it('route returns 422 tenant_not_provisioned even with COMMERCE_ALLOW_AUTO_TENANT=true in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    seedCommerceContextNoMapping();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_not_provisioned');

    // No INSERT to commerce_tenants happened.
    const insertedAnyTenant = sqlMock.mock.calls.some((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string'
        && /INSERT INTO commerce_tenants/i.test(s));
    });
    expect(insertedAnyTenant).toBe(false);
  });

  it('isAutoTenantAllowed() returns false in production regardless of the flag', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    const { isAutoTenantAllowed } = await import('../src/lib/commerce/tenant.js');
    expect(isAutoTenantAllowed()).toBe(false);
  });

  it('lib resolveOrCreateTenantForDeveloper throws in production even with flag set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    const { resolveOrCreateTenantForDeveloper } = await import('../src/lib/commerce/tenant.js');
    await expect(
      resolveOrCreateTenantForDeveloper(sqlMock as unknown as never, 'dev_X', 'X'),
    ).rejects.toThrow(/auto-provisioning is disabled/i);
  });
});

describe('Tenant resolution — disabled tenant', () => {
  it('returns 403 tenant_disabled (does NOT 422 and does NOT auto-create a replacement)', async () => {
    seedCommerceContextDisabledTenant();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; remediation: string } }>();
    expect(body.error.code).toBe('tenant_disabled');
    expect(body.error.remediation).toMatch(/Contact Grantex support/);
  });

  it('does NOT auto-create a replacement even when COMMERCE_ALLOW_AUTO_TENANT=true', async () => {
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    seedCommerceContextDisabledTenant();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_X',
      headers: authHeader(),
    });

    // Disabled mapping is preserved; auto-create is bypassed by design.
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');

    // Confirm no commerce_tenants INSERT happened.
    const insertedAnyTenant = sqlMock.mock.calls.some((c) => {
      const tpl = c[0] as unknown;
      if (!Array.isArray(tpl)) return false;
      return tpl.some((s) => typeof s === 'string'
        && /INSERT INTO commerce_tenants/i.test(s));
    });
    expect(insertedAnyTenant).toBe(false);
  });

  it('library function refuses to provision when caller is mapped to a disabled tenant', async () => {
    vi.stubEnv('COMMERCE_ALLOW_AUTO_TENANT', 'true');
    sqlMock.mockResolvedValueOnce([{ id: 'cten_DIS', status: 'disabled' }]);

    const { resolveOrCreateTenantForDeveloper } = await import('../src/lib/commerce/tenant.js');
    await expect(
      resolveOrCreateTenantForDeveloper(sqlMock as unknown as never, 'dev_X', 'X'),
    ).rejects.toThrow(/disabled tenant/i);
  });
});
