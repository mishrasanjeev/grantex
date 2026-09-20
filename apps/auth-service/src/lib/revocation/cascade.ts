/**
 * Cascade revocation and suspension (PRD G-6).
 *
 * One call acts on a grant and every grant delegated beneath it, to any
 * depth, in one transaction per batch of roots: the grants change status, the
 * developer's audit hash chain records one entry per grant, wallet
 * reservations are released, and revocation events are emitted. Suspension is
 * the reversible form — the grant authorises nothing until it is resumed.
 *
 * Tenancy: every statement is scoped by `developer_id`, so a root id belonging
 * to another developer resolves to nothing and no grant of theirs is touched.
 */
import type postgres from 'postgres';
import { getRedis } from '../../redis/client.js';
import { appendPlatformAuditEntries, lockAuditChain, type PlatformAuditEntry } from '../audit-chain.js';
import { emitEvent } from '../events.js';
import { grantsRevokedTotal } from '../metrics.js';
import { releaseWalletReservationsForGrants } from '../prepaid-wallet.js';
import { revokeVCsByGrantIds } from '../vc.js';
import { grantRevocationsTotal } from './metrics.js';

type Sql = ReturnType<typeof postgres>;

export type RevocationCause = 'api' | 'event' | 'emergency_stop';
export type GrantAction = 'revoke' | 'suspend';

/** Longest delegation chain the cascade walks; a defence against bad parent data, not a policy. */
const MAX_CASCADE_DEPTH = 64;
/** Roots per transaction. Keeps one emergency stop from holding a single long transaction. */
const ROOT_BATCH = 200;

export interface CascadeInput {
  developerId: string;
  rootGrantIds: readonly string[];
  action: GrantAction;
  cause: RevocationCause;
  /** Free text recorded in the audit entry (no personal data). */
  reason?: string;
  /** Extra audit metadata: event id, rule id, source id, stop id. */
  context?: Record<string, unknown>;
}

export interface AffectedGrant {
  grantId: string;
  rootGrantId: string;
  depth: number;
  agentId: string;
  principalId: string;
}

export interface CascadeOutcome {
  affected: AffectedGrant[];
  /** Roots that were themselves acted on (a root already revoked is not). */
  roots: string[];
}

interface AffectedRow {
  id: string;
  root_id: string;
  depth: number;
  agent_id: string;
  agent_did: string | null;
  principal_id: string;
  expires_at: Date | string;
}

/**
 * The audit action names. Reserved (`grantex.` prefix), so a tenant cannot
 * write one through POST /v1/audit/log.
 */
export const AUDIT_ACTIONS = {
  revoke: 'grantex.grant.revoked',
  suspend: 'grantex.grant.suspended',
  resume: 'grantex.grant.resumed',
  reEvaluate: 'grantex.grant.re_evaluation_requested',
  emergencyStop: 'grantex.emergency_stop',
} as const;

/** The evidence-package revocation vocabulary (`admin`, `api`, `cascade`, `event`, `expiry`). */
function trigger(cause: RevocationCause, depth: number): string {
  if (depth > 0) return 'cascade';
  return cause === 'emergency_stop' ? 'admin' : cause;
}

export async function cascadeGrantAction(sql: Sql, input: CascadeInput): Promise<CascadeOutcome> {
  const unique = [...new Set(input.rootGrantIds)];
  const outcome: CascadeOutcome = { affected: [], roots: [] };
  for (let index = 0; index < unique.length; index += ROOT_BATCH) {
    const batch = unique.slice(index, index + ROOT_BATCH);
    const rows = await cascadeBatch(sql, input, batch);
    for (const row of rows) {
      outcome.affected.push({
        grantId: row.id,
        rootGrantId: row.root_id,
        depth: row.depth,
        agentId: row.agent_id,
        principalId: row.principal_id,
      });
      if (row.depth === 0) outcome.roots.push(row.id);
    }
    await announce(input, rows);
  }
  return outcome;
}

