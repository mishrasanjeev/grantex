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
/**
 * `CREATE [UNIQUE] INDEX CONCURRENTLY [IF NOT EXISTS] name`, with the name
 * either bare or double-quoted. Matched against SQL whose comments and string
 * literals have been blanked out, so neither can contribute a name.
 */
const CONCURRENT_INDEX_NAMES =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z0-9_$]+)/gi;

/**
 * What `SET lock_timeout` accepts: a count with an optional unit. Zero is
 * rejected on purpose — it means "wait forever", which is the behaviour this
 * file exists to prevent.
 */
const LOCK_TIMEOUT_SYNTAX = /^(\d+)\s*(us|ms|s|min|h|d)?$/i;

export interface MigrationSummary {
  /** Files applied by this run. */
  applied: string[];
  /** Files the ledger already had. */
  skipped: number;
  /** Files whose content changed after they were applied. */
  changed: string[];
  /** Ledger rows with no file on disk: a migration was renamed or deleted. */
  missing: string[];
  /** Invalid indexes dropped so a later attempt can rebuild them. */
  repairedIndexes: string[];
}

/**
 * Why `value` cannot be used as `lock_timeout`, or null if it can.
 *
 * `validateConfig` calls this at boot, so a typo is reported on the next
 * start rather than on the first deploy that happens to have a migration
 * pending — which could be months later, and would be the worst possible
 * moment to discover it.
 */
export function migrationLockTimeoutError(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const match = LOCK_TIMEOUT_SYNTAX.exec(value.trim());
  if (!match) {
    return 'MIGRATION_LOCK_TIMEOUT must be a PostgreSQL interval such as 2s, 500ms or 1min';
  }
  if (Number(match[1]) === 0) {
    return 'MIGRATION_LOCK_TIMEOUT must not be 0: that disables the timeout, letting a migration queue in front of live traffic';
  }
  return null;
}

function resolveLockTimeout(): string {
  const raw = process.env['MIGRATION_LOCK_TIMEOUT'];
  const problem = migrationLockTimeoutError(raw);
  if (problem !== null) throw new Error(problem);
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_LOCK_TIMEOUT : raw.trim();
  const match = LOCK_TIMEOUT_SYNTAX.exec(value)!;
  // Rebuilt from the parsed parts, so nothing from the environment reaches
  // the `SET` statement verbatim.
  return `${Number(match[1])}${(match[2] ?? '').toLowerCase()}`;
}

/**
 * Blank out comments, string literals and dollar-quoted bodies so the
 * scanners above cannot be fooled by any of them. A file that merely
 * *mentions* `CONCURRENTLY` in a comment was treated as non-transactional,
 * silently costing it the atomicity of its statements and its ledger row.
 *
 * Quoted identifiers are kept, because an index name may be one. Lengths are
 * preserved so offsets still line up with the original.
 */
