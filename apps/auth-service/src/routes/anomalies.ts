import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAnomalyId, newAnomalyRuleId, newAnomalyChannelId } from '../lib/ids.js';

type AnomalyType = 'rate_spike' | 'high_failure_rate' | 'new_principal' | 'off_hours_activity';
type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

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

// ─── Built-in detection rules ──────────────────────────────────────────────────

export const BUILTIN_RULES = [
  { ruleId: 'AD-001', name: 'Velocity spike', severity: 'high', description: '> 10x normal grant issuance rate in 5 min' },
  { ruleId: 'AD-002', name: 'Scope escalation attempt', severity: 'critical', description: 'Agent requests scopes beyond registered max' },
  { ruleId: 'AD-003', name: 'Unusual geography', severity: 'medium', description: 'Grant token verified from unexpected country' },
  { ruleId: 'AD-004', name: 'Off-hours activity', severity: 'low', description: 'Agent active outside configured normal hours' },
  { ruleId: 'AD-005', name: 'Delegation depth spike', severity: 'high', description: 'Suddenly higher A2A delegation depth detected' },
  { ruleId: 'AD-006', name: 'Rapid revocation', severity: 'critical', description: '> 5 grants revoked in 60 seconds' },
  { ruleId: 'AD-007', name: 'Budget cliff', severity: 'high', description: 'Scope budget 90%+ consumed in < 1 hour' },
  { ruleId: 'AD-008', name: 'Unknown agent', severity: 'critical', description: 'Token presented from unregistered agent DID' },
  { ruleId: 'AD-009', name: 'Replay attempt', severity: 'critical', description: 'Same JTI presented twice' },
  { ruleId: 'AD-010', name: 'Offline bundle stale', severity: 'medium', description: 'Bundle last synced beyond configured threshold' },
] as const;

// ─── Legacy response mapper ────────────────────────────────────────────────────

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

// ─── Alert response mapper (new format) ────────────────────────────────────────

function toAlertResponse(row: Record<string, unknown>) {
  return {
    alertId: row['id'],
    ruleId: row['rule_id'] ?? null,
    ruleName: row['rule_name'] ?? row['type'],
    severity: row['severity'],
    status: row['status'] ?? 'open',
    agentId: row['agent_id'] ?? null,
    detectedAt: row['detected_at'],
    description: row['description'],
    context: row['context'] ?? row['metadata'] ?? {},
    acknowledgedAt: row['acknowledged_at'] ?? null,
    resolvedAt: row['resolved_at'] ?? null,
  };
}

const VALID_ALERT_STATUSES = ['open', 'acknowledged', 'resolved'];
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_CHANNEL_TYPES = ['slack', 'webhook', 'email'];
const VALID_WINDOWS = ['1h', '6h', '24h'];

