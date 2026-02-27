import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';

type Framework = 'soc2' | 'gdpr' | 'all';

function verifyChain(
  entries: Array<Record<string, unknown>>,
): { valid: boolean; checkedEntries: number; firstBrokenAt: string | null } {
  let prevHash: string | null = null;
  for (const entry of entries) {
    const entryPrevHash = (entry['previous_hash'] as string | null) ?? null;
    if (prevHash !== null && entryPrevHash !== prevHash) {
      return { valid: false, checkedEntries: entries.indexOf(entry), firstBrokenAt: entry['id'] as string };
    }
    prevHash = entry['hash'] as string;
  }
  return { valid: true, checkedEntries: entries.length, firstBrokenAt: null };
}

export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/compliance/summary
  app.get('/v1/compliance/summary', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;
    const since = query['since'] ?? null;
    const until = query['until'] ?? null;

    const [agentRows, grantRows, auditRows, policyRows, subRows] = await Promise.all([
      sql`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status = 'active')     AS active,
          COUNT(*) FILTER (WHERE status = 'suspended')  AS suspended,
          COUNT(*) FILTER (WHERE status = 'revoked')    AS revoked
        FROM agents WHERE developer_id = ${developerId}
      `,
      sql`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status = 'active')     AS active,
          COUNT(*) FILTER (WHERE status = 'revoked')    AS revoked,
          COUNT(*) FILTER (WHERE status = 'expired')    AS expired
        FROM grants WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR issued_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR issued_at <= ${until}::timestamptz)
      `,
      sql`
        SELECT
          COUNT(*)                                        AS total,
          COUNT(*) FILTER (WHERE status = 'success')     AS success,
          COUNT(*) FILTER (WHERE status = 'failure')     AS failure,
          COUNT(*) FILTER (WHERE status = 'blocked')     AS blocked
        FROM audit_entries WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR timestamp >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR timestamp <= ${until}::timestamptz)
      `,
      sql`
        SELECT COUNT(*) AS total FROM policies WHERE developer_id = ${developerId}
      `,
      sql`
        SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
      `,
    ]);

    const agents = agentRows[0] as Record<string, unknown> ?? {};
    const grants = grantRows[0] as Record<string, unknown> ?? {};
    const audit = auditRows[0] as Record<string, unknown> ?? {};
    const policies = policyRows[0] as Record<string, unknown> ?? {};
    const sub = subRows[0] as Record<string, unknown> | undefined;

    return reply.send({
      generatedAt: new Date().toISOString(),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      agents: {
        total: Number(agents['total'] ?? 0),
        active: Number(agents['active'] ?? 0),
        suspended: Number(agents['suspended'] ?? 0),
        revoked: Number(agents['revoked'] ?? 0),
      },
      grants: {
        total: Number(grants['total'] ?? 0),
        active: Number(grants['active'] ?? 0),
        revoked: Number(grants['revoked'] ?? 0),
        expired: Number(grants['expired'] ?? 0),
      },
      auditEntries: {
        total: Number(audit['total'] ?? 0),
        success: Number(audit['success'] ?? 0),
        failure: Number(audit['failure'] ?? 0),
        blocked: Number(audit['blocked'] ?? 0),
      },
      policies: {
        total: Number(policies['total'] ?? 0),
      },
      plan: (sub?.['plan'] as string | undefined) ?? 'free',
    });
  });

  // GET /v1/compliance/export/grants
  app.get('/v1/compliance/export/grants', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;
    const since = query['since'] ?? null;
    const until = query['until'] ?? null;
    const status = query['status'] ?? null;

    const rows = await sql`
      SELECT id, agent_id, principal_id, developer_id, scopes, status,
             issued_at, expires_at, revoked_at, delegation_depth
      FROM grants
      WHERE developer_id = ${developerId}
        AND (${since}::timestamptz IS NULL OR issued_at >= ${since}::timestamptz)
        AND (${until}::timestamptz IS NULL OR issued_at <= ${until}::timestamptz)
        AND (${status}::text IS NULL OR status = ${status ?? ''})
      ORDER BY issued_at DESC
    `;

    const grants = rows.map((r) => ({
      grantId: r['id'],
      agentId: r['agent_id'],
      principalId: r['principal_id'],
      developerId: r['developer_id'],
      scopes: r['scopes'],
      status: r['status'],
      issuedAt: r['issued_at'],
      expiresAt: r['expires_at'],
      revokedAt: r['revoked_at'] ?? null,
      delegationDepth: r['delegation_depth'] ?? 0,
    }));

    return reply.send({
      generatedAt: new Date().toISOString(),
      total: grants.length,
      grants,
    });
  });

  // GET /v1/compliance/evidence-pack
  app.get('/v1/compliance/evidence-pack', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;
    const since = query['since'] ?? null;
    const until = query['until'] ?? null;
    const framework: Framework = (query['framework'] as Framework | undefined) ?? 'all';

    const [
      agentRows, grantStatRows, auditStatRows, policyStatRows, subRows,
      grantRows, auditRows, policyRows,
    ] = await Promise.all([
      // ── Summary stats (5 queries) ──
      sql`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status = 'active')     AS active,
          COUNT(*) FILTER (WHERE status = 'suspended')  AS suspended,
          COUNT(*) FILTER (WHERE status = 'revoked')    AS revoked
        FROM agents WHERE developer_id = ${developerId}
      `,
      sql`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status = 'active')     AS active,
          COUNT(*) FILTER (WHERE status = 'revoked')    AS revoked,
          COUNT(*) FILTER (WHERE status = 'expired')    AS expired
        FROM grants WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR issued_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR issued_at <= ${until}::timestamptz)
      `,
      sql`
        SELECT
          COUNT(*)                                        AS total,
          COUNT(*) FILTER (WHERE status = 'success')     AS success,
          COUNT(*) FILTER (WHERE status = 'failure')     AS failure,
          COUNT(*) FILTER (WHERE status = 'blocked')     AS blocked
        FROM audit_entries WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR timestamp >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR timestamp <= ${until}::timestamptz)
      `,
      sql`SELECT COUNT(*) AS total FROM policies WHERE developer_id = ${developerId}`,
      sql`SELECT plan FROM subscriptions WHERE developer_id = ${developerId}`,
      // ── Full data exports (3 queries) ──
      sql`
        SELECT id, agent_id, principal_id, developer_id, scopes, status,
               issued_at, expires_at, revoked_at, delegation_depth
        FROM grants
        WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR issued_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR issued_at <= ${until}::timestamptz)
        ORDER BY issued_at DESC
      `,
      sql`
        SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id,
               action, metadata, hash, previous_hash, timestamp, status
        FROM audit_entries
        WHERE developer_id = ${developerId}
          AND (${since}::timestamptz IS NULL OR timestamp >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR timestamp <= ${until}::timestamptz)
        ORDER BY timestamp ASC
      `,
      sql`
        SELECT id, name, effect, priority, agent_id, principal_id, scopes,
               time_of_day_start, time_of_day_end, created_at, updated_at
        FROM policies
        WHERE developer_id = ${developerId}
        ORDER BY priority DESC, created_at ASC
      `,
    ]);

    const agents     = agentRows[0]    as Record<string, unknown> ?? {};
    const grantStats = grantStatRows[0] as Record<string, unknown> ?? {};
    const audit      = auditStatRows[0] as Record<string, unknown> ?? {};
    const policies   = policyStatRows[0] as Record<string, unknown> ?? {};
    const sub        = subRows[0]       as Record<string, unknown> | undefined;

    const grants = (grantRows as Array<Record<string, unknown>>).map((r) => ({
      grantId: r['id'],
      agentId: r['agent_id'],
      principalId: r['principal_id'],
      developerId: r['developer_id'],
      scopes: r['scopes'],
      status: r['status'],
      issuedAt: r['issued_at'],
      expiresAt: r['expires_at'],
      revokedAt: r['revoked_at'] ?? null,
      delegationDepth: r['delegation_depth'] ?? 0,
    }));

    const entries = (auditRows as Array<Record<string, unknown>>).map((r) => ({
      entryId: r['id'],
      agentId: r['agent_id'],
      agentDid: r['agent_did'],
      grantId: r['grant_id'],
      principalId: r['principal_id'],
      developerId: r['developer_id'],
      action: r['action'],
      metadata: r['metadata'],
      hash: r['hash'],
      prevHash: r['previous_hash'] ?? null,
      timestamp: r['timestamp'],
      status: r['status'] ?? 'success',
    }));

    const policyList = (policyRows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'],
      name: r['name'],
      effect: r['effect'],
      priority: r['priority'],
      agentId: r['agent_id'] ?? null,
      principalId: r['principal_id'] ?? null,
      scopes: r['scopes'] ?? null,
      timeOfDayStart: r['time_of_day_start'] ?? null,
      timeOfDayEnd: r['time_of_day_end'] ?? null,
      createdAt: r['created_at'],
      updatedAt: r['updated_at'],
    }));

    const chainIntegrity = verifyChain(auditRows as Array<Record<string, unknown>>);

    return reply.send({
      meta: {
        schemaVersion: '1.0',
        generatedAt: new Date().toISOString(),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        framework,
      },
      summary: {
        agents: {
          total: Number(agents['total'] ?? 0),
          active: Number(agents['active'] ?? 0),
          suspended: Number(agents['suspended'] ?? 0),
          revoked: Number(agents['revoked'] ?? 0),
        },
        grants: {
          total: Number(grantStats['total'] ?? 0),
          active: Number(grantStats['active'] ?? 0),
          revoked: Number(grantStats['revoked'] ?? 0),
          expired: Number(grantStats['expired'] ?? 0),
        },
        auditEntries: {
          total: Number(audit['total'] ?? 0),
          success: Number(audit['success'] ?? 0),
          failure: Number(audit['failure'] ?? 0),
          blocked: Number(audit['blocked'] ?? 0),
        },
        policies: { total: Number(policies['total'] ?? 0) },
        plan: (sub?.['plan'] as string | undefined) ?? 'free',
      },
      grants,
      auditEntries: entries,
      policies: policyList,
      chainIntegrity,
    });
  });

  // GET /v1/compliance/export/audit
  app.get('/v1/compliance/export/audit', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;
    const since = query['since'] ?? null;
    const until = query['until'] ?? null;
    const agentId = query['agentId'] ?? null;
    const status = query['status'] ?? null;

    const rows = await sql`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id,
             action, metadata, hash, previous_hash, timestamp, status
      FROM audit_entries
      WHERE developer_id = ${developerId}
        AND (${since}::timestamptz IS NULL OR timestamp >= ${since}::timestamptz)
        AND (${until}::timestamptz IS NULL OR timestamp <= ${until}::timestamptz)
        AND (${agentId}::text IS NULL OR agent_id = ${agentId ?? ''})
        AND (${status}::text IS NULL OR status = ${status ?? ''})
      ORDER BY timestamp ASC
    `;

    const entries = rows.map((r) => ({
      entryId: r['id'],
      agentId: r['agent_id'],
      agentDid: r['agent_did'],
      grantId: r['grant_id'],
      principalId: r['principal_id'],
      developerId: r['developer_id'],
      action: r['action'],
      metadata: r['metadata'],
      hash: r['hash'],
      prevHash: r['previous_hash'] ?? null,
      timestamp: r['timestamp'],
      status: r['status'] ?? 'success',
    }));

    return reply.send({
      generatedAt: new Date().toISOString(),
      total: entries.length,
      entries,
    });
  });
}