export function blankSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', i);
      const stop = newline === -1 ? sql.length : newline;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) { depth += 1; j += 2; continue; }
        if (sql.startsWith('*/', j)) { depth -= 1; j += 2; continue; }
        j += 1;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    const dollarTag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(rest);
    if (dollarTag) {
      const tag = dollarTag[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** The index names a file builds concurrently, unquoted. */
export function concurrentIndexNames(sql: string): string[] {
  const names: string[] = [];
  for (const match of blankSqlNoise(sql).matchAll(CONCURRENT_INDEX_NAMES)) {
    const raw = match[1];
    if (raw === undefined) continue;
    names.push(raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw);
  }
  return names;
}

/** Whether a file has to run outside a transaction. */
export function runsConcurrently(sql: string): boolean {
  return CONCURRENTLY.test(blankSqlNoise(sql));
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
 * Run one piece of migration work, retrying while it is only the lock that is
 * busy, and naming what failed when it gives up.
 */
async function withLockRetry<T>(what: string, lockTimeout: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isLockTimeout(err) || attempt >= LOCK_ATTEMPTS) {
        const waited = isLockTimeout(err)
          ? ` after ${attempt} attempts waiting for a lock (lock_timeout=${lockTimeout})`
          : '';
        throw new Error(
          `Migration ${what} failed${waited}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      console.warn(`Migrations: ${what} could not take its lock (attempt ${attempt}/${LOCK_ATTEMPTS}); retrying`);
      await sleep(LOCK_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
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
  lockTimeout: string,
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
    // original build could not get — but it still waits behind transactions
    // that were already running, so it gets the same retry and the same
    // "which statement was it" framing as everything else.
    await withLockRetry(`repair of invalid index ${row.indexname}`, lockTimeout, () =>
      sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${row.indexname.replace(/"/g, '""')}"`));
    repaired.push(row.indexname);
  }
  return repaired;
}

const ADVISORY_LOCK = "SELECT pg_advisory_lock(hashtextextended('grantex:migrations', 0))";
const ADVISORY_UNLOCK = "SELECT pg_advisory_unlock(hashtextextended('grantex:migrations', 0))";

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

/**
 * Take the migration lock on a session of its own, run `work`, then put the
 * session back the way it was found.
 *
 * `lock_timeout` is a *session* setting and this connection returns to the
 * pool afterwards, where ordinary application statements would inherit it and
 * abort with 55P03 instead of waiting for a contended row — on roughly one
 * connection in `max`, until the pool recycles it. `SET LOCAL` is not an
 * option because the CONCURRENTLY files run outside a transaction, so it is
 * reset here instead, on every path including failure.
 */
async function withMigrationSession<T>(
  sql: ReturnType<typeof postgres>,
  work: (migrationSql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  // Cloud Run/Kubernetes may start several instances together. Reserve one
  // session so the advisory lock remains on the same PostgreSQL connection,
  // then serialize DDL across instances. A transaction lock cannot be used
  // because production index migrations use CREATE INDEX CONCURRENTLY.
  const migrationSql = await sql.reserve();
  let locked = false;
  try {
    await migrationSql.unsafe(ADVISORY_LOCK);
    locked = true;
    return await work(migrationSql as unknown as ReturnType<typeof postgres>);
  } finally {
    try {
      await migrationSql.unsafe('RESET lock_timeout');
    } catch {
      /* the session goes back to the pool either way; an error from `work` matters more */
    }
    try {
      if (locked) await migrationSql.unsafe(ADVISORY_UNLOCK);
    } finally {
      migrationSql.release();
    }
  }
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
 * `schema_migrations`. A database with no ledger yet still applies everything
 * once — that is what fills it, and it is safe because every file is
 * idempotent — and every start after that applies nothing. For a database
 * already at head, `baselineMigrations` fills the ledger without executing
 * anything, so even that first run is a no-op; see docs/self-hosting.md.
 */
export async function runMigrations(sql: ReturnType<typeof postgres>): Promise<MigrationSummary> {
  const files = migrationFiles();
  const lockTimeout = resolveLockTimeout();
  const summary: MigrationSummary = {
    applied: [], skipped: 0, changed: [], missing: [], repairedIndexes: [],
  };

  await withMigrationSession(sql, async (migrationSql) => {
    await migrationSql.unsafe(LEDGER_DDL);

    const ledger = new Map(
      (await migrationSql<{ filename: string; checksum: string }[]>`
        SELECT filename, checksum FROM schema_migrations`).map((row) => [row.filename, row.checksum]),
    );

    const onDisk = new Set(files);
    for (const filename of ledger.keys()) if (!onDisk.has(filename)) summary.missing.push(filename);
    summary.missing.sort();

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

    if (pending.length === 0) return;

    // A statement that cannot take its lock inside the timeout fails rather
    // than queueing in front of live traffic. This session only, and reset
    // before the connection goes back to the pool.
    await migrationSql.unsafe(`SET lock_timeout = '${lockTimeout}'`);

    const indexNames = new Set<string>();
    for (const file of pending) {
      for (const name of concurrentIndexNames(readFileSync(join(migrationsDir, file), 'utf-8'))) {
        indexNames.add(name);
      }
    }
    summary.repairedIndexes = await repairInvalidIndexes(migrationSql, [...indexNames], lockTimeout);

    for (const file of pending) {
      const content = readFileSync(join(migrationsDir, file), 'utf-8');
      const checksum = checksumOf(content);
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction, so those
      // files record their ledger row immediately after they succeed; every
      // other file commits its statements and its ledger row together.
      const transactional = !runsConcurrently(content);

      await withLockRetry(file, lockTimeout, async () => {
        if (transactional) {
          // A reserved connection has no `begin()` helper; it is one session,
          // so the transaction is explicit.
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
      });
      summary.applied.push(file);
    }
  });

  warnAboutSummary(summary);
  console.log(
    `Migrations: applied ${summary.applied.length}, already applied ${summary.skipped} of ${files.length} files`,
  );
  return summary;
}

function warnAboutSummary(summary: MigrationSummary): void {
  if (summary.changed.length > 0) {
    console.warn(
      `Migrations: ${summary.changed.length} already-applied file(s) have changed since they ran `
      + `(${summary.changed.join(', ')}); they are not re-applied — ship a new migration instead. `
      + 'This warns rather than fails on purpose: refusing to boot would take the service down over an '
      + 'edit that has already had no effect.',
    );
  }
  if (summary.missing.length > 0) {
    console.warn(
      `Migrations: ${summary.missing.length} applied file(s) are no longer on disk `
      + `(${summary.missing.join(', ')}); if one was renamed, the new name counts as pending and its `
      + 'statements run again — re-executing a heavy migration is exactly what the ledger exists to '
      + 'prevent, so check before deploying.',
    );
  }
  if (summary.repairedIndexes.length > 0) {
    console.warn(`Migrations: dropped invalid index(es) so they can be rebuilt: ${summary.repairedIndexes.join(', ')}`);
  }
}

export interface SchemaExpectation {
  /** Every table the files create and do not drop. */
  tables: string[];
  /** Every column the files add and do not drop, on a table they keep. */
  columns: Array<{ table: string; column: string }>;
}

const CREATE_TABLE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_$."]+)/gi;
const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_$."]+)/gi;
const ADD_COLUMN =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_$."]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_$."]+)/gi;
const DROP_COLUMN =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_$."]+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_$."]+)/gi;

