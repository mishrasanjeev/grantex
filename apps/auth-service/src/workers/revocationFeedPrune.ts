/**
 * Keeps `grant_revocation_events` bounded.
 *
 * The feed is append-only, and every cold start reads a snapshot, so without
 * pruning the table grows forever and every new client pays for it. Entries
 * are deleted only once the credential they are about has been expired longer
 * than `REVOCATION_FEED_RETENTION_HOURS`: an entry for a live credential is
 * the only thing standing between a revoked grant and a client that has not
 * heard about it.
 *
 * The triggers fill the table whether or not the feed is served, so the first
 * prune after the feed turns on can face a large backlog (FINDINGS G-66).
 * A run therefore:
 *
 * - deletes in batches of `PRUNE_BATCH_SIZE`, each its own short statement,
 *   pausing between batches so it never holds locks or a transaction for long;
 * - stops after `PRUNE_MAX_BATCHES` batches or `PRUNE_MAX_RUN_MS`, whichever
 *   comes first; the next run continues where it stopped;
 * - runs on one instance at a time: it takes a session advisory lock on
 *   `PRUNE_LOCK_KEY` and skips the run when another instance holds it;
 * - starts, on each instance, after a random delay of up to
 *   `REVOCATION_FEED_PRUNE_JITTER_SECONDS`, then hourly from there, so
 *   instances started by one deploy do not all reach the database at once.
 *
 * Pruning is housekeeping, not an authority path: nothing is allowed or denied
 * on its result. A failed run is logged and retried next interval, and never
 * throws into the service.
 *
 * Runs only while the feed is enabled.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../lib/logger.js';
import { pruneFeedBatch } from '../lib/revocation-feed/store.js';
import { revocationFeedSettings } from '../lib/revocation-feed/settings.js';
import { revocationFeedPruneRunsTotal, revocationFeedPrunedTotal } from '../lib/revocation-feed/metrics.js';

type Sql = ReturnType<typeof postgres>;

const PRUNE_INTERVAL_MS = 60 * 60_000;

/** Rows per DELETE statement. */
export const PRUNE_BATCH_SIZE = 1_000;
/** Batches per run: at most 50 000 rows per run, one run an hour per instance. */
export const PRUNE_MAX_BATCHES = 50;
/** Wall-clock budget of one run; the batch in flight when it runs out finishes. */
export const PRUNE_MAX_RUN_MS = 60_000;
/** Pause between batches, so other work on the table is never starved. */
export const PRUNE_BATCH_PAUSE_MS = 100;
/**
 * The advisory lock key, hashed the way the migration lock is
 * (`hashtextextended('grantex:migrations', 0)` in db/migrate.ts). One key for
 * every instance of the deployment: whoever holds it prunes.
 */
export const PRUNE_LOCK_KEY = 'grantex:revocation-feed-prune';

export type PruneOutcome = 'complete' | 'capped' | 'skipped_locked' | 'failed' | 'disabled';

export interface PruneRunResult {
  outcome: PruneOutcome;
  deleted: number;
  batches: number;
}

export interface PruneRunOptions {
  batchSize?: number;
  maxBatches?: number;
  maxRunMs?: number;
  /** How the run yields between batches (tests pass a no-op or a slow one). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let firstRun: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;

function record(result: PruneRunResult): PruneRunResult {
  revocationFeedPruneRunsTotal.inc({ outcome: result.outcome });
  if (result.deleted > 0) revocationFeedPrunedTotal.inc(result.deleted);
  return result;
}

export async function pruneRevocationFeedOnce(
  sql: Sql,
  log: AppLogger = logger,
  options: PruneRunOptions = {},
): Promise<PruneRunResult> {
  const settings = revocationFeedSettings();
  if (!settings.enabled) return { outcome: 'disabled', deleted: 0, batches: 0 };
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PRUNE_MAX_BATCHES;
  const maxRunMs = options.maxRunMs ?? PRUNE_MAX_RUN_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  let deleted = 0;
  let batches = 0;
  let session: Awaited<ReturnType<Sql['reserve']>> | null = null;
  let locked = false;
  try {
    // A session lock must be taken, used and released on one connection, so
    // the run reserves one from the pool. If the instance dies mid-run the
    // connection closes and Postgres releases the lock with it.
    session = await sql.reserve();
    const [row] = await session<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${PRUNE_LOCK_KEY}, 0)) AS locked`;
    locked = row?.locked === true;
    if (!locked) {
      const result = record({ outcome: 'skipped_locked', deleted: 0, batches: 0 });
      log.info({ feed: 'revocation', ...result }, 'revocation feed prune skipped: another instance is pruning');
      return result;
    }

    const started = now();
    for (;;) {
      const removed = await pruneFeedBatch(session as unknown as Sql, settings.retentionHours, batchSize);
      batches += 1;
      deleted += removed;
      if (removed < batchSize) {
        const result = record({ outcome: 'complete', deleted, batches });
        log.info({ feed: 'revocation', ...result }, 'pruned revocation feed entries past their retention');
        return result;
      }
      if (batches >= maxBatches || now() - started >= maxRunMs) {
        const result = record({ outcome: 'capped', deleted, batches });
        log.info(
          { feed: 'revocation', ...result },
          'pruned revocation feed entries past their retention; the rest is left to the next run',
        );
        return result;
      }
      await sleep(PRUNE_BATCH_PAUSE_MS);
    }
  } catch (err) {
    // Batches already deleted stay deleted (each committed on its own); the
    // next run picks up the rest.
    const result = record({ outcome: 'failed', deleted, batches });
    log.error({ err, feed: 'revocation', ...result }, 'revocation feed prune failed; it runs again next interval');
    return result;
  } finally {
    if (session) {
      try {
        if (locked) await session`SELECT pg_advisory_unlock(hashtextextended(${PRUNE_LOCK_KEY}, 0))`;
      } catch (err) {
        // The session goes back to the pool either way; a broken connection
        // has already dropped the lock with it.
        log.warn({ err, feed: 'revocation' }, 'could not release the revocation feed prune lock');
      } finally {
        session.release();
      }
    }
  }
}

/** A delay uniform in [0, jitterSeconds) seconds, in milliseconds. */
export function pruneStartDelayMs(jitterSeconds: number, random: () => number = Math.random): number {
  if (!(jitterSeconds > 0)) return 0;
  const span = jitterSeconds * 1_000;
  return Math.min(span - 1, Math.max(0, Math.floor(random() * span)));
}

export function startRevocationFeedPruneWorker(
  sql: Sql,
  log: AppLogger = logger,
  intervalMs: number = PRUNE_INTERVAL_MS,
  options: { random?: () => number } = {},
): void {
  if (firstRun || timer) return;
  const delay = pruneStartDelayMs(revocationFeedSettings().pruneJitterSeconds, options.random);
  // The hourly timer is armed at the first run, not at boot, so each
  // instance keeps its own offset instead of every instance of a deploy
  // pruning in the same minute each hour.
  firstRun = setTimeout(() => {
    firstRun = null;
    void pruneRevocationFeedOnce(sql, log);
    timer = setInterval(() => void pruneRevocationFeedOnce(sql, log), intervalMs);
    timer.unref?.();
  }, delay);
  firstRun.unref?.();
}

export function stopRevocationFeedPruneWorker(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
