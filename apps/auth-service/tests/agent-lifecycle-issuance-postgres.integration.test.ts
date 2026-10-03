import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { emitEvent } from '../src/lib/events.js';
import { revokeAgentGrantsInTx } from '../src/lib/revoke.js';
import type { TxSql } from '../src/db/client.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

interface Gate { entered: () => void; release: Promise<void> }
const signGate = vi.hoisted(() => ({ armed: null as Gate | null }));

vi.mock('../src/lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/crypto.js')>();
  return {
    ...actual,
    signGrantToken: async (...args: Parameters<typeof actual.signGrantToken>) => {
      const gate = signGate.armed;
      if (gate) {
        signGate.armed = null;
        gate.entered();
        await gate.release;
      }
      return actual.signGrantToken(...args);
    },
  };
});

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI for lifecycle issuance races');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
interface Tenant { id: string; apiKey: string; agentId: string }
let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for concurrent lifecycle operation');
}

async function newTenant(): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = {
    id: `dev_lifecycle_${suffix}`,
    apiKey: `gx_lifecycle_${suffix}_key`,
    agentId: `ag_lifecycle_${suffix}`,
  };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Lifecycle Race Test', 'sandbox')`;
  await sql`INSERT INTO agents (id, did, developer_id, name, scopes)
            VALUES (${tenant.agentId}, ${'did:grantex:' + tenant.agentId}, ${tenant.id},
                    'Lifecycle Agent', ${['read']})`;
  return tenant;
}

function call(tenant: Tenant, method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
  return app.inject({
    method, url, payload,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
  });
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('lifecycle_issuance');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 }).catch(() => undefined);
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  vi.stubEnv('AGENT_LIFECYCLE_STATES_ENABLED', 'true');
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  signGate.armed = null;
  vi.unstubAllEnvs();
});

