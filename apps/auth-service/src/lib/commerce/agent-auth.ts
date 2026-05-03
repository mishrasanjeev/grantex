import {
  jwtVerify,
  decodeProtectedHeader,
  decodeJwt,
  importJWK,
  type KeyLike,
  type JWTPayload,
} from 'jose';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import type { JWK } from 'jose';
import { sha256hex } from '../hash.js';

type Sql = ReturnType<typeof postgres>;

const AGENT_API_KEY_PREFIX = 'grtx_agent_';
const ASSERTION_AUDIENCE = 'grantex-commerce';
const ASSERTION_MAX_LIFETIME_SECONDS = 5 * 60;
const ASSERTION_CLOCK_SKEW_SECONDS = 30;
const REDIS_REPLAY_KEY_PREFIX = 'commerce:agent_assertion:jti:';

export function looksLikeAgentApiKey(token: string): boolean {
  return token.startsWith(AGENT_API_KEY_PREFIX);
}

export function looksLikeJwt(token: string): boolean {
  // Three URL-safe-base64 segments separated by dots; we don't parse here.
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export interface ResolvedAgentCaller {
  agentId: string;
  tenantId: string;
  authMethod: 'jwt' | 'api_key';
  trustStatus: 'trusted';
  /** Present when the assertion JWT carried a session_id claim. */
  sessionId?: string;
}

export type AgentResolutionFailure =
  | { kind: 'unknown_credential' }
  | { kind: 'unknown_agent' }
  | { kind: 'agent_not_trusted'; trustStatus: 'pending' | 'suspended' | 'disabled' }
  | { kind: 'tenant_disabled' }
  | { kind: 'assertion_malformed'; reason: string }
  | { kind: 'assertion_kid_mismatch' }
  | { kind: 'assertion_signature_invalid'; reason: string }
  | { kind: 'assertion_expired' }
  | { kind: 'assertion_too_long_lived'; lifetimeSeconds: number }
  | { kind: 'assertion_wrong_audience'; aud: unknown }
  | { kind: 'assertion_missing_claims'; fields: string[] }
  | { kind: 'assertion_replay' }
  | { kind: 'replay_check_unavailable'; error: string };

export type AgentAuthResult =
  | { ok: true; resolved: ResolvedAgentCaller }
  | { ok: false; failure: AgentResolutionFailure };

interface AgentRow {
  id: string;
  tenant_id: string;
  trust_status: string;
  public_key_jwk: Record<string, unknown> | null;
  api_key_hash: string | null;
  tenant_status: string;
}

async function loadAgentByApiKeyHash(sql: Sql, hash: string): Promise<AgentRow | null> {
  const rows = await sql<AgentRow[]>`
    SELECT a.id, a.tenant_id, a.trust_status, a.public_key_jwk, a.api_key_hash,
           t.status AS tenant_status
      FROM commerce_agents a
      JOIN commerce_tenants t ON t.id = a.tenant_id
     WHERE a.api_key_hash = ${hash}
       AND a.disabled_at IS NULL
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadAgentById(sql: Sql, agentId: string): Promise<AgentRow | null> {
  const rows = await sql<AgentRow[]>`
    SELECT a.id, a.tenant_id, a.trust_status, a.public_key_jwk, a.api_key_hash,
           t.status AS tenant_status
      FROM commerce_agents a
      JOIN commerce_tenants t ON t.id = a.tenant_id
     WHERE a.id = ${agentId}
       AND a.disabled_at IS NULL
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Combined trust + tenant-active gate. Trust check runs first (an agent
 * in a disabled tenant is also untrusted-by-effect, but we surface the
 * more specific reason). tenant_disabled returned when trust passes but
 * the agent's tenant is no longer active (Finding 3).
 */
function trustGate(row: AgentRow): AgentResolutionFailure | null {
  if (row.trust_status !== 'trusted') {
    return {
      kind: 'agent_not_trusted',
      trustStatus: row.trust_status as 'pending' | 'suspended' | 'disabled',
    };
  }
  if (row.tenant_status === 'disabled') {
    return { kind: 'tenant_disabled' };
  }
  return null;
}

/**
 * API-key path. Looks up the agent by sha256(token) and applies the
 * trust gate.
 */
export async function resolveAgentByApiKey(sql: Sql, token: string): Promise<AgentAuthResult> {
  if (!looksLikeAgentApiKey(token)) return { ok: false, failure: { kind: 'unknown_credential' } };
  const row = await loadAgentByApiKeyHash(sql, sha256hex(token));
  if (!row) return { ok: false, failure: { kind: 'unknown_agent' } };
  const trust = trustGate(row);
  if (trust) return { ok: false, failure: trust };
  return {
    ok: true,
    resolved: {
      agentId: row.id,
      tenantId: row.tenant_id,
      authMethod: 'api_key',
      trustStatus: 'trusted',
    },
  };
}

/**
 * JWT assertion path.
 *
 * Spec §6: assertion must include `iss=agent_id`, `sub=agent_id`,
 * `aud=grantex-commerce`, `tenant_id`, `iat`, `exp`, `jti`. Lifetime
 * capped at 5 minutes. Replay jti tracked in Redis with TTL = lifetime.
 *
 * Decision E: Redis unavailable → replay_check_unavailable (caller
 * should return 503 assertion_replay_check_unavailable, NOT 401, since
 * this is auth infrastructure unavailable rather than bad credentials).
 */
export async function verifyAgentAssertion(
  sql: Sql,
  redis: Redis | null,
  token: string,
): Promise<AgentAuthResult> {
  if (!looksLikeJwt(token)) return { ok: false, failure: { kind: 'unknown_credential' } };

  let header: ReturnType<typeof decodeProtectedHeader>;
  let unverifiedPayload: JWTPayload;
  try {
    header = decodeProtectedHeader(token);
    unverifiedPayload = decodeJwt(token);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'assertion_malformed', reason: err instanceof Error ? err.message : 'decode failed' },
    };
  }

  // alg must be a public-key JOSE alg (ES256 or EdDSA preferred). We
  // explicitly reject HS* and 'none'. The verifier below uses 'algorithms'
  // for defense in depth but checking here lets us return a precise error.
  const ALLOWED_AGENT_ALGS = new Set(['ES256', 'ES384', 'EdDSA', 'RS256', 'PS256']);
  if (!header.alg || !ALLOWED_AGENT_ALGS.has(String(header.alg))) {
    return {
      ok: false,
      failure: { kind: 'assertion_signature_invalid', reason: `algorithm ${header.alg} not allowed` },
    };
  }

  const issAgentId = unverifiedPayload.iss;
  if (typeof issAgentId !== 'string') {
    return { ok: false, failure: { kind: 'assertion_missing_claims', fields: ['iss'] } };
  }
  const agent = await loadAgentById(sql, issAgentId);
  if (!agent) return { ok: false, failure: { kind: 'unknown_agent' } };
  if (!agent.public_key_jwk) {
    return { ok: false, failure: { kind: 'assertion_signature_invalid', reason: 'agent has no public_key_jwk' } };
  }
  const trust = trustGate(agent);
  if (trust) return { ok: false, failure: trust };

  // Verify signature with the algorithm we accepted from the header
  // (after allowlist filter above).
  let publicKey: KeyLike;
  try {
    publicKey = await importJWK(agent.public_key_jwk as unknown as JWK, String(header.alg)) as KeyLike;
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'assertion_signature_invalid', reason: err instanceof Error ? err.message : 'jwk import failed' },
    };
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, publicKey, {
      audience: ASSERTION_AUDIENCE,
      algorithms: [String(header.alg)],
      clockTolerance: ASSERTION_CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') return { ok: false, failure: { kind: 'assertion_expired' } };
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      const claim = (err as { claim?: string }).claim;
      if (claim === 'aud') return { ok: false, failure: { kind: 'assertion_wrong_audience', aud: unverifiedPayload.aud } };
    }
    return {
      ok: false,
      failure: { kind: 'assertion_signature_invalid', reason: err instanceof Error ? err.message : 'verify failed' },
    };
  }

  // Required claims present?
  const missing: string[] = [];
  for (const f of ['sub', 'jti', 'iat', 'exp', 'tenant_id']) {
    if (payload[f] === undefined || payload[f] === null) missing.push(f);
  }
  if (missing.length) return { ok: false, failure: { kind: 'assertion_missing_claims', fields: missing } };

  if (payload.sub !== issAgentId) {
    return { ok: false, failure: { kind: 'assertion_signature_invalid', reason: 'sub != iss' } };
  }
  if (String(payload['tenant_id']) !== agent.tenant_id) {
    return { ok: false, failure: { kind: 'assertion_signature_invalid', reason: 'tenant_id mismatch with registered agent' } };
  }
  const lifetime = (payload.exp as number) - (payload.iat as number);
  if (lifetime > ASSERTION_MAX_LIFETIME_SECONDS) {
    return { ok: false, failure: { kind: 'assertion_too_long_lived', lifetimeSeconds: lifetime } };
  }

  const jti = String(payload.jti);

  // Replay protection. Use Redis SET key with NX + EX so first writer
  // wins. If Redis unavailable, fail closed (caller surfaces 503).
  if (redis) {
    try {
      const setKey = `${REDIS_REPLAY_KEY_PREFIX}${jti}`;
      const ttl = Math.max(1, ASSERTION_MAX_LIFETIME_SECONDS);
      // ioredis SET with options: ['EX', ttl, 'NX']
      const result = await redis.set(setKey, '1', 'EX', ttl, 'NX');
      if (result !== 'OK') {
        return { ok: false, failure: { kind: 'assertion_replay' } };
      }
    } catch (err) {
      return {
        ok: false,
        failure: { kind: 'replay_check_unavailable', error: err instanceof Error ? err.message : 'redis unavailable' },
      };
    }
  } else {
    return {
      ok: false,
      failure: { kind: 'replay_check_unavailable', error: 'redis client not initialized' },
    };
  }

  const sessionId = typeof payload['session_id'] === 'string' ? (payload['session_id'] as string) : undefined;

  return {
    ok: true,
    resolved: {
      agentId: agent.id,
      tenantId: agent.tenant_id,
      authMethod: 'jwt',
      trustStatus: 'trusted',
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

export const _internal = {
  ASSERTION_MAX_LIFETIME_SECONDS,
  ASSERTION_AUDIENCE,
  REDIS_REPLAY_KEY_PREFIX,
};
