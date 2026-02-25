import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAuditEntryId } from '../lib/ids.js';
import { computeAuditHash } from '../lib/hash.js';

interface AuditLogBody {
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  action: string;
  metadata?: Record<string, unknown>;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/audit/log
  app.post<{ Body: AuditLogBody }>('/v1/audit/log', async (request, reply) => {
    const { agentId, agentDid, grantId, principalId, action, metadata = {} } = request.body;

    if (!agentId || !agentDid || !grantId || !principalId || !action) {
      return reply.status(400).send({
        message: 'agentId, agentDid, grantId, principalId, and action are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Get last audit entry hash for chain
    const lastRows = await sql`
      SELECT hash FROM audit_entries
      WHERE developer_id = ${developerId}
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const previousHash = lastRows[0] ? (lastRows[0]['hash'] as string) : null;

    const id = newAuditEntryId();
    const timestamp = new Date().toISOString();

    const hash = computeAuditHash({
      id,
      agentId,
      agentDid,
      grantId,
      principalId,
      developerId,
      action,
      metadata,
      timestamp,
      previousHash,
    });

    const rows = await sql`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp)
      VALUES (
        ${id}, ${agentId}, ${agentDid}, ${grantId}, ${principalId},
        ${developerId}, ${action}, ${JSON.stringify(metadata)}, ${hash},
        ${previousHash}, ${timestamp}
      )
      RETURNING id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp
    `;

    return reply.status(201).send(toAuditResponse(rows[0]!));
  });

  // GET /v1/audit/entries
  app.get('/v1/audit/entries', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;

    const agentId = query['agentId'] ?? null;
    const grantId = query['grantId'] ?? null;
    const principalId = query['principalId'] ?? null;
    const action = query['action'] ?? null;

    const rows = await sql`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp
      FROM audit_entries
      WHERE developer_id = ${developerId}
        AND (${agentId}::text IS NULL OR agent_id = ${agentId ?? ''})
        AND (${grantId}::text IS NULL OR grant_id = ${grantId ?? ''})
        AND (${principalId}::text IS NULL OR principal_id = ${principalId ?? ''})
        AND (${action}::text IS NULL OR action = ${action ?? ''})
      ORDER BY timestamp ASC
    `;

    return reply.send({ entries: rows.map(toAuditResponse) });
  });

  // GET /v1/audit/:id
  app.get<{ Params: { id: string } }>('/v1/audit/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp
      FROM audit_entries
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    const entry = rows[0];
    if (!entry) {
      return reply.status(404).send({ message: 'Audit entry not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.send(toAuditResponse(entry));
  });
}

function toAuditResponse(row: Record<string, unknown>) {
  return {
    id: row['id'],
    agentId: row['agent_id'],
    agentDid: row['agent_did'],
    grantId: row['grant_id'],
    principalId: row['principal_id'],
    developerId: row['developer_id'],
    action: row['action'],
    metadata: row['metadata'],
    hash: row['hash'],
    previousHash: row['previous_hash'],
    timestamp: row['timestamp'],
  };
}
