// SPDX-License-Identifier: Apache-2.0
/**
 * A key compromise racing a delegation, against real Postgres.
 *
 * POST /v1/grants/delegate binds the child grant to the sub-agent's
 * registered key (cnf.jkt) and inserts it under the developer's cascade lock
 * (hashtextextended(developer_id, 4)). A compromise of that key must not
 * leave such a grant live, whichever way the two interleave:
 *
 *   1. The delegation holds the cascade lock, its grant not yet committed,
 *      while the compromise looks for the grants bound to the key. The
 *      compromise takes the same lock before it looks, so it waits for the
 *      delegation and finds its grant.
 *   2. The delegation read the sub-agent's key before the compromise ended
 *      it, and reaches the cascade lock only after the compromise finished.
 *      The delegation re-checks the key under the lock and refuses it.
 *
 * Each ordering is forced: the first by holding the parent grant's row lock
 * (which the delegation takes right after the cascade lock), the second by
 * pausing the delegation between its read of the sub-agent and its
 * transaction (a gate around signGrantToken).
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
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
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres compromise race tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const SCOPES = ['tool:acme_kyb:read', 'payments:mpp:inference'];

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string; ip: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let tenantCounter = 0;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function newTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_race_${suffix}`, apiKey: `gx_test_race_${suffix}_key`, ip: `198.51.100.${200 + tenantCounter}` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Compromise Race Test', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    remoteAddress: tenant.ip,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function createAgent(tenant: Tenant, name: string): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/agents', { name, scopes: SCOPES });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ agentId: string }>().agentId;
}

/**
 * A sub-agent whose registered key is in its history as active: added and
 * proven through the key routes, then made the registered key with PATCH.
 * Works the same with the history mirror on or off.
 */
async function subAgentWithRegisteredKey(tenant: Tenant): Promise<{ agentId: string; key: Key }> {
  const agentId = await createAgent(tenant, 'Nimbus Shopper 2.4 (sub)');
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const key = { privateKey, jwk, thumbprint: jwkThumbprint(jwk) };
  const added = await call(tenant, 'POST', `/v1/agents/${agentId}/keys`, { publicJwk: jwk });
  expect(added.statusCode, added.body).toBe(201);
  const issued = await call(tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/challenge`);
  expect(issued.statusCode, issued.body).toBe(201);
  const proof = await new SignJWT({ nonce: issued.json<{ challenge: string }>().challenge, sub: agentId })
    .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .sign(privateKey);
  const proved = await call(tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/prove`, { proof });
  expect(proved.statusCode, proved.body).toBe(200);
  const patched = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: jwk });
  expect(patched.statusCode, patched.body).toBe(200);
  expect(patched.json()).toMatchObject({ keyThumbprint: key.thumbprint });
  return { agentId, key };
}

async function mintGrant(tenant: Tenant, agentId: string, principalId: string) {
  const authorized = await call(tenant, 'POST', '/v1/authorize', { agentId, principalId, scopes: SCOPES });
  expect(authorized.statusCode, authorized.body).toBe(201);
  const exchanged = await call(tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId });
  expect(exchanged.statusCode, exchanged.body).toBe(201);
  return exchanged.json<{ grantToken: string; grantId: string }>();
}

/** Grants bound to the key that could still be used. */
async function liveBoundGrants(developerId: string, thumbprint: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM grants
    WHERE developer_id = ${developerId} AND agent_key_thumbprint = ${thumbprint}
      AND status IN ('active', 'suspended')`;
  return rows.map((row) => row.id);
}

/** Poll until `probe` is true, or fail after `timeoutMs`. */
async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Backends of this database waiting on a lock of the given kind (pg_stat_activity wait_event). */
async function waiting(waitEvent: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = ${waitEvent}`;
  return rows[0]?.count ?? 0;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('agent-key-race');
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
  signGate.armed = null;
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  signGate.armed = null;
  vi.unstubAllEnvs();
});