describePostgres('agent lifecycle against concurrent grant issuance', () => {
  it('refuses a code exchange queued behind a lifecycle transition and preserves the code', async () => {
    const tenant = await newTenant();
    const authorized = await call(tenant, 'POST', '/v1/authorize', {
      agentId: tenant.agentId, principalId: 'user_lifecycle', scopes: ['read'],
    });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const code = authorized.json<{ code: string }>().code;

    const entered = deferred();
    const release = deferred();
    const transition = sql.begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      await tx`UPDATE agents SET status = 'suspended' WHERE id = ${tenant.agentId}`;
      entered.resolve();
      await release.promise;
      await revokeAgentGrantsInTx(tx, tenant.agentId, tenant.id, false);
    });
    await entered.promise;

    let exchange: ReturnType<typeof call> | undefined;
    try {
      exchange = call(tenant, 'POST', '/v1/token', { code, agentId: tenant.agentId });
      await waitFor(async () => {
        const rows = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND wait_event IN ('transactionid', 'tuple')`;
        return (rows[0]?.count ?? 0) > 0;
      });
    } finally {
      release.resolve();
      await transition;
    }

    const refused = await exchange!;
    expect(refused.statusCode, refused.body).toBe(400);
    expect((await sql`SELECT status FROM auth_requests WHERE code = ${code}`)[0]?.['status']).toBe('approved');
    expect(await sql`SELECT id FROM grants WHERE agent_id = ${tenant.agentId}`).toHaveLength(0);
  }, 120_000);

  it('lets a started exchange commit first, then sweeps its grant on suspension', async () => {
    const tenant = await newTenant();
    const authorized = await call(tenant, 'POST', '/v1/authorize', {
      agentId: tenant.agentId, principalId: 'user_lifecycle', scopes: ['read'],
    });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const code = authorized.json<{ code: string }>().code;

    const entered = deferred();
    const release = deferred();
    const hold = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${tenant.id}, 4))`;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let exchange: ReturnType<typeof call> | undefined;
    let transition: ReturnType<typeof call> | undefined;
    try {
      exchange = call(tenant, 'POST', '/v1/token', { code, agentId: tenant.agentId });
      await waitFor(async () => {
        const rows = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'`;
        return (rows[0]?.count ?? 0) > 0;
      });
      transition = call(tenant, 'PATCH', `/v1/agents/${tenant.agentId}`, { status: 'suspended' });
      await waitFor(async () => {
        const rows = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND wait_event IN ('transactionid', 'tuple')`;
        return (rows[0]?.count ?? 0) > 0;
      });
    } finally {
      release.resolve();
      await hold;
    }

    const issued = await exchange!;
    const suspended = await transition!;
    expect(issued.statusCode, issued.body).toBe(201);
    expect(suspended.statusCode, suspended.body).toBe(200);
    const grantId = issued.json<{ grantId: string }>().grantId;
    expect((await sql`SELECT status FROM grants WHERE id = ${grantId}`)[0]?.['status']).toBe('revoked');
    expect((await sql`SELECT status FROM auth_requests WHERE code = ${code}`)[0]?.['status']).toBe('consumed');
  }, 120_000);

  it('refuses a bundle that read an active agent before the suspension committed', async () => {
    const tenant = await newTenant();
    const entered = deferred();
    const release = deferred();
    signGate.armed = { entered: entered.resolve, release: release.promise };
    let bundle: ReturnType<typeof call> | undefined;
    try {
      bundle = call(tenant, 'POST', '/v1/consent-bundles', {
        agentId: tenant.agentId, userId: 'user_lifecycle', scopes: ['read'],
      });
      await entered.promise;
      const suspended = await call(tenant, 'PATCH', `/v1/agents/${tenant.agentId}`, { status: 'suspended' });
      expect(suspended.statusCode, suspended.body).toBe(200);
    } finally {
      release.resolve();
    }
    const refused = await bundle!;
    expect(refused.statusCode, refused.body).toBe(404);
    expect(await sql`SELECT id FROM grants WHERE agent_id = ${tenant.agentId}`).toHaveLength(0);
    expect(await sql`SELECT id FROM consent_bundles WHERE agent_id = ${tenant.agentId}`).toHaveLength(0);
  }, 120_000);

  it('still issues a bundle for an active agent under the lifecycle flag', async () => {
    const tenant = await newTenant();
    const issued = await call(tenant, 'POST', '/v1/consent-bundles', {
      agentId: tenant.agentId, userId: 'user_lifecycle', scopes: ['read'],
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const grants = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM grants WHERE agent_id = ${tenant.agentId}`;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.status).toBe('active');

    const suspended = await call(tenant, 'PATCH', `/v1/agents/${tenant.agentId}`, { status: 'suspended' });
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect((await sql`SELECT status FROM grants WHERE id = ${grants[0]!.id}`)[0]?.['status']).toBe('revoked');
  }, 120_000);

  it('publishes one grant.revoked event per grant only after lifecycle commit', async () => {
    const tenant = await newTenant();
    const parent = `grnt_parent_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const child = `grnt_child_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
              VALUES (${parent}, ${tenant.agentId}, 'user_lifecycle', ${tenant.id}, ${['read']}, NOW() + INTERVAL '1 hour')`;
    await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id)
              VALUES (${child}, ${tenant.agentId}, 'user_lifecycle', ${tenant.id}, ${['read']},
                      NOW() + INTERVAL '1 hour', ${parent})`;
    const observed: Array<{ grantId: string; cascade: boolean; statuses: string[] }> = [];
    vi.mocked(emitEvent).mockImplementation(async (developerId, type, data) => {
      if (developerId !== tenant.id || type !== 'grant.revoked') return;
      const grants = await sql<{ status: string }[]>`
        SELECT status FROM grants WHERE id IN (${parent}, ${child})`;
      observed.push({
        grantId: data['grantId'] as string,
        cascade: data['cascade'] as boolean,
        statuses: grants.map((row) => row.status),
      });
    });
    try {
      const suspended = await call(tenant, 'PATCH', `/v1/agents/${tenant.agentId}`, { status: 'suspended' });
      expect(suspended.statusCode, suspended.body).toBe(200);
      await waitFor(async () => observed.length === 2);
      expect(new Map(observed.map((event) => [event.grantId, event.cascade])))
        .toEqual(new Map([[parent, true], [child, false]]));
      expect(observed.every((event) => event.statuses.length === 2
        && event.statuses.every((status) => status === 'revoked'))).toBe(true);
    } finally {
      vi.mocked(emitEvent).mockResolvedValue(undefined);
    }
  }, 120_000);
});
