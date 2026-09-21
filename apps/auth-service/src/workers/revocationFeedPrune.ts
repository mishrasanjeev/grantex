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
 * Runs only while the feed is enabled.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../lib/logger.js';
import { pruneFeed } from '../lib/revocation-feed/store.js';
import { revocationFeedSettings } from '../lib/revocation-feed/settings.js';

const PRUNE_INTERVAL_MS = 60 * 60_000;

let timer: NodeJS.Timeout | null = null;

export async function pruneRevocationFeedOnce(
  sql: ReturnType<typeof postgres>,
  log: AppLogger = logger,
): Promise<number> {
  const settings = revocationFeedSettings();
  if (!settings.enabled) return 0;
  try {
    const deleted = await pruneFeed(sql, settings.retentionHours);
    if (deleted > 0) {
      log.info({ feed: 'revocation', deleted }, 'pruned revocation feed entries past their retention');
    }
    return deleted;
  } catch (err) {
    log.error({ err, feed: 'revocation' }, 'revocation feed prune failed; it runs again next interval');
    return 0;
  }
}

export function startRevocationFeedPruneWorker(
  sql: ReturnType<typeof postgres>,
  log: AppLogger = logger,
  intervalMs: number = PRUNE_INTERVAL_MS,
): void {
  if (timer) return;
  void pruneRevocationFeedOnce(sql, log);
  timer = setInterval(() => void pruneRevocationFeedOnce(sql, log), intervalMs);
  timer.unref?.();
}

export function stopRevocationFeedPruneWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
