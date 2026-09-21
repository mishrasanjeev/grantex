import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

/**
 * How long a migration statement waits for a lock before giving up. A boot
 * that cannot take its locks must fail loudly rather than queue an
 * `ACCESS EXCLUSIVE` request in front of live traffic: while such a request
 * waits, every later reader of that table waits behind it.
 */
const DEFAULT_LOCK_TIMEOUT = '2s';
/** Attempts per file when the lock is busy, with a short backoff between them. */
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_BASE_MS = 250;

const LOCK_NOT_AVAILABLE = '55P03';
const CONCURRENTLY = /\bCONCURRENTLY\b/i;
const CONCURRENT_INDEX_NAMES = /CREATE\s+INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;

export interface MigrationSummary {
  /** Files applied by this run. */
  applied: string[];
  /** Files the ledger already had. */
  skipped: number;
  /** Files whose content changed after they were applied. */
  changed: string[];
  /** Invalid indexes dropped so a later attempt can rebuild them. */
  repairedIndexes: string[];
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Drop indexes a previous `CREATE INDEX CONCURRENTLY` left behind invalid.
 *
 * An invalid index is never used by the planner but is still maintained on
 * every write, and `CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches it by
 * name and skips — so without this it is never repaired. Only names this
 * repository's own pending migrations create are considered.
 */
async function repairInvalidIndexes(
  sql: ReturnType<typeof postgres>,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await sql<{ indexname: string }[]>`
    SELECT c.relname AS indexname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT i.indisvalid
       AND n.nspname = current_schema()
       AND c.relname = ANY(${names as string[]})`;
  const repaired: string[] = [];
  for (const row of rows) {
    // Dropping concurrently keeps the repair from taking the lock the
    // original build could not get.
    await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${row.indexname}"`);
    repaired.push(row.indexname);
  }
  return repaired;
}

/**
 * Apply every migration this database has not seen, once.
 *
 * Until this ledger existed, every start re-executed all files. They are all
 * idempotent, so the result was correct — but ten of them are
 * `ALTER TABLE grants ADD COLUMN IF NOT EXISTS …`, and Postgres takes the
 * `ACCESS EXCLUSIVE` lock *before* evaluating `IF NOT EXISTS`. A no-op
 * statement therefore still queues behind whatever transaction is touching
 * `grants`, and every reader arriving after it waits behind the queued
 * request. On a rolling deploy that is the running instance's authorization
 * path, stalled by the starting instance.
 *
 * Now each file is applied at most once per database and recorded in
 * `schema_migrations`. The first start after this change still applies
 * everything once — that is what fills the ledger, and it is safe because
 * every file is idempotent — and every start after that applies nothing.
 */
export async function runMigrations(sql: ReturnType<typeof postgres>): Promise<MigrationSummary> {
  const files = migrationFiles();
  const lockTimeout = (process.env['MIGRATION_LOCK_TIMEOUT'] ?? DEFAULT_LOCK_TIMEOUT).replace(/'/g, '');
  const summary: MigrationSummary = { applied: [], skipped: 0, changed: [], repairedIndexes: [] };

  // Cloud Run/Kubernetes may start several instances together. Reserve one
  // session so the advisory lock remains on the same PostgreSQL connection,
  // then serialize DDL across instances. A transaction lock cannot be used
  // because production index migrations use CREATE INDEX CONCURRENTLY.
  const migrationSql = await sql.reserve();
  let locked = false;
  try {
    await migrationSql`SELECT pg_advisory_lock(hashtextextended('grantex:migrations', 0))`;
    locked = true;

    await migrationSql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

    const ledger = new Map(
      (await migrationSql<{ filename: string; checksum: string }[]>`
        SELECT filename, checksum FROM schema_migrations`).map((row) => [row.filename, row.checksum]),
    );

    const pending: string[] = [];
    for (const file of files) {
      const recorded = ledger.get(file);
      if (recorded === undefined) {
        pending.push(file);
        continue;
      }
      summary.skipped += 1;
      if (checksumOf(readFileSync(join(migrationsDir, file), 'utf-8')) !== recorded) summary.changed.push(file);
    }

    if (pending.length > 0) {
      // A statement that cannot take its lock inside the timeout fails rather
      // than queueing in front of live traffic. This session only.
      await migrationSql.unsafe(`SET lock_timeout = '${lockTimeout}'`);

      const concurrentIndexNames = new Set<string>();
      for (const file of pending) {
        for (const match of readFileSync(join(migrationsDir, file), 'utf-8').matchAll(CONCURRENT_INDEX_NAMES)) {
          if (match[1]) concurrentIndexNames.add(match[1]);
        }
      }
      summary.repairedIndexes = await repairInvalidIndexes(migrationSql, [...concurrentIndexNames]);

      for (const file of pending) {
        const content = readFileSync(join(migrationsDir, file), 'utf-8');
        const checksum = checksumOf(content);
        // CREATE INDEX CONCURRENTLY cannot run inside a transaction, so those
        // files record their ledger row immediately after they succeed; every
        // other file commits its statements and its ledger row together.
        const transactional = !CONCURRENTLY.test(content);

        for (let attempt = 1; ; attempt += 1) {
          try {
            if (transactional) {
              // A reserved connection has no `begin()` helper; it is one
              // session, so the transaction is explicit.
              await migrationSql.unsafe('BEGIN');
              try {
                await migrationSql.unsafe(content);
                await migrationSql`
                  INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
                  ON CONFLICT (filename) DO NOTHING`;
                await migrationSql.unsafe('COMMIT');
              } catch (err) {
                await migrationSql.unsafe('ROLLBACK').catch(() => { /* the original error is the one to report */ });
                throw err;
              }
            } else {
              await migrationSql.unsafe(content);
              await migrationSql`
                INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
                ON CONFLICT (filename) DO NOTHING`;
            }
            break;
          } catch (err) {
            if (!isLockTimeout(err) || attempt >= LOCK_ATTEMPTS) {
              const waited = isLockTimeout(err)
                ? ` after ${attempt} attempts waiting for a lock (lock_timeout=${lockTimeout})`
                : '';
              throw new Error(
                `Migration ${file} failed${waited}: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
            console.warn(`Migrations: ${file} could not take its lock (attempt ${attempt}/${LOCK_ATTEMPTS}); retrying`);
            await sleep(LOCK_RETRY_BASE_MS * 2 ** (attempt - 1));
          }
        }
        summary.applied.push(file);
      }
    }
  } finally {
    try {
      if (locked) {
        await migrationSql`SELECT pg_advisory_unlock(hashtextextended('grantex:migrations', 0))`;
      }
    } finally {
      migrationSql.release();
    }
  }

  if (summary.changed.length > 0) {
    console.warn(
      `Migrations: ${summary.changed.length} already-applied file(s) have changed since they ran `
      + `(${summary.changed.join(', ')}); they are not re-applied — ship a new migration instead`,
    );
  }
  if (summary.repairedIndexes.length > 0) {
    console.warn(`Migrations: dropped invalid index(es) so they can be rebuilt: ${summary.repairedIndexes.join(', ')}`);
  }
  console.log(
    `Migrations: applied ${summary.applied.length}, already applied ${summary.skipped} of ${files.length} files`,
  );
  return summary;
}
