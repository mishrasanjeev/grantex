/**
 * What the callers of `runMigrations` do with its summary.
 *
 * Both of them used to discard it, on a service whose deploy can now fail on
 * migrations: nothing said which files a boot applied, whether an
 * already-applied file had been edited, whether a ledger row had lost its
 * file, or whether an invalid index had been dropped. It is one log line and
 * four counters, so the answer is in the logs and on the dashboard rather
 * than in someone's reconstruction after the fact.
 */
import type { MigrationSummary } from './migrate.js';
import { migrationsTotal } from '../lib/metrics.js';

export function reportMigrationSummary(summary: MigrationSummary, context: string): void {
  migrationsTotal.inc({ outcome: 'applied' }, summary.applied.length);
  migrationsTotal.inc({ outcome: 'changed' }, summary.changed.length);
  migrationsTotal.inc({ outcome: 'missing' }, summary.missing.length);
  migrationsTotal.inc({ outcome: 'repaired_index' }, summary.repairedIndexes.length);
  console.log(`[migrations] ${JSON.stringify({
    context,
    applied: summary.applied,
    skipped: summary.skipped,
    changed: summary.changed,
    missing: summary.missing,
    repairedIndexes: summary.repairedIndexes,
  })}`);
}