describePostgres('a key compromise racing a delegation', () => {
  it('waits for a delegation that holds the cascade lock, and revokes the grant it commits', async () => {
    const tenant = await newTenant();
    const parentAgent = await createAgent(tenant, 'Nimbus Shopper 2.4 (parent)');
    const { agentId: subAgent, key } = await subAgentWithRegisteredKey(tenant);
    const parent = await mintGrant(tenant, parentAgent, 'shopper-01');

    // The controlled hold: the parent grant's row, which the delegation locks
    // FOR UPDATE right after it takes the cascade lock.
    const held = deferred();
    const release = deferred();
    const hold = sql.begin(async (tx) => {
      await tx`SELECT id FROM grants WHERE id = ${parent.grantId} FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    await held.promise;

    let delegation: Promise<Awaited<ReturnType<typeof call>>> | undefined;
    let compromise: Promise<Awaited<ReturnType<typeof call>>> | undefined;
    try {
      delegation = call(tenant, 'POST', '/v1/grants/delegate', {
        parentGrantToken: parent.grantToken, subAgentId: subAgent, scopes: [SCOPES[0]], expiresIn: '30m',
      });
      // The delegation now holds the cascade lock and waits on the row.
      await waitFor('the delegation to wait on the parent grant row', async () => (await waiting('transactionid')) + (await waiting('tuple')) > 0);

      compromise = call(tenant, 'POST', `/v1/agents/${subAgent}/keys/${key.thumbprint}/compromise`, { reason: 'device lost' });
      let settled = false;
      void compromise.then(() => { settled = true; });
      // The compromise must queue behind the delegation's cascade lock before
      // it looks for bound grants; one that answers first has looked too early.
      await waitFor('the compromise to wait on the cascade lock, or to answer', async () => settled || (await waiting('advisory')) > 0);
    } finally {
      release.resolve();
      await hold;
    }

    const delegated = await delegation!;
    expect(delegated.statusCode, delegated.body).toBe(201);
    const childGrantId = delegated.json<{ grantId: string }>().grantId;
    const childRow = await sql`SELECT agent_key_thumbprint FROM grants WHERE id = ${childGrantId}`;
    expect(childRow[0]!['agent_key_thumbprint']).toBe(key.thumbprint);

    const compromised = await compromise!;
    expect(compromised.statusCode, compromised.body).toBe(200);
    expect(compromised.json()).toMatchObject({ grantsRevoked: 1, agentKey: 'cleared', agentSuspended: true });

    const grant = await sql<{ status: string }[]>`SELECT status FROM grants WHERE id = ${childGrantId}`;
    expect(grant[0]!.status).toBe('revoked');
    expect(await liveBoundGrants(tenant.id, key.thumbprint)).toEqual([]);
  }, 120_000);

  it('refuses a delegation that read the key before the compromise and reaches the cascade lock after it', async () => {
    const tenant = await newTenant();
    const parentAgent = await createAgent(tenant, 'Nimbus Shopper 2.4 (parent)');
    const { agentId: subAgent, key } = await subAgentWithRegisteredKey(tenant);
    const parent = await mintGrant(tenant, parentAgent, 'shopper-02');

    // Pause the delegation after it read the sub-agent (and its key), before
    // its transaction.
    const entered = deferred();
    const release = deferred();
    signGate.armed = { entered: () => entered.resolve(), release: release.promise };
    let delegation: Promise<Awaited<ReturnType<typeof call>>> | undefined;
    try {
      delegation = call(tenant, 'POST', '/v1/grants/delegate', {
        parentGrantToken: parent.grantToken, subAgentId: subAgent, scopes: [SCOPES[0]], expiresIn: '30m',
      });
      await entered.promise;

      // The whole compromise runs while the delegation is paused.
      const compromised = await call(tenant, 'POST', `/v1/agents/${subAgent}/keys/${key.thumbprint}/compromise`, {});
      expect(compromised.statusCode, compromised.body).toBe(200);
      expect(compromised.json()).toMatchObject({ grantsRevoked: 0, agentKey: 'cleared', agentSuspended: true });
    } finally {
      release.resolve();
    }

    const delegated = await delegation!;
    // Fail closed: a grant bound to a key reported compromised is never issued.
    expect(delegated.statusCode, delegated.body).toBe(409);
    expect(delegated.json()).toMatchObject({ code: 'key_not_active' });
    expect(await liveBoundGrants(tenant.id, key.thumbprint)).toEqual([]);
    const children = await sql`SELECT id FROM grants WHERE parent_grant_id = ${parent.grantId}`;
    expect(children).toHaveLength(0);
  }, 120_000);
});
