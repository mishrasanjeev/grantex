import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import postgres from 'postgres';
import { PostgresStorage, fromPostgresJs, runMigrations } from '../../src/storage/postgres.js';
import { describeStorageContract } from '../storage-contract.js';
import { databaseUrl } from './env.js';

const skip = !databaseUrl;

const TABLES = [
  'mcp_auth_authorization_codes',
  'mcp_auth_clients',
  'mcp_auth_consents',
  'mcp_auth_pending_authorizations',
  'mcp_auth_refresh_token_bindings',
  'mcp_auth_revocations',
];

// One pool and one postgres.js instance for the whole file, opened lazily so
// the file imports cleanly when the suite is skipped.
let pool: pg.Pool | undefined;
let sql: ReturnType<typeof postgres> | undefined;
const getPool = () => (pool ??= new pg.Pool({ connectionString: databaseUrl, max: 30 }));
const getSql = () => (sql ??= postgres(databaseUrl!, { max: 30, onnotice: () => {} }));

async function dump(): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const { rows } = await getPool().query(`SELECT t::text AS row FROM ${table} t`);
    parts.push(...rows.map((row: { row: string }) => row.row));
  }
  return parts.join('\n');
}

beforeAll(async () => {
  if (!skip) await runMigrations(getPool());
});

afterAll(async () => {
  await pool?.end();
  await sql?.end();
});

(skip ? describe.skip : describe)('Postgres storage (real database)', () => {
  it('migrations are idempotent and safe to run from several replicas at once', async () => {
    const results = await Promise.all([
      runMigrations(getPool()),
      runMigrations(getPool()),
      runMigrations(fromPostgresJs(getSql())),
    ]);
    for (const files of results) expect(files).toEqual(['001_mcp_auth_state.sql']);
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mcp_auth_%' ORDER BY table_name`,
    );
    expect(rows.map((row: { table_name: string }) => row.table_name)).toEqual(TABLES);
  });

  it('purgeExpired removes expired rows and keeps live ones', async () => {
    const storage = new PostgresStorage({ db: getPool() });
    const record = {
      clientId: 'purge-client',
      redirectUri: 'https://app.example.com/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256' as const,
      scopes: [],
      grantexAuthRequestId: 'areq',
    };
    await storage.putAuthorizationCode('purge-expired', { ...record, expiresAt: Date.now() - 1000 });
    await storage.putAuthorizationCode('purge-live', { ...record, expiresAt: Date.now() + 60_000 });
    expect(await storage.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await storage.consumeAuthorizationCode('purge-live')).toBeDefined();
  });

  it('propagates a database error instead of reporting "not found"', async () => {
    const broken = new PostgresStorage({
      db: { query: async () => { throw new Error('connection refused'); } },
    });
    await expect(broken.consumeAuthorizationCode('any')).rejects.toThrow('connection refused');
    await expect(broken.isTokenRevoked('any')).rejects.toThrow('connection refused');
  });
});

describeStorageContract(
  'postgres (pg driver)',
  async () => ({ storage: new PostgresStorage({ db: getPool() }), dump }),
  { skip },
);

describeStorageContract(
  'postgres (postgres.js driver)',
  async () => ({ storage: new PostgresStorage({ db: fromPostgresJs(getSql()) }), dump }),
  { skip },
);
