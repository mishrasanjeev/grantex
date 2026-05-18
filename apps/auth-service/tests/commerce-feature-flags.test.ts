import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Commerce feature flag (COMMERCE_V1_ENABLED)', () => {
  it('returns 503 with commerce_disabled envelope when flag is unset', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', '');
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);  // auth only

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_does_not_matter',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string; message: string; retryable: boolean } }>();
    expect(body.error.code).toBe('commerce_disabled');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.message).toBe('string');
  });

  it('returns 503 with commerce_disabled when flag is literal "false"', async () => {
    vi.stubEnv('COMMERCE_V1_ENABLED', 'false');
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/merchants',
      headers: authHeader(),
      payload: { legal_name: 'X', display_name: 'X', category_preset: 'electronics_appliances' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('commerce_disabled');
  });

  it('passes the flag check when COMMERCE_V1_ENABLED=true', async () => {
    // vitest.config.ts sets it to 'true' by default; verify the gate lets
    // the request through to the next stage (tenant lookup / 404).
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
    sqlMock.mockResolvedValueOnce([{ tenant_id: 'cten_TESTTENANT' }]);
    sqlMock.mockResolvedValueOnce([]);  // merchant lookup empty -> 404

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/merchants/mch_NOPE',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });
});

describe('Commerce flags exposed on config', () => {
  it('config.commerceV1Enabled is true in test env', async () => {
    const { config } = await import('../src/config.js');
    expect(config.commerceV1Enabled).toBe(true);
    expect(config).toHaveProperty('commercePublicDiscoveryEnabled');
    expect(config.commercePublicDiscoveryEnabled).toBe(false);
    expect(config).toHaveProperty('commercePublicDiscoveryMerchantAllowlist');
    expect(config.commercePublicDiscoveryMerchantAllowlist).toEqual([]);
    expect(config).toHaveProperty('pluralSandboxEnabled');
    expect(config).toHaveProperty('pluralLiveEnabled');
    expect(config).toHaveProperty('commerceLiveModeEnabled');
    expect(config).toHaveProperty('commerceSandboxEnabled');
    // Auto-tenant flag MUST default off; turning it on is a sandbox-only opt-in.
    expect(config).toHaveProperty('commerceAllowAutoTenant');
    expect(config.commerceAllowAutoTenant).toBe(false);
  });
});
