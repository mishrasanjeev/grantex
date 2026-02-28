import type postgres from 'postgres';
import { ulid } from 'ulid';

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

/**
 * Run anomaly detection for a single developer.
 */
async function detectForDeveloper(
  sql: ReturnType<typeof postgres>,
  developerId: string,
): Promise<void> {
  const [rateSpikeRows, highFailureRows, newPrincipalRows, offHoursRows] = await Promise.all([
    sql`
      SELECT agent_id, COUNT(*) AS count
      FROM audit_entries
      WHERE developer_id = ${developerId}
        AND timestamp >= NOW() - INTERVAL '1 hour'
      GROUP BY agent_id
      HAVING COUNT(*) > 50
    `,
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

  const anomalies: AnomalyInsert[] = [];

  for (const r of rateSpikeRows as Array<Record<string, unknown>>) {
    const agentId = r['agent_id'] as string;
    const count = Number(r['count']);
    anomalies.push({
      id: `anom_${ulid()}`,
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
      id: `anom_${ulid()}`,
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
      id: `anom_${ulid()}`,
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
      id: `anom_${ulid()}`,
      developer_id: developerId,
      type: 'off_hours_activity',
      severity: 'low',
      agent_id: agentId,
      principal_id: null,
      description: `Agent ${agentId} performed ${count} actions outside business hours (22:00–06:00 UTC) in the last 24 hours.`,
      metadata: { count, windowHours: 24, threshold: 10 },
    });
  }

  if (anomalies.length === 0) return;

  // Clear existing unacknowledged anomalies for this developer
  await sql`
    DELETE FROM anomalies
    WHERE developer_id = ${developerId} AND acknowledged_at IS NULL
  `;

  for (const a of anomalies) {
    await sql`
      INSERT INTO anomalies
        (id, developer_id, type, severity, agent_id, principal_id, description, metadata)
      VALUES
        (${a.id}, ${a.developer_id}, ${a.type}, ${a.severity},
         ${a.agent_id}, ${a.principal_id}, ${a.description}, ${JSON.stringify(a.metadata)})
    `;
  }
}

/**
 * Run anomaly detection across all developers.
 */
async function runDetection(sql: ReturnType<typeof postgres>): Promise<void> {
  const developers = await sql<{ id: string }[]>`SELECT id FROM developers`;

  for (const dev of developers) {
    await detectForDeveloper(sql, dev.id);
  }
}

/**
 * Start the anomaly detection worker. Runs detection every `intervalMs`
 * (default 60 minutes) across all developers.
 */
export function startAnomalyDetectionWorker(
  sql: ReturnType<typeof postgres>,
  intervalMs = 60 * 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    runDetection(sql).catch((err) => {
      console.error('[anomaly-detection] Error running detection:', err);
    });
  }, intervalMs);

  // Run once immediately
  runDetection(sql).catch((err) => {
    console.error('[anomaly-detection] Error on initial run:', err);
  });

  return timer;
}
