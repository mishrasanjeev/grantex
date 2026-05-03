import type postgres from 'postgres';
import { type TxSql } from '../../db/client.js';
import { newCommerceTenantId } from './ids.js';

type Sql = ReturnType<typeof postgres>;

/**
 * Three-state resolution of a developer's default commerce tenant.
 * Distinguishing "no mapping" from "mapping exists but tenant is disabled"
 * matters because the policy on each is different:
 *   - `not_provisioned`  → 422 tenant_not_provisioned; auto-create only in
 *                          explicitly-enabled test/local sandbox.
 *   - `disabled`         → 403 tenant_disabled; never auto-create a
 *                          replacement (would let a disabled tenant be
 *                          silently bypassed).
 *   - `resolved`         → request proceeds with the returned tenantId.
 */
export type TenantResolution =
  | { kind: 'resolved'; tenantId: string }
  | { kind: 'not_provisioned' }
  | { kind: 'disabled'; tenantId: string };

/**
 * Pure lookup. Joins commerce_developer_tenants → commerce_tenants so the
 * caller learns both whether a mapping exists and whether the mapped
 * tenant is currently active.
 */
export async function resolveTenantForDeveloper(
  sql: Sql,
  developerId: string,
): Promise<TenantResolution> {
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT t.id, t.status
      FROM commerce_developer_tenants dt
      JOIN commerce_tenants t ON t.id = dt.tenant_id
     WHERE dt.developer_id = ${developerId}
       AND dt.is_default = TRUE
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { kind: 'not_provisioned' };
  if (row.status === 'disabled') return { kind: 'disabled', tenantId: row.id };
  return { kind: 'resolved', tenantId: row.id };
}

/**
 * True only when COMMERCE_ALLOW_AUTO_TENANT === 'true' AND the process is
 * not running in production. The NODE_ENV gate is unconditional: even an
 * accidental COMMERCE_ALLOW_AUTO_TENANT=true in a production deploy must
 * not silently provision tenants. Read at call time so tests can flip
 * either env var via vi.stubEnv.
 *
 * M2 introduces explicit provisioning endpoints
 * (POST /v1/commerce/tenants and POST /v1/commerce/developer-tenants);
 * the auto path is for local/sandbox iteration only.
 */
export function isAutoTenantAllowed(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return process.env['COMMERCE_ALLOW_AUTO_TENANT'] === 'true';
}

/**
 * Test/local-sandbox-only. Throws if the auto-tenant flag is not set —
 * defense in depth against accidental production use. The route
 * preHandler additionally guards by checking isAutoTenantAllowed before
 * calling, so a misconfigured caller cannot silently provision tenants.
 */
export async function resolveOrCreateTenantForDeveloper(
  sql: Sql,
  developerId: string,
  developerDisplayName: string,
): Promise<string> {
  if (!isAutoTenantAllowed()) {
    throw new Error(
      'Tenant auto-provisioning is disabled. Set COMMERCE_ALLOW_AUTO_TENANT=true ' +
      'for test/local sandbox use only. Staging and production must provision ' +
      'tenants explicitly via the M2 admin endpoints.',
    );
  }

  // Re-check whether a mapping already exists; if so, prefer it (even if
  // disabled — disabled tenants are NEVER replaced by auto-create).
  const existing = await resolveTenantForDeveloper(sql, developerId);
  if (existing.kind === 'resolved') return existing.tenantId;
  if (existing.kind === 'disabled') {
    throw new Error(
      `Cannot auto-provision: developer ${developerId} is mapped to disabled tenant ` +
      `${existing.tenantId}. Re-enable the tenant or remove the mapping.`,
    );
  }

  const tenantId = newCommerceTenantId();
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`
      INSERT INTO commerce_tenants (id, display_name)
      VALUES (${tenantId}, ${developerDisplayName})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO commerce_developer_tenants (developer_id, tenant_id, is_default)
      VALUES (${developerId}, ${tenantId}, TRUE)
      ON CONFLICT (developer_id, tenant_id) DO NOTHING
    `;
  });
  return tenantId;
}
