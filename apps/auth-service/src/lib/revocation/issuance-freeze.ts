// SPDX-License-Identifier: Apache-2.0
/**
 * The emergency stop's lockout (PRD G-6): a freeze that refuses issuance.
 *
 * A stop revokes what exists. A freeze refuses what would come next: while one
 * is in force, nothing issues a grant or a grant token under its scope — not
 * `POST /v1/authorize`, the code exchange, refresh or delegation, the OAuth
 * profile's pushed request and token endpoint, consent bundles or passports —
 * until it is lifted. Only a stop that asks for it (`lockout: true`) places
 * one; a stop without it is the sweep it always was.
 *
 * The scopes are the stop's own, and a freeze covers what a stop over the same
 * scope would revoke: a grant and everything delegated beneath it, an agent's
 * grants and theirs, a principal's, or the whole developer. That is why a
 * refresh, a delegation or a passport is checked against the lineage of the
 * grant it acts on, not only the grant itself.
 *
 * Issuance and freezing meet on one advisory lock per developer. Every path
 * that writes in a transaction takes it shared, inside that transaction, and
 * a freeze takes it exclusively. That includes every path that creates a
 * grant, and passports: their writes are the ones a later sweep has to find.
 * So does the credential an exchange or a delegation issues after its grant
 * has committed (`issueForCommittedGrant`), which is written after that
 * transaction has released the lock.
 * A write that committed before the freeze is visible to the sweep that
 * follows it; one that had not yet read the freeze state waits, then sees it.
 * Without the lock a grant could read "not frozen", commit after the sweep's
 * last read, and outlive both.
 *
 * All of it is off unless EMERGENCY_STOP_ENABLED=true. With the flag off the
 * issuance paths do not read the freeze state at all and behave exactly as
 * they did before this existed — which also means a freeze left in place when
 * the flag is turned off is no longer enforced. The runbook says to lift it
 * first.
 */
import type postgres from 'postgres';
import { ulid } from 'ulid';
import type { TxSql } from '../../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { logger, type AppLogger } from '../logger.js';
import { AUDIT_ACTIONS } from './cascade.js';
import { issuanceFreezeChangesTotal, issuanceRefusalsTotal } from './metrics.js';
import { withTransactionRetry } from './retry.js';
import type { StopScope, StopScopeType } from './emergency-stop.js';

type Sql = ReturnType<typeof postgres>;

/** Who placed a freeze, and so who may lift it. */
export type FreezeAuthority = 'developer' | 'operator';

/**
 * Where issuance was refused. A fixed set, so it can label a metric.
 */
export type IssuancePath =
  | 'authorize'
  | 'token'
  | 'token_refresh'
  | 'delegate'
  | 'consent_bundle'
  | 'consent_bundle_refresh'
  | 'passport'
  | 'oauth_par'
  | 'oauth_code'
  | 'oauth_refresh'
  | 'oauth_token_exchange'
  | 'token_exchange';

/**
 * What a request would issue under. Every field is matched against the freeze
 * scope of the same name; `grantIds` also brings in each grant's ancestors,
 * with their agents and principals, because a stop over any of those would
 * have revoked the grant.
 */
export interface IssuanceSubject {
  /** Always from the verified credential, never from the request body. */
  developerId: string;
  agentIds?: readonly string[];
  principalIds?: readonly (string | null | undefined)[];
  grantIds?: readonly (string | null | undefined)[];
}

export interface ActiveFreeze {
  id: string;
  scopeType: StopScopeType;
  scopeId: string;
  stopId: string | null;
}

/**
 * The seed of the advisory lock the freeze and the issuance paths share:
 * `hashtextextended(developer_id, 5)`. Seeds 0 to 4 on the bare developer id
 * are the audit chain, webhooks, agents, grant issuance, and delegation with
 * revocation. It appears as a literal in the SQL below, where it is greppable.
 */
export const ISSUANCE_FREEZE_LOCK_SEED = 5;

/** How far up a delegation chain the lineage is followed; well past any configurable depth. */
const MAX_LINEAGE_DEPTH = 32;

export const newFreezeId = (): string => `frz_${ulid()}`;

/** The freeze is part of the emergency stop, and off with it. */
export function issuanceFreezeEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['EMERGENCY_STOP_ENABLED'] === 'true';
}