async function cascadeBatch(sql: Sql, input: CascadeInput, roots: string[]): Promise<AffectedRow[]> {
  // A revocation reaches suspended grants too, so a suspended subtree cannot
  // be resumed under a revoked ancestor. A suspension only touches active ones.
  const actOn = input.action === 'revoke' ? ['active', 'suspended'] : ['active'];
  const { developerId } = input;
  let affected: AffectedRow[] = [];

  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    // The same lock delegation and DELETE /v1/grants/:id take: a child being
    // delegated while its parent is revoked either loses the race (the parent
    // is gone when it commits) or is included in this cascade.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;

    const rows = input.action === 'revoke'
      ? await tx<AffectedRow[]>`
          WITH RECURSIVE tree AS (
            SELECT g.id, g.id AS root_id, 0 AS depth
            FROM grants g
            WHERE g.id = ANY(${roots}) AND g.developer_id = ${developerId} AND g.status = ANY(${actOn})
            UNION
            SELECT c.id, t.root_id, t.depth + 1
            FROM grants c
            JOIN tree t ON c.parent_grant_id = t.id
            WHERE c.developer_id = ${developerId} AND c.status = ANY(${actOn}) AND t.depth < ${MAX_CASCADE_DEPTH}
          ),
          picked AS (SELECT DISTINCT ON (id) id, root_id, depth FROM tree ORDER BY id, depth),
          updated AS (
            UPDATE grants g SET status = 'revoked', revoked_at = NOW()
            FROM picked p
            WHERE g.id = p.id AND g.developer_id = ${developerId} AND g.status = ANY(${actOn})
            RETURNING g.id, p.root_id, p.depth, g.agent_id, g.principal_id, g.expires_at
          )
          SELECT u.id, u.root_id, u.depth, u.agent_id, u.principal_id, u.expires_at, a.did AS agent_did
          FROM updated u LEFT JOIN agents a ON a.id = u.agent_id
          ORDER BY u.depth, u.id`
      : await tx<AffectedRow[]>`
          WITH RECURSIVE tree AS (
            SELECT g.id, g.id AS root_id, 0 AS depth
            FROM grants g
            WHERE g.id = ANY(${roots}) AND g.developer_id = ${developerId} AND g.status = ANY(${actOn})
            UNION
            SELECT c.id, t.root_id, t.depth + 1
            FROM grants c
            JOIN tree t ON c.parent_grant_id = t.id
            WHERE c.developer_id = ${developerId} AND c.status = ANY(${actOn}) AND t.depth < ${MAX_CASCADE_DEPTH}
          ),
          picked AS (SELECT DISTINCT ON (id) id, root_id, depth FROM tree ORDER BY id, depth),
          updated AS (
            UPDATE grants g SET status = 'suspended'
            FROM picked p
            WHERE g.id = p.id AND g.developer_id = ${developerId} AND g.status = ANY(${actOn})
            RETURNING g.id, p.root_id, p.depth, g.agent_id, g.principal_id, g.expires_at
          )
          SELECT u.id, u.root_id, u.depth, u.agent_id, u.principal_id, u.expires_at, a.did AS agent_did
          FROM updated u LEFT JOIN agents a ON a.id = u.agent_id
          ORDER BY u.depth, u.id`;
    affected = rows;
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    if (input.action === 'revoke') {
      await releaseWalletReservationsForGrants(tx, developerId, ids);
      // A revoked grant is never resumable.
      await tx`DELETE FROM grant_suspensions WHERE developer_id = ${developerId} AND grant_id = ANY(${ids})`;
    } else {
      for (const row of rows) {
        await tx`
          INSERT INTO grant_suspensions (grant_id, developer_id, root_grant_id, cause)
          VALUES (${row.id}, ${developerId}, ${row.root_id}, ${input.cause})
          ON CONFLICT (grant_id) DO UPDATE SET root_grant_id = EXCLUDED.root_grant_id, cause = EXCLUDED.cause, suspended_at = NOW()`;
      }
    }

    const head = await lockAuditChain(tx, developerId);
    const entries: PlatformAuditEntry[] = rows.map((row) => ({
      action: input.action === 'revoke' ? AUDIT_ACTIONS.revoke : AUDIT_ACTIONS.suspend,
      grantId: row.id,
      agentId: row.agent_id,
      ...(row.agent_did !== null ? { agentDid: row.agent_did } : {}),
      metadata: {
        grant_id: row.id,
        root_grant_id: row.root_id,
        depth: row.depth,
        cascade: row.depth > 0,
        cause: input.cause,
        trigger: trigger(input.cause, row.depth),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.context ?? {}),
      },
    }));
    await appendPlatformAuditEntries(tx, developerId, head, entries);
  });

  return affected;
}

