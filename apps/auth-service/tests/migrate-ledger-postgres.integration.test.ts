import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { baselineMigrations, checkAtHead, expectedSchema, runMigrations } from '../src/db/migrate.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres migration ledger tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

/**
 * An empty database of its own: what a deployment that has never been
 * migrated looks like. A schema inside the shared database is not enough —
 * extensions (pg_trgm) are database-wide, so a schema-scoped run would find
 * one installed elsewhere and then fail to see its operator classes.
 */
async function freshDatabase(): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  const name = `migrate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  return {
    sql,
    url: url.toString(),
    drop: async () => {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    },
  };
}

/**
 * Apply the migration files up to and including the one whose name starts
 * with `lastPrefix`, directly and with no ledger — what an older deployment's
 * database looks like.
 */
async function applyMigrationFilesUpTo(sql: Sql, lastPrefix: string): Promise<number> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  let applied = 0;
  for (const file of files) {
    await sql.unsafe(readFileSync(join(dir, file), 'utf-8'));
    applied += 1;
    if (file.startsWith(lastPrefix)) break;
  }
  return applied;
}

describePostgres('the migration ledger against real Postgres', () => {
  it('applies every file once, then nothing, and records what it applied', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      const first = await runMigrations(sql);
      expect(first.applied.length).toBeGreaterThan(50);
      expect(first.skipped).toBe(0);
      expect(first.changed).toEqual([]);

      const second = await runMigrations(sql);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toBe(first.applied.length);

      const ledger = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM schema_migrations`;
      expect(Number(ledger[0]!.count)).toBe(first.applied.length);
      // The schema really was built, not just recorded.
      const grants = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'grants'`;
      expect(Number(grants[0]!.count)).toBeGreaterThan(10);
    } finally {
      await drop();
    }
  }, 300_000);

  it('notices a file that changed after it was applied, and does not re-apply it', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      const first = await runMigrations(sql);
      const file = first.applied[0]!;
      await sql`UPDATE schema_migrations SET checksum = 'not-the-checksum' WHERE filename = ${file}`;

      const second = await runMigrations(sql);
      expect(second.applied).toEqual([]);
      expect(second.changed).toEqual([file]);
    } finally {
      await drop();
    }
  }, 300_000);

  it('drops an index a previous CREATE INDEX CONCURRENTLY left invalid, so it can be rebuilt', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      await runMigrations(sql);
      const index = 'idx_grants_parent';
      // Simulate the state a cancelled concurrent build leaves behind.
      await sql.unsafe(`DROP INDEX IF EXISTS ${index}`);
      await sql.unsafe(`CREATE INDEX ${index} ON grants (parent_grant_id)`);
      await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${index}'::regclass`);
      await sql`DELETE FROM schema_migrations WHERE filename LIKE '069%'`;

      const run = await runMigrations(sql);
      expect(run.repairedIndexes).toContain(index);
      const valid = await sql<{ indisvalid: boolean }[]>`
        SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = ${index} AND c.relnamespace = current_schema()::regnamespace`;
      expect(valid[0]?.indisvalid).toBe(true);
    } finally {
      await drop();
    }
  }, 300_000);

  /**
   * The boot production will actually take: a database whose schema is at
   * head but which has no ledger, because every previous version of this
   * service re-applied all files on every start. Every other case here starts
   * from an empty database, which is the easy one.
   *
   * The ledger is dropped after a full run rather than the schema being built
   * by hand, so the schema really is at head, exactly as a live database is.
   */
  it('adopts a fully-migrated database that has no ledger, then applies nothing', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      const build = await runMigrations(sql);
      await sql.unsafe('DROP TABLE schema_migrations');

      // This is the transition boot: everything is pending again.
      const transition = await runMigrations(sql);
      expect(transition.applied).toEqual(build.applied);
      expect(transition.skipped).toBe(0);
      const ledger = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM schema_migrations`;
      expect(Number(ledger[0]!.count)).toBe(build.applied.length);

      // And every boot after it is a no-op.
      const steady = await runMigrations(sql);
      expect(steady.applied).toEqual([]);
      expect(steady.skipped).toBe(build.applied.length);
    } finally {
      await drop();
    }
  }, 600_000);

  /**
   * Why the baseline command exists. On a database at head with no ledger, a
   * transaction holding a row in `grants` is enough to fail the transition
   * boot — safely, before the server listens, but it is still a failed
   * deploy. `baselineMigrations` removes that risk: it records the files
   * without executing them, so it does not need the lock at all.
   */
  it('fails the no-ledger boot rather than queueing behind a held row lock, and baseline does not', async () => {
    const { sql, url, drop } = await freshDatabase();
    const holder = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding: Promise<unknown> = Promise.resolve();
    try {
      const build = await runMigrations(sql);
      await sql`
        INSERT INTO developers (id, api_key_hash, name) VALUES ('dev_base', 'hash_base', 'Baseline Test')`;
      await sql`INSERT INTO agents (id, did, developer_id, name) VALUES ('ag_base', 'did:grantex:ag_base', 'dev_base', 'Agent')`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
        VALUES ('grnt_base', 'ag_base', 'user_1', 'dev_base', ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 hour')`;
      await sql.unsafe('DROP TABLE schema_migrations');

      holding = holder.begin(async (tx) => {
        await tx`SELECT id FROM grants WHERE id = 'grnt_base' FOR UPDATE`;
        await held;
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The transition boot wants ACCESS EXCLUSIVE on `grants`. It gives up
      // instead of queueing, and says which file could not proceed.
      await expect(runMigrations(sql)).rejects.toThrow(/could not|lock/i);
      // Traffic is unaffected: the reader is not stuck behind a queued
      // exclusive request, which is the whole point.
      const reader = await sql<{ id: string }[]>`SELECT id FROM grants WHERE id = 'grnt_base'`;
      expect(reader[0]?.id).toBe('grnt_base');

      // The failure is consistent: the files that ran before the one that
      // could not take its lock are recorded, and no others.
      const [partial] = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM schema_migrations`;
      const recorded = Number(partial!.count);
      expect(recorded).toBeGreaterThan(0);
      expect(recorded).toBeLessThan(build.applied.length);

      // The operator path: adopt the database instead. It executes nothing,
      // so the held lock is irrelevant.
      const dry = await baselineMigrations(sql, { dryRun: true });
      expect(dry.recorded.length).toBe(build.applied.length - recorded);
      expect(dry.alreadyRecorded).toBe(recorded);
      const unchanged = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM schema_migrations`;
      expect(Number(unchanged[0]!.count)).toBe(recorded);

      const baselined = await baselineMigrations(sql);
      expect(baselined.recorded.length).toBe(build.applied.length - recorded);

      // Now the deploy that was failing is a no-op, with the lock still held.
      const boot = await runMigrations(sql);
      expect(boot.applied).toEqual([]);
      expect(boot.skipped).toBe(build.applied.length);
    } finally {
      release();
      await holding;
      await holder.end({ timeout: 5 }).catch(() => undefined);
      await drop();
    }
  }, 600_000);

  /**
   * The case that actually bites: a database that is *partly* migrated. It
   * has `grants`, so the old check (`to_regclass('grants') IS NOT NULL`)
   * passed, every file was recorded as applied, and the next boot applied
   * nothing — for ever — on a schema missing dozens of migrations, with no
   * warning anywhere and no way back except editing the ledger by hand.
   *
   * The empty-database case below is the easy one; this is the one the
   * command has to refuse.
   */
  it('refuses to baseline a database that is only partly migrated, and says what is missing', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      // Applied through 060 only, which is what an older deployment looks
      // like: `grants` exists, and 43 later files do not.
      const files = await applyMigrationFilesUpTo(sql, '060');
      expect(files).toBeGreaterThan(50);
      const [grants] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'grants'`;
      expect(Number(grants!.count)).toBeGreaterThan(5);

      const check = await checkAtHead(sql);
      expect(check.atHead).toBe(false);
      expect(check.missingTables).toContain('evidence_records');

      await expect(baselineMigrations(sql)).rejects.toThrow(/not at head/i);
      // And it refused before writing anything at all.
      const [ledger] = await sql<{ present: boolean }[]>`
        SELECT to_regclass('schema_migrations') IS NOT NULL AS present`;
      expect(ledger!.present).toBe(false);

      // A dry run answers the question the operator was asked to promise,
      // instead of printing the same count either way.
      const dry = await baselineMigrations(sql, { dryRun: true });
      expect(dry.head.atHead).toBe(false);
      expect(dry.verdict).toMatch(/NOT at head/);
      expect(dry.verdict).toMatch(/evidence_records/);

      // Starting the service normally is the way out, and then it is fine.
      await runMigrations(sql);
      await sql.unsafe('DROP TABLE schema_migrations');
      const after = await baselineMigrations(sql, { dryRun: true });
      expect(after.head.atHead).toBe(true);
      expect(after.verdict).toMatch(/is at head/);
    } finally {
      await drop();
    }
  }, 600_000);

  it('refuses to baseline an empty database', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      await expect(baselineMigrations(sql)).rejects.toThrow(/not at head/i);
    } finally {
      await drop();
    }
  }, 300_000);

  /**
   * The head check refuses a baseline, so a wrong expectation is worse than a
   * missing one: it would block an operator who is doing exactly the right
   * thing. Against a database the migrations themselves built, nothing may be
   * reported missing.
   */
  it('expects nothing a full migration run does not build', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      await runMigrations(sql);
      const check = await checkAtHead(sql);
      expect(check.missingTables).toEqual([]);
      expect(check.missingColumns).toEqual([]);
      expect(check.atHead).toBe(true);
      // And it is comparing a real list, not an empty one.
      const expectedObjects = expectedSchema();
      expect(expectedObjects.tables.length).toBeGreaterThan(50);
      expect(expectedObjects.columns.length).toBeGreaterThan(20);
      expect(expectedObjects.tables).toContain('grants');
      expect(expectedObjects.tables).not.toContain('signing_keys'); // dropped by 030
      expect(check.checked).toBe(expectedObjects.tables.length + expectedObjects.columns.length);

      // And the other direction, which is the one CI cannot otherwise see: a
      // table the scanner *misses* is a table whose absence would be reported
      // as "at head". A `CREATE TABLE IF NOT EXISTS` inside a `DO $$ … $$`
      // block is idempotent, invisible to the scanner, and leaves the whole
      // suite green — so every table the migrations actually build must
      // appear in the expected list.
      const built = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         ORDER BY table_name`;
      const unexpected = built
        .map((row) => row.table_name)
        // The ledger is written by the runner, not by a migration file.
        .filter((name) => name !== 'schema_migrations')
        .filter((name) => !expectedObjects.tables.includes(name));
      expect(unexpected, 'tables the head check would never notice were missing').toEqual([]);
    } finally {
      await drop();
    }
  }, 600_000);

  it('writes nothing at all on a dry run, not even the ledger table', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      await runMigrations(sql);
      await sql.unsafe('DROP TABLE schema_migrations');

      const dry = await baselineMigrations(sql, { dryRun: true });
      expect(dry.recorded.length).toBeGreaterThan(50);
      const [ledger] = await sql<{ present: boolean }[]>`
        SELECT to_regclass('schema_migrations') IS NOT NULL AS present`;
      expect(ledger!.present).toBe(false);
    } finally {
      await drop();
    }
  }, 600_000);

  /**
   * `lock_timeout` is a session setting and the migration connection goes
   * back to the pool. If it is left set, an ordinary application statement
   * that lands on that connection aborts with 55P03 instead of waiting for a
   * contended row — on roughly one connection in `max`, until the pool
   * recycles it. With `max: 1` the connection is necessarily the same one.
   */
  it('does not leave lock_timeout set on the pooled connection', async () => {
    const { sql, url, drop } = await freshDatabase();
    const single = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
    try {
      const applied = await runMigrations(single);
      expect(applied.applied.length).toBeGreaterThan(50);
      const [after] = await single<{ lock_timeout: string }[]>`SHOW lock_timeout`;
      expect(after?.lock_timeout).toBe('0');

      // And on the path where nothing is pending, too.
      await runMigrations(single);
      const [steady] = await single<{ lock_timeout: string }[]>`SHOW lock_timeout`;
      expect(steady?.lock_timeout).toBe('0');
    } finally {
      await single.end({ timeout: 5 }).catch(() => undefined);
      await sql.end().catch(() => undefined);
      await drop();
    }
  }, 600_000);

  it('warns about a ledger row whose file is gone instead of silently re-applying it later', async () => {
    const { sql, drop } = await freshDatabase();
    try {
      await runMigrations(sql);
      await sql`
        INSERT INTO schema_migrations (filename, checksum) VALUES ('099_renamed_away.sql', 'whatever')`;

      const run = await runMigrations(sql);
      expect(run.missing).toEqual(['099_renamed_away.sql']);
      expect(run.applied).toEqual([]);
    } finally {
      await drop();
    }
  }, 300_000);

  it('does not queue an exclusive lock in front of traffic once the ledger is filled', async () => {
    const { sql, url, drop } = await freshDatabase();
    const holder = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    try {
      await runMigrations(sql);
      await sql`
        INSERT INTO developers (id, api_key_hash, name) VALUES ('dev_lock', 'hash_lock', 'Lock Test')`;
      await sql`INSERT INTO agents (id, did, developer_id, name) VALUES ('ag_lock', 'did:grantex:ag_lock', 'dev_lock', 'Agent')`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
        VALUES ('grnt_lock', 'ag_lock', 'user_1', 'dev_lock', ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 hour')`;

      // A long-running transaction holding a row lock on `grants`, exactly
      // what an in-flight authorization does.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holding = holder.begin(async (tx) => {
        await tx`SELECT id FROM grants WHERE id = 'grnt_lock' FOR UPDATE`;
        await held;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Before the ledger this start re-ran ALTER TABLE grants and blocked
      // here — and every reader behind it. It must now be a no-op.
      const started = Date.now();
      const run = await runMigrations(sql);
      const elapsed = Date.now() - started;
      release();
      await holding;

      expect(run.applied).toEqual([]);
      expect(elapsed).toBeLessThan(2_000);

      // And a reader that arrives during a boot is not blocked either.
      const reader = await sql<{ id: string }[]>`SELECT id FROM grants WHERE id = 'grnt_lock'`;
      expect(reader[0]?.id).toBe('grnt_lock');
    } finally {
      await holder.end({ timeout: 5 }).catch(() => undefined);
      await drop();
    }
  }, 300_000);
});
