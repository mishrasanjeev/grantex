/**
 * The emergency stop (PRD G-6): one authenticated call that halts every agent
 * under a grant, an agent, a principal or a whole developer.
 *
 * It is deliberately ordinary underneath — cascade revocations — so the grants
 * it stops appear in the audit hash chain and on the revocation feed exactly
 * like any other revocation, and an SDK following the feed denies the agents'
 * next calls within seconds.
 *
 * Three things make it safe to expose: it is scoped to one developer, it
 * refuses to run without a confirmation phrase naming what it will stop, and
 * `dryRun` answers "how much would this take down" without taking anything
 * down.
 *
 * **It is a sweep, not a lockout.** It revokes what exists, and repeats until
 * the scope comes back empty, so a grant delegated while it runs is caught by
 * a later sweep. It does not stop new grants being issued afterwards: whoever
 * holds the developer's API key can mint one a second later. Rotating or
 * disabling that credential is a separate step, and the runbook says so.
 */
import type postgres from 'postgres';
import { ulid } from 'ulid';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { logger, type AppLogger } from '../logger.js';
import { AUDIT_ACTIONS, cascadeGrantAction } from './cascade.js';
import { emergencyStopsTotal } from './metrics.js';
import { withTransactionRetry } from './retry.js';

type Sql = ReturnType<typeof postgres>;

export const STOP_SCOPES = ['grant', 'agent', 'principal', 'developer'] as const;
export type StopScopeType = (typeof STOP_SCOPES)[number];

export type StopStatus = 'running' | 'completed' | 'incomplete' | 'failed';

/**
 * How many times the scope is re-read and revoked before giving up. A grant
 * delegated while the stop runs shows up in the next sweep; if grants keep
 * appearing after this many passes, something is still issuing them and the
 * stop reports that rather than looping forever.
 */
const MAX_SWEEPS = 5;
/** Roots revoked per batch, so the record is updated as the work proceeds. */
const ROOT_BATCH = 200;
/** Agents named in the response and the audit entry; a stop can cover more. */
const MAX_REPORTED_AGENTS = 100;

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
  log?: AppLogger;
}

export interface EmergencyStopResult {
  stopId: string;
  developerId: string;
  scope: StopScope;
  dryRun: boolean;
  status: StopStatus;
  /** How many times the scope was read and revoked. */
  sweeps: number;
  grantsMatched: number;
  grantsRevoked: number;
  agentsStopped: string[];
  /** True when more agents were stopped than the list above names. */
  agentsStoppedTruncated: boolean;
  /** How many distinct agents were stopped, whatever the list length. */
  agentsStoppedTotal: number;
  /** Always false: revoking what exists does not stop new grants being issued. */
  lockout: false;
  startedAt: string;
  completedAt: string;
}

export const newEmergencyStopId = (): string => `stop_${ulid()}`;

/** The phrase a caller must repeat before anything is revoked. */
export function confirmationPhrase(scope: StopScope): string {
  return `stop ${scope.type}:${scope.id}`;
}

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
 *
 * The `emergency_stops` row is updated as the work proceeds and marked
 * `failed` if a batch throws, so it can never read as though nothing happened
 * after thousands of grants were revoked.
 */