/** `public."Thing"` becomes `thing`: the name as `information_schema` reports it. */
function bareName(raw: string): string {
  const last = raw.split('.').pop() ?? raw;
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

/**
 * What a database at head must contain, read from the migration files
 * themselves.
 *
 * Only statements that are plainly visible count: comments, string literals
 * and dollar-quoted bodies are blanked first, so a `CREATE TABLE` inside a
 * `DO ... $$ ... $$` block is not expected. That is deliberate — this list is
 * used to *refuse* a baseline, and a false expectation would block a
 * legitimate one. Missing an object makes the check weaker, never wrong.
 */
export function expectedSchema(): SchemaExpectation {
  return expectedSchemaOf(migrationFiles().map((file) => readFileSync(join(migrationsDir, file), 'utf-8')));
}

/**
 * The same scan over SQL given directly, in file order, so the rules above can
 * be tested on their own rather than only against the whole corpus.
 */
export function expectedSchemaOf(files: readonly string[]): SchemaExpectation {
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();

  for (const raw of files) {
    const sql = blankSqlNoise(raw);
    for (const match of sql.matchAll(CREATE_TABLE)) tables.add(bareName(match[1]!));
    for (const match of sql.matchAll(DROP_TABLE)) {
      const table = bareName(match[1]!);
      tables.delete(table);
      columns.delete(table);
    }
    for (const match of sql.matchAll(ADD_COLUMN)) {
      const table = bareName(match[1]!);
      const set = columns.get(table) ?? new Set<string>();
      set.add(bareName(match[2]!));
      columns.set(table, set);
    }
    for (const match of sql.matchAll(DROP_COLUMN)) {
      columns.get(bareName(match[1]!))?.delete(bareName(match[2]!));
    }
  }

  return {
    tables: [...tables].sort(),
    // A column on a table nothing creates any more is not expected either.
    columns: [...columns]
      .flatMap(([table, set]) => (tables.has(table) ? [...set].map((column) => ({ table, column })) : []))
      .sort((a, b) => (a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table))),
  };
}

export interface HeadCheck {
  atHead: boolean;
  /** Tables the files build that this database does not have. */
  missingTables: string[];
  /** Columns the files add that this database does not have. */
  missingColumns: Array<{ table: string; column: string }>;
  /** How many objects were compared, so "nothing missing" can be read as real. */
  checked: number;
}

/** The verdict as a sentence, whichever way it went. */
export function describeHeadCheck(check: HeadCheck): string {
  if (check.atHead) {
    return `this database is at head: all ${check.checked} tables and columns the migration files build are present`;
  }
  const missing = [
    ...check.missingTables.map((table) => `table ${table}`),
    ...check.missingColumns.map((entry) => `${entry.table}.${entry.column}`),
  ];
  const shown = missing.slice(0, 20).join(', ');
  const rest = missing.length > 20 ? `, and ${missing.length - 20} more` : '';
  return `this database is NOT at head: ${missing.length} of ${check.checked} objects are missing (${shown}${rest})`;
}

