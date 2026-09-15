import pg from 'pg';
import { PostgresStorage, runMigrations } from '@grantex/mcp-auth/postgres';

export async function openPostgresStorage(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  // Idempotent and serialised by an advisory lock, so every replica can run
  // it at start-up.
  await runMigrations(pool);

  const storage = new PostgresStorage({ db: pool });

  // Expired rows are already invisible to every read; purging bounds table size.
  const purge = setInterval(() => {
    storage.purgeExpired().catch((err: unknown) => console.error('mcp-auth purge failed', err));
  }, 5 * 60_000);
  purge.unref();

  return {
    storage,
    async close() {
      clearInterval(purge);
      await pool.end();
    },
  };
}
