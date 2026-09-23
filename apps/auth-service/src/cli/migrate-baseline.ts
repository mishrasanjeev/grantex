/**
 * Adopt an existing database into the migration ledger.
 *
 *   node dist/cli/migrate-baseline.js --dry-run     # the verdict, writes nothing
 *   node dist/cli/migrate-baseline.js               # record, if it is at head
 *
 * Records every migration file as applied **without executing any of them**,
 * for a database that is already at head but has no `schema_migrations` table
 * because it was migrated by the versions of this service that re-applied all
 * files on every start.
 *
 * Run it once, against the production database, immediately before the first
 * deploy that carries the ledger. After it, that deploy's boot applies
 * nothing, like every boot after it.
 *
 * It refuses a database that is **not** at head — recording work that was
 * never done would mean no later boot ever does it — by comparing the
 * database against every table and column the migration files build.
 * `--dry-run` prints that comparison and writes nothing at all.
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
    console.log(summary.verdict);
    // On a database that is not at head, the count of files a baseline *would*
    // record is the one number a reader latches onto, and it is the one thing
    // that must not happen. It is left out entirely rather than printed
    // beside the refusal.
    console.log(JSON.stringify(summary.head.atHead
      ? {
        baselined: !dryRun,
        dryRun,
        atHead: true,
        objectsChecked: summary.head.checked,
        recorded: summary.recorded.length,
        alreadyRecorded: summary.alreadyRecorded,
        files: summary.recorded,
      }
      : {
        baselined: false,
        dryRun,
        atHead: false,
        objectsChecked: summary.head.checked,
        missingTables: summary.head.missingTables,
        missingColumns: summary.head.missingColumns.map((entry) => `${entry.table}.${entry.column}`),
      }));
    if (dryRun && !summary.head.atHead) {
      // A dry run reports rather than throws, but it must not exit 0 on a
      // database a real run would refuse.
      console.error(
        'Baselining this database would be wrong: start the service instead, and it applies what is missing.',
      );
      process.exitCode = 1;
    }
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
