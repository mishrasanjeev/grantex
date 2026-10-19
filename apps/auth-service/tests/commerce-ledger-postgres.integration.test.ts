/**
 * Commerce ledger (G16) against real Postgres: arbiter decisions are stored
 * append-only and idempotently, and the database itself refuses a refusal
 * that carries a grant.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own (FINDINGS G-24).
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres commerce ledger tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const SERVICE_TOKEN = 'agenticorg-ledger-fixture-service-key';
const TENANT = 'cten_LEDGER';

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('commerce-ledger');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('commerce ledger against real Postgres', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 6, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin(cb as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
  });

  describe('arbiter decisions', () => {
    const decision = (id: string, overrides: Record<string, unknown> = {}) => ({
      decision_id: id,
      tenant_id: TENANT,
      merchant_id: 'mch_example',
      seller_agent_id: 'seller-01',
      buyer_agent_id: 'shopper-01',
      action: 'purchase_handoff',
      action_hash: 'c'.repeat(64),
      outcome: 'allow',
      rules_evaluated: ['mandate_present', 'consent_granted'],
      failing_rule: null,
      evidence: { mandate_ref: 'mandate:01', mandate_hash: 'd'.repeat(64), consent_ref: 'consent:01', consent_status: 'granted', passport_ref: null, artifact_ids: [] },
      decided_at: new Date().toISOString(),
      policy_version: '2026-10-01',
      ...overrides,
    });
    const post = (payload: unknown) => app.inject({
      method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }, payload: payload as Record<string, unknown>,
    });

    it('stores an allow once with its grant claims and answers a replay with the same jti', async () => {
      const body = decision('arb_int_allow_1');
      const first = await post(body);
      expect(first.statusCode, first.body).toBe(201);
      const replay = await post(body);
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ jti: string; exp: number }>()).toMatchObject({ jti: first.json<{ jti: string }>().jti, exp: first.json<{ exp: number }>().exp });
      const rows = await sql`SELECT outcome, grant_jti, grant_claims, service_id FROM commerce_arbiter_decisions WHERE decision_id = 'arb_int_allow_1'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'allow', grant_jti: first.json<{ jti: string }>().jti, service_id: 'agenticorg_c6z_authority' });
      expect((rows[0]!['grant_claims'] as Record<string, unknown>)['approver_auth']).toBe('policy_arbiter');

      const conflict = await post({ ...body, action_hash: 'e'.repeat(64) });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ error: { code: string } }>().error.code).toBe('arbiter_decision_conflict');
    });

    it('records a refusal with no grant, and concurrent identical posts store one row', async () => {
      const body = decision('arb_int_refuse_1', {
        outcome: 'refuse', failing_rule: 'consent_granted',
        evidence: { mandate_ref: 'mandate:01', mandate_hash: 'd'.repeat(64), consent_ref: null, consent_status: 'revoked', passport_ref: null, artifact_ids: [] },
      });
      const answers = await Promise.all([post(body), post(body), post(body)]);
      expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 200, 201]);
      for (const a of answers) expect(a.json()).toEqual({ decision_id: 'arb_int_refuse_1', outcome: 'refuse', recorded: true });
      const rows = await sql`SELECT grant_jti, grant_claims, grant_expires_at FROM commerce_arbiter_decisions WHERE decision_id = 'arb_int_refuse_1'`;
      expect(rows).toEqual([{ grant_jti: null, grant_claims: null, grant_expires_at: null }]);
    });

    it('concurrent allows of one decision_id mint one jti', async () => {
      const body = decision('arb_int_allow_race');
      const answers = await Promise.all([post(body), post(body), post(body)]);
      expect(new Set(answers.map((a) => a.json<{ jti: string }>().jti)).size).toBe(1);
    });

    it('the database refuses a refusal carrying a grant, and any update or delete', async () => {
      await expect(sql`
        INSERT INTO commerce_arbiter_decisions (decision_id, tenant_id, merchant_id, seller_agent_id, buyer_agent_id, action, action_hash,
          outcome, rules_evaluated, failing_rule, evidence, decided_at, policy_version, request_hash, grant_jti, grant_claims, grant_expires_at, service_id)
        VALUES ('arb_int_bad', ${TENANT}, 'mch_example', 'seller-01', 'shopper-01', 'purchase_handoff', ${'c'.repeat(64)},
          'refuse', '["r"]', 'r', '{}', NOW(), '1', ${'f'.repeat(64)}, 'dgnt_x', '{}', NOW(), 'svc')`).rejects.toThrow(/chk_arbiter_grant/);
      await expect(sql`UPDATE commerce_arbiter_decisions SET outcome = 'refuse' WHERE decision_id = 'arb_int_allow_1'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM commerce_arbiter_decisions WHERE decision_id = 'arb_int_allow_1'`).rejects.toThrow(/append-only/);
    });
  });
});
