/**
 * The emergency stop (PRD G-6): one authenticated call that halts every agent
 * under a grant, an agent, a principal or a whole developer.
 *
 * It is deliberately ordinary underneath — a cascade revocation per matched
 * root — so the grants it stops appear in the audit hash chain and on the
 * revocation feed exactly like any other revocation, and an SDK following the
 * feed denies the agents' next calls within seconds.
 *
 * Three things make it safe to expose: it is scoped to one developer, it
 * refuses to run without a confirmation phrase naming what it will stop, and
 * `dryRun` answers "how much would this take down" without taking anything
 * down.
 */
import type postgres from 'postgres';
import { ulid } from 'ulid';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { AUDIT_ACTIONS, cascadeGrantAction } from './cascade.js';
import { emergencyStopsTotal } from './metrics.js';
import { withTransactionRetry } from './retry.js';

type Sql = ReturnType<typeof postgres>;

export const STOP_SCOPES = ['grant', 'agent', 'principal', 'developer'] as const;
export type StopScopeType = (typeof STOP_SCOPES)[number];

export interface StopScope {
  type: StopScopeType;
  id: string;
}

export interface EmergencyStopInput {
  developerId: string;
  scope: StopScope;
  reason: string;
  /** Who asked: an admin key, or the developer's own API key. */
  requestedBy: string;
  dryRun?: boolean;
}

export interface EmergencyStopResult {
  stopId: string;
  developerId: string;
  scope: StopScope;
  dryRun: boolean;
  grantsMatched: number;
  grantsRevoked: number;
  agentsStopped: string[];
  startedAt: string;
  completedAt: string;
}

export const newEmergencyStopId = (): string => `stop_${ulid()}`;

/** The phrase a caller must repeat before anything is revoked. */
export function confirmationPhrase(scope: StopScope): string {
  return `stop ${scope.type}:${scope.id}`;
}

/** Agents named in the response and the audit entry; a stop can cover more. */
const MAX_REPORTED_AGENTS = 100;

/** The live grants this scope covers, as the roots of the cascade. */
async function rootsFor(sql: Sql, developerId: string, scope: StopScope): Promise<string[]> {
  const live = ['active', 'suspended'];
  if (scope.type === 'grant') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE id = ${scope.id} AND developer_id = ${developerId} AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  if (scope.type === 'agent') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE agent_id = ${scope.id} AND developer_id = ${developerId} AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  if (scope.type === 'principal') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE principal_id = ${scope.id} AND developer_id = ${developerId} AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  // A whole developer: every live grant. Delegated children are reached by the
  // cascade as well, but naming them all costs nothing and is idempotent.
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM grants WHERE developer_id = ${developerId} AND status = ANY(${live})`;
  return rows.map((row) => row.id);
}

/**
 * Stop everything under `scope`. With `dryRun` nothing is revoked and nothing
 * is recorded: the result says what a real stop would cover.
 */
export async function emergencyStop(sql: Sql, input: EmergencyStopInput): Promise<EmergencyStopResult> {
  const startedAt = new Date();
  const stopId = newEmergencyStopId();
  const dryRun = input.dryRun === true;
  const roots = await rootsFor(sql, input.developerId, input.scope);

  if (dryRun) {
    emergencyStopsTotal.inc({ scope: input.scope.type, outcome: 'dry_run' });
    return {
      stopId,
      developerId: input.developerId,
      scope: input.scope,
      dryRun: true,
      grantsMatched: roots.length,
      grantsRevoked: 0,
      agentsStopped: [],
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  await sql`
    INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, dry_run, grants_matched, started_at)
    VALUES (${stopId}, ${input.developerId}, ${input.scope.type}, ${input.scope.id}, ${input.reason},
            ${input.requestedBy}, FALSE, ${roots.length}, ${startedAt})`;

  const outcome = await cascadeGrantAction(sql, {
    developerId: input.developerId,
    rootGrantIds: roots,
    action: 'revoke',
    cause: 'emergency_stop',
    reason: input.reason,
    context: {
      stop_id: stopId,
      scope_type: input.scope.type,
      scope_id: input.scope.id,
      requested_by: input.requestedBy,
    },
  });

  const agents = [...new Set(outcome.affected.map((grant) => grant.agentId))];
  const completedAt = new Date();
  await sql`
    UPDATE emergency_stops SET grants_revoked = ${outcome.affected.length}, completed_at = ${completedAt}
     WHERE id = ${stopId}`;

  // One summary entry on the chain, beside the per-grant revocation entries.
  await withTransactionRetry('emergency_stop_summary', () => sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const head = await lockAuditChain(tx, input.developerId);
    await appendPlatformAuditEntries(tx, input.developerId, head, [{
      action: AUDIT_ACTIONS.emergencyStop,
      metadata: {
        stop_id: stopId,
        scope_type: input.scope.type,
        scope_id: input.scope.id,
        reason: input.reason,
        requested_by: input.requestedBy,
        grants_matched: roots.length,
        grants_revoked: outcome.affected.length,
        agents_stopped: agents.slice(0, MAX_REPORTED_AGENTS).length,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
      },
    }]);
  }));

  emergencyStopsTotal.inc({ scope: input.scope.type, outcome: 'applied' });
  return {
    stopId,
    developerId: input.developerId,
    scope: input.scope,
    dryRun: false,
    grantsMatched: roots.length,
    grantsRevoked: outcome.affected.length,
    agentsStopped: agents.slice(0, MAX_REPORTED_AGENTS),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}

export interface EmergencyStopRow {
  id: string;
  developer_id: string;
  scope_type: StopScopeType;
  scope_id: string;
  reason: string;
  requested_by: string;
  dry_run: boolean;
  grants_matched: number;
  grants_revoked: number;
  started_at: Date | string;
  completed_at: Date | string | null;
}

export async function listEmergencyStops(sql: Sql, developerId: string, limit = 50): Promise<EmergencyStopRow[]> {
  return sql<EmergencyStopRow[]>`
    SELECT * FROM emergency_stops
     WHERE developer_id = ${developerId}
     ORDER BY started_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}`;
}

export function toEmergencyStopResponse(row: EmergencyStopRow): Record<string, unknown> {
  return {
    stopId: row.id,
    developerId: row.developer_id,
    scope: { type: row.scope_type, id: row.scope_id },
    reason: row.reason,
    requestedBy: row.requested_by,
    dryRun: row.dry_run,
    grantsMatched: row.grants_matched,
    grantsRevoked: row.grants_revoked,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}
