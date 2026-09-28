// SPDX-License-Identifier: Apache-2.0
/**
 * Status-list reconciliation with cascade (PRD §7 Events reconciliation
 * loop, §8.7, §9; spec/registry-federation.md "Status reconciliation").
 *
 * With REGISTRY_STATUS_RECONCILIATION_ENABLED=true, one instance at a time
 * (a session advisory lock on RECONCILIATION_LOCK_KEY, as the revocation
 * feed prune does) runs, every tick:
 *
 *   1. poll: every active accredited issuer's Token Status List that an
 *      accepted, unexpired attestation points into is read when it is due: one tick
 *      before the last read goes stale (the list's ttl, or its exp, or a
 *      day; draft-ietf-oauth-status-list-21 §13.7), and never sooner than
 *      REGISTRY_STATUS_POLL_MIN_INTERVAL_MS after the last attempt. One fetch
 *      per list serves every attestation on it; at most MAX_LISTS_PER_RUN
 *      lists a run, POLL_CONCURRENCY at once. A flipped entry is recorded
 *      (issuer_status valid, suspended or revoked; audited). A list that
 *      cannot be read, verified or decoded changes nothing but the time of
 *      the attempt: the recorded status stops counting when its freshness
 *      runs out, and a bound grant's refresh then refuses with status_stale;
 *   2. decide: the registry's acceptance entry of each accepted attestation
 *      follows deriveAcceptance (INVALID for a revoked passport, SUSPENDED
 *      while the passport or its issuer is suspended or the issuer
 *      withdrawn, VALID on a fresh read only), through setAcceptance, which opens the
 *      cascade window of the acceptance lists. An attestation signed with an
 *      issuer key revoked in the last day is withdrawn (INVALID, final);
 *   3. cascade: every grant bound to a passport (grant_passport_bindings)
 *      follows its acceptance entry. INVALID revokes the grant and its
 *      descendants; SUSPENDED suspends them (grant_suspensions, cause
 *      `registry`); VALID again resumes a suspension the registry made, and
 *      only that. Both go through lib/revocation/cascade.ts, so the audit
 *      chain, the webhooks and the revocation feed see them as any other.
 *
 * Every step is level-triggered: it acts on what the tables say now, not on
 * the change that led there, so a run that fails half way is completed by
 * the next, and the same work done twice changes nothing. An operator's
 * PATCH of an issuer runs steps 2 and 3 for that issuer at once
 * (applyRegistryDecisions), and the loop repeats them every tick, which
 * also catches a suspension scheduled for later when it takes effect.
 *
 * Failing closed: nothing here ever reads a failure as VALID. A list that
 * cannot be read leaves the status as it was and lets its freshness run out;
 * an issuer record that cannot be found suspends acceptance; an issuer
 * status this code does not know is revoked.
 */
import type postgres from 'postgres';
import { config } from '../../config.js';
import { queries } from '../../db/client.js';
import { logger, type AppLogger } from '../logger.js';
import { cascadeGrantAction, resumeSuspendedGrants } from '../revocation/cascade.js';
import { acceptanceListUriPrefix } from './acceptance-status.js';
import { AttestationError } from './attestation-jws.js';
import {
  applyAcceptanceDecision,
  attestationSigningKid,
  readIssuerStatusListEntries,
  recordIssuerStatusAttempts,
  recordIssuerStatusReads,
  withdrawForRevokedKey,
  type AcceptanceDecision,
  type IssuerStatus,
} from './attestations.js';
import { statusPollMinIntervalMs } from './status-poll-config.js';
import { effectiveIssuerStatus, getAccreditedIssuer, type IssuerStatus as IssuerRecordStatus } from './issuers.js';
import {
  registryAcceptanceChangesTotal,
  registryCascadeGrantsTotal,
  registryReconcileFailuresTotal,
  registryReconcileRunsTotal,
  registryStatusFlipsTotal,
  registryStatusListPollFailuresTotal,
  registryStatusListPollsTotal,
  registryStatusListsStale,
  registryStatusPollLagSeconds,
} from './reconciliation-metrics.js';

type Sql = ReturnType<typeof postgres>;

// ── Configuration ──────────────────────────────────────────────────────────────

