import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
if (['true', '1'].includes(process.env['CI']?.trim().toLowerCase() ?? '') && !adminUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL is required in CI for consent retention tests');
}
const describePostgres = adminUrl ? describe : describe.skip;
let sql: ReturnType<typeof postgres>;
let app: FastifyInstance;
let drop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!adminUrl) return;
  const db = await createTestDatabase('consent_retention');
  drop = db.drop;
  sql = postgres(db.url, { max: 6, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 120_000);

afterAll(async () => {
  try { await app?.close(); await sql?.end({ timeout: 5 }); }
  finally { await drop?.(); }
}, 60_000);

beforeEach(() => {
  if (!adminUrl) return;
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
  vi.stubEnv('AGENT_CONSENT_RETENTION_GUARD_ENABLED', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); });

async function fixture() {
  const suffix = randomUUID().replace(/-/g, '');
  const row = { developer: `dev_${suffix}`, agent: `ag_${suffix}`, grant: `grnt_${suffix}`, bundle: `bundle_${suffix}`, key: `gx_test_${suffix}` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
    VALUES (${row.developer}, ${hashApiKey(row.key)}, 'Consent Retention Test', 'sandbox')`;
  await sql`INSERT INTO agents (id, did, developer_id, name)
    VALUES (${row.agent}, ${'did:grantex:' + row.agent}, ${row.developer}, 'Nimbus Shopper 2.4')`;
  await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
    VALUES (${row.grant}, ${row.agent}, 'synthetic_principal', ${row.developer}, ${['read']}, NOW() + INTERVAL '1 hour')`;
  return row;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function bundle(row: Fixture, status: string) {
  await sql`INSERT INTO consent_bundles
    (id, developer_id, agent_id, grant_id, user_id, scopes, audit_public_key, offline_expires_at, status)
    VALUES (${row.bundle}, ${row.developer}, ${row.agent}, ${row.grant}, 'synthetic_principal',
      ${['read']}, 'synthetic-public-key', NOW() - INTERVAL '1 hour', ${status})`;
  await sql`INSERT INTO offline_audit_entries
    (id, bundle_id, developer_id, seq, timestamp, action, agent_did, grant_id, scopes, result, prev_hash, hash, signature)
    VALUES (${'oae_' + row.bundle}, ${row.bundle}, ${row.developer}, 1, NOW(), 'read',
      ${'did:grantex:' + row.agent}, ${row.grant}, ${['read']}, 'success', '', 'synthetic-hash', 'synthetic-signature')`;
}

function remove(row: Fixture, key = row.key) {
  return app.inject({ method: 'DELETE', url: `/v1/agents/${row.agent}`, headers: { authorization: `Bearer ${key}` } });
}
async function snapshot(row: Fixture) {
  return {
    agents: await sql`SELECT * FROM agents WHERE id = ${row.agent}`,
    grants: await sql`SELECT * FROM grants WHERE id = ${row.grant}`,
    bundles: await sql`SELECT * FROM consent_bundles WHERE id = ${row.bundle}`,
    audit: await sql`SELECT * FROM offline_audit_entries WHERE bundle_id = ${row.bundle}`,
  };
}

describePostgres('opt-in consent retention on agent deletion', () => {
  it.each(['active', 'revoked', 'expired'])('retains every row for a %s bundle across repeated deletion', async (status) => {
    const row = await fixture();
    await bundle(row, status);
    const before = await snapshot(row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await remove(row);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'AGENT_HAS_CONSENT_HISTORY' });
      expect(await snapshot(row)).toEqual(before);
    }
  });

  it.each([undefined, 'false', 'TRUE'])('preserves the default-off path for flag %s without losing rows', async (flag) => {
    if (flag === undefined) delete process.env['AGENT_CONSENT_RETENTION_GUARD_ENABLED'];
    else vi.stubEnv('AGENT_CONSENT_RETENTION_GUARD_ENABLED', flag);
    const row = await fixture();
    await bundle(row, 'active');
    const before = await snapshot(row);
    expect((await remove(row)).statusCode).toBe(500);
    expect(await snapshot(row)).toEqual(before);
  });

  it('does not expose another tenant history and still deletes an unreferenced agent', async () => {
    const row = await fixture();
    await bundle(row, 'active');
    const other = await fixture();
    const before = await snapshot(row);
    expect((await remove(row, other.key)).statusCode).toBe(404);
    expect(await snapshot(row)).toEqual(before);
    expect((await remove(other)).statusCode).toBe(204);
    expect((await snapshot(other)).agents).toHaveLength(0);
    expect((await snapshot(other)).grants).toHaveLength(0);
  });

  it('retains a bundle referencing the agent grant even when its agent field differs', async () => {
    const row = await fixture();
    await bundle(row, 'active');
    const sibling = 'ag_sibling_' + randomUUID().replace(/-/g, '');
    await sql`INSERT INTO agents (id, did, developer_id, name)
      VALUES (${sibling}, ${'did:grantex:' + sibling}, ${row.developer}, 'Sibling')`;
    await sql`UPDATE consent_bundles SET agent_id = ${sibling} WHERE id = ${row.bundle}`;
    const before = await snapshot(row);
    expect((await remove(row)).statusCode).toBe(409);
    expect(await snapshot(row)).toEqual(before);
  });

  it('waits for an in-flight bundle insert and then refuses deletion without losing evidence', async () => {
    const row = await fixture();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<number>((resolve) => { ready = resolve; });
    const writer = sql.begin(async (tx) => {
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      // A bundle insert obtains a key-share agent lock through its foreign key.
      await tx`INSERT INTO consent_bundles
        (id, developer_id, agent_id, grant_id, user_id, scopes, audit_public_key, offline_expires_at)
        VALUES (${row.bundle}, ${row.developer}, ${row.agent}, ${row.grant}, 'synthetic_principal',
          ${['read']}, 'synthetic-public-key', NOW() + INTERVAL '1 hour')`;
      ready(backend!['pid'] as number);
      await held;
    });
    const pid = await started;
    const deletion = remove(row).then((response) => response);
    try {
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const waiting = await sql`SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) LIMIT 1`;
        if (waiting.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
    } finally { release(); await writer; }
    const response = await deletion;
    expect(response.statusCode, response.body).toBe(409);
    const after = await snapshot(row);
    expect(after.agents).toHaveLength(1);
    expect(after.grants).toHaveLength(1);
    expect(after.bundles).toHaveLength(1);
  });
});
