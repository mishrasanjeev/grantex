import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newPolicyId } from '../lib/ids.js';

interface PolicyBody {
  name: string;
  effect: 'allow' | 'deny';
  priority?: number;
  agentId?: string;
  principalId?: string;
  scopes?: string[];
  timeOfDayStart?: string;
  timeOfDayEnd?: string;
}

interface UpdatePolicyBody {
  name?: string;
  effect?: 'allow' | 'deny';
  priority?: number;
  agentId?: string | null;
  principalId?: string | null;
  scopes?: string[] | null;
  timeOfDayStart?: string | null;
  timeOfDayEnd?: string | null;
}

function toResponse(row: Record<string, unknown>) {
  return {
    id: row['id'],
    name: row['name'],
    effect: row['effect'],
    priority: row['priority'],
    agentId: row['agent_id'] ?? null,
    principalId: row['principal_id'] ?? null,
    scopes: row['scopes'] ?? null,
    timeOfDayStart: row['time_of_day_start'] ?? null,
    timeOfDayEnd: row['time_of_day_end'] ?? null,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

export async function policiesRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/policies — create a policy
  app.post<{ Body: PolicyBody }>('/v1/policies', async (request, reply) => {
    const {
      name,
      effect,
      priority = 0,
      agentId,
      principalId,
      scopes,
      timeOfDayStart,
      timeOfDayEnd,
    } = request.body;

    if (!name || !effect || !['allow', 'deny'].includes(effect)) {
      return reply.status(400).send({
        message: 'name and effect (allow|deny) are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const id = newPolicyId();

    const rows = await sql`
      INSERT INTO policies
        (id, developer_id, name, effect, priority, agent_id, principal_id,
         scopes, time_of_day_start, time_of_day_end)
      VALUES
        (${id}, ${developerId}, ${name}, ${effect}, ${priority},
         ${agentId ?? null}, ${principalId ?? null}, ${scopes ?? null},
         ${timeOfDayStart ?? null}, ${timeOfDayEnd ?? null})
      RETURNING *
    `;

    return reply.status(201).send(toResponse(rows[0] as Record<string, unknown>));
  });

  // GET /v1/policies — list policies
  app.get('/v1/policies', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const rows = await sql`
      SELECT * FROM policies
      WHERE developer_id = ${developerId}
      ORDER BY priority DESC, created_at ASC
    `;

    return reply.send({
      policies: rows.map((r) => toResponse(r as Record<string, unknown>)),
      total: rows.length,
    });
  });

  // GET /v1/policies/:id — get single policy
  app.get<{ Params: { id: string } }>('/v1/policies/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM policies
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'Policy not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.send(toResponse(rows[0] as Record<string, unknown>));
  });

  // PATCH /v1/policies/:id — update policy
  app.patch<{ Params: { id: string }; Body: UpdatePolicyBody }>(
    '/v1/policies/:id',
    async (request, reply) => {
      const sql = getSql();
      const {
        name,
        effect,
        priority,
        agentId,
        principalId,
        scopes,
        timeOfDayStart,
        timeOfDayEnd,
      } = request.body;

      if (effect !== undefined && !['allow', 'deny'].includes(effect)) {
        return reply.status(400).send({
          message: 'effect must be allow or deny',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const rows = await sql`
        UPDATE policies SET
          name               = COALESCE(${name ?? null}, name),
          effect             = COALESCE(${effect ?? null}, effect),
          priority           = COALESCE(${priority ?? null}, priority),
          agent_id           = CASE WHEN ${agentId !== undefined} THEN ${agentId ?? null} ELSE agent_id END,
          principal_id       = CASE WHEN ${principalId !== undefined} THEN ${principalId ?? null} ELSE principal_id END,
          scopes             = CASE WHEN ${scopes !== undefined} THEN ${scopes ?? null} ELSE scopes END,
          time_of_day_start  = CASE WHEN ${timeOfDayStart !== undefined} THEN ${timeOfDayStart ?? null} ELSE time_of_day_start END,
          time_of_day_end    = CASE WHEN ${timeOfDayEnd !== undefined} THEN ${timeOfDayEnd ?? null} ELSE time_of_day_end END,
          updated_at         = NOW()
        WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
        RETURNING *
      `;

      if (!rows[0]) {
        return reply.status(404).send({ message: 'Policy not found', code: 'NOT_FOUND', requestId: request.id });
      }
      return reply.send(toResponse(rows[0] as Record<string, unknown>));
    },
  );

  // DELETE /v1/policies/:id — delete policy
  app.delete<{ Params: { id: string } }>('/v1/policies/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM policies
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'Policy not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.status(204).send();
  });
}