export {
  DEFAULT_POLL_MIN_INTERVAL_MS,
  DEV_POLL_MIN_INTERVAL_FLOOR_MS,
  MAX_POLL_MIN_INTERVAL_MS,
  POLL_MIN_INTERVAL_ENV,
  PRODUCTION_POLL_MIN_INTERVAL_FLOOR_MS,
  statusPollMinIntervalConfigError,
  statusPollMinIntervalMs,
} from './status-poll-config.js';

/** Lists read in one run; the rest are due in the next. */
export const MAX_LISTS_PER_RUN = 200;
/** Lists fetched at once. */
export const POLL_CONCURRENCY = 8;
/** Rows each decision or cascade query takes in one run. */
export const DECISION_BATCH = 500;
/** How long after a kid is revoked the loop keeps looking for attestations it signed. */
export const KEY_REVOCATION_SWEEP_SECONDS = 86_400;
/**
 * The advisory lock key, hashed the way the migration lock is
 * (hashtextextended(key, 0)). One key for every instance: whoever holds it
 * reconciles.
 */
export const RECONCILIATION_LOCK_KEY = 'grantex:registry-status-reconciliation';

const FETCH_REASONS = new Set(['unreachable', 'http_status', 'content_type', 'too_large', 'dev_map_refused']);

/**
 * How often a run starts: four times per minimum interval, and never more
 * often than every 250 ms. A list is read one tick before its last read goes
 * stale, so a timely read never lets it lapse.
 */
export function reconciliationTickMs(minIntervalMs: number): number {
  return Math.max(250, Math.floor(minIntervalMs / 4));
}

/** A delay uniform in [0, boundMs), so instances started by one deploy do not all start together. */
export function reconciliationStartDelayMs(boundMs: number, random: () => number = Math.random): number {
  if (!(boundMs > 0)) return 0;
  return Math.min(boundMs - 1, Math.max(0, Math.floor(random() * boundMs)));
}

// ── The registry's decision ────────────────────────────────────────────────────

export interface AcceptanceInputs {
  /** What the issuer's list said at the registry's last read. */
  issuerStatus: IssuerStatus;
  /** Until when that read counts (registry_attestations.issuer_status_fresh_until). */
  issuerStatusFreshUntil: Date;
  issuer: { status: IssuerRecordStatus; suspendedEffectiveFrom: Date | null };
}

/**
 * The acceptance entry an accepted attestation should have now.
 *
 * - The passport is revoked on the issuer's list: INVALID. Final, as the
 *   list's own INVALID is (draft-ietf-oauth-status-list-21 §7.1). Any issuer
 *   status this code does not know reads as revoked.
 * - The issuer is suspended (from its effective time) or withdrawn:
 *   SUSPENDED. An operator can reinstate an issuer, so its attestations are
 *   suspended rather than ended, and come back with it.
 * - The passport is suspended on the issuer's list: SUSPENDED.
 * - The passport is valid on a read that is still fresh: VALID, which is how
 *   a reinstatement returns.
 * - Valid on a read whose freshness has run out: null, the entry stays as it
 *   is. An old read is no evidence that the passport is valid now, so a
 *   SUSPENDED entry (an issuer reinstated while its list was unreadable, or
 *   not read because it was suspended) waits for a fresh read before it is
 *   VALID and its grants are resumed. A VALID entry stays VALID: the
 *   issuance and refresh checks refuse a stale read with status_stale on
 *   their own (spec/passport-binding.md), and an unreadable list is not a
 *   reason to suspend.
 */
export function deriveAcceptance(inputs: AcceptanceInputs, now: Date): AcceptanceDecision | null {
  if (inputs.issuerStatus !== 'valid' && inputs.issuerStatus !== 'suspended') return { status: 'invalid', cause: 'issuer_status' };
  if (effectiveIssuerStatus(inputs.issuer, now) !== 'active') return { status: 'suspended', cause: 'issuer' };
  if (inputs.issuerStatus === 'suspended') return { status: 'suspended', cause: 'issuer_status' };
  // Fail closed: a read that no longer counts never makes an entry VALID.
  if (!(inputs.issuerStatusFreshUntil.getTime() > now.getTime())) return null;
  return { status: 'valid', cause: 'issuer_status' };
}

// ── Step 1: poll ───────────────────────────────────────────────────────────────

interface DueList {
  issuer_id: string;
  entity_id: string;
  status_list_uri: string;
  due_at: Date;
}

