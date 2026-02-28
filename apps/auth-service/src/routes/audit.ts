import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAuditEntryId } from '../lib/ids.js';
import { computeAuditHash } from '../lib/hash.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';

interface AuditLogBody {
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  action: string;
  metadata?: Record<string, unknown>;
  status?: 'success' | 'failure' | 'blocked';
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/audit/log
  app.post<{ Body: AuditLogBody }>('/v1/audit/log', async (request, reply) => {
    const { agentId, agentDid, grantId, principalId, action, metadata = {}, status = 'success' } = request.body;

    if (!agentId || !agentDid || !grantId || !principalId || !action) {
      return reply.status(400).send({
        message: 'agentId, agentDid, grantId, principalId, and action are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Enforce plan audit entry limit
    const subRows = await sql<{ plan: string }[]>`
      SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
    `;
    const planName = subRows[0]?.plan ?? 'free';
    const plan = isPlanName(planName) ? planName : 'free';
    const auditLimit = PLAN_LIMITS[plan].auditEntries;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM audit_entries WHERE developer_id = ${developerId}
    `;
    const auditCount = parseInt(countRows[0]?.count ?? '0', 10);

    if (auditCount >= auditLimit) {
      return reply.status(402).send({
        message: `Plan limit reached: ${plan} plan allows ${auditLimit} audit entries. Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }

    // Get last audit entry hash for chain
    const lastRows = await sql`
      SELECT hash FROM audit_entries
      WHERE developer_id = ${developerId}
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const prevHash = lastRows[0] ? (lastRows[0]['hash'] as string) : null;

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
      prevHash,
      status,
    });

    const rows = await sql`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
      VALUES (
        ${id}, ${agentId}, ${agentDid}, ${grantId}, ${principalId},
        ${developerId}, ${action}, ${JSON.stringify(metadata)}, ${hash},
        ${prevHash}, ${timestamp}, ${status}
      )
      RETURNING id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
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
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
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
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
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
    entryId: row['id'],
    agentId: row['agent_id'],
    agentDid: row['agent_did'],
    grantId: row['grant_id'],
    principalId: row['principal_id'],
    developerId: row['developer_id'],
    action: row['action'],
    metadata: row['metadata'],
    hash: row['hash'],
    prevHash: row['previous_hash'],
    timestamp: row['timestamp'],
    status: row['status'] ?? 'success',
  };
}
