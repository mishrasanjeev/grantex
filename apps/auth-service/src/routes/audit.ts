import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { toAuditEntryResponse } from '../lib/audit-entry.js';
import { newAuditEntryId } from '../lib/ids.js';
import { computeAuditHash } from '../lib/hash.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { signAuditCheckpoint } from '../lib/crypto.js';
import { ulid } from 'ulid';

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
  app.post<{ Body: AuditLogBody }>('/v1/audit/log', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<AuditLogBody>;
    const { agentId, agentDid, grantId, principalId, action, metadata = {}, status = 'success' } = body;

    if (!agentId || !agentDid || !grantId || !principalId || !action) {
      return reply.status(400).send({
        message: 'agentId, agentDid, grantId, principalId, and action are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (!['success', 'failure', 'blocked'].includes(status)) {
      return reply.status(400).send({
        message: 'status must be success, failure, or blocked',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return reply.status(400).send({
        message: 'metadata must be an object',
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

    let limitExceeded = false;
    let createdRow: Record<string, unknown> | undefined;
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      // Serialise chain heads per developer, including the empty-chain case
      // where SELECT ... FOR UPDATE has no row to lock.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;

      const countRows = await tx<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM audit_entries WHERE developer_id = ${developerId}
      `;
      const auditCount = parseInt(countRows[0]?.count ?? '0', 10);
      if (auditCount >= auditLimit) {
        limitExceeded = true;
        return;
      }

      const lastRows = await tx`
        SELECT hash FROM audit_entries
        WHERE developer_id = ${developerId}
        ORDER BY timestamp DESC, id DESC
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

      const rows = await tx`
        INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
        VALUES (
          ${id}, ${agentId}, ${agentDid}, ${grantId}, ${principalId},
          ${developerId}, ${action}, ${tx.json(metadata as postgres.JSONValue)}, ${hash},
          ${prevHash}, ${timestamp}, ${status}
        )
        RETURNING id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
      `;
      createdRow = rows[0] as Record<string, unknown> | undefined;
    });

    if (limitExceeded) {
      return reply.status(402).send({
        message: `Plan limit reached: ${plan} plan allows ${auditLimit} audit entries. Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }
    if (!createdRow) throw new Error('Audit entry insert returned no row');
    return reply.status(201).send(toAuditEntryResponse(createdRow));
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

    const predicates = ['developer_id = $1'];
    const parameters: string[] = [developerId];
    for (const [column, value] of [
      ['agent_id', agentId],
      ['grant_id', grantId],
      ['principal_id', principalId],
      ['action', action],
    ] as const) {
      if (value !== null) {
        parameters.push(value);
        predicates.push(`${column} = $${parameters.length}`);
      }
    }

    const rows = await sql.unsafe(`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
      FROM audit_entries
      WHERE ${predicates.join(' AND ')}
      -- Must mirror the chain builder's "timestamp DESC, id DESC" head lookup.
      -- Ordering on timestamp alone leaves same-millisecond entries in an
      -- arbitrary order, so the hash chain fails to verify on read-back.
      ORDER BY timestamp ASC, id ASC
    `, parameters);

    return reply.send({ entries: rows.map(toAuditEntryResponse) });
  });

  // POST /v1/audit/checkpoints — sign the current chain head for export to
  // an independent timestamping, transparency-log, or evidence system.
  app.post('/v1/audit/checkpoints', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const rows = await sql<{
      id: string;
      hash: string;
      timestamp: string;
      entry_count: string;
    }[]>`
      SELECT id, hash, timestamp,
             COUNT(*) OVER () AS entry_count
      FROM audit_entries
      WHERE developer_id = ${developerId}
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `;
    const head = rows[0];
    if (!head) {
      return reply.status(409).send({
        message: 'Cannot checkpoint an empty audit chain',
        code: 'AUDIT_CHAIN_EMPTY',
        requestId: request.id,
      });
    }

    const entryCount = Number(head.entry_count);
    if (!Number.isSafeInteger(entryCount) || entryCount < 1) {
      throw new Error('Invalid audit entry count');
    }
    const checkpointId = `achk_${ulid()}`;
    const signedCheckpoint = await signAuditCheckpoint({
      developerId,
      headEntryId: head.id,
      headHash: head.hash,
      entryCount,
      checkpointId,
    });

    return reply.status(201).send({
      checkpointId,
      headEntryId: head.id,
      headHash: head.hash,
      headTimestamp: head.timestamp,
      entryCount,
      signedCheckpoint,
      witnessRequired: true,
    });
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
    return reply.send(toAuditEntryResponse(entry));
  });
}
