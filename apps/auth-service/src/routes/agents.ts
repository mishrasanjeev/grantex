import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newAgentId } from '../lib/ids.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import {
  validateAgentPublicJwk,
  validateRedirectUris,
  validateResourceServers,
} from '../lib/agent-security.js';
import type { JWK } from 'jose';
import { config } from '../config.js';
import { AgentKeyMirrorRefusal, mirrorRegisteredAgentKey } from '../lib/registry/agent-key-mirror.js';
import { emitEvent } from '../lib/events.js';

interface RegisterAgentBody {
  name: string;
  description?: string;
  scopes?: string[];
  redirectUris?: string[];
  resourceServers?: string[];
  publicJwk?: JWK;
  /** `draft` or `active` (the default): a draft agent is registered but not yet usable. */
  status?: string;
}

interface UpdateAgentBody {
  name?: string;
  description?: string;
  scopes?: string[];
  status?: string;
  /** Why the status changed; recorded on the agent. */
  statusReason?: string;
  redirectUris?: string[];
  resourceServers?: string[];
  publicJwk?: JWK;
}

/**
 * Agent lifecycle: draft (registered, not yet usable), active, suspended (paused,
 * resumable) and retired (final). Issuance requires `active`, so a draft, suspended
 * or retired agent is never issued a grant; retiring does not revoke the grants it
 * already holds (revoke them, or use the emergency stop).
 */
export const AGENT_STATUSES = ['draft', 'active', 'suspended', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_STATUS_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  draft: ['active', 'retired'],
  active: ['suspended', 'retired'],
  suspended: ['active', 'retired'],
  retired: [],
};
const VALID_AGENT_STATUSES = new Set<string>(AGENT_STATUSES);

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && VALID_AGENT_STATUSES.has(value);
}

