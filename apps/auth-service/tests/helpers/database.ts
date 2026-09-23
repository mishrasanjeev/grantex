import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;

const adminUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];

/**
 * A database of this test file's own.
 *
 * Every Postgres integration file used to share one database and run the
 * migrations in it. Vitest runs files in parallel, so several `runMigrations`
 * calls met in the same database: the advisory lock serialised the runs, but
 * `CREATE INDEX CONCURRENTLY` (064) still deadlocked against whatever another
 * file was doing, and the suite failed roughly one run in two with
 * `40P01 deadlock detected`. See FINDINGS G-24.
 *
 * A separate database per file removes the contention rather than retrying
 * through it: nothing another file does can be seen, let alone locked against.
 * It also means extensions, which are database-wide, cannot leak between
 * files the way a shared-database schema would allow.
 */
export async function createTestDatabase(label: string): Promise<{
  sql: Sql;
  url: string;
  name: string;
  drop: () => Promise<void>;
}> {
  if (!adminUrl) {
    throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set to create a test database');
  }
  const safeLabel = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 20);
  const name = `t_${safeLabel}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const admin = postgres(adminUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    sql: postgres(url.toString(), { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} }),
    url: url.toString(),
    name,
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    },
  };
}