/** The confirmation phrase an unfreeze must repeat. */
export function unfreezeConfirmationPhrase(scope: StopScope): string {
  return `unfreeze ${scope.type}:${scope.id}`;
}

export class IssuanceFrozenError extends Error {
  readonly statusCode = 403;
  readonly code = 'ISSUANCE_FROZEN';

  constructor(readonly freeze: ActiveFreeze, readonly path: IssuancePath) {
    super(`Issuance is frozen for this ${freeze.scopeType} by an emergency stop`);
    this.name = 'IssuanceFrozenError';
  }
}

export class FreezeStateUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'FREEZE_STATE_UNAVAILABLE';

  constructor(readonly path: IssuancePath, options: { cause: unknown }) {
    super('Issuance is refused because the emergency stop lockout state could not be read; retry shortly', options);
    this.name = 'FreezeStateUnavailableError';
  }
}

/**
 * The response a `/v1` route sends for a refusal from `assertIssuanceOpen`,
 * or null for any other error, which the caller handles as it always did.
 */
export function issuanceRefusal(err: unknown): { statusCode: number; body: { message: string; code: string } } | null {
  if (err instanceof IssuanceFrozenError || err instanceof FreezeStateUnavailableError) {
    return { statusCode: err.statusCode, body: { message: err.message, code: err.code } };
  }
  return null;
}