/** Staying in the same state is always allowed; otherwise the transition table decides. */
export function agentStatusTransitionAllowed(from: string, to: AgentStatus): boolean {
  if (from === to) return true;
  const allowed = (AGENT_STATUS_TRANSITIONS as Record<string, readonly AgentStatus[]>)[from];
  return allowed !== undefined && allowed.includes(to);
}
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/agents
  app.post<{ Body: RegisterAgentBody }>('/v1/agents', async (request, reply) => {
    const body = request.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const {
      name,
      description = '',
      scopes = [],
      redirectUris: rawRedirectUris = [],
      resourceServers: rawResourceServers = [],
      publicJwk: rawPublicJwk,
    } = body as Partial<RegisterAgentBody>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (typeof description !== 'string') {
      return reply.status(400).send({ message: 'description must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string'
        || s.length > 256 || s.length === 0 || !OAUTH_SCOPE_TOKEN.test(s))
        || new Set(scopes).size !== scopes.length) {
      return reply.status(400).send({ message: 'Invalid scope format', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (scopes.length > 100) {
      return reply.status(400).send({ message: 'Too many scopes (max 100)', code: 'BAD_REQUEST', requestId: request.id });
    }

    let redirectUris: string[];
    let resourceServers: string[];
    let publicJwk: JWK | null = null;
    let keyThumbprint: string | null = null;
    try {
      redirectUris = validateRedirectUris(rawRedirectUris);
      resourceServers = validateResourceServers(rawResourceServers);
      if (rawPublicJwk !== undefined) {
        const validated = await validateAgentPublicJwk(rawPublicJwk);
        publicJwk = validated.jwk;
        keyThumbprint = validated.thumbprint;
      }
    } catch (err) {
      return reply.status(400).send({
        message: err instanceof Error ? err.message : 'Invalid agent security metadata',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    const id = newAgentId();
    const did = keyThumbprint
      ? `did:web:${config.didWebDomain}:agents:${id}`
      : `did:grantex:${id}`;
    const requestedStatus = (body as Partial<RegisterAgentBody>).status;
    if (requestedStatus !== undefined && requestedStatus !== 'draft' && requestedStatus !== 'active') {
      return reply.status(400).send({
        message: 'status may be "draft" or "active" at registration',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const initialStatus: AgentStatus = requestedStatus ?? 'active';
    let limitExceeded: { plan: string; limit: number } | undefined;
    let createdRow: Record<string, unknown> | undefined;

    // The plan check and insert must be one serialized operation. Otherwise
    // parallel requests can each observe space and exceed the agent quota.
    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 2))`;

        const subRows = await tx<{ plan: string }[]>`
          SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
        `;
        const planName = subRows[0]?.plan ?? 'free';
        const plan = isPlanName(planName) ? planName : 'free';
        const agentLimit = PLAN_LIMITS[plan].agents;

        const countRows = await tx<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM agents WHERE developer_id = ${developerId}
        `;
        const agentCount = parseInt(countRows[0]?.count ?? '0', 10);
        if (agentCount >= agentLimit) {
          limitExceeded = { plan, limit: agentLimit };
          return;
        }

        const rows = await tx`
          INSERT INTO agents (
            id, did, developer_id, name, description, scopes,
            redirect_uris, resource_servers, public_jwk, key_thumbprint,
            status, status_changed_at
          )
          VALUES (
            ${id}, ${did}, ${developerId}, ${name.trim()}, ${description}, ${scopes},
            ${redirectUris}, ${resourceServers}, ${publicJwk ? tx.json(publicJwk) : null}, ${keyThumbprint},
            ${initialStatus}, NOW()
          )
          RETURNING id, did, developer_id, name, description, scopes, status,
                    redirect_uris, resource_servers, public_jwk, key_thumbprint,
                    key_verified_thumbprint, key_verified_at,
                    status_changed_at, status_reason, retired_at,
                    created_at, updated_at
        `;
        createdRow = rows[0];
        // AGENT_KEY_HISTORY_MIRROR_ENABLED (default off): the key also enters
        // the agent key history, in this transaction. Off, nothing here runs.
        if (config.agentKeyHistoryMirrorEnabled && keyThumbprint !== null) {
          await mirrorRegisteredAgentKey(tx, {
            agentId: id, developerId, jwk: publicJwk, thumbprint: keyThumbprint, previousThumbprint: null,
          });
        }
      });
    } catch (error) {
      if (isAgentKeyConflict(error)) {
        return reply.status(409).send({
          message: 'publicJwk is already registered to another Agent Client Instance',
          code: 'AGENT_KEY_CONFLICT',
          requestId: request.id,
        });
      }
      // Only the history mirror throws this, and only with its flag on.
      if (error instanceof AgentKeyMirrorRefusal) {
        return reply.status(error.status).send({ message: error.message, code: error.code, requestId: request.id });
      }
      throw error;
    }

    if (limitExceeded) {
      return reply.status(402).send({
        message: `Plan limit reached: ${limitExceeded.plan} plan allows ${limitExceeded.limit} agent(s). Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }
    if (!createdRow) {
      throw new Error('Agent insert did not return a row');
    }
    return reply.status(201).send(toAgentResponse(createdRow));
  });

  // GET /v1/agents
  app.get('/v1/agents', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, did, developer_id, name, description, scopes, status,
             redirect_uris, resource_servers, public_jwk, key_thumbprint,
             key_verified_thumbprint, key_verified_at,
             status_changed_at, status_reason, retired_at,
             created_at, updated_at
      FROM agents
      WHERE developer_id = ${request.developer.id}
      ORDER BY created_at DESC
    `;
    return reply.send({ agents: rows.map(toAgentResponse) });
  });

  // GET /v1/agents/:id
  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, did, developer_id, name, description, scopes, status,
             redirect_uris, resource_servers, public_jwk, key_thumbprint,
             key_verified_thumbprint, key_verified_at,
             status_changed_at, status_reason, retired_at,
             created_at, updated_at
      FROM agents
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    const agent = rows[0];
    if (!agent) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.send(toAgentResponse(agent));
  });

  // PATCH /v1/agents/:id
  app.patch<{ Params: { id: string }; Body: UpdateAgentBody }>('/v1/agents/:id', async (request, reply) => {
    const sql = getSql();
    const body = request.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { name, description, scopes, status, statusReason, redirectUris, resourceServers, publicJwk } =
      body as UpdateAgentBody;

    if (name === undefined && description === undefined && scopes === undefined && status === undefined
        && redirectUris === undefined && resourceServers === undefined && publicJwk === undefined) {
      return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return reply.status(400).send({ message: 'name must be a non-empty string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (description !== undefined && typeof description !== 'string') {
      return reply.status(400).send({ message: 'description must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (status !== undefined && !isAgentStatus(status)) {
      return reply.status(400).send({
        message: `status must be one of ${AGENT_STATUSES.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (statusReason !== undefined && (typeof statusReason !== 'string' || statusReason.length > 500)) {
      return reply.status(400).send({
        message: 'statusReason must be a string of at most 500 characters',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    // A lifecycle change is checked against the current state before any write:
    // draft becomes active, active and suspended swap, either retires, retired is final.
    let statusChange: { from: string; to: AgentStatus } | null = null;
    if (status !== undefined) {
      const currentRows = await sql`
        SELECT status FROM agents WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      `;
      const current = currentRows[0]?.['status'];
      if (typeof current !== 'string') {
        return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
      }
      if (!agentStatusTransitionAllowed(current, status)) {
        return reply.status(409).send({
          message: `An agent does not move from ${current} to ${status}: draft becomes active, active and suspended swap, either retires, and retired is final`,
          code: 'AGENT_STATUS_TRANSITION',
          requestId: request.id,
        });
      }
      if (current !== status) statusChange = { from: current, to: status };
    }

    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string'
          || s.length > 256 || s.length === 0 || !OAUTH_SCOPE_TOKEN.test(s))
          || new Set(scopes).size !== scopes.length) {
        return reply.status(400).send({ message: 'Invalid scope format', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (scopes.length > 100) {
        return reply.status(400).send({ message: 'Too many scopes (max 100)', code: 'BAD_REQUEST', requestId: request.id });
      }
    }

    let validatedRedirectUris: string[] | undefined;
    let validatedResourceServers: string[] | undefined;
    let validatedPublicJwk: JWK | undefined;
    let keyThumbprint: string | undefined;
    try {
      if (redirectUris !== undefined) validatedRedirectUris = validateRedirectUris(redirectUris);
      if (resourceServers !== undefined) validatedResourceServers = validateResourceServers(resourceServers);
      if (publicJwk !== undefined) {
        const validated = await validateAgentPublicJwk(publicJwk);
        validatedPublicJwk = validated.jwk;
        keyThumbprint = validated.thumbprint;
      }
    } catch (err) {
      return reply.status(400).send({
        message: err instanceof Error ? err.message : 'Invalid agent security metadata',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const keyedDid = keyThumbprint
      ? `did:web:${config.didWebDomain}:agents:${request.params.id}`
      : null;

    // AGENT_KEY_HISTORY_MIRROR_ENABLED (default off), and only when the key
    // changes: the same update in a transaction that also mirrors the key into
    // the agent key history. Otherwise, the single statement below, unchanged.
    if (config.agentKeyHistoryMirrorEnabled && keyThumbprint !== undefined && validatedPublicJwk !== undefined) {
      const developerId = request.developer.id;
      const agentId = request.params.id;
      const jwk = validatedPublicJwk;
      const thumbprint = keyThumbprint;
      let mirrored: Record<string, unknown>[] = [];
      try {
        await sql.begin(async (_tx) => {
          const tx = _tx as unknown as TxSql;
          // The key the agent holds now, locked so the replaced key and the
          // new one are recorded against the same row the update changes.
          const current = await tx<{ key_thumbprint: string | null }[]>`
            SELECT key_thumbprint FROM agents WHERE id = ${agentId} AND developer_id = ${developerId} FOR UPDATE`;
          if (!current[0]) return;
          mirrored = await tx`
            UPDATE agents
            SET
            did         = COALESCE(${keyedDid}, did),
            name        = COALESCE(${name?.trim() ?? null}, name),
            description = COALESCE(${description ?? null}, description),
            scopes      = COALESCE(${scopes ?? null}, scopes),
            status      = COALESCE(${status ?? null}, status),
            status_changed_at = CASE
              WHEN ${status ?? null}::text IS NULL OR ${status ?? null}::text = status THEN status_changed_at
              ELSE NOW()
            END,
            status_reason = CASE WHEN ${status ?? null}::text IS NULL THEN status_reason ELSE ${statusReason ?? null} END,
            retired_at = CASE WHEN ${status ?? null}::text = 'retired' THEN COALESCE(retired_at, NOW()) ELSE retired_at END,
            redirect_uris = COALESCE(${validatedRedirectUris ?? null}, redirect_uris),
            resource_servers = COALESCE(${validatedResourceServers ?? null}, resource_servers),
            public_jwk = ${tx.json(jwk as never)},
            key_thumbprint = ${thumbprint},
            key_verified_thumbprint = NULL,
            key_verified_at = NULL,
            updated_at  = NOW()
            WHERE id = ${agentId} AND developer_id = ${developerId}
            RETURNING id, did, developer_id, name, description, scopes, status,
                      redirect_uris, resource_servers, public_jwk, key_thumbprint,
                      key_verified_thumbprint, key_verified_at,
                      status_changed_at, status_reason, retired_at,
                      created_at, updated_at
          `;
          await mirrorRegisteredAgentKey(tx, {
            agentId, developerId, jwk, thumbprint, previousThumbprint: current[0].key_thumbprint,
          });
        });
      } catch (error) {
        if (isAgentKeyConflict(error)) {
          return reply.status(409).send({
            message: 'publicJwk is already registered to another Agent Client Instance',
            code: 'AGENT_KEY_CONFLICT',
            requestId: request.id,
          });
        }
        if (error instanceof AgentKeyMirrorRefusal) {
          return reply.status(error.status).send({ message: error.message, code: error.code, requestId: request.id });
        }
        throw error;
      }
      const agent = mirrored[0];
      if (!agent) {
        return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
      }
      announceStatusChange(request.developer.id, agent, statusChange);
      return reply.send(toAgentResponse(agent));
    }

    // Use COALESCE so unset fields keep their current values — single SQL call, no fragments
    let rows;
    try {
      rows = await sql`
        UPDATE agents
        SET
        did         = COALESCE(${keyedDid}, did),
        name        = COALESCE(${name?.trim() ?? null}, name),
        description = COALESCE(${description ?? null}, description),
        scopes      = COALESCE(${scopes ?? null}, scopes),
        status      = COALESCE(${status ?? null}, status),
        status_changed_at = CASE
          WHEN ${status ?? null}::text IS NULL OR ${status ?? null}::text = status THEN status_changed_at
          ELSE NOW()
        END,
        status_reason = CASE WHEN ${status ?? null}::text IS NULL THEN status_reason ELSE ${statusReason ?? null} END,
        retired_at = CASE WHEN ${status ?? null}::text = 'retired' THEN COALESCE(retired_at, NOW()) ELSE retired_at END,
        redirect_uris = COALESCE(${validatedRedirectUris ?? null}, redirect_uris),
        resource_servers = COALESCE(${validatedResourceServers ?? null}, resource_servers),
        public_jwk = COALESCE(${validatedPublicJwk ? sql.json(validatedPublicJwk) : null}, public_jwk),
        key_thumbprint = COALESCE(${keyThumbprint ?? null}, key_thumbprint),
        key_verified_thumbprint = CASE
          WHEN ${keyThumbprint ?? null}::text IS NULL THEN key_verified_thumbprint
          ELSE NULL
        END,
        key_verified_at = CASE
          WHEN ${keyThumbprint ?? null}::text IS NULL THEN key_verified_at
          ELSE NULL
        END,
        updated_at  = NOW()
        WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
        RETURNING id, did, developer_id, name, description, scopes, status,
                  redirect_uris, resource_servers, public_jwk, key_thumbprint,
                  key_verified_thumbprint, key_verified_at,
                  status_changed_at, status_reason, retired_at,
                  created_at, updated_at
      `;
    } catch (error) {
      if (isAgentKeyConflict(error)) {
        return reply.status(409).send({
          message: 'publicJwk is already registered to another Agent Client Instance',
          code: 'AGENT_KEY_CONFLICT',
          requestId: request.id,
        });
      }
      throw error;
    }
    const agent = rows[0];
    if (!agent) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }
    announceStatusChange(request.developer.id, agent, statusChange);
    return reply.send(toAgentResponse(agent));
  });

  // DELETE /v1/agents/:id
  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    const sql = getSql();
    const agentId = request.params.id;
    const developerId = request.developer.id;

    // Verify agent exists and belongs to this developer
    const rows = await sql`
      SELECT id FROM agents WHERE id = ${agentId} AND developer_id = ${developerId}
    `;
    if (rows.length === 0) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }

    let hasFinancialHistory = false;
    let hasCredentialHistory = false;
    // Serialize deletion with wallet authorization and preserve append-only
    // financial evidence. Agents with payment history must be suspended and
    // their grants revoked instead of being hard-deleted.
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${developerId}:${agentId}`}, 13))`;
      // Serialize against inserts whose foreign keys reference this agent.
      await tx`SELECT id FROM agents WHERE id = ${agentId} AND developer_id = ${developerId} FOR UPDATE`;
      const walletHistory = await tx`
        SELECT 1 FROM wallet_payment_reservations
        WHERE agent_id = ${agentId} AND developer_id = ${developerId}
        LIMIT 1
      `;
      if (walletHistory[0]) {
        hasFinancialHistory = true;
        return;
      }
      const credentialHistory = await tx`
        SELECT 1 FROM verifiable_credentials vc
        JOIN grants g ON g.id = vc.grant_id
        WHERE g.agent_id = ${agentId} AND g.developer_id = ${developerId}
        LIMIT 1
      `;
      if (credentialHistory[0]) {
        hasCredentialHistory = true;
        return;
      }
      const grantSubquery = tx`SELECT id FROM grants WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM budget_transactions WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM budget_allocations WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM refresh_tokens WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM grant_tokens WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM grants WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM auth_requests WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM oauth_par_requests WHERE client_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM agents WHERE id = ${agentId} AND developer_id = ${developerId}`;
    });

    if (hasFinancialHistory) {
      return reply.status(409).send({
        message: 'Agents with prepaid-wallet history cannot be deleted; suspend the agent and revoke its grants to preserve financial evidence',
        code: 'AGENT_HAS_FINANCIAL_HISTORY',
        requestId: request.id,
      });
    }
    if (hasCredentialHistory) {
      return reply.status(409).send({
        message: 'Agents with issued verifiable credentials cannot be deleted; suspend the agent and revoke its grants to preserve credential status and history',
        code: 'AGENT_HAS_CREDENTIAL_HISTORY',
        requestId: request.id,
      });
    }

    return reply.status(204).send();
  });
}

function announceStatusChange(
  developerId: string,
  agent: Record<string, unknown>,
  change: { from: string; to: AgentStatus } | null,
): void {
  if (!change) return;
  emitEvent(developerId, 'agent.status_changed', {
    agentId: agent['id'],
    from: change.from,
    to: change.to,
    reason: agent['status_reason'] ?? null,
  }).catch(() => {});
}

function toAgentResponse(row: Record<string, unknown>) {
  return {
    agentId: row['id'],
    did: row['did'],
    developerId: row['developer_id'],
    name: row['name'],
    description: row['description'],
    scopes: row['scopes'],
    redirectUris: row['redirect_uris'] ?? [],
    resourceServers: row['resource_servers'] ?? [],
    publicJwk: row['public_jwk'] ?? null,
    keyThumbprint: row['key_thumbprint'] ?? null,
    keyBindingConfigured: typeof row['key_thumbprint'] === 'string' && row['key_thumbprint'].length > 0,
    keyPossessionVerified: row['key_verified_thumbprint'] === row['key_thumbprint']
      && row['key_verified_at'] !== null
      && row['key_verified_at'] !== undefined,
    status: row['status'],
    statusChangedAt: row['status_changed_at'] ?? null,
    statusReason: row['status_reason'] ?? null,
    retiredAt: row['retired_at'] ?? null,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

function isAgentKeyConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && 'code' in error
    && 'constraint_name' in error
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint_name?: unknown }).constraint_name === 'idx_agents_key_thumbprint_unique');
}