export interface PollResult {
  polled: number;
  failed: number;
  flips: number;
}

function failureReason(err: unknown): string {
  if (err instanceof AttestationError) {
    if (FETCH_REASONS.has(err.reason)) return err.reason;
    if (err.reason === 'status_list_not_under_base') return 'not_under_base';
    return 'invalid';
  }
  return 'error';
}

async function pollList(sql: Sql, list: DueList, now: Date, log: AppLogger): Promise<{ ok: boolean; flips: number }> {
  const q = queries(sql);
  const rows = await q<{ id: string; status_list_idx: number }[]>`
    SELECT id, status_list_idx FROM registry_attestations
    WHERE issuer_id = ${list.issuer_id} AND status_list_uri = ${list.status_list_uri}
      AND state = 'accepted' AND issuer_status <> 'revoked' AND exp > ${now}`;
  const ids = rows.map((row) => row.id);
  const fail = async (reason: string, err: unknown) => {
    // Nothing about the status is written: only the attempt, so the list is
    // tried again after the minimum interval and its last good read runs
    // out on its own. Counted and logged, never read as any status.
    await recordIssuerStatusAttempts(sql, ids, now);
    registryStatusListPollsTotal.inc({ outcome: 'failed' });
    registryStatusListPollFailuresTotal.inc({ reason });
    log.warn({ err, worker: 'registry-status-reconciliation', issuerId: list.issuer_id, reason },
      'could not read an issuer status list');
    return { ok: false, flips: 0 };
  };
  if (rows.length === 0) return { ok: true, flips: 0 };
  const issuer = await getAccreditedIssuer(sql, list.entity_id);
  if (!issuer) return fail('issuer_unknown', null);
  let read: { values: Map<number, number | null>; freshUntil: Date };
  try {
    read = await readIssuerStatusListEntries(sql, issuer, list.status_list_uri, rows.map((row) => Number(row.status_list_idx)), now);
  } catch (err) {
    return fail(failureReason(err), err);
  }
  const reads: Array<{ id: string; value: number }> = [];
  const missing: string[] = [];
  for (const row of rows) {
    const value = read.values.get(Number(row.status_list_idx));
    if (value === undefined || value === null) missing.push(row.id);
    else reads.push({ id: row.id, value });
  }
  const flips = await recordIssuerStatusReads(sql, reads, read.freshUntil, now);
  if (missing.length > 0) {
    // An entry the list does not have cannot be read: as for an unreadable list.
    await recordIssuerStatusAttempts(sql, missing, now);
    registryStatusListPollFailuresTotal.inc({ reason: 'invalid' }, missing.length);
  }
  registryStatusListPollsTotal.inc({ outcome: 'ok' });
  for (const flip of flips) registryStatusFlipsTotal.inc({ to: flip.to });
  if (flips.length > 0) {
    log.info({ worker: 'registry-status-reconciliation', issuerId: list.issuer_id, flips: flips.length },
      'issuer status list entries changed');
  }
  return { ok: true, flips: flips.length };
}