/** Everything that happens after the transaction commits: cache, credentials, events, metrics. */
async function announce(input: CascadeInput, rows: AffectedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);

  if (input.action === 'revoke') {
    // Redis accelerates the check; the database stays authoritative, so a
    // cache outage must not turn a committed revocation into a failed call.
    const redis = getRedis();
    await Promise.allSettled(rows.map(async (row) => {
      const ttl = Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000));
      await redis.set(`revoked:grant:${row.id}`, '1', 'EX', ttl);
    }));
    revokeVCsByGrantIds(ids, input.developerId).catch(() => { /* best effort */ });
    grantsRevokedTotal.inc(rows.length);
  }

  grantRevocationsTotal.inc({ action: input.action === 'revoke' ? 'revoked' : 'suspended', cause: input.cause }, rows.length);

  const byRoot = new Map<string, string[]>();
  for (const row of rows) {
    const list = byRoot.get(row.root_id) ?? [];
    list.push(row.id);
    byRoot.set(row.root_id, list);
  }
  await Promise.allSettled([...byRoot].map(([rootGrantId, grantIds]) => emitEvent(
    input.developerId,
    input.action === 'revoke' ? 'grant.revoked' : 'grant.suspended',
    {
      grantId: rootGrantId,
      cascade: grantIds.length > 1,
      cause: input.cause,
      grantIds,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.context ?? {}),
    },
  )));
}

export interface ResumeOutcome {
  status: 'resumed' | 'not_suspended' | 'ancestor_inactive';
  grantIds: string[];
}

/**
 * Restore the grants one suspension suspended. Refused while any ancestor of
 * the root is not active, so a subtree cannot come back under a revoked or
 * suspended parent.
 */
export async function resumeSuspendedGrants(
  sql: Sql,
  developerId: string,
  rootGrantId: string,
  context: Record<string, unknown> = {},
): Promise<ResumeOutcome> {
  let outcome: ResumeOutcome = { status: 'not_suspended', grantIds: [] };

  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;

    const roots = await tx<{ id: string; parent_grant_id: string | null }[]>`
      SELECT g.id, g.parent_grant_id
      FROM grants g JOIN grant_suspensions s ON s.grant_id = g.id AND s.developer_id = g.developer_id
      WHERE g.id = ${rootGrantId} AND g.developer_id = ${developerId}
        AND g.status = 'suspended' AND s.root_grant_id = ${rootGrantId}`;
    if (!roots[0]) return;

    if (roots[0].parent_grant_id !== null) {
      const ancestors = await tx<{ status: string }[]>`
        WITH RECURSIVE chain AS (
          SELECT p.id, p.parent_grant_id, p.status, 0 AS hops
          FROM grants p WHERE p.id = ${roots[0].parent_grant_id} AND p.developer_id = ${developerId}
          UNION ALL
          SELECT p.id, p.parent_grant_id, p.status, c.hops + 1
          FROM grants p JOIN chain c ON p.id = c.parent_grant_id
          WHERE p.developer_id = ${developerId} AND c.hops < ${MAX_CASCADE_DEPTH}
        )
        SELECT status FROM chain WHERE status <> 'active' LIMIT 1`;
      if (ancestors[0]) {
        outcome = { status: 'ancestor_inactive', grantIds: [] };
        return;
      }
    }

    const rows = await tx<AffectedRow[]>`
      WITH suspended AS (
        SELECT grant_id FROM grant_suspensions
         WHERE developer_id = ${developerId} AND root_grant_id = ${rootGrantId}
      ),
      updated AS (
        UPDATE grants g SET status = 'active'
        FROM suspended s
        WHERE g.id = s.grant_id AND g.developer_id = ${developerId} AND g.status = 'suspended'
        RETURNING g.id, ${rootGrantId}::text AS root_id, 0 AS depth, g.agent_id, g.principal_id, g.expires_at
      )
      SELECT u.*, a.did AS agent_did FROM updated u LEFT JOIN agents a ON a.id = u.agent_id ORDER BY u.id`;
    if (rows.length === 0) return;

    await tx`DELETE FROM grant_suspensions WHERE developer_id = ${developerId} AND root_grant_id = ${rootGrantId}`;

    const head = await lockAuditChain(tx, developerId);
    await appendPlatformAuditEntries(tx, developerId, head, rows.map((row) => ({
      action: AUDIT_ACTIONS.resume,
      grantId: row.id,
      agentId: row.agent_id,
      ...(row.agent_did !== null ? { agentDid: row.agent_did } : {}),
      metadata: { grant_id: row.id, root_grant_id: rootGrantId, ...context },
    })));
    outcome = { status: 'resumed', grantIds: rows.map((row) => row.id) };
  });

  if (outcome.status === 'resumed') {
    grantRevocationsTotal.inc({ action: 'resumed', cause: 'api' }, outcome.grantIds.length);
    await emitEvent(developerId, 'grant.resumed', {
      grantId: rootGrantId,
      grantIds: outcome.grantIds,
      ...context,
    }).catch(() => { /* best effort */ });
  }
  return outcome;
}
