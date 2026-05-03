import type postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { hashApiKey } from '../hash.js';
import { resolveMerchantApiKey, looksLikeMerchantApiKey } from './merchant-auth.js';
import {
  resolveAgentByApiKey,
  verifyAgentAssertion,
  looksLikeAgentApiKey,
  looksLikeJwt,
} from './agent-auth.js';

type Sql = ReturnType<typeof postgres>;

export type CommerceCaller =
  | {
      kind: 'operator';
      developerId: string;
      developerName: string;
      tenantId: string;
      /** null when no developer→tenant mapping exists (then tenantId === ''). */
      tenantStatus: 'active' | 'disabled' | null;
      isOwnerOfTenant: boolean;
      isPlatformAdmin: boolean;
    }
  | {
      kind: 'merchant';
      apiKeyId: string;
      tenantId: string;
      merchantId: string;
      environment: 'sandbox' | 'live';
    }
  | {
      kind: 'agent';
      agentId: string;
      tenantId: string;
      authMethod: 'jwt' | 'api_key';
      sessionId?: string;
    }
  | {
      kind: 'service';
      serviceId: string;
      tenantId: string;
      scopes: string[];
    };

export type CallerResolutionFailure =
  | { status: 401; code: 'missing_authorization'; message: string }
  | { status: 401; code: 'unknown_credential_format'; message: string }
  | { status: 401; code: 'invalid_developer_key'; message: string }
  | { status: 401; code: 'invalid_merchant_key'; message: string }
  | { status: 401; code: 'invalid_agent_credential'; message: string; details?: Record<string, unknown> }
  | { status: 401; code: 'agent_assertion_replay'; message: string }
  | { status: 403; code: 'agent_not_trusted'; message: string; details?: Record<string, unknown> }
  | { status: 403; code: 'tenant_disabled'; message: string }
  | { status: 503; code: 'assertion_replay_check_unavailable'; message: string };

export type CallerResolution =
  | { ok: true; caller: CommerceCaller }
  | { ok: false; failure: CallerResolutionFailure };

interface DeveloperRow {
  id: string;
  name: string;
  mode: string;
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token || token.length < 16 || token.length > 4096) return null;
  return token;
}

async function loadDeveloperByApiKey(sql: Sql, token: string): Promise<DeveloperRow | null> {
  const keyHash = hashApiKey(token);
  const rows = await sql<DeveloperRow[]>`
    SELECT id, name, mode FROM developers WHERE api_key_hash = ${keyHash} LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Single JOIN that resolves the operator's default tenant + tenant
 * status + role. Returns null when no developer→tenant mapping exists
 * (caller decides auto-provision vs 422). Returns status='disabled' so
 * the route preHandler can 403 without an extra round-trip.
 */
async function loadOperatorContext(
  sql: Sql,
  developerId: string,
): Promise<{ tenantId: string; tenantStatus: 'active' | 'disabled'; isOwner: boolean } | null> {
  const rows = await sql<Array<{ tenant_id: string; status: string; role: string | null }>>`
    SELECT dt.tenant_id, t.status, op.role
      FROM commerce_developer_tenants dt
      JOIN commerce_tenants t ON t.id = dt.tenant_id
      LEFT JOIN commerce_tenant_operators op
             ON op.developer_id = dt.developer_id AND op.tenant_id = dt.tenant_id
     WHERE dt.developer_id = ${developerId}
       AND dt.is_default = TRUE
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    tenantStatus: row.status === 'disabled' ? 'disabled' : 'active',
    isOwner: row.role === 'owner',
  };
}