/** Step 1. `force` reads every list now, whatever its schedule (operators and tests). */
export async function pollDueStatusLists(
  sql: Sql,
  options: { now: Date; minIntervalMs: number; force?: boolean; log?: AppLogger },
): Promise<PollResult> {
  const { now, minIntervalMs } = options;
  const log = options.log ?? logger;
  const tickMs = reconciliationTickMs(minIntervalMs);
  const force = options.force === true;
  // Per attestation: due one tick before its read goes stale, and not before
  // the minimum interval has passed since the last attempt. A list is due
  // when any attestation on it is. Only issuers active now are read: a
  // withdrawn issuer has no keys to verify a list with, and a suspended
  // issuer's list is not acted on (an operator suspends an issuer that
  // publishes a wrong list so that no flip on it revokes anything while it
  // is fixed). Step 2 suspends their attestations instead, and a
  // reinstatement waits for the first fresh read (deriveAcceptance).
  const due = await queries(sql)<DueList[]>`
    SELECT a.issuer_id, i.entity_id, a.status_list_uri,
           MIN(GREATEST(
             a.issuer_status_fresh_until - (${tickMs}::int * INTERVAL '1 millisecond'),
             a.issuer_status_checked_at + (${minIntervalMs}::int * INTERVAL '1 millisecond')
           )) AS due_at
    FROM registry_attestations a
    JOIN accredited_issuers i ON i.id = a.issuer_id
    WHERE a.state = 'accepted' AND a.issuer_status <> 'revoked' AND a.exp > ${now}
      AND (i.status = 'active' OR (i.status = 'suspended' AND i.suspended_effective_from > ${now}))
    GROUP BY a.issuer_id, i.entity_id, a.status_list_uri
    HAVING ${force}::boolean OR MIN(GREATEST(
             a.issuer_status_fresh_until - (${tickMs}::int * INTERVAL '1 millisecond'),
             a.issuer_status_checked_at + (${minIntervalMs}::int * INTERVAL '1 millisecond')
           )) <= ${now}
    ORDER BY due_at, a.status_list_uri
    LIMIT ${MAX_LISTS_PER_RUN}`;

  let lagMs = 0;
  for (const list of due) lagMs = Math.max(lagMs, now.getTime() - new Date(list.due_at).getTime());
  registryStatusPollLagSeconds.set(force ? 0 : lagMs / 1000);

  const result: PollResult = { polled: 0, failed: 0, flips: 0 };
  let next = 0;
  const workers = Array.from({ length: Math.min(POLL_CONCURRENCY, due.length) }, async () => {
    while (next < due.length) {
      const list = due[next]!;
      next += 1;
      let outcome: { ok: boolean; flips: number };
      try {
        outcome = await pollList(sql, list, now, log);
      } catch (err) {
        // The registry's own database failed while this list was recorded.
        // It is this list's failure, not the run's: the other workers finish
        // their lists before the run goes on and releases its lock. Whatever
        // was not written stays as it was, so the recorded status keeps
        // running out rather than being read as any status (fail closed).
        registryStatusListPollsTotal.inc({ outcome: 'failed' });
        registryStatusListPollFailuresTotal.inc({ reason: 'error' });
        log.error({ err, worker: 'registry-status-reconciliation', issuerId: list.issuer_id },
          'could not record an issuer status list read; it is tried again next tick');
        outcome = { ok: false, flips: 0 };
      }
      result.polled += 1;
      if (!outcome.ok) result.failed += 1;
      result.flips += outcome.flips;
    }
  });
  await Promise.all(workers);
  return result;
}

// ── Step 2 and 3: decide and cascade ───────────────────────────────────────────

export interface DecisionScope {
  /** Limit to one issuer (the operator's PATCH); every issuer when absent. */
  issuerId?: string;
  now?: Date;
  log?: AppLogger;
}

export interface DecisionResult {
  attestationsWithdrawn: number;
  acceptanceChanges: number;
  grantsRevoked: number;
  grantsSuspended: number;
  grantsResumed: number;
}

/** Attestations signed with a revoked kid of their issuer: withdrawn (INVALID, final). */
async function withdrawRevokedKeyAttestations(sql: Sql, scope: DecisionScope, now: Date): Promise<number> {
  const q = queries(sql);
  // At the operator's PATCH every accepted attestation of the issuer is
  // checked; the loop looks only at kids revoked in the last day, as the
  // retry of a PATCH whose cascade failed. An attestation received after a
  // kid was revoked cannot be signed with it (ingestion refuses the kid).
  const since = scope.issuerId !== undefined ? new Date(0) : new Date(now.getTime() - KEY_REVOCATION_SWEEP_SECONDS * 1000);
  let withdrawn = 0;
  let after = '';
  for (;;) {
    const rows = await q<{ id: string; jws: string; kids: string[] }[]>`
      SELECT a.id, a.jws, ARRAY_AGG(r.kid) AS kids
      FROM registry_attestations a
      JOIN accredited_issuer_revoked_keys r ON r.issuer_id = a.issuer_id
      WHERE a.state = 'accepted' AND r.revoked_at >= ${since} AND a.id > ${after}
        AND (${scope.issuerId ?? null}::text IS NULL OR a.issuer_id = ${scope.issuerId ?? null})
      GROUP BY a.id, a.jws
      ORDER BY a.id
      LIMIT ${DECISION_BATCH}`;
    for (const row of rows) {
      const kid = attestationSigningKid(row.jws);
      // A stored JWS whose kid cannot be read (ingestion never stores one)
      // cannot be shown to be signed by a key still in force: withdraw it.
      if (kid !== null && !row.kids.includes(kid)) continue;
      if (await withdrawForRevokedKey(sql, row.id, kid ?? '(unreadable)', now)) {
        withdrawn += 1;
        registryAcceptanceChangesTotal.inc({ to: 'invalid', cause: 'key_revoked' });
      }
    }
    if (rows.length < DECISION_BATCH) return withdrawn;
    after = rows[rows.length - 1]!.id;
  }
}