function present(values: readonly (string | null | undefined)[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/**
 * Refuse issuance when a freeze covers `subject`; do nothing when none does,
 * or when the emergency stop is off.
 *
 * Call it before anything is written. Inside the transaction that writes a
 * grant, a token or a passport, pass `inTransaction: true`: the shared lock is
 * then held until that transaction ends, which is what makes the freeze and
 * the write see each other. Outside one, the read alone is made. Those paths
 * write nothing a sweep would have to find: an authorization request is only
 * a request, and its code is checked again when it is exchanged; an exchanged
 * token is recorded against an existing grant, and every check of that token
 * reads the grant's status, so revoking the grant denies it whenever it was
 * written. A passport is not like that. It is verified offline, against a
 * status bit the sweep sets only for credentials already written, so it is
 * checked inside the transaction that writes it.
 *
 * Fails closed: if the lock or the read fails, issuance is refused with
 * `FreezeStateUnavailableError`, never let through. An unreadable lockout is
 * indistinguishable from one that says "frozen", and a lockout exists for the
 * incident where letting one more grant through is the failure.
 */
export async function assertIssuanceOpen(
  sql: TxSql,
  subject: IssuanceSubject,
  options: { path: IssuancePath; inTransaction: boolean; log?: AppLogger },
): Promise<void> {
  if (!issuanceFreezeEnforced()) return;
  const log = options.log ?? logger;
  const developerId = subject.developerId;
  const agentIds = present(subject.agentIds);
  const principalIds = present(subject.principalIds);
  const grantIds = present(subject.grantIds);

  let rows: Array<{ id: string; scope_type: StopScopeType; scope_id: string; stop_id: string | null }>;
  try {
    if (options.inTransaction) {
      // Its own statement, and first: under READ COMMITTED a statement's
      // snapshot is taken when it starts, so a read in the same statement as
      // the lock could miss a freeze committed while it waited.
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${developerId}, 5))`;
    }
    rows = await sql<Array<{ id: string; scope_type: StopScopeType; scope_id: string; stop_id: string | null }>>`
      WITH RECURSIVE lineage AS (
        SELECT g.id, g.agent_id, g.principal_id, g.parent_grant_id, 0 AS depth
          FROM grants g
         WHERE g.developer_id = ${developerId} AND g.id = ANY(${grantIds})
        UNION ALL
        SELECT p.id, p.agent_id, p.principal_id, p.parent_grant_id, l.depth + 1
          FROM grants p
          JOIN lineage l ON p.id = l.parent_grant_id
         WHERE p.developer_id = ${developerId} AND l.depth < ${MAX_LINEAGE_DEPTH}
      )
      SELECT f.id, f.scope_type, f.scope_id, f.stop_id
        FROM issuance_freezes f
       WHERE f.developer_id = ${developerId}
         AND f.cleared_at IS NULL
         AND (f.scope_type = 'developer'
              OR (f.scope_type = 'agent'
                  AND (f.scope_id = ANY(${agentIds}) OR f.scope_id IN (SELECT agent_id FROM lineage)))
              OR (f.scope_type = 'principal'
                  AND (f.scope_id = ANY(${principalIds}) OR f.scope_id IN (SELECT principal_id FROM lineage)))
              OR (f.scope_type = 'grant'
                  AND (f.scope_id = ANY(${grantIds}) OR f.scope_id IN (SELECT id FROM lineage))))
       ORDER BY f.created_at, f.id
       LIMIT 1`;
  } catch (err) {
    // Not swallowed: refused, logged and counted, with the cause kept on the
    // error the route turns into a 503.
    issuanceRefusalsTotal.inc({ path: options.path, reason: 'freeze_state_unavailable' });
    log.error({ err, alert: 'issuance_freeze_unavailable', developerId, path: options.path },
      'issuance refused: the emergency stop lockout state could not be read');
    throw new FreezeStateUnavailableError(options.path, { cause: err });
  }

  const row = rows[0];
  if (!row) return;
  const freeze: ActiveFreeze = { id: row.id, scopeType: row.scope_type, scopeId: row.scope_id, stopId: row.stop_id };
  issuanceRefusalsTotal.inc({ path: options.path, reason: 'frozen' });
  log.warn({ alert: 'issuance_frozen', developerId, path: options.path, freezeId: freeze.id, scopeType: freeze.scopeType },
    'issuance refused: an emergency stop lockout covers this request');
  throw new IssuanceFrozenError(freeze, options.path);
}

/**
 * Issue something for a grant that has already been committed, in a
 * transaction of its own that the lockout can see: the best-effort
 * verifiable credential of a code exchange or a delegation, which is issued
 * after the grant's transaction ends.
 *
 * That gap is the problem. A lockout landing in it revokes the grant and
 * sweeps the credentials it already has; a credential written afterwards
 * keeps a clear status bit, and repeating the stop never reaches it because
 * its grant is already revoked. So, in one transaction, and in the order
 * passports take them:
 *
 *   1. the grant's row, `FOR SHARE`: a revocation of it waits for this
 *      transaction, and then its own sweep of credentials sees what this
 *      wrote;
 *   2. the freeze check, with the shared lock (`assertIssuanceOpen`): a
 *      freeze committed before this refuses it with `IssuanceFrozenError`,
 *      and one placed after waits for this commit, so its sweep finds the
 *      credential and sets its bit;
 *   3. the grant's status, as that row read it: a grant that is no longer
 *      active and unexpired gets nothing, and `null` is returned.
 *
 * Refusals fail closed, as `assertIssuanceOpen` does: a freeze state that
 * cannot be read throws `FreezeStateUnavailableError` and nothing is issued.
 * The caller decides how to answer; the issuance itself never goes ahead.
 *
 * Only for use while the emergency stop is on: with it off, callers keep
 * their original path, untouched.
 */
export async function issueForCommittedGrant<T>(
  sql: Sql,
  input: { subject: IssuanceSubject & { grantId: string }; path: IssuancePath; log?: AppLogger },
  issue: (tx: TxSql) => Promise<T>,
): Promise<T | null> {
  const { grantId, ...subject } = input.subject;
  const result = await sql.begin(async (raw) => {
    const tx = raw as unknown as TxSql;
    const rows = await tx<{ status: string }[]>`
      SELECT status FROM grants
       WHERE id = ${grantId} AND developer_id = ${subject.developerId} AND expires_at > NOW()
       FOR SHARE`;
    await assertIssuanceOpen(tx, {
      ...subject,
      grantIds: [...(subject.grantIds ?? []), grantId],
    }, { path: input.path, inTransaction: true, ...(input.log ? { log: input.log } : {}) });
    if (rows[0]?.status !== 'active') return { issued: false as const };
    return { issued: true as const, value: await issue(tx) };
  });
  return result.issued ? result.value : null;
}

export interface PlaceFreezeInput {
  developerId: string;
  scope: StopScope;
  stopId: string;
  reason: string;
  requestedBy: string;
  placedBy: FreezeAuthority;
}

export interface PlacedFreeze {
  freezeId: string;
  /** False when a freeze was already in force for this scope and this call reaffirmed it. */
  created: boolean;
  /** True when an operator's stop took over a freeze the developer had placed. */
  escalated: boolean;
  /** Whose the freeze in force now is. */
  placedBy: FreezeAuthority;
}

/**
 * Put a freeze in force, inside the caller's transaction, and write it on the
 * developer's audit chain in the same transaction: there is never a freeze
 * without its record, or a record without the freeze.
 *
 * A freeze already in force for the scope is reaffirmed rather than stacked.
 * If the operator reaffirms one the developer placed, it becomes the
 * operator's: the developer's key — which may be the leaked credential — can
 * then no longer lift it.
 */
export async function placeIssuanceFreeze(tx: TxSql, input: PlaceFreezeInput): Promise<PlacedFreeze> {
  // Exclusive: waits for issuance transactions already past their check, so
  // what they wrote is committed before the sweep reads the scope.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.developerId}, 5))`;
  const candidate = newFreezeId();
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO issuance_freezes
      (id, developer_id, scope_type, scope_id, stop_id, placed_by, reason, requested_by)
    VALUES (${candidate}, ${input.developerId}, ${input.scope.type}, ${input.scope.id}, ${input.stopId},
            ${input.placedBy}, ${input.reason}, ${input.requestedBy})
    ON CONFLICT (developer_id, scope_type, scope_id) WHERE cleared_at IS NULL DO NOTHING
    RETURNING id`;

  let placed: PlacedFreeze;
  if (inserted[0]) {
    placed = { freezeId: inserted[0].id, created: true, escalated: false, placedBy: input.placedBy };
  } else {
    // The lock above is held, so the freeze in force cannot be lifted
    // between the conflict and this read.
    const existing = await tx<{ id: string; placed_by: FreezeAuthority }[]>`
      SELECT id, placed_by FROM issuance_freezes
       WHERE developer_id = ${input.developerId} AND scope_type = ${input.scope.type}
         AND scope_id = ${input.scope.id} AND cleared_at IS NULL`;
    const row = existing[0];
    if (!row) throw new Error('issuance freeze conflicted but no freeze is in force for the scope');
    const escalated = input.placedBy === 'operator' && row.placed_by !== 'operator';
    if (escalated) {
      await tx`UPDATE issuance_freezes SET placed_by = 'operator' WHERE id = ${row.id}`;
    }
    placed = { freezeId: row.id, created: false, escalated, placedBy: escalated ? 'operator' : row.placed_by };
  }

  const head = await lockAuditChain(tx, input.developerId);
  await appendPlatformAuditEntries(tx, input.developerId, head, [{
    action: AUDIT_ACTIONS.issuanceFrozen,
    metadata: {
      freeze_id: placed.freezeId,
      stop_id: input.stopId,
      scope_type: input.scope.type,
      scope_id: input.scope.id,
      reason: input.reason,
      requested_by: input.requestedBy,
      placed_by: placed.placedBy,
      reaffirmed: !placed.created,
      ...(placed.escalated ? { escalated: true } : {}),
    },
  }]);
  issuanceFreezeChangesTotal.inc({ action: placed.created ? 'placed' : 'reaffirmed', scope: input.scope.type });
  return placed;
}

export interface IssuanceFreezeRow {
  id: string;
  developer_id: string;
  scope_type: StopScopeType;
  scope_id: string;
  stop_id: string | null;
  placed_by: FreezeAuthority;
  reason: string;
  requested_by: string;
  created_at: Date | string;
  cleared_at: Date | string | null;
  cleared_by: string | null;
  clear_reason: string | null;
}

export class FreezeNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FROZEN';

  constructor() {
    super('No lockout is in force for this scope');
    this.name = 'FreezeNotFoundError';
  }
}

export class FreezeHeldByOperatorError extends Error {
  readonly statusCode = 403;
  readonly code = 'FREEZE_HELD_BY_OPERATOR';

  constructor() {
    super('This lockout was placed by the platform operator and only the operator can lift it');
    this.name = 'FreezeHeldByOperatorError';
  }
}

export interface LiftFreezeInput {
  developerId: string;
  scope: StopScope;
  reason: string;
  requestedBy: string;
  /** Who is asking. A developer cannot lift a freeze the operator placed. */
  liftedBy: FreezeAuthority;
  log?: AppLogger;
}

/**
 * Lift the freeze in force for `scope`, and write that on the audit chain in
 * the same transaction. The row is kept, with who cleared it, when and why.
 */
export async function liftIssuanceFreeze(sql: Sql, input: LiftFreezeInput): Promise<IssuanceFreezeRow> {
  const log = input.log ?? logger;
  const cleared = await withTransactionRetry('issuance_unfreeze', () => sql.begin(async (raw) => {
    const tx = raw as unknown as TxSql;
    // The same exclusive lock a freeze takes, so lifting and placing cannot
    // interleave for one developer.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.developerId}, 5))`;
    const rows = await tx<IssuanceFreezeRow[]>`
      SELECT * FROM issuance_freezes
       WHERE developer_id = ${input.developerId} AND scope_type = ${input.scope.type}
         AND scope_id = ${input.scope.id} AND cleared_at IS NULL
       FOR UPDATE`;
    const freeze = rows[0];
    if (!freeze) throw new FreezeNotFoundError();
    if (freeze.placed_by === 'operator' && input.liftedBy !== 'operator') throw new FreezeHeldByOperatorError();

    const updated = await tx<IssuanceFreezeRow[]>`
      UPDATE issuance_freezes
         SET cleared_at = NOW(), cleared_by = ${input.requestedBy}, clear_reason = ${input.reason}
       WHERE id = ${freeze.id} AND cleared_at IS NULL
       RETURNING *`;
    const row = updated[0];
    if (!row) throw new FreezeNotFoundError();

    const head = await lockAuditChain(tx, input.developerId);
    await appendPlatformAuditEntries(tx, input.developerId, head, [{
      action: AUDIT_ACTIONS.issuanceUnfrozen,
      metadata: {
        freeze_id: row.id,
        stop_id: row.stop_id,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        placed_by: row.placed_by,
        reason: input.reason,
        requested_by: input.requestedBy,
        frozen_at: new Date(row.created_at).toISOString(),
      },
    }]);
    return row;
  }));
  issuanceFreezeChangesTotal.inc({ action: 'lifted', scope: cleared.scope_type });
  log.warn({
    alert: 'issuance_unfrozen', developerId: input.developerId, freezeId: cleared.id, scopeType: cleared.scope_type,
    liftedBy: input.liftedBy,
  }, 'emergency stop lockout lifted');
  return cleared;
}

