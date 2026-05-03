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
 * Mapped, active tenant — operator caller (developer API key). Primes:
 *   1. caller.ts loadDeveloperByApiKey → developer row
 *   2. caller.ts loadOperatorContext JOIN → { tenant_id, status, role }
 *
 * Token shape detection in caller.ts: anything that is not merchant key
 * prefix / agent key prefix / 3-segment JWT falls through to the
 * operator path. The TEST_API_KEY ('test-api-key-1234') matches that.
 */
export function seedCommerceContext(tenantId: string = TEST_COMMERCE_TENANT_ID): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([{ tenant_id: tenantId, status: 'active', role: 'owner' }]);
}

/**
 * No developer→tenant mapping exists. JOIN returns []; the route
 * preHandler either 422s (default) or auto-provisions (if
 * COMMERCE_ALLOW_AUTO_TENANT=true).
 */
export function seedCommerceContextNoMapping(): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([]);
}

/**
 * Mapping exists but the tenant is disabled. JOIN returns
 * status='disabled'; the route preHandler must 403 and must NOT
 * auto-provision a replacement.
 */
export function seedCommerceContextDisabledTenant(
  tenantId: string = TEST_COMMERCE_TENANT_ID,
): void {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
  sqlMock.mockResolvedValueOnce([{ tenant_id: tenantId, status: 'disabled', role: 'owner' }]);
}