/** Accepted attestations whose acceptance entry is not what deriveAcceptance says. */
async function alignAcceptance(sql: Sql, scope: DecisionScope, now: Date): Promise<number> {
  const q = queries(sql);
  const prefix = acceptanceListUriPrefix();
  // Candidates only: an attestation that reads valid, of an active issuer,
  // with a VALID entry, needs nothing. The decision itself is taken again
  // inside the write's transaction, on what the rows say then.
  let changed = 0;
  let after = '';
  for (;;) {
    const rows = await q<{ id: string }[]>`
      SELECT a.id
      FROM registry_attestations a
      JOIN accredited_issuers i ON i.id = a.issuer_id
      JOIN registry_acceptance_entries e
        ON left(a.acceptance_list_uri, ${prefix.length}) = ${prefix}
       AND e.list_id = substr(a.acceptance_list_uri, ${prefix.length + 1})
       AND e.idx = a.acceptance_list_idx
      WHERE a.state = 'accepted' AND a.exp > ${now} AND e.status <> 1
        AND (e.status <> 0 OR a.issuer_status <> 'valid' OR i.status <> 'active')
        AND a.id > ${after}
        AND (${scope.issuerId ?? null}::text IS NULL OR a.issuer_id = ${scope.issuerId ?? null})
      ORDER BY a.id
      LIMIT ${DECISION_BATCH}`;
    for (const row of rows) {
      const change = await applyAcceptanceDecision(sql, row.id,
        (record, issuer) => deriveAcceptance({
          issuerStatus: record.issuerStatus, issuerStatusFreshUntil: record.issuerStatusFreshUntil, issuer,
        }, now), now);
      if (change) {
        changed += 1;
        registryAcceptanceChangesTotal.inc({ to: change.to.status, cause: change.to.cause });
      }
    }
    if (rows.length < DECISION_BATCH) return changed;
    after = rows[rows.length - 1]!.id;
  }
}

function byDeveloper(rows: ReadonlyArray<{ grant_id: string; developer_id: string }>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.developer_id) ?? [];
    list.push(row.grant_id);
    grouped.set(row.developer_id, list);
  }
  return grouped;
}