function isPlatformAdminToken(token: string): boolean {
  const adminKey = process.env['ADMIN_API_KEY'];
  if (!adminKey || adminKey.length < 16) return false;
  // Constant-time compare to avoid leaking key length via timing.
  if (token.length !== adminKey.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ adminKey.charCodeAt(i);
  return diff === 0;
}

/**
 * Single entry point for commerce route auth. Detects token shape and
 * dispatches to the appropriate resolver. Sets request.commerceCaller
 * and request.commerceTenantId on success.
 *
 * Decision F: every commerce route must have config.skipAuth=true so the
 * global authPlugin doesn't try to resolve as a developer first; the
 * commerce sub-instance's onRoute hook in routes/commerce.ts ensures
 * this. A test in commerce-caller-bypass.test.ts confirms merchant and
 * agent tokens reach this resolver without being rejected upstream.
 */
export async function resolveCommerceCaller(
  request: FastifyRequest,
  sql: Sql,
  redis: Redis | null,
): Promise<CallerResolution> {
  const token = extractBearer(request);
  if (!token) {
    return { ok: false, failure: { status: 401, code: 'missing_authorization', message: 'Missing or malformed Authorization header' } };
  }

  // Order matters: check the most specific shapes first so an opaque
  // token doesn't accidentally match the operator fallback.
  if (looksLikeMerchantApiKey(token)) {
    const r = await resolveMerchantApiKey(sql, token);
    if (!r.ok) {
      if (r.reason === 'tenant_disabled') {
        return { ok: false, failure: { status: 403, code: 'tenant_disabled',
          message: 'Commerce tenant for this merchant key is disabled' } };
      }
      return { ok: false, failure: { status: 401, code: 'invalid_merchant_key', message: 'Merchant API key not recognized or revoked' } };
    }
    return { ok: true, caller: { kind: 'merchant', ...r.resolved } };
  }

  if (looksLikeAgentApiKey(token)) {
    const r = await resolveAgentByApiKey(sql, token);
    if (!r.ok) {
      if (r.failure.kind === 'agent_not_trusted') {
        return { ok: false, failure: { status: 403, code: 'agent_not_trusted', message: `Agent trust_status is ${r.failure.trustStatus}`, details: { trust_status: r.failure.trustStatus } } };
      }
      if (r.failure.kind === 'tenant_disabled') {
        return { ok: false, failure: { status: 403, code: 'tenant_disabled',
          message: 'Commerce tenant for this agent is disabled' } };
      }
      return { ok: false, failure: { status: 401, code: 'invalid_agent_credential', message: 'Agent API key not recognized', details: { reason: r.failure.kind } } };
    }
    return { ok: true, caller: { kind: 'agent', ...r.resolved } };
  }

  if (looksLikeJwt(token)) {
    const r = await verifyAgentAssertion(sql, redis, token);
    if (!r.ok) {
      const f = r.failure;
      if (f.kind === 'agent_not_trusted') {
        return { ok: false, failure: { status: 403, code: 'agent_not_trusted', message: `Agent trust_status is ${f.trustStatus}`, details: { trust_status: f.trustStatus } } };
      }
      if (f.kind === 'tenant_disabled') {
        return { ok: false, failure: { status: 403, code: 'tenant_disabled',
          message: 'Commerce tenant for this agent is disabled' } };
      }
      if (f.kind === 'assertion_replay') {
        return { ok: false, failure: { status: 401, code: 'agent_assertion_replay', message: 'Agent assertion jti has already been used' } };
      }
      if (f.kind === 'replay_check_unavailable') {
        return { ok: false, failure: { status: 503, code: 'assertion_replay_check_unavailable', message: 'Agent assertion replay protection unavailable; refusing fail-open' } };
      }
      return { ok: false, failure: { status: 401, code: 'invalid_agent_credential', message: 'Agent assertion failed verification', details: { reason: f.kind } } };
    }
    return { ok: true, caller: { kind: 'agent', ...r.resolved } };
  }

  // Fallback: operator (developer API key OR platform admin key).
  const isAdmin = isPlatformAdminToken(token);
  const developer = await loadDeveloperByApiKey(sql, token);
  if (!developer && !isAdmin) {
    return { ok: false, failure: { status: 401, code: 'invalid_developer_key', message: 'Developer API key not recognized' } };
  }
  // Admin without a backing developer record: synthesize an operator caller
  // marked as platform admin. The admin caller has no implicit tenant —
  // operator endpoints that require a tenant context must accept a
  // tenant_id parameter and validate the admin gate.
  if (isAdmin && !developer) {
    return {
      ok: true,
      caller: {
        kind: 'operator',
        developerId: '__admin__',
        developerName: 'platform admin',
        tenantId: '',
        tenantStatus: null,
        isOwnerOfTenant: false,
        isPlatformAdmin: true,
      },
    };
  }
  // Real developer (with optional admin elevation).
  const dev = developer!;
  const ctx = await loadOperatorContext(sql, dev.id);
  return {
    ok: true,
    caller: {
      kind: 'operator',
      developerId: dev.id,
      developerName: dev.name,
      tenantId: ctx?.tenantId ?? '',
      tenantStatus: ctx?.tenantStatus ?? null,
      isOwnerOfTenant: ctx?.isOwner ?? false,
      isPlatformAdmin: isAdmin,
    },
  };
}
