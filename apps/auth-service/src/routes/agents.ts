import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAgentId } from '../lib/ids.js';

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

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/agents
  app.post<{ Body: RegisterAgentBody }>('/v1/agents', async (request, reply) => {
    const { name, description = '', scopes = [] } = request.body;
    if (!name) {
      return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const id = newAgentId();
    const did = `did:grantex:${id}`;

    const rows = await sql`
      INSERT INTO agents (id, did, developer_id, name, description, scopes)
      VALUES (${id}, ${did}, ${developerId}, ${name}, ${description}, ${scopes})
      RETURNING id, did, developer_id, name, description, scopes, status, created_at, updated_at
    `;

    return reply.status(201).send(toAgentResponse(rows[0]!));
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
    const { name, description, scopes, status } = request.body;

    if (name === undefined && description === undefined && scopes === undefined && status === undefined) {
      return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Use COALESCE so unset fields keep their current values — single SQL call, no fragments
    const rows = await sql`
      UPDATE agents
      SET
        name        = COALESCE(${name ?? null}, name),
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
    const result = await sql`
      DELETE FROM agents
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    if (result.count === 0) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }
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