/** Bound grants follow their acceptance entry: INVALID revokes, SUSPENDED suspends, VALID resumes. */
async function cascadeBoundGrants(sql: Sql, scope: DecisionScope & { issuerEntityId?: string }, now: Date, log: AppLogger) {
  const q = queries(sql);
  const prefix = acceptanceListUriPrefix();
  const issuer = scope.issuerEntityId ?? null;
  const counts = { revoked: 0, suspended: 0, resumed: 0 };

  for (const action of ['revoke', 'suspend'] as const) {
    const rows = await q<{ grant_id: string; developer_id: string }[]>`
      SELECT b.grant_id, b.developer_id
      FROM registry_acceptance_entries e
      JOIN grant_passport_bindings b
        ON b.acceptance_list_uri = ${prefix} || e.list_id AND b.acceptance_list_idx = e.idx
      JOIN grants g ON g.id = b.grant_id AND g.developer_id = b.developer_id
      WHERE e.status = ${action === 'revoke' ? 1 : 2}
        AND g.status = ANY(${action === 'revoke' ? ['active', 'suspended'] : ['active']})
        AND g.expires_at > ${now}
        AND (${issuer}::text IS NULL OR b.issuer_entity_id = ${issuer})
      ORDER BY b.grant_id
      LIMIT ${DECISION_BATCH}`;
    for (const [developerId, rootGrantIds] of byDeveloper(rows)) {
      const outcome = await cascadeGrantAction(sql, {
        developerId,
        rootGrantIds,
        action,
        cause: 'registry',
        reason: action === 'revoke'
          ? 'the registry no longer accepts the bound Agent Passport'
          : 'the registry has suspended its acceptance of the bound Agent Passport',
      });
      const n = outcome.affected.length;
      if (action === 'revoke') counts.revoked += n;
      else counts.suspended += n;
      registryCascadeGrantsTotal.inc({ action: action === 'revoke' ? 'revoked' : 'suspended' }, n);
      if (n > 0) {
        log.warn({ worker: 'registry-status-reconciliation', developerId, action, grants: n },
          'bound grants follow the registry\'s acceptance of their passport');
      }
    }
  }

  // Only suspensions the registry made come back, and only once the entry
  // is VALID again: a grant suspended for any other reason stays as it is.
  // Roots still suspended whose parent is active (or that have none); one
  // whose parent is not active cannot be resumed yet (resumeSuspendedGrants
  // refuses it and keeps its rows), so it is left out, and the query pages
  // by root so that roots refused further up the chain never hold up the
  // ones after them.
  let after = '';
  for (;;) {
    const resumable = await q<{ grant_id: string; developer_id: string }[]>`
      SELECT DISTINCT s.root_grant_id AS grant_id, s.developer_id
      FROM grant_suspensions s
      JOIN grants g ON g.id = s.root_grant_id AND g.developer_id = s.developer_id AND g.status = 'suspended'
      LEFT JOIN grants p ON p.id = g.parent_grant_id AND p.developer_id = g.developer_id
      JOIN grant_passport_bindings b ON b.grant_id = s.root_grant_id AND b.developer_id = s.developer_id
      JOIN registry_acceptance_entries e
        ON left(b.acceptance_list_uri, ${prefix.length}) = ${prefix}
       AND e.list_id = substr(b.acceptance_list_uri, ${prefix.length + 1})
       AND e.idx = b.acceptance_list_idx
      WHERE s.cause = 'registry' AND e.status = 0
        AND (g.parent_grant_id IS NULL OR p.status = 'active')
        AND s.root_grant_id > ${after}
        AND (${issuer}::text IS NULL OR b.issuer_entity_id = ${issuer})
      ORDER BY s.root_grant_id
      LIMIT ${DECISION_BATCH}`;
    for (const row of resumable) {
      const outcome = await resumeSuspendedGrants(sql, row.developer_id, row.grant_id, { cause: 'registry' });
      counts.resumed += outcome.grantIds.length;
      registryCascadeGrantsTotal.inc({ action: 'resumed' }, outcome.grantIds.length);
    }
    if (resumable.length < DECISION_BATCH) return counts;
    after = resumable[resumable.length - 1]!.grant_id;
  }
}

/**
 * Steps 2 and 3, for every issuer or for one (the operator's PATCH). Throws
 * on a database error: the caller logs and counts it, and the loop runs the
 * same steps again at its next tick.
 */
export async function applyRegistryDecisions(sql: Sql, scope: DecisionScope = {}): Promise<DecisionResult> {
  const now = scope.now ?? new Date();
  const log = scope.log ?? logger;
  let issuerEntityId: string | undefined;
  if (scope.issuerId !== undefined) {
    const [row] = await queries(sql)`SELECT entity_id FROM accredited_issuers WHERE id = ${scope.issuerId}`;
    if (!row) return { attestationsWithdrawn: 0, acceptanceChanges: 0, grantsRevoked: 0, grantsSuspended: 0, grantsResumed: 0 };
    issuerEntityId = row['entity_id'] as string;
  }
  const attestationsWithdrawn = await withdrawRevokedKeyAttestations(sql, scope, now);
  const acceptanceChanges = await alignAcceptance(sql, scope, now);
  const grants = await cascadeBoundGrants(sql, { ...scope, ...(issuerEntityId !== undefined ? { issuerEntityId } : {}) }, now, log);
  return {
    attestationsWithdrawn,
    acceptanceChanges,
    grantsRevoked: grants.revoked,
    grantsSuspended: grants.suspended,
    grantsResumed: grants.resumed,
  };
}

/** Lists the loop reads whose best read has run out: nothing on them counts until one is read. */
async function countStaleLists(sql: Sql, now: Date): Promise<number> {
  const [row] = await queries(sql)`
    SELECT COUNT(*)::int AS n FROM (
      SELECT 1
      FROM registry_attestations a
      JOIN accredited_issuers i ON i.id = a.issuer_id
      WHERE a.state = 'accepted' AND a.issuer_status <> 'revoked' AND a.exp > ${now}
        AND (i.status = 'active' OR (i.status = 'suspended' AND i.suspended_effective_from > ${now}))
      GROUP BY a.issuer_id, a.status_list_uri
      HAVING MAX(a.issuer_status_fresh_until) <= ${now}
    ) stale`;
  return Number(row?.['n'] ?? 0);
}

