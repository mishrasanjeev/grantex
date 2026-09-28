// SPDX-License-Identifier: Apache-2.0
/**
 * Rereads accredited issuers' Token Status Lists for accepted registry
 * attestations before the registry's last read of each goes stale.
 *
 * An attestation counts toward a computed trust level only while the
 * registry's last read of its issuer's list showed VALID and is still fresh
 * (registry_attestations.issuer_status_fresh_until: the list's exp, the time
 * of reading plus its ttl, at most a day; lib/registry/trust-level.ts). This
 * worker keeps those reads current, so a revocation or suspension on the
 * issuer's list reaches the level within the list's ttl without anyone
 * calling recheckIssuerStatus by hand.
 *
 * Each run takes up to `RECHECK_BATCH_SIZE` accepted, unexpired attestations
 * whose read is stale or goes stale within `RECHECK_AHEAD_SECONDS`, least
 * recently tried first, and rereads each (lib/registry/attestations.ts
 * recheckIssuerStatus). A list that cannot be read records the attempt and
 * leaves the status and its freshness as they were, so the attestation stops
 * counting when the freshness runs out: the worker failing is a fail-closed
 * outcome, never a pass. Revoked entries are final and not reread.
 *
 * Instances do not coordinate: two rereading one attestation at once each
 * write what the list said, under the registry chain's lock, and only a
 * change of status is audited, so the result is the same. A run does not
 * start while the previous one on this instance is still going.
 *
 * index.ts starts it only while REGISTRY_STATUS_RECONCILIATION_ENABLED is
 * off; with the flag on, workers/registryStatusReconciliation.ts reads each
 * list once for every attestation on it and also cascades.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../lib/logger.js';
import { recheckIssuerStatus } from '../lib/registry/attestations.js';

type Sql = ReturnType<typeof postgres>;

/** How often a run starts. */
export const RECHECK_INTERVAL_MS = 60_000;
/** Reread a list this long before the last read goes stale, so a timely reread keeps the level steady. */
export const RECHECK_AHEAD_SECONDS = 120;
/** Attestations per run; the rest wait for the next run. */
export const RECHECK_BATCH_SIZE = 100;

export interface RecheckRunResult {
  /** complete: every due row was tried; failed: the due rows could not be listed. */
  outcome: 'complete' | 'failed';
  checked: number;
  changed: number;
  failed: number;
}

export interface RecheckRunOptions {
  batchSize?: number;
  now?: () => Date;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function recheckIssuerStatusesOnce(
  sql: Sql,
  log: AppLogger = logger,
  options: RecheckRunOptions = {},
): Promise<RecheckRunResult> {
  const now = (options.now ?? (() => new Date()))();
  const batchSize = options.batchSize ?? RECHECK_BATCH_SIZE;
  const dueBy = new Date(now.getTime() + RECHECK_AHEAD_SECONDS * 1000);
  let due: Array<{ id: string; issuer_status: string }>;
  try {
    due = await sql<Array<{ id: string; issuer_status: string }>>`
      SELECT id, issuer_status FROM registry_attestations
      WHERE state = 'accepted' AND issuer_status <> 'revoked'
        AND issuer_status_fresh_until <= ${dueBy} AND exp > ${now}
      ORDER BY issuer_status_checked_at, id
      LIMIT ${batchSize}`;
  } catch (err) {
    // Nothing was reread, so every stale read stays stale and stops counting.
    log.error({ err, worker: 'registry-issuer-status-recheck' }, 'could not list attestations due for an issuer status recheck');
    return { outcome: 'failed', checked: 0, changed: 0, failed: 0 };
  }
  let checked = 0;
  let changed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const status = await recheckIssuerStatus(sql, row.id, now);
      checked += 1;
      if (status !== row.issuer_status) changed += 1;
    } catch (err) {
      // The attempt is recorded and the stored status is kept; it stops
      // counting when its freshness runs out. The next run tries again.
      failed += 1;
      log.warn({ err, worker: 'registry-issuer-status-recheck', attestationId: row.id },
        'could not reread the issuer status list of an attestation');
    }
  }
  if (due.length > 0) {
    log.info({ worker: 'registry-issuer-status-recheck', checked, changed, failed }, 'reread issuer status lists');
  }
  return { outcome: 'complete', checked, changed, failed };
}

export function startRegistryIssuerStatusRecheckWorker(
  sql: Sql,
  log: AppLogger = logger,
  intervalMs: number = RECHECK_INTERVAL_MS,
): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void recheckIssuerStatusesOnce(sql, log).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopRegistryIssuerStatusRecheckWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
