/**
 * Commerce ledger (G16) against real Postgres: arbiter decisions are stored
 * append-only and idempotently, and the database itself refuses a refusal
 * that carries a grant; witness checkpoints are idempotent, a fork is refused
 * and recorded, and both read back; wallet ledger entries are chained by the
 * database on every insert path, concurrently, the backfill chains existing
 * rows, and the verifier finds edited, deleted and reordered entries.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { createPrincipalReload } from '../src/lib/prepaid-wallet.js';
import { loadWalletLedgerChain, verifyWalletLedger, walletLedgerEntryHash } from '../src/lib/wallet-ledger-chain.js';
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

  describe('witness checkpoints', () => {
    const head = (seq: number, hash: string, tenant = 'tenant-int-1') => ({
      source: 'agenticorg', tenant_ref: tenant, chain: 'audit_log', head_seq: seq, head_hash: hash, anchored_at: new Date().toISOString(),
    });
    const post = (payload: unknown) => app.inject({
      method: 'POST', url: '/v1/audit/witness-checkpoints',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }, payload: payload as Record<string, unknown>,
    });

    it('witnesses a head once, replays it, refuses and records a fork, and reads both back', async () => {
      const first = await post(head(7, 'a'.repeat(64)));
      expect(first.statusCode, first.body).toBe(201);
      const replay = await post(head(7, 'a'.repeat(64)));
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        witness_id: first.json<{ witness_id: string }>().witness_id,
        countersignature: first.json<{ countersignature: string }>().countersignature,
      });

      const fork = await post(head(7, 'b'.repeat(64)));
      expect(fork.statusCode).toBe(409);
      expect(fork.json()).toMatchObject({ code: 'WITNESS_FORK', fork: { witnessed: { head_hash: 'a'.repeat(64) }, presented: { head_hash: 'b'.repeat(64) } } });

      expect((await post(head(8, 'c'.repeat(64)))).statusCode).toBe(201);
      // Another tenant's position 7 is its own.
      expect((await post(head(7, 'b'.repeat(64), 'tenant-int-2'))).statusCode).toBe(201);

      const read = await app.inject({
        method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=tenant-int-1',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      expect(read.statusCode).toBe(200);
      const body = read.json<{ checkpoints: { head_seq: number; head_hash: string }[]; forks: { head_seq: number; presented_hash: string }[] }>();
      expect(body.checkpoints.map((c) => [c.head_seq, c.head_hash])).toEqual([[8, 'c'.repeat(64)], [7, 'a'.repeat(64)]]);
      expect(body.forks).toHaveLength(1);
      expect(body.forks[0]).toMatchObject({ head_seq: 7, presented_hash: 'b'.repeat(64) });
    });

    it('concurrent posts of one head store one witness; racing a fork against it refuses the loser', async () => {
      const same = await Promise.all([post(head(20, 'd'.repeat(64))), post(head(20, 'd'.repeat(64))), post(head(20, 'd'.repeat(64)))]);
      expect(same.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(new Set(same.map((r) => r.json<{ witness_id: string }>().witness_id)).size).toBe(1);
      const raced = await Promise.all([post(head(21, 'e'.repeat(64))), post(head(21, 'f'.repeat(64)))]);
      expect(raced.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });

    it('reads heads back in numeric head_seq order', async () => {
      for (const seq of [9, 10, 100]) expect((await post(head(seq, 'a'.repeat(64), 'tenant-int-order'))).statusCode).toBe(201);
      const read = await app.inject({
        method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=tenant-int-order',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      expect(read.json<{ checkpoints: { head_seq: number }[] }>().checkpoints.map((c) => c.head_seq)).toEqual([100, 10, 9]);
    });

    it('witness rows and fork records are append-only', async () => {
      await expect(sql`UPDATE audit_witness_checkpoints SET head_hash = ${'0'.repeat(64)}`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM audit_witness_forks`).rejects.toThrow(/append-only/);
    });
  });

  describe('wallet ledger chain', () => {
    const developerId = 'dev_ledger_chain';
    const owner = { developerId, principalId: 'user_ledger' };
    let walletCounter = 0;

    async function newWallet(): Promise<string> {
      const id = `pwal_chain_${++walletCounter}`;
      await sql`INSERT INTO developers (id, api_key_hash, name, mode) VALUES (${developerId}, ${'h'.repeat(64)}, 'Ledger developer', 'sandbox')
                ON CONFLICT (id) DO NOTHING`;
      await sql`INSERT INTO prepaid_wallets (id, developer_id, principal_id, name, custody_mode, network, asset)
                VALUES (${id}, ${developerId}, ${owner.principalId}, 'Chain wallet', 'sandbox_ledger', 'sandbox', 'USD')`;
      return id;
    }

    async function rawEntry(walletId: string, n: number, extra: { metadata?: string } = {}) {
      await sql`INSERT INTO wallet_ledger_entries (id, wallet_id, developer_id, principal_id, entry_type, amount, available_after, reserved_after,
                  metadata, chain_seq, prev_hash, entry_hash)
                VALUES (${`wled_${walletId}_${n}`}, ${walletId}, ${developerId}, ${owner.principalId}, 'credit', ${String(n * 10)}, ${String(n * 10)}, '0',
                  ${extra.metadata ?? '{}'}::jsonb, 999, ${'0'.repeat(64)}, ${'0'.repeat(64)})`;
    }

    /** Runs `statement` with the append-only trigger off, as only the table owner could. */
    async function tamper(statement: (tx: postgres.TransactionSql) => Promise<unknown>) {
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER trg_wallet_ledger_no_update_delete`;
        await statement(tx);
        await tx`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER trg_wallet_ledger_no_update_delete`;
      });
    }

    it('chains every entry written through the reload path, concurrently, with no fork', async () => {
      const walletId = await newWallet();
      await Promise.all(Array.from({ length: 12 }, (_, i) =>
        createPrincipalReload(sql, owner, walletId, String(100 + i), `idem-chain-concurrent-${i}-0000`)));
      const rows = await loadWalletLedgerChain(sql, walletId);
      expect(rows.map((r) => r.chain_seq)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
      const result = await verifyWalletLedger(sql, walletId, owner);
      expect(result).toMatchObject({ valid: true, entries: 12, head_seq: 12, head_hash: rows[11]!.entry_hash });
      // The verifier's hash agrees with the trigger's, field for field.
      for (const row of rows) expect(walletLedgerEntryHash(row)).toBe(row.entry_hash);
    });

    it('overwrites caller-supplied chain columns and hashes UTF-8 metadata and NULLs as the verifier does', async () => {
      const walletId = await newWallet();
      await rawEntry(walletId, 1, { metadata: '{"note": "Café ☕ – ok", "z": [1, 2.50, null]}' });
      await rawEntry(walletId, 2);
      const rows = await loadWalletLedgerChain(sql, walletId);
      expect(rows.map((r) => [r.chain_seq, r.prev_hash === null])).toEqual([['1', true], ['2', false]]);
      expect(rows[0]!.entry_hash).not.toBe('0'.repeat(64));
      expect(rows[1]!.prev_hash).toBe(rows[0]!.entry_hash);
      expect((await verifyWalletLedger(sql, walletId)).valid).toBe(true);
    });

    it('refuses updates and deletes of chained entries', async () => {
      const walletId = await newWallet();
      await rawEntry(walletId, 1);
      await expect(sql`UPDATE wallet_ledger_entries SET entry_hash = ${'1'.repeat(64)} WHERE wallet_id = ${walletId}`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`).rejects.toThrow(/append-only/);
    });

    it('detects an edited entry', async () => {
      const walletId = await newWallet();
      for (let n = 1; n <= 4; n += 1) await rawEntry(walletId, n);
      await tamper((tx) => tx`UPDATE wallet_ledger_entries SET amount = 1000000 WHERE id = ${`wled_${walletId}_3`}`);
      const result = await verifyWalletLedger(sql, walletId);
      expect(result.valid).toBe(false);
      expect(result.failures).toEqual([{ position: 2, entry_id: `wled_${walletId}_3`, chain_seq: '3', reason: 'entry_hash_mismatch' }]);
    });

    it('detects a deleted entry', async () => {
      const walletId = await newWallet();
      for (let n = 1; n <= 4; n += 1) await rawEntry(walletId, n);
      await tamper((tx) => tx`DELETE FROM wallet_ledger_entries WHERE id = ${`wled_${walletId}_2`}`);
      const result = await verifyWalletLedger(sql, walletId);
      expect(result.valid).toBe(false);
      expect(result.failures.map((f) => [f.entry_id, f.reason])).toEqual(expect.arrayContaining([
        [`wled_${walletId}_3`, 'prev_hash_mismatch'],
        [`wled_${walletId}_3`, 'chain_seq_mismatch'],
      ]));
    });

    it('detects reordered entries', async () => {
      const walletId = await newWallet();
      for (let n = 1; n <= 4; n += 1) await rawEntry(walletId, n);
      await tamper(async (tx) => {
        await tx`UPDATE wallet_ledger_entries SET chain_seq = 1000 WHERE id = ${`wled_${walletId}_2`}`;
        await tx`UPDATE wallet_ledger_entries SET chain_seq = 2 WHERE id = ${`wled_${walletId}_3`}`;
        await tx`UPDATE wallet_ledger_entries SET chain_seq = 3 WHERE id = ${`wled_${walletId}_2`}`;
      });
      const result = await verifyWalletLedger(sql, walletId);
      expect(result.valid).toBe(false);
      expect(new Set(result.failures.map((f) => f.entry_id))).toEqual(new Set([`wled_${walletId}_2`, `wled_${walletId}_3`, `wled_${walletId}_4`]));
    });

    it('scopes the principal verification to the wallet owner', async () => {
      const walletId = await newWallet();
      await expect(verifyWalletLedger(sql, walletId, { developerId, principalId: 'user_other' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    });
  });

  describe('wallet ledger backfill (migration 134 over existing rows)', () => {
    it('chains existing rows per wallet in (created_at, id) order, and a re-run changes nothing', async () => {
      const db = await createTestDatabase('ledger-backfill');
      const fresh = postgres(db.url, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
      try {
        const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
        const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
        for (const file of files.filter((f) => f < '134')) await fresh.unsafe(readFileSync(join(dir, file), 'utf-8'));
        await fresh`INSERT INTO developers (id, api_key_hash, name, mode) VALUES ('dev_backfill', ${'b'.repeat(64)}, 'Backfill', 'sandbox')`;
        for (const w of ['pwal_bf_a', 'pwal_bf_b']) {
          await fresh`INSERT INTO prepaid_wallets (id, developer_id, principal_id, name, custody_mode, network, asset)
                      VALUES (${w}, 'dev_backfill', 'user_bf', 'Backfill wallet', 'sandbox_ledger', 'sandbox', 'USD')`;
        }
        // Inserted out of order; two entries share a created_at, so id breaks the tie.
        const legacy: [string, string, string][] = [
          ['wled_bf_3', 'pwal_bf_a', '2026-01-01T00:00:03Z'],
          ['wled_bf_1', 'pwal_bf_a', '2026-01-01T00:00:01Z'],
          ['wled_bf_2b', 'pwal_bf_a', '2026-01-01T00:00:02Z'],
          ['wled_bf_2a', 'pwal_bf_a', '2026-01-01T00:00:02Z'],
          ['wled_bf_x', 'pwal_bf_b', '2026-01-01T00:00:05Z'],
        ];
        for (const [id, wallet, at] of legacy) {
          await fresh`INSERT INTO wallet_ledger_entries (id, wallet_id, developer_id, principal_id, entry_type, amount, available_after, reserved_after, metadata, created_at)
                      VALUES (${id}, ${wallet}, 'dev_backfill', 'user_bf', 'credit', 5, 5, 0, ${'{"legacy": true}'}::jsonb, ${at})`;
        }
        const migration = readFileSync(join(dir, '134_commerce_ledger.sql'), 'utf-8');
        await fresh.begin((tx) => tx.unsafe(migration));
        const a = await loadWalletLedgerChain(fresh, 'pwal_bf_a');
        expect(a.map((r) => [r.id, r.chain_seq])).toEqual([['wled_bf_1', '1'], ['wled_bf_2a', '2'], ['wled_bf_2b', '3'], ['wled_bf_3', '4']]);
        expect(await verifyWalletLedger(fresh, 'pwal_bf_a')).toMatchObject({ valid: true, entries: 4 });
        expect(await verifyWalletLedger(fresh, 'pwal_bf_b')).toMatchObject({ valid: true, entries: 1 });

        await fresh.begin((tx) => tx.unsafe(migration));
        expect((await loadWalletLedgerChain(fresh, 'pwal_bf_a')).map((r) => r.entry_hash)).toEqual(a.map((r) => r.entry_hash));
        // Append-only again after the backfill, and new entries continue the chain.
        await expect(fresh`UPDATE wallet_ledger_entries SET amount = 6 WHERE id = 'wled_bf_1'`).rejects.toThrow(/append-only/);
        await fresh`INSERT INTO wallet_ledger_entries (id, wallet_id, developer_id, principal_id, entry_type, amount, available_after, reserved_after)
                    VALUES ('wled_bf_5', 'pwal_bf_a', 'dev_backfill', 'user_bf', 'credit', 5, 10, 0)`;
        expect(await verifyWalletLedger(fresh, 'pwal_bf_a')).toMatchObject({ valid: true, entries: 5, head_seq: 5 });
      } finally {
        await fresh.end();
        await db.drop();
      }
    }, 180_000);
  });
});