// ── One run ────────────────────────────────────────────────────────────────────

export type ReconcileOutcome = 'complete' | 'skipped_locked' | 'failed' | 'disabled';

export interface ReconcileResult extends DecisionResult {
  outcome: ReconcileOutcome;
  listsPolled: number;
  listsFailed: number;
  flips: number;
}

export interface ReconcileOptions {
  now?: Date;
  minIntervalMs?: number;
  /** Read every list now, whatever its schedule. */
  force?: boolean;
}

function emptyResult(outcome: ReconcileOutcome): ReconcileResult {
  return {
    outcome, listsPolled: 0, listsFailed: 0, flips: 0,
    attestationsWithdrawn: 0, acceptanceChanges: 0, grantsRevoked: 0, grantsSuspended: 0, grantsResumed: 0,
  };
}

/**
 * One reconciliation run: poll, decide, cascade, on the instance holding
 * the lock. Never throws: a failed step is logged and counted, and the next
 * run does the same work again (every step is level-triggered).
 */
export async function reconcileRegistryStatusOnce(
  sql: Sql,
  log: AppLogger = logger,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (!config.registryStatusReconciliationEnabled) {
    registryReconcileRunsTotal.inc({ outcome: 'disabled' });
    return emptyResult('disabled');
  }
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? statusPollMinIntervalMs();
  let session: Awaited<ReturnType<Sql['reserve']>> | null = null;
  let locked = false;
  const result = emptyResult('complete');
  try {
    // A session lock is taken, used and released on one connection, so the
    // run reserves one. If the instance dies mid-run the connection closes
    // and Postgres releases the lock with it.
    session = await sql.reserve();
    const [row] = await session<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${RECONCILIATION_LOCK_KEY}, 0)) AS locked`;
    locked = row?.locked === true;
    if (!locked) {
      // Another instance reconciles; this one reports nothing of its own, so
      // max() over instances is the lock holder's view.
      registryStatusPollLagSeconds.set(0);
      registryStatusListsStale.set(0);
      registryReconcileRunsTotal.inc({ outcome: 'skipped_locked' });
      return emptyResult('skipped_locked');
    }

    try {
      const polled = await pollDueStatusLists(sql, { now, minIntervalMs, force: options.force === true, log });
      result.listsPolled = polled.polled;
      result.listsFailed = polled.failed;
      result.flips = polled.flips;
    } catch (err) {
      // The due lists could not be listed or recorded: nothing was read as
      // any status, and the decisions below still run on what is recorded.
      result.outcome = 'failed';
      registryReconcileFailuresTotal.inc({ step: 'poll' });
      log.error({ err, worker: 'registry-status-reconciliation' }, 'registry status poll failed; it runs again next tick');
    }
    try {
      Object.assign(result, await applyRegistryDecisions(sql, { now, log }));
    } catch (err) {
      result.outcome = 'failed';
      registryReconcileFailuresTotal.inc({ step: 'decide' });
      log.error({ err, worker: 'registry-status-reconciliation' },
        'registry acceptance decisions or their cascade failed; they run again next tick');
    }
    registryStatusListsStale.set(await countStaleLists(sql, new Date()));
    registryReconcileRunsTotal.inc({ outcome: result.outcome });
    return result;
  } catch (err) {
    registryReconcileRunsTotal.inc({ outcome: 'failed' });
    log.error({ err, worker: 'registry-status-reconciliation' }, 'registry status reconciliation failed; it runs again next tick');
    return { ...result, outcome: 'failed' };
  } finally {
    if (session) {
      try {
        if (locked) await session`SELECT pg_advisory_unlock(hashtextextended(${RECONCILIATION_LOCK_KEY}, 0))`;
      } catch (err) {
        // The connection goes back to the pool either way; a broken one has
        // already dropped the lock with it.
        log.warn({ err, worker: 'registry-status-reconciliation' }, 'could not release the reconciliation lock');
      } finally {
        session.release();
      }
    }
  }
}
