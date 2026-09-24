import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate.js';
import { loadAdminStats } from '../src/routes/admin.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL is required for real-Postgres admin tests in CI');
}

const describePostgres = adminDatabaseUrl ? describe : describe.skip;
let sql: ReturnType<typeof postgres>;
let dropTestDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('admin');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 3, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

describePostgres('admin stats against real Postgres', () => {
  it('returns an empty mode map when there are no developers', async () => {
    expect(await loadAdminStats(sql)).toEqual({
      totalDevelopers: 0,
      last24h: 0,
      last7d: 0,
      last30d: 0,
      byMode: {},
      totalAgents: 0,
      totalGrants: 0,
    });
  });

  it('returns counts and mode breakdown in one query', async () => {
    await sql`
      INSERT INTO developers (id, api_key_hash, name, mode, created_at)
      VALUES
        ('dev_admin_old', 'hash_admin_old', 'Old Developer', 'sandbox', NOW() - INTERVAL '2 days'),
        ('dev_admin_new', 'hash_admin_new', 'New Developer', 'live', NOW())
    `;
    await sql`
      INSERT INTO agents (id, did, developer_id, name)
      VALUES ('ag_admin', 'did:grantex:ag_admin', 'dev_admin_new', 'Admin Agent')
    `;
    await sql`
      INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES ('grnt_admin', 'ag_admin', 'user_admin', 'dev_admin_new', ${['read']}, NOW() + INTERVAL '1 hour')
    `;

    expect(await loadAdminStats(sql)).toEqual({
      totalDevelopers: 2,
      last24h: 1,
      last7d: 2,
      last30d: 2,
      byMode: { live: 1, sandbox: 1 },
      totalAgents: 1,
      totalGrants: 1,
    });
  });
});
