import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newAgentId } from '../lib/ids.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';

interface RegisterAgentBody {
  name: string;
  description?: string;
  scopes?: string[];
}

interface UpdateAgentBody {
  name?: string;
  description?: string;
  scopes?: string[];
  status?: string;
}

const VALID_AGENT_STATUSES = new Set(['active', 'suspended']);

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/agents
  app.post<{ Body: RegisterAgentBody }>('/v1/agents', async (request, reply) => {
    const body = request.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { name, description = '', scopes = [] } = body as Partial<RegisterAgentBody>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (typeof description !== 'string') {
      return reply.status(400).send({ message: 'description must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || s.length > 256 || s.length === 0)) {
      return reply.status(400).send({ message: 'Invalid scope format', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (scopes.length > 100) {
      return reply.status(400).send({ message: 'Too many scopes (max 100)', code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    const id = newAgentId();
    const did = `did:grantex:${id}`;
    let limitExceeded: { plan: string; limit: number } | undefined;
    let createdRow: Record<string, unknown> | undefined;

    // The plan check and insert must be one serialized operation. Otherwise
    // parallel requests can each observe space and exceed the agent quota.
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
        INSERT INTO agents (id, did, developer_id, name, description, scopes)
        VALUES (${id}, ${did}, ${developerId}, ${name.trim()}, ${description}, ${scopes})
        RETURNING id, did, developer_id, name, description, scopes, status, created_at, updated_at
      `;
      createdRow = rows[0];
    });

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
      SELECT id, did, developer_id, name, description, scopes, status, created_at, updated_at
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
      SELECT id, did, developer_id, name, description, scopes, status, created_at, updated_at
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
    const { name, description, scopes, status } = body as UpdateAgentBody;

    if (name === undefined && description === undefined && scopes === undefined && status === undefined) {
      return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return reply.status(400).send({ message: 'name must be a non-empty string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (description !== undefined && typeof description !== 'string') {
      return reply.status(400).send({ message: 'description must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (status !== undefined && (typeof status !== 'string' || !VALID_AGENT_STATUSES.has(status))) {
      return reply.status(400).send({ message: 'status must be active or suspended', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || s.length > 256 || s.length === 0)) {
        return reply.status(400).send({ message: 'Invalid scope format', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (scopes.length > 100) {
        return reply.status(400).send({ message: 'Too many scopes (max 100)', code: 'BAD_REQUEST', requestId: request.id });
      }
    }

    // Use COALESCE so unset fields keep their current values — single SQL call, no fragments
    const rows = await sql`
      UPDATE agents
      SET
        name        = COALESCE(${name?.trim() ?? null}, name),
        description = COALESCE(${description ?? null}, description),
        scopes      = COALESCE(${scopes ?? null}, scopes),
        status      = COALESCE(${status ?? null}, status),
        updated_at  = NOW()
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id, did, developer_id, name, description, scopes, status, created_at, updated_at
    `;
    const agent = rows[0];
    if (!agent) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }
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

    // Cascade delete as one transaction so an intermediate FK/DB failure
    // cannot leave a half-deleted agent graph.
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const grantSubquery = tx`SELECT id FROM grants WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM budget_transactions WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM budget_allocations WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM refresh_tokens WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM grant_tokens WHERE grant_id IN (${grantSubquery})`;
      await tx`DELETE FROM grants WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM auth_requests WHERE agent_id = ${agentId} AND developer_id = ${developerId}`;
      await tx`DELETE FROM agents WHERE id = ${agentId} AND developer_id = ${developerId}`;
    });

    return reply.status(204).send();
  });
}

function toAgentResponse(row: Record<string, unknown>) {
  return {
    agentId: row['id'],
    did: row['did'],
    developerId: row['developer_id'],
    name: row['name'],
    description: row['description'],
    scopes: row['scopes'],
    status: row['status'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}
