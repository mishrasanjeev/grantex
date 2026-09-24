import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { checkSharedDatabase, snapshotSharedDatabase } from './helpers/shared-database-guard.js';

// The guard is exercised against a database of this file's own, standing in
// for the shared one; see FINDINGS G-30.
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const describePostgres = adminDatabaseUrl ? describe : describe.skip;
const dropAfter: Array<() => Promise<void>> = [];

async function scratch(): Promise<{ url: string; sql: ReturnType<typeof postgres> }> {
  const db = await createTestDatabase('guard');
  const sql = postgres(db.url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  dropAfter.push(async () => { await sql.end(); await db.drop(); });
  return { url: db.url, sql };
}

afterAll(async () => {
  for (const drop of dropAfter) await drop();
}, 60_000);

describePostgres('shared-database guard', () => {
  it('passes a run that left the shared database as it found it', async () => {
    const { url, sql } = await scratch();
    await sql`CREATE TABLE unrelated_app_table (id int)`;
    const before = await snapshotSharedDatabase(url);
    await expect(checkSharedDatabase(url, before)).resolves.toBeUndefined();
  }, 60_000);

  it('fails a run in which a test file migrated the shared database, naming the tables', async () => {
    const { url, sql } = await scratch();
    const before = await snapshotSharedDatabase(url);
    await runMigrations(sql);
    await expect(checkSharedDatabase(url, before)).rejects.toThrow(/schema_migrations[\s\S]*createTestDatabase/);
  }, 120_000);

  it('fails a run that created any table in the shared database', async () => {
    const { url, sql } = await scratch();
    const before = await snapshotSharedDatabase(url);
    await sql`CREATE TABLE stray_fixture (id int)`;
    await expect(checkSharedDatabase(url, before)).rejects.toThrow(/public\.stray_fixture/);
  }, 60_000);

  it('refuses to start when the shared database already holds a migration ledger', async () => {
    const { url, sql } = await scratch();
    await runMigrations(sql);
    await expect(snapshotSharedDatabase(url)).rejects.toThrow(/already holds a migration ledger/);
  }, 120_000);

  it('fails closed when the shared database cannot be reached', async () => {
    const unreachable = new URL(adminDatabaseUrl!);
    unreachable.pathname = '/t_guard_does_not_exist';
    await expect(snapshotSharedDatabase(unreachable.toString())).rejects.toThrow(/could not inspect the shared database/);
    await expect(checkSharedDatabase(unreachable.toString(), { tables: new Set() }))
      .rejects.toThrow(/could not inspect the shared database/);
  }, 60_000);

  it('fails closed, with its own explanation, when the shared database URL is malformed', async () => {
    await expect(snapshotSharedDatabase('not a database url')).rejects.toThrow(/could not inspect the shared database/);
  });
});
