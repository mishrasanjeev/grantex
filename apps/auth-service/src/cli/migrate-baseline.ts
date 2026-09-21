/**
 * Adopt an existing database into the migration ledger.
 *
 *   node dist/cli/migrate-baseline.js [--dry-run]
 *
 * Records every migration file as applied **without executing any of them**,
 * for a database that is already at head but has no `schema_migrations` table
 * because it was migrated by the versions of this service that re-applied all
 * files on every start.
 *
 * Run it once, against a database known to be at head, immediately before the
 * first deploy that carries the ledger. After it, that deploy's boot applies
 * nothing, like every boot after it.
 *
 * Do not run it against a database that is behind: it would record work that
 * was never done. It refuses outright where there is no schema at all.
 * `--dry-run` prints what it would record and writes nothing.
 */
import { pathToFileURL } from 'node:url';
import { closeSql, getSql } from '../db/client.js';
import { baselineMigrations } from '../db/migrate.js';

export function parseBaselineArgs(argv: readonly string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseBaselineArgs(process.argv.slice(2));
  const sql = getSql();
  try {
    const summary = await baselineMigrations(sql, { dryRun });
    console.log(JSON.stringify({
      baselined: !dryRun,
      dryRun,
      recorded: summary.recorded.length,
      alreadyRecorded: summary.alreadyRecorded,
      files: summary.recorded,
    }));
  } finally {
    await closeSql();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`migrate-baseline failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