/** The largest page of freezes one request may ask for, as on the other paged `/v1` lists. */
export const MAX_FREEZE_PAGE_SIZE = 200;
/** The page size when none is asked for. */
export const DEFAULT_FREEZE_PAGE_SIZE = 50;

/**
 * One page of the freezes in force for a developer, oldest first, and how
 * many are in force in all, so a caller can tell a full page from the whole
 * list and ask for the rest. Paged with `page` and `pageSize`, as
 * `GET /v1/budget/transactions/:grantId` and the admin developer list are.
 */
export async function listActiveFreezes(
  sql: Sql,
  developerId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ freezes: IssuanceFreezeRow[]; total: number; page: number; pageSize: number }> {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? DEFAULT_FREEZE_PAGE_SIZE, MAX_FREEZE_PAGE_SIZE);
  const [freezes, counted] = await Promise.all([
    sql<IssuanceFreezeRow[]>`
      SELECT * FROM issuance_freezes
       WHERE developer_id = ${developerId} AND cleared_at IS NULL
       ORDER BY created_at, id
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM issuance_freezes
       WHERE developer_id = ${developerId} AND cleared_at IS NULL`,
  ]);
  return { freezes, total: Number(counted[0]?.total ?? 0), page, pageSize };
}

export function toFreezeResponse(row: IssuanceFreezeRow): Record<string, unknown> {
  return {
    freezeId: row.id,
    developerId: row.developer_id,
    scope: { type: row.scope_type, id: row.scope_id },
    stopId: row.stop_id,
    placedBy: row.placed_by,
    reason: row.reason,
    requestedBy: row.requested_by,
    frozenAt: new Date(row.created_at).toISOString(),
    ...(row.cleared_at !== null
      ? {
          clearedAt: new Date(row.cleared_at).toISOString(),
          clearedBy: row.cleared_by,
          clearReason: row.clear_reason,
        }
      : {}),
  };
}