/**
 * Compare this database against what the migration files build.
 *
 * `to_regclass('grants') IS NOT NULL` used to be the whole test, and `grants`
 * comes from `001_initial.sql` — so a database that had run a single
 * migration passed, and baselining it recorded every file as applied. The
 * next boot then applied nothing, for ever, on a schema missing dozens of
 * migrations, with `changed: []`, `missing: []` and no warning anywhere. This
 * is what makes the precondition in the runbook something the command can
 * check instead of something the operator has to promise.
 */
export async function checkAtHead(sql: ReturnType<typeof postgres>): Promise<HeadCheck> {
  const expected = expectedSchema();

  const presentTables = new Set(
    (await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()`).map((row) => row.table_name),
  );
  const presentColumns = new Set(
    (await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()`).map((row) => `${row.table_name}.${row.column_name}`),
  );

  const missingTables = expected.tables.filter((table) => !presentTables.has(table));
  // A column is only reported when its table exists; otherwise the missing
  // table already says it, several times over.
  const missingColumns = expected.columns.filter((entry) =>
    presentTables.has(entry.table) && !presentColumns.has(`${entry.table}.${entry.column}`));

  return {
    atHead: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    checked: expected.tables.length + expected.columns.length,
  };
}

export interface BaselineSummary {
  /** Files recorded by this run without being executed. */
  recorded: string[];
  /** Files the ledger already had. */
  alreadyRecorded: number;
  /** True when nothing was written. */
  dryRun: boolean;
  /** What this database was compared against, and how it did. */
  head: HeadCheck;
  /** That verdict as a sentence. */
  verdict: string;
}

/**
 * Record every migration file as applied **without executing any of them**.
 *
 * For one situation only: a database that is already at head but has no
 * ledger, because it was migrated by the versions of this service that
 * re-applied every file on every start. Without this, the first boot after
 * the ledger ships re-executes all of them against a live database — which
 * takes a few seconds when traffic is ordinary, and fails on a lock timeout
 * when a transaction is holding a row in `grants` for longer than
 * `MIGRATION_LOCK_TIMEOUT`. Migrations run before the server listens, so the
 * revision never goes ready and traffic stays on the old one: a safe failure,
 * but still a broken deploy.
 *
 * Run it against a database known to be at head, immediately before the first
 * deploy that carries the ledger. On any other database it would mark work as
 * done that was never done, so it refuses to run where there is no schema at
 * all.
 */
export async function baselineMigrations(
  sql: ReturnType<typeof postgres>,
  options: { dryRun?: boolean } = {},
): Promise<BaselineSummary> {
  const files = migrationFiles();
  const dryRun = options.dryRun === true;

  return withMigrationSession(sql, async (migrationSql) => {
    const head = await checkAtHead(migrationSql);
    const verdict = describeHeadCheck(head);
    if (!head.atHead && !dryRun) {
      throw new Error(
        `Refusing to baseline: ${verdict}. Recording these files as applied would mark work as done `
        + 'that was never done, and no later start would ever do it. Start the service normally — it '
        + 'applies whatever is missing — and baseline only a database that is already at head.',
      );
    }

    const ledgerExists = (await migrationSql<{ present: boolean }[]>`
      SELECT to_regclass('schema_migrations') IS NOT NULL AS present`)[0]?.present === true;
    const existing = new Set(ledgerExists
      ? (await migrationSql<{ filename: string }[]>`SELECT filename FROM schema_migrations`)
        .map((row) => row.filename)
      : []);

    const recorded = files.filter((file) => !existing.has(file));
    if (dryRun) {
      // Nothing is written at all, not even the ledger table: a dry run that
      // leaves an empty `schema_migrations` behind is not writing nothing.
      return { recorded, alreadyRecorded: files.length - recorded.length, dryRun, head, verdict };
    }

    await migrationSql.unsafe(LEDGER_DDL);
    for (const file of recorded) {
      const checksum = checksumOf(readFileSync(join(migrationsDir, file), 'utf-8'));
      await migrationSql`
        INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
        ON CONFLICT (filename) DO NOTHING`;
    }

    return { recorded, alreadyRecorded: files.length - recorded.length, dryRun, head, verdict };
  });
}