export async function anomaliesRoutes(app: FastifyInstance): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════════
  // Legacy endpoints (backward compatible)
  // ═════════════════════════════════════════════════════════════════════════════

  // POST /v1/anomalies/detect — run detection, persist results, return them
  app.post('/v1/anomalies/detect', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

  // ═════════════════════════════════════════════════════════════════════════════
  // New alert lifecycle endpoints
  // ═════════════════════════════════════════════════════════════════════════════

  // GET /v1/anomaly/alerts — list alerts with filters
  app.get('/v1/anomaly/alerts', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;

    const status = query['status'] ?? null;
    const severity = query['severity'] ?? null;
    const agentId = query['agentId'] ?? null;
    const limit = Math.min(Math.max(parseInt(query['limit'] ?? '100', 10) || 100, 1), 1000);

    if (status && !VALID_ALERT_STATUSES.includes(status)) {
      return reply.status(400).send({
        message: `Invalid status. Must be one of: ${VALID_ALERT_STATUSES.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (severity && !VALID_SEVERITIES.includes(severity)) {
      return reply.status(400).send({
        message: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const rows = await sql`
      SELECT id, type, severity, status, rule_id, rule_name, agent_id,
             description, context, metadata, detected_at, acknowledged_at, resolved_at
      FROM anomalies
      WHERE developer_id = ${developerId}
        AND (${status === null} OR status = ${status ?? ''})
        AND (${severity === null} OR severity = ${severity ?? ''})
        AND (${agentId === null} OR agent_id = ${agentId ?? ''})
      ORDER BY detected_at DESC
      LIMIT ${limit}
    `;

    const data = (rows as Array<Record<string, unknown>>).map(toAlertResponse);
    return reply.send({ data });
  });

  // POST /v1/anomaly/alerts/:alertId/acknowledge — acknowledge an alert
  app.post<{ Params: { alertId: string }; Body: { note?: string } }>(
    '/v1/anomaly/alerts/:alertId/acknowledge',
    async (request, reply) => {
      const sql = getSql();
      const { alertId } = request.params;
      const body = (request.body ?? {}) as { note?: string };
      const note = body.note ?? null;

      const rows = await sql`
        UPDATE anomalies
        SET status = 'acknowledged',
            acknowledged_at = NOW(),
            resolution_note = COALESCE(${note}, resolution_note)
        WHERE id = ${alertId}
          AND developer_id = ${request.developer.id}
        RETURNING *
      `;

      if (!rows[0]) {
        return reply.status(404).send({ message: 'Alert not found', code: 'NOT_FOUND', requestId: request.id });
      }

      return reply.send(toAlertResponse(rows[0] as Record<string, unknown>));
    },
  );

  // POST /v1/anomaly/alerts/:alertId/resolve — resolve an alert
  app.post<{ Params: { alertId: string }; Body: { note?: string } }>(
    '/v1/anomaly/alerts/:alertId/resolve',
    async (request, reply) => {
      const sql = getSql();
      const { alertId } = request.params;
      const body = (request.body ?? {}) as { note?: string };
      const note = body.note ?? null;

      const rows = await sql`
        UPDATE anomalies
        SET status = 'resolved',
            resolved_at = NOW(),
            resolution_note = COALESCE(${note}, resolution_note)
        WHERE id = ${alertId}
          AND developer_id = ${request.developer.id}
        RETURNING *
      `;

      if (!rows[0]) {
        return reply.status(404).send({ message: 'Alert not found', code: 'NOT_FOUND', requestId: request.id });
      }

      return reply.send(toAlertResponse(rows[0] as Record<string, unknown>));
    },
  );

  // GET /v1/anomaly/metrics — real-time anomaly metrics
  app.get('/v1/anomaly/metrics', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;

    const agentId = query['agentId'] ?? null;
    const window = query['window'] ?? '24h';

    if (!VALID_WINDOWS.includes(window)) {
      return reply.status(400).send({
        message: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const intervalMap: Record<string, string> = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours' };
    const interval = intervalMap[window]!;

    const rows = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'open')::int AS open,
        COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
        COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
        COUNT(*) FILTER (WHERE severity = 'high')::int AS high,
        COUNT(*) FILTER (WHERE severity = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE severity = 'low')::int AS low
      FROM anomalies
      WHERE developer_id = ${developerId}
        AND detected_at >= NOW() - CAST(${interval} AS INTERVAL)
        AND (${agentId === null} OR agent_id = ${agentId ?? ''})
    `;

    const r = (rows[0] ?? {}) as Record<string, unknown>;
    return reply.send({
      window,
      total: Number(r['total'] ?? 0),
      byStatus: {
        open: Number(r['open'] ?? 0),
        acknowledged: Number(r['acknowledged'] ?? 0),
        resolved: Number(r['resolved'] ?? 0),
      },
      bySeverity: {
        critical: Number(r['critical'] ?? 0),
        high: Number(r['high'] ?? 0),
        medium: Number(r['medium'] ?? 0),
        low: Number(r['low'] ?? 0),
      },
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Custom detection rules
  // ═════════════════════════════════════════════════════════════════════════════

  // POST /v1/anomaly/rules — create custom rule
  app.post('/v1/anomaly/rules', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const ruleId = body['ruleId'] as string | undefined;
    const name = body['name'] as string | undefined;
    const description = (body['description'] as string | undefined) ?? null;
    const condition = body['condition'] as Record<string, unknown> | undefined;
    const severity = (body['severity'] as string | undefined) ?? 'medium';
    const alertChannels = (body['alertChannels'] as string[] | undefined) ?? [];

    if (!ruleId || !name) {
      return reply.status(400).send({
        message: 'ruleId and name are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (!condition || typeof condition !== 'object') {
      return reply.status(400).send({
        message: 'condition is required and must be an object',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (!VALID_SEVERITIES.includes(severity)) {
      return reply.status(400).send({
        message: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const id = newAnomalyRuleId();

    await sql`
      INSERT INTO anomaly_rules (id, developer_id, rule_id, name, description, condition, severity, alert_channels)
      VALUES (${id}, ${developerId}, ${ruleId}, ${name}, ${description},
              ${JSON.stringify(condition)}, ${severity}, ${alertChannels})
    `;

    return reply.status(201).send({
      id,
      ruleId,
      name,
      description,
      condition,
      severity,
      alertChannels,
      enabled: true,
    });
  });

  // GET /v1/anomaly/rules — list built-in + custom rules
  app.get('/v1/anomaly/rules', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const rows = await sql`
      SELECT id, rule_id, name, description, condition, severity, alert_channels, enabled, created_at
      FROM anomaly_rules
      WHERE developer_id = ${developerId}
      ORDER BY created_at DESC
    `;

    const builtIn = BUILTIN_RULES.map((r) => ({
      ruleId: r.ruleId,
      name: r.name,
      severity: r.severity,
      description: r.description,
      builtIn: true,
      enabled: true,
    }));

    const custom = (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'],
      ruleId: r['rule_id'],
      name: r['name'],
      description: r['description'] ?? null,
      condition: r['condition'],
      severity: r['severity'],
      alertChannels: r['alert_channels'] ?? [],
      enabled: r['enabled'] ?? true,
      builtIn: false,
      createdAt: r['created_at'],
    }));

    return reply.send({ rules: [...builtIn, ...custom] });
  });

  // DELETE /v1/anomaly/rules/:ruleId — delete a custom rule
  app.delete<{ Params: { ruleId: string } }>(
    '/v1/anomaly/rules/:ruleId',
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql`
        DELETE FROM anomaly_rules
        WHERE id = ${request.params.ruleId}
          AND developer_id = ${request.developer.id}
        RETURNING id
      `;

      if (!rows[0]) {
        return reply.status(404).send({ message: 'Rule not found', code: 'NOT_FOUND', requestId: request.id });
      }

      return reply.status(204).send();
    },
  );

  // ═════════════════════════════════════════════════════════════════════════════
  // Notification channels
  // ═════════════════════════════════════════════════════════════════════════════

  // POST /v1/anomaly/channels — create notification channel
  app.post('/v1/anomaly/channels', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const type = body['type'] as string | undefined;
    const name = body['name'] as string | undefined;
    const config = body['config'] as Record<string, unknown> | undefined;
    const severities = (body['severities'] as string[] | undefined) ?? ['critical', 'high'];

    if (!type || !VALID_CHANNEL_TYPES.includes(type)) {
      return reply.status(400).send({
        message: `type is required and must be one of: ${VALID_CHANNEL_TYPES.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (!name) {
      return reply.status(400).send({
        message: 'name is required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (!config || typeof config !== 'object') {
      return reply.status(400).send({
        message: 'config is required and must be an object',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const id = newAnomalyChannelId();

    await sql`
      INSERT INTO anomaly_channels (id, developer_id, type, name, config, severities)
      VALUES (${id}, ${developerId}, ${type}, ${name}, ${JSON.stringify(config)}, ${severities})
    `;

    return reply.status(201).send({
      id,
      type,
      name,
      config,
      severities,
      enabled: true,
    });
  });

  // GET /v1/anomaly/channels — list notification channels
  app.get('/v1/anomaly/channels', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const rows = await sql`
      SELECT id, type, name, config, severities, enabled, created_at
      FROM anomaly_channels
      WHERE developer_id = ${developerId}
      ORDER BY created_at DESC
    `;

    const channels = (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'],
      type: r['type'],
      name: r['name'],
      config: r['config'],
      severities: r['severities'] ?? [],
      enabled: r['enabled'] ?? true,
      createdAt: r['created_at'],
    }));

    return reply.send({ channels });
  });

  // DELETE /v1/anomaly/channels/:channelId — delete notification channel
  app.delete<{ Params: { channelId: string } }>(
    '/v1/anomaly/channels/:channelId',
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql`
        DELETE FROM anomaly_channels
        WHERE id = ${request.params.channelId}
          AND developer_id = ${request.developer.id}
        RETURNING id
      `;

      if (!rows[0]) {
        return reply.status(404).send({ message: 'Channel not found', code: 'NOT_FOUND', requestId: request.id });
      }

      return reply.status(204).send();
    },
  );
}