export async function emergencyStop(sql: Sql, input: EmergencyStopInput): Promise<EmergencyStopResult> {
  const log = input.log ?? logger;
  const startedAt = new Date();
  const stopId = newEmergencyStopId();
  const dryRun = input.dryRun === true;

  if (dryRun) {
    const roots = await rootsFor(sql, input.developerId, input.scope);
    const finishedAt = new Date();
    // Recorded like a real stop, with dry_run = TRUE. A rehearsal used to
    // leave no trace at all, so `GET /v1/emergency-stops` could not answer
    // "who has been probing the blast radius of this tenant, and when" — and
    // the `dry_run` column existed with nothing ever setting it.
    await sql`
      INSERT INTO emergency_stops
        (id, developer_id, scope_type, scope_id, reason, requested_by, dry_run, status,
         sweeps, grants_matched, grants_revoked, started_at, completed_at)
      VALUES (${stopId}, ${input.developerId}, ${input.scope.type}, ${input.scope.id}, ${input.reason},
              ${input.requestedBy}, TRUE, 'completed', 0, ${roots.length}, 0, ${startedAt}, ${finishedAt})`;
    emergencyStopsTotal.inc({ scope: input.scope.type, outcome: 'dry_run' });
    return {
      stopId,
      developerId: input.developerId,
      scope: input.scope,
      dryRun: true,
      status: 'completed',
      sweeps: 0,
      grantsMatched: roots.length,
      grantsRevoked: 0,
      agentsStopped: [],
      agentsStoppedTruncated: false,
      agentsStoppedTotal: 0,
      lockout: false,
      startedAt: startedAt.toISOString(),
      completedAt: finishedAt.toISOString(),
    };
  }

  await sql`
    INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, dry_run, status, started_at)
    VALUES (${stopId}, ${input.developerId}, ${input.scope.type}, ${input.scope.id}, ${input.reason},
            ${input.requestedBy}, FALSE, 'running', ${startedAt})`;

  const agents = new Set<string>();
  let matched = 0;
  let revoked = 0;
  let sweeps = 0;
  let status: StopStatus = 'completed';
  let completedAt = startedAt;

  const record = async (final: StopStatus | null, error?: string): Promise<void> => {
    await sql`
      UPDATE emergency_stops SET
        grants_matched = ${matched},
        grants_revoked = ${revoked},
        sweeps = ${sweeps},
        status = ${final ?? 'running'},
        error = ${error ?? null},
        completed_at = ${final === null ? null : new Date()}
       WHERE id = ${stopId}`;
  };

  try {
    while (sweeps < MAX_SWEEPS) {
      const roots = await rootsFor(sql, input.developerId, input.scope);
      sweeps += 1;
      if (roots.length === 0) break;
      matched += roots.length;

      for (let index = 0; index < roots.length; index += ROOT_BATCH) {
        const outcome = await cascadeGrantAction(sql, {
          developerId: input.developerId,
          rootGrantIds: roots.slice(index, index + ROOT_BATCH),
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
        revoked += outcome.affected.length;
        for (const grant of outcome.affected) agents.add(grant.agentId);
        // Progress is recorded as it happens: a failure after this point
        // leaves a row that says what was already revoked.
        await record(null);
      }
    }
    if (sweeps >= MAX_SWEEPS && (await rootsFor(sql, input.developerId, input.scope)).length > 0) {
      // Something is still issuing grants under this scope. Say so rather
      // than report a clean stop.
      status = 'incomplete';
      log.error({
        alert: 'emergency_stop', stopId, developerId: input.developerId, scopeType: input.scope.type,
      }, 'emergency stop finished with grants still appearing under the scope');
    }
    // The summary entry belongs inside this try. It used to sit after the row
    // had already been marked `completed`, so exhausting the retries left a
    // row claiming success with no summary on the chain and a 500 for a stop
    // that had in fact revoked everything.
    completedAt = new Date();
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
          status,
          sweeps,
          grants_matched: matched,
          grants_revoked: revoked,
          agents_stopped: Math.min(agents.size, MAX_REPORTED_AGENTS),
          // The audit chain is permanent, so it says when the list was cut
          // rather than leaving a capped number that reads as the true one.
          agents_stopped_truncated: agents.size > MAX_REPORTED_AGENTS,
          agents_stopped_total: agents.size,
          started_at: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
        },
      }]);
    }));
  } catch (err) {
    await record('failed', err instanceof Error ? err.message : String(err)).catch(() => {
      /* the original error is the one to report */
    });
    emergencyStopsTotal.inc({ scope: input.scope.type, outcome: 'failed' });
    throw err;
  }

  await record(status);

  emergencyStopsTotal.inc({ scope: input.scope.type, outcome: status === 'completed' ? 'applied' : status });
  return {
    stopId,
    developerId: input.developerId,
    scope: input.scope,
    dryRun: false,
    status,
    sweeps,
    grantsMatched: matched,
    grantsRevoked: revoked,
    agentsStopped: [...agents].slice(0, MAX_REPORTED_AGENTS),
    agentsStoppedTruncated: agents.size > MAX_REPORTED_AGENTS,
    agentsStoppedTotal: agents.size,
    lockout: false,
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
  status: StopStatus;
  sweeps: number;
  grants_matched: number;
  grants_revoked: number;
  error: string | null;
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
    status: row.status,
    sweeps: row.sweeps,
    grantsMatched: row.grants_matched,
    grantsRevoked: row.grants_revoked,
    ...(row.error !== null ? { error: row.error } : {}),
    lockout: false,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}
