import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAnomalyId } from '../lib/ids.js';

type AnomalyType = 'rate_spike' | 'high_failure_rate' | 'new_principal' | 'off_hours_activity';
type AnomalySeverity = 'low' | 'medium' | 'high';

interface AnomalyInsert {
  id: string;
  developer_id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  agent_id: string | null;
  principal_id: string | null;
  description: string;
  metadata: Record<string, unknown>;
}

function toResponse(row: Record<string, unknown>) {
  return {
    id: row['id'],
    type: row['type'],
    severity: row['severity'],
    agentId: row['agent_id'] ?? null,
    principalId: row['principal_id'] ?? null,
    description: row['description'],
    metadata: row['metadata'] ?? {},
    detectedAt: row['detected_at'],
    acknowledgedAt: row['acknowledged_at'] ?? null,
  };
}

export async function anomaliesRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/anomalies/detect — run detection, persist results, return them
  app.post('/v1/anomalies/detect', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const [rateSpikeRows, highFailureRows, newPrincipalRows, offHoursRows] = await Promise.all([
      // rate_spike: >50 actions per agent in last 1 hour
      sql`
        SELECT agent_id, COUNT(*) AS count
        FROM audit_entries
        WHERE developer_id = ${developerId}
          AND timestamp >= NOW() - INTERVAL '1 hour'
        GROUP BY agent_id
        HAVING COUNT(*) > 50
      `,
      // high_failure_rate: >20% failure/blocked in last 24h (min 5 entries)
      sql`
        SELECT agent_id,
               COUNT(*) FILTER (WHERE status IN ('failure', 'blocked')) AS bad_count,
               COUNT(*) AS total_count
        FROM audit_entries
        WHERE developer_id = ${developerId}
          AND timestamp >= NOW() - INTERVAL '24 hours'
        GROUP BY agent_id
        HAVING COUNT(*) >= 5
           AND (COUNT(*) FILTER (WHERE status IN ('failure', 'blocked')))::float
               / COUNT(*) > 0.2
      `,
      // new_principal: grant issued to a brand-new agent-principal pair in last 24h
      sql`
        SELECT g.agent_id, g.principal_id
        FROM grants g
        WHERE g.developer_id = ${developerId}
          AND g.issued_at >= NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM grants g2
            WHERE g2.developer_id = ${developerId}
              AND g2.agent_id = g.agent_id
              AND g2.principal_id = g.principal_id
              AND g2.issued_at < g.issued_at
          )
      `,
      // off_hours_activity: >10 entries between 22:00–06:00 UTC in last 24h
      sql`
        SELECT agent_id, COUNT(*) AS count
        FROM audit_entries
        WHERE developer_id = ${developerId}
          AND timestamp >= NOW() - INTERVAL '24 hours'
          AND (
            EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') >= 22
            OR EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') < 6
          )
        GROUP BY agent_id
        HAVING COUNT(*) > 10
      `,
    ]);

    // Build anomaly objects
    const anomalies: AnomalyInsert[] = [];
    const now = new Date().toISOString();

    for (const r of rateSpikeRows as Array<Record<string, unknown>>) {
      const agentId = r['agent_id'] as string;
      const count = Number(r['count']);
      anomalies.push({
        id: newAnomalyId(),
        developer_id: developerId,
        type: 'rate_spike',
        severity: 'high',
        agent_id: agentId,
        principal_id: null,
        description: `Agent ${agentId} performed ${count} actions in the last hour (threshold: 50).`,
        metadata: { count, windowHours: 1, threshold: 50 },
      });
    }

    for (const r of highFailureRows as Array<Record<string, unknown>>) {
      const agentId = r['agent_id'] as string;
      const total = Number(r['total_count']);
      const bad = Number(r['bad_count']);
      const pct = Math.round((bad / total) * 100);
      anomalies.push({
        id: newAnomalyId(),
        developer_id: developerId,
        type: 'high_failure_rate',
        severity: 'medium',
        agent_id: agentId,
        principal_id: null,
        description: `Agent ${agentId} has ${pct}% failure/blocked rate over the last 24 hours (${bad}/${total}).`,
        metadata: { badCount: bad, totalCount: total, percentFailure: pct, windowHours: 24, threshold: 0.2 },
      });
    }

    for (const r of newPrincipalRows as Array<Record<string, unknown>>) {
      const agentId = r['agent_id'] as string;
      const principalId = r['principal_id'] as string;
      anomalies.push({
        id: newAnomalyId(),
        developer_id: developerId,
        type: 'new_principal',
        severity: 'low',
        agent_id: agentId,
        principal_id: principalId,
        description: `Agent ${agentId} received a grant from previously-unseen principal ${principalId}.`,
        metadata: { windowHours: 24 },
      });
    }

    for (const r of offHoursRows as Array<Record<string, unknown>>) {
      const agentId = r['agent_id'] as string;
      const count = Number(r['count']);
      anomalies.push({
        id: newAnomalyId(),
        developer_id: developerId,
        type: 'off_hours_activity',
        severity: 'low',
        agent_id: agentId,
        principal_id: null,
        description: `Agent ${agentId} performed ${count} actions outside business hours (22:00–06:00 UTC) in the last 24 hours.`,
        metadata: { count, windowHours: 24, threshold: 10 },
      });
    }

    // Clear existing unacknowledged anomalies for this developer
    await sql`
      DELETE FROM anomalies
      WHERE developer_id = ${developerId} AND acknowledged_at IS NULL
    `;

    // Persist new anomalies (one INSERT per anomaly for simplicity)
    for (const a of anomalies) {
      await sql`
        INSERT INTO anomalies
          (id, developer_id, type, severity, agent_id, principal_id, description, metadata)
        VALUES
          (${a.id}, ${a.developer_id}, ${a.type}, ${a.severity},
           ${a.agent_id}, ${a.principal_id}, ${a.description}, ${JSON.stringify(a.metadata)})
      `;
    }

    return reply.send({
      detectedAt: now,
      total: anomalies.length,
      anomalies: anomalies.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        agentId: a.agent_id,
        principalId: a.principal_id,
        description: a.description,
        metadata: a.metadata,
        detectedAt: now,
        acknowledgedAt: null,
      })),
    });
  });

  // GET /v1/anomalies — list stored anomalies
  app.get('/v1/anomalies', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;
    const unacknowledgedOnly = query['unacknowledged'] === 'true';

    const rows = await sql`
      SELECT id, type, severity, agent_id, principal_id, description, metadata,
             detected_at, acknowledged_at
      FROM anomalies
      WHERE developer_id = ${developerId}
        AND (${!unacknowledgedOnly} OR acknowledged_at IS NULL)
      ORDER BY detected_at DESC
    `;

    const anomalies = (rows as Array<Record<string, unknown>>).map(toResponse);
    return reply.send({ anomalies, total: anomalies.length });
  });

  // PATCH /v1/anomalies/:id/acknowledge — mark an anomaly as acknowledged
  app.patch<{ Params: { id: string } }>(
    '/v1/anomalies/:id/acknowledge',
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql`
        UPDATE anomalies
        SET acknowledged_at = NOW()
        WHERE id = ${request.params.id}
          AND developer_id = ${request.developer.id}
        RETURNING *
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'Anomaly not found', code: 'NOT_FOUND', requestId: request.id });
      }
      return reply.send(toResponse(rows[0] as Record<string, unknown>));
    },
  );
}
