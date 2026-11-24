import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { emitEvent } from '../src/lib/events.js';
import { hashApiKey } from '../src/lib/hash.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
if (/^(true|1)$/i.test(process.env['CI'] ?? '') && !adminUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL is required in CI for budget replay integration tests');
}
const describePostgres = adminUrl ? describe : describe.skip;
type Sql = ReturnType<typeof postgres>;
interface Fixture { tenant: string; apiKey: string; agent: string; grant: string }
let sql: Sql;
let app: FastifyInstance;
let drop: (() => Promise<void>) | undefined;
let address = 0;

function forwardSql(): void {
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((callback: (tx: unknown) => unknown) => sql.begin(tx => callback(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
}

beforeAll(async () => {
  if (!adminUrl) return;
  const database = await createTestDatabase('budget_replay');
  drop = database.drop;
  sql = postgres(database.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 180_000);

beforeEach(() => {
  if (!adminUrl) return;
  forwardSql();
  vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
  vi.mocked(emitEvent).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  await app?.close();
  await sql?.end();
  await drop?.();
}, 60_000);

async function fixture(owner?: Fixture): Promise<Fixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const tenant = owner?.tenant ?? `dev_budget_${suffix}`;
  const apiKey = owner?.apiKey ?? `gx_test_${randomBytes(32).toString('hex')}`;
  const agent = `ag_budget_${suffix}`;
  const grant = `grnt_budget_${suffix}`;
  if (!owner) {
    await sql`INSERT INTO developers (id, api_key_hash, name, mode)
      VALUES (${tenant}, ${hashApiKey(apiKey)}, 'Budget Replay Fixture', 'sandbox')`;
  }
  await sql`INSERT INTO agents (id, developer_id, name, did, scopes)
    VALUES (${agent}, ${tenant}, 'Nimbus Shopper 2.4', ${`did:grantex:${agent}`}, ${['files:read']})`;
  await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
    VALUES (${grant}, ${agent}, 'budget-example-principal', ${tenant}, ${['files:read']}, NOW() + INTERVAL '1 day')`;
  await sql`INSERT INTO budget_allocations (id, grant_id, developer_id, initial_budget, remaining_budget)
    VALUES (${`bdg_${suffix}`}, ${grant}, ${tenant}, 100, 100)`;
  return { tenant, apiKey, agent, grant };
}

async function debit(f: Fixture, key: string | undefined, amount = 10, extra: Record<string, unknown> = {}) {
  address += 1;
  return app.inject({ method: 'POST', url: '/v1/budget/debit', remoteAddress: `198.51.100.${address % 250 + 1}`,
    headers: { authorization: `Bearer ${f.apiKey}`, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload: { grantId: f.grant, amount, ...extra } });
}

async function state(f: Fixture) {
  const [balance] = await sql`SELECT remaining_budget FROM budget_allocations WHERE grant_id = ${f.grant}`;
  const transactions = await sql`SELECT id, amount FROM budget_transactions WHERE grant_id = ${f.grant} ORDER BY id`;
  const replies = await sql`SELECT * FROM budget_debit_idempotency WHERE developer_id = ${f.tenant} AND grant_id = ${f.grant}`;
  return { balance: Number(balance!['remaining_budget']), transactions, replies };
}

const key = () => `budget-example-${randomUUID()}`;

describePostgres('budget debit replay transaction (real Postgres)', () => {
  it.each([16, 256])('accepts an exact boundary key of %i characters', async (length) => {
    const f = await fixture();
    const retryKey = 'x'.repeat(length);
    const first = await debit(f, retryKey);
    const replay = await debit(f, retryKey);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await state(f)).transactions).toHaveLength(1);
  });
  it('replays the committed response after a lost reply without a second debit or event', async () => {
    const f = await fixture();
    const retryKey = key();
    const first = await debit(f, retryKey, 60);
    const replay = await debit(f, retryKey, 60);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const actual = await state(f);
    expect(actual.balance).toBe(40);
    expect(actual.transactions).toHaveLength(1);
    expect(actual.replies).toHaveLength(1);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledTimes(1);
    expect(actual.replies[0]!['key_hash']).not.toBe(retryKey);
    expect(Object.values(actual.replies[0]!)).not.toContain(retryKey);
  });

  it('serializes eight simultaneous retries into one committed debit and one stored response', async () => {
    const f = await fixture();
    const retryKey = key();
    const responses = await Promise.all(Array.from({ length: 8 }, () => debit(f, retryKey)));
    expect(responses.map(response => response.statusCode)).toEqual(Array(8).fill(200));
    expect(new Set(responses.map(response => response.json().transactionId)).size).toBe(1);
    expect(responses.every(response => response.body === responses[0]!.body)).toBe(true);
    const actual = await state(f);
    expect(actual.balance).toBe(90);
    expect(actual.transactions).toHaveLength(1);
    expect(actual.replies).toHaveLength(1);
  });

  it.each([
    { amount: 11 }, { description: 'different operation' }, { metadata: { action: 'different' } },
  ])('conflicts on a changed effective request without another financial write (%j)', async (change) => {
    const f = await fixture();
    const retryKey = key();
    expect((await debit(f, retryKey)).statusCode).toBe(200);
    const conflict = await debit(f, retryKey, 10, change);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const actual = await state(f);
    expect(actual.balance).toBe(90);
    expect(actual.transactions).toHaveLength(1);
  });

  it('canonicalizes nested metadata ordering without changing array ordering', async () => {
    const f = await fixture();
    const retryKey = key();
    const first = await debit(f, retryKey, 10, { metadata: { z: 1, a: { y: true, b: [1, 2] } } });
    const replay = await debit(f, retryKey, 10, { metadata: { a: { b: [1, 2], y: true }, z: 1 } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const conflict = await debit(f, retryKey, 10, { metadata: { a: { b: [2, 1], y: true }, z: 1 } });
    expect(conflict.statusCode).toBe(409);
    expect((await state(f)).transactions).toHaveLength(1);
  });

  it('accepts only one of two concurrent different requests sharing a key', async () => {
    const f = await fixture();
    const retryKey = key();
    const responses = await Promise.all([debit(f, retryKey, 10), debit(f, retryKey, 20)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const success = responses.find(response => response.statusCode === 200)!;
    const actual = await state(f);
    expect(actual.balance).toBe(Number(success.json().remaining));
    expect(actual.transactions).toHaveLength(1);
    expect(actual.replies).toHaveLength(1);
  });

  it('does not disclose or replay another tenant response, and scopes identical keys by tenant and grant', async () => {
    const first = await fixture();
    const second = await fixture();
    const third = await fixture(first);
    const retryKey = key();
    expect((await debit(first, retryKey)).statusCode).toBe(200);
    const denied = await debit({ ...second, grant: first.grant }, retryKey);
    expect(denied.statusCode, denied.body).toBe(404);
    expect((await debit(second, retryKey)).statusCode).toBe(200);
    expect((await debit(third, retryKey)).statusCode).toBe(200);
    for (const f of [first, second, third]) {
      const actual = await state(f);
      expect(actual.balance).toBe(90);
      expect(actual.transactions).toHaveLength(1);
      expect(actual.replies).toHaveLength(1);
    }
  });

  it.each(['revoked', 'expired'])('refuses replay after the grant is %s', async (condition) => {
    const f = await fixture();
    const retryKey = key();
    expect((await debit(f, retryKey)).statusCode).toBe(200);
    if (condition === 'revoked') await sql`UPDATE grants SET status = 'revoked' WHERE id = ${f.grant}`;
    else await sql`UPDATE grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${f.grant}`;
    const denied = await debit(f, retryKey);
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json().code).toBe('GRANT_INACTIVE');
    const actual = await state(f);
    expect(actual.balance).toBe(90);
    expect(actual.transactions).toHaveLength(1);
  });

  it('returns the original exhausted response rather than attempting to debit again', async () => {
    const f = await fixture();
    const retryKey = key();
    const first = await debit(f, retryKey, 100);
    const replay = await debit(f, retryKey, 100);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await state(f)).transactions).toHaveLength(1);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledTimes(1);
  });

  it('uses a new operation after the 24-hour window and retains both ledger rows', async () => {
    const f = await fixture();
    const retryKey = key();
    const first = await debit(f, retryKey);
    expect(first.statusCode).toBe(200);
    await sql`UPDATE budget_debit_idempotency SET created_at = NOW() - INTERVAL '2 days',
      expires_at = NOW() - INTERVAL '1 second' WHERE grant_id = ${f.grant}`;
    const next = await debit(f, retryKey, 20);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().transactionId).not.toBe(first.json().transactionId);
    const actual = await state(f);
    expect(actual.balance).toBe(70);
    expect(actual.transactions).toHaveLength(2);
    expect(actual.replies).toHaveLength(1);
    expect(new Date(actual.replies[0]!['expires_at'] as Date).getTime()
      - new Date(actual.replies[0]!['created_at'] as Date).getTime()).toBe(86_400_000);
  });

  it.each(['budget_transactions', 'budget_debit_idempotency'])('rolls back balance, ledger and reply if %s insert fails', async (table) => {
    const f = await fixture();
    const retryKey = key();
    await sql.unsafe(`CREATE FUNCTION budget_replay_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic budget rollback probe'; END $$`);
    // `table` is the fixed two-element test matrix, never request input.
    await sql.unsafe(`CREATE TRIGGER budget_replay_failure BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION budget_replay_failure()`);
    try {
      const failed = await debit(f, retryKey, 60);
      expect(failed.statusCode).toBe(500);
      const actual = await state(f);
      expect(actual.balance).toBe(100);
      expect(actual.transactions).toHaveLength(0);
      expect(actual.replies).toHaveLength(0);
      expect(vi.mocked(emitEvent)).not.toHaveBeenCalled();
    } finally {
      await sql.unsafe(`DROP TRIGGER budget_replay_failure ON ${table}`);
      await sql.unsafe('DROP FUNCTION budget_replay_failure()');
    }
    expect((await debit(f, retryKey, 60)).statusCode).toBe(200);
    expect((await state(f)).transactions).toHaveLength(1);
  });

  it('preserves insufficient-budget and unauthenticated denials without storing replies', async () => {
    const f = await fixture();
    expect((await debit(f, key(), 101)).statusCode).toBe(402);
    expect((await debit({ ...f, apiKey: 'invalid-example-key' }, key())).statusCode).toBe(401);
    const actual = await state(f);
    expect(actual.balance).toBe(100);
    expect(actual.transactions).toHaveLength(0);
    expect(actual.replies).toHaveLength(0);
  });

  it('retains legacy repeated-debit behavior with the flag off or without a key', async () => {
    const first = await fixture();
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'false');
    const retryKey = key();
    expect((await debit(first, retryKey)).statusCode).toBe(200);
    expect((await debit(first, retryKey)).statusCode).toBe(200);
    const second = await fixture();
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
    expect((await debit(second, undefined)).statusCode).toBe(200);
    expect((await debit(second, undefined)).statusCode).toBe(200);
    for (const f of [first, second]) {
      const actual = await state(f);
      expect(actual.balance).toBe(80);
      expect(actual.transactions).toHaveLength(2);
      expect(actual.replies).toHaveLength(0);
    }
  });

  it('keeps agent deletion compatible through replay-state foreign-key cascades', async () => {
    const f = await fixture();
    expect((await debit(f, key())).statusCode).toBe(200);
    const deleted = await app.inject({ method: 'DELETE', url: `/v1/agents/${f.agent}`,
      headers: { authorization: `Bearer ${f.apiKey}` }, remoteAddress: '198.51.100.254' });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await sql`SELECT 1 FROM budget_debit_idempotency WHERE grant_id = ${f.grant}`).toHaveLength(0);
  });
});
