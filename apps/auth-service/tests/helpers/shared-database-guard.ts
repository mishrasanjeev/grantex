import postgres from 'postgres';

/**
 * Fails the run if any test file touched the shared database.
 *
 * Each Postgres integration file migrates a database of its own
 * (`createTestDatabase` in `./database.ts`); the one named by
 * `AUDIT_INTEGRATION_DATABASE_URL` is only an admin connection used to create
 * them. A file that migrates the shared database instead still passes on its
 * own, and brings back the cross-file deadlock the per-file databases removed
 * (FINDINGS G-24). Nothing noticed when the tenth file did exactly that, so the
 * run now checks, before and after, that the shared database gained no tables
 * (FINDINGS G-30).
 */
export interface SharedDatabaseSnapshot {
  tables: Set<string>;
}

const LEDGER = 'schema_migrations';

async function inspect<T>(url: string, read: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  try {
    return await read(sql);
  } catch (err) {
    throw new Error(
      `The shared-database guard could not inspect the shared database, so it cannot tell whether a test file migrated it: ${String(err)}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function listTables(sql: ReturnType<typeof postgres>): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`
    SELECT table_schema || '.' || table_name AS name
      FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_schema NOT LIKE 'pg\_%'`;
  return new Set(rows.map((row) => row.name));
}

async function hasLedger(sql: ReturnType<typeof postgres>): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass(${LEDGER}) IS NOT NULL AS present`;
  return row?.present === true;
}

export async function snapshotSharedDatabase(url: string): Promise<SharedDatabaseSnapshot> {
  const { tables, ledger } = await inspect(url, async (sql) => ({
    tables: await listTables(sql),
    ledger: await hasLedger(sql),
  }));
  // A ledger left by an earlier run means a migration against it now would
  // create nothing new, so a regression would pass unseen. Refuse to guess.
  if (ledger) {
    throw new Error(
      `The shared database already holds a migration ledger (${LEDGER}), left by an earlier run that migrated it, ` +
        'so this run cannot tell whether a test file migrates it again. Point AUDIT_INTEGRATION_DATABASE_URL at a ' +
        'database without Grantex tables, or drop the leftover ones.',
    );
  }
  return { tables };
}

export async function checkSharedDatabase(url: string, before: SharedDatabaseSnapshot): Promise<void> {
  const after = await inspect(url, listTables);
  const added = [...after].filter((name) => !before.tables.has(name)).sort();
  if (added.length === 0) return;
  // The ledger is the proof that migrations ran; show it first so it is never
  // among the tables cut from the message.
  const migrated = added.some((name) => name.endsWith(`.${LEDGER}`));
  if (migrated) added.sort((a, b) => Number(b.endsWith(`.${LEDGER}`)) - Number(a.endsWith(`.${LEDGER}`)));
  const shown = added.slice(0, 10).join(', ') + (added.length > 10 ? `, and ${added.length - 10} more` : '');
  throw new Error(
    `${migrated ? 'A test file ran the migrations in' : 'A test file created tables in'} the shared database ` +
      `(AUDIT_INTEGRATION_DATABASE_URL): ${shown}. Integration files must use a database of their own: ` +
      'call createTestDatabase() from tests/helpers/database.ts in beforeAll. See FINDINGS G-24 and G-30.',
  );
}
