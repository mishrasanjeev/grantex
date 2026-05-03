/**
 * Commerce-specific test helpers. Layered on top of helpers.ts:
 * `seedCommerceContext` primes the auth lookup AND the tenant resolver
 * lookup (developer→tenant join) so commerce route tests can focus on the
 * route's own SQL.
 *
 * The resolver returns rows of shape `{ id, status }` from the join
 * `commerce_developer_tenants → commerce_tenants`. These helpers honour
 * that shape; tests that need the disabled or unmapped variants use the
 * dedicated helpers below.
 */
import { sqlMock, TEST_DEVELOPER } from './helpers.js';

export const TEST_COMMERCE_TENANT_ID = 'cten_TESTTENANT';

/**
 * Mapped, active tenant — the common case. Primes:
 *   1. authPlugin developer SELECT
 *   2. resolveTenantForDeveloper join → returns { id, status: 'active' }
 */
export function seedCommerceContext(tenantId: string = TEST_COMMERCE_TENANT_ID): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([{ id: tenantId, status: 'active' }]);
}

/**
 * No developer→tenant mapping exists. Resolver returns
 * `{ kind: 'not_provisioned' }`; the route preHandler then either
 * 422s (default) or auto-provisions (if COMMERCE_ALLOW_AUTO_TENANT=true).
 */
export function seedCommerceContextNoMapping(): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([]);
}

/**
 * Mapping exists but the tenant is disabled. Resolver returns
 * `{ kind: 'disabled' }`; the route preHandler must 403 and must NOT
 * auto-provision a replacement.
 */
export function seedCommerceContextDisabledTenant(
  tenantId: string = TEST_COMMERCE_TENANT_ID,
): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([{ id: tenantId, status: 'disabled' }]);
}
