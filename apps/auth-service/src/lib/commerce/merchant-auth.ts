import type postgres from 'postgres';
import { sha256hex } from '../hash.js';

type Sql = ReturnType<typeof postgres>;

const MERCHANT_KEY_PREFIXES = ['grtx_sk_sandbox_', 'grtx_sk_live_'] as const;

export function looksLikeMerchantApiKey(token: string): boolean {
  return MERCHANT_KEY_PREFIXES.some((p) => token.startsWith(p));
}

export interface ResolvedMerchantApiKey {
  apiKeyId: string;
  tenantId: string;
  merchantId: string;
  environment: 'sandbox' | 'live';
}

export type MerchantApiKeyResolution =
  | { ok: true; resolved: ResolvedMerchantApiKey }
  | { ok: false; reason: 'unknown_key' | 'tenant_disabled' };

/**
 * Look up a merchant API key. Joins commerce_tenants so a disabled
 * tenant is rejected at auth time (Finding 3). Returns tenant_disabled
 * separately from unknown_key so the route can surface a clear 403.
 */
export async function resolveMerchantApiKey(
  sql: Sql,
  token: string,
): Promise<MerchantApiKeyResolution> {
  if (!looksLikeMerchantApiKey(token)) return { ok: false, reason: 'unknown_key' };
  const keyHash = sha256hex(token);
  const rows = await sql<Array<{
    id: string;
    tenant_id: string;
    merchant_id: string;
    environment: string;
    tenant_status: string;
  }>>`
    SELECT k.id, k.tenant_id, k.merchant_id, k.environment, t.status AS tenant_status
      FROM commerce_merchant_api_keys k
      JOIN commerce_tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = ${keyHash}
       AND k.revoked_at IS NULL
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown_key' };
  if (row.tenant_status === 'disabled') return { ok: false, reason: 'tenant_disabled' };
  // Best-effort last_used_at update; not in critical path.
  void sql`
    UPDATE commerce_merchant_api_keys SET last_used_at = NOW() WHERE id = ${row.id}
  `.catch(() => undefined);
  return {
    ok: true,
    resolved: {
      apiKeyId: row.id,
      tenantId: row.tenant_id,
      merchantId: row.merchant_id,
      environment: row.environment === 'live' ? 'live' : 'sandbox',
    },
  };
}
