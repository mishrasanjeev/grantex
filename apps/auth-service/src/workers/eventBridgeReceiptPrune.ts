/**
 * Keeps `event_bridge_receipts` bounded without re-opening the replay window.
 *
 * The receipts table is the event bridge's replay store: while a delivery's id
 * is in it, a replay of that delivery is refused. Deleting a receipt too early
 * therefore makes an old delivery acceptable again — so a receipt is only
 * removed once it is older than the window in which its own source would still
 * accept the delivery at all, and never sooner than
 * `EVENT_BRIDGE_RECEIPT_RETENTION_HOURS`.
 *
 * That window is measured from `received_at`, and it is **twice** the
 * verifier's tolerance, not once. A webhook's timestamp check is two-sided
 * (`|now - timestamp| > tolerance`), so a delivery may arrive with a
 * timestamp up to `tolerance` in the future and stays acceptable until
 * `timestamp + tolerance` — that is `received_at + 2 × tolerance`. A SET is
 * accepted while `now - iat <= max_age + skew` and its `iat` may be up to
 * `skew` ahead, so its horizon is `received_at + max_age + 2 × skew`.
 * Deleting a receipt before its horizon makes the delivery replayable with a
 * signature that still verifies.
 *
 * Runs only while the event bridge is enabled.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../lib/logger.js';
import { eventBridgeSettings } from '../lib/event-bridge/settings.js';

const PRUNE_INTERVAL_MS = 60 * 60_000;
/** The skew `verifySecurityEventToken` allows, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

let timer: NodeJS.Timeout | null = null;

export async function pruneEventBridgeReceiptsOnce(
  sql: ReturnType<typeof postgres>,
  log: AppLogger = logger,
): Promise<number> {
  const settings = eventBridgeSettings();
  if (!settings.enabled) return 0;
  try {
    // The window is read from the source the receipt belongs to, so raising a
    // source's tolerance automatically keeps its receipts longer.
    const rows = await sql<{ deleted: string }[]>`
      WITH removed AS (
        DELETE FROM event_bridge_receipts r
         USING event_bridge_sources s
         WHERE s.id = r.source_id
           AND r.received_at < NOW()
             - GREATEST(
                 make_interval(hours => ${settings.receiptRetentionHours}),
                 make_interval(secs => GREATEST(
                   2 * s.tolerance_seconds,
                   s.max_age_seconds + 2 * ${CLOCK_SKEW_SECONDS}
                 ))
               )
        RETURNING r.event_id
      )
      SELECT COUNT(*)::text AS deleted FROM removed`;
    const deleted = Number(rows[0]?.deleted ?? '0');
    if (deleted > 0) {
      log.info({ event_bridge: 'receipts_pruned', deleted }, 'pruned event bridge receipts past their replay window');
    }
    return deleted;
  } catch (err) {
    log.error({ err, event_bridge: 'receipts_pruned' }, 'event bridge receipt prune failed; it runs again next interval');
    return 0;
  }
}

export function startEventBridgeReceiptPruneWorker(
  sql: ReturnType<typeof postgres>,
  log: AppLogger = logger,
  intervalMs: number = PRUNE_INTERVAL_MS,
): void {
  if (timer) return;
  void pruneEventBridgeReceiptsOnce(sql, log);
  timer = setInterval(() => void pruneEventBridgeReceiptsOnce(sql, log), intervalMs);
  timer.unref?.();
}

export function stopEventBridgeReceiptPruneWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
