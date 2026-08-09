import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

export async function runMigrations(sql: ReturnType<typeof postgres>): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Cloud Run/Kubernetes may start several instances together. Reserve one
  // session so the advisory lock remains on the same PostgreSQL connection,
  // then serialize DDL across instances. A transaction lock cannot be used
  // because production index migrations use CREATE INDEX CONCURRENTLY.
  const migrationSql = await sql.reserve();
  let locked = false;
  try {
    await migrationSql`SELECT pg_advisory_lock(hashtextextended('grantex:migrations', 0))`;
    locked = true;

    for (const file of files) {
      const content = readFileSync(join(migrationsDir, file), 'utf-8');
      await migrationSql.unsafe(content);
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

  console.log(`Migrations: applied ${files.length} files`);
}
