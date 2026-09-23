#!/usr/bin/env node
/**
 * Settles one question with a real Postgres: does running the migrations from
 * several connections against ONE database, while an index is built and
 * dropped concurrently, deadlock?
 *
 * That is the shape the Postgres integration tests had before they were given
 * a database each (FINDINGS G-24): vitest runs test files in parallel, each
 * file called `runMigrations` on the same database, and one of them built and
 * dropped indexes on purpose. CI failed on the migration ledger's merge commit
 * with `Migration 064_agents_developer_created_index.sql failed: deadlock
 * detected`, and a re-run went green — which is how a real failure gets waved
 * through.
 *
 * The suite itself is a poor instrument for that: it depends on machine speed
 * and on which files happen to overlap, so "N clean runs" says little and a
 * re-run says less. This reproduces the mechanism directly instead, so a fix
 * can be measured rather than hoped at.
 *
 *   node migration-contention-probe.mjs --mode shared    [--workers 6] [--rounds 4]
 *   node migration-contention-probe.mjs --mode per-file  [--workers 6] [--rounds 4]
 *
 *   --mode shared     every worker migrates the same database (the old shape)
 *   --mode per-file   every worker migrates a database of its own (the fix)
 *   --url             admin connection string; defaults to
 *                     AUDIT_INTEGRATION_DATABASE_URL
 *
 * Measured on one development machine — Postgres 16 in Docker on Windows,
 * 6 workers x 4 rounds, both modes run back to back:
 *
 *   shared     4 of 4 rounds deadlocked, 24 of 24 workers failed
 *   per-file   0 of 4 rounds, 0 workers failed
 *
 * A third arrangement is worth knowing: with a database per worker but the
 * index loop pointed at one of *their* databases rather than its own, 4 of 4
 * rounds failed again, one worker each. So the property that matters is "no
 * database has two concurrent sessions doing DDL in it" — not "index builds
 * are avoided".
 *
 * Those are this machine's numbers and not a general claim. The point is the
 * before/after on the same hardware minutes apart, and that the "before" fails
 * at all — which the test suite does not show on this machine: 10 full runs of
 * the integration files warm and 10 more from an empty database were clean
 * either way. A flake that only appears on CI cannot be measured by re-running
 * the suite, which is why this exists.
 *
 * It creates databases named `mcp_<mode>_<n>` and drops them again. It never
 * touches a database it did not create.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const serviceDir = join(here, '..');

function parseArgs(argv) {
  const args = { mode: 'shared', workers: 6, rounds: 4, url: process.env['AUDIT_INTEGRATION_DATABASE_URL'] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--mode') { args.mode = value; i += 1; }
    else if (flag === '--workers') { args.workers = Number(value); i += 1; }
    else if (flag === '--rounds') { args.rounds = Number(value); i += 1; }
    else if (flag === '--url') { args.url = value; i += 1; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!['shared', 'per-file'].includes(args.mode)) throw new Error('--mode must be shared or per-file');
  if (!args.url) throw new Error('set AUDIT_INTEGRATION_DATABASE_URL or pass --url');
  return args;
}

const { mode, workers, rounds, url } = parseArgs(process.argv.slice(2));

// The runner under test, loaded from this checkout.
const { runMigrations } = await import(pathToFileURL(join(serviceDir, 'src', 'db', 'migrate.ts')).href);

const connect = (target, max = 2) =>
  postgres(target, { max, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });

function urlFor(database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function classify(err) {
  const code = err?.code ?? err?.cause?.code;
  const message = String(err?.message ?? err);
  if (code === '40P01' || /deadlock detected/i.test(message)) return 'deadlock';
  if (code === '55P03' || /lock_timeout|could not obtain lock/i.test(message)) return 'lock timeout';
  return 'other';
}

async function withAdmin(fn) {
  const admin = connect(urlFor('postgres'));
  try {
    return await fn(admin);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function recreate(admin, database) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${database}`);
}

/**
 * One round: `workers` migration runs racing each other, with a loop building
 * and dropping an index throughout. In `shared` mode they all use one
 * database; in `per-file` mode each has its own, which is the only difference
 * the fix makes.
 */
async function round(index) {
  const databases = mode === 'shared'
    ? [`mcp_shared_${index}`]
    : Array.from({ length: workers }, (_, worker) => `mcp_perfile_${index}_${worker}`);
  // In `shared` mode the index work lands in the one database everybody is
  // migrating — the old arrangement. In `per-file` mode it gets a database of
  // its own, which is what a database per test file actually gives you: no
  // database has two concurrent sessions in it. Point this at a worker's
  // database instead and the deadlocks come straight back, which is the point:
  // the fix is the isolation, not avoiding index builds.
  const indexDatabase = mode === 'shared' ? databases[0] : `mcp_perfile_${index}_index`;

  const allDatabases = mode === 'shared' ? databases : [...databases, indexDatabase];
  await withAdmin(async (admin) => {
    for (const database of allDatabases) await recreate(admin, database);
  });

  // Build the schema once, then clear the ledger so every worker has the full
  // set of files to apply — which is what an empty CI database gives them.
  for (const database of allDatabases) {
    const seed = connect(urlFor(database));
    try {
      await runMigrations(seed);
      // Every database a worker migrates starts with an empty ledger, so each
      // worker has the whole set of files to apply — what an empty CI database
      // gives them. In `per-file` mode the index database is not one of those,
      // and keeps its ledger; in `shared` mode it is the same database, so it
      // must still be cleared or the workers would have nothing to do and the
      // probe would report a clean run for the wrong reason.
      const migratedByWorkers = mode === 'shared' || database !== indexDatabase;
      if (migratedByWorkers) await seed.unsafe('DELETE FROM schema_migrations');
    } finally {
      await seed.end({ timeout: 10 }).catch(() => undefined);
    }
  }

  let indexing = true;
  const indexer = (async () => {
    const sql = connect(urlFor(indexDatabase));
    try {
      while (indexing) {
        await sql.unsafe('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_probe_grants ON grants (developer_id)')
          .catch(() => undefined);
        await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS idx_probe_grants').catch(() => undefined);
        await sleep(10);
      }
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  })();

  const results = await Promise.allSettled(Array.from({ length: workers }, async (_, worker) => {
    const database = mode === 'shared' ? databases[0] : databases[worker];
    const sql = connect(urlFor(database));
    try {
      await runMigrations(sql);
    } finally {
      await sql.end({ timeout: 10 }).catch(() => undefined);
    }
  }));

  indexing = false;
  await indexer;

  await withAdmin(async (admin) => {
    for (const database of allDatabases) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    }
  });

  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => ({ kind: classify(result.reason), message: String(result.reason?.message ?? result.reason) }));
  return failures;
}

const totals = { deadlock: 0, 'lock timeout': 0, other: 0 };
let badRounds = 0;

for (let index = 1; index <= rounds; index += 1) {
  const failures = await round(index);
  for (const failure of failures) totals[failure.kind] += 1;
  if (failures.length > 0) badRounds += 1;
  const verdict = failures.length === 0
    ? 'ok'
    : `${failures.length} worker(s) failed: ${[...new Set(failures.map((f) => f.kind))].join(', ')}`;
  console.log(`round ${index}: ${verdict}`);
}

console.log(JSON.stringify({
  mode,
  workers,
  rounds,
  roundsWithFailures: badRounds,
  failingWorkers: totals,
}));

// A probe reports; it does not judge. Exit non-zero only if it could not run.
