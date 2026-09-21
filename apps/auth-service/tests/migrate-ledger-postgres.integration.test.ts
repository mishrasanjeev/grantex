import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

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
