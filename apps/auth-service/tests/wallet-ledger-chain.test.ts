/**
 * Wallet ledger tamper evidence (G16): the chain verifier finds an edited,
 * deleted, inserted or reordered entry, and the verification routes are
 * authenticated and owner-scoped. The hash the database trigger computes is
 * checked against this one in commerce-ledger-postgres.integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  verifyWalletLedgerChain,
  walletLedgerEntryHash,
  type WalletLedgerChainRow,
} from '../src/lib/wallet-ledger-chain.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';

const WALLET = 'pwal_TEST01';

/** A well-formed chain of `n` entries, hashed as the trigger hashes them. */
function chain(n: number): WalletLedgerChainRow[] {
  const rows: WalletLedgerChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i += 1) {
    const base = {
      chain_seq: String(i),
      prev_hash: prev,
      id: `wled_${String(i).padStart(4, '0')}`,
      wallet_id: WALLET,
      developer_id: 'dev_TEST',
      principal_id: 'user_123',
      entry_type: i === 1 ? 'credit' : 'settlement',
      amount: String(1000 * i),
      available_after: String(100000 - 1000 * i),
      reserved_after: '0',
      reservation_id: i === 1 ? null : `wres_${i}`,
      reload_request_id: i === 1 ? 'wrel_1' : null,
      external_reference: null,
      metadata_text: i === 2 ? '{"note": "Café ☕"}' : '{}',
      created_at_text: `2026-10-19T10:00:0${i}.123456Z`,
    };
    const entry_hash = walletLedgerEntryHash(base);
    rows.push({ ...base, entry_hash });
    prev = entry_hash;
  }
  return rows;
}

const reasons = (rows: WalletLedgerChainRow[]) =>
  verifyWalletLedgerChain(WALLET, rows).failures.map((f) => [f.entry_id, f.reason]);

describe('wallet ledger chain verifier', () => {
  it('accepts an intact chain and reports its head', () => {
    const rows = chain(5);
    const result = verifyWalletLedgerChain(WALLET, rows);
    expect(result).toMatchObject({ valid: true, entries: 5, head_seq: 5, head_hash: rows[4]!.entry_hash, failures: [] });
  });

  it('accepts an empty chain with head 0', () => {
    expect(verifyWalletLedgerChain(WALLET, [])).toMatchObject({ valid: true, entries: 0, head_seq: 0, head_hash: null });
  });

  it('pins the preimage: field lengths are UTF-8 octets and NULL is distinct from empty', () => {
    const [first] = chain(1);
    expect(first!.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    // An empty string where NULL was hashed is a different entry.
    expect(walletLedgerEntryHash({ ...first!, external_reference: '' })).not.toBe(first!.entry_hash);
    // Moving a character across a field boundary is a different entry.
    expect(walletLedgerEntryHash({ ...first!, developer_id: 'dev_TES', principal_id: 'Tuser_123' })).not.toBe(first!.entry_hash);
  });

  it('detects an edited entry, and only that entry', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, amount: '999999' };
    expect(reasons(rows)).toEqual([['wled_0003', 'entry_hash_mismatch']]);
    const meta = chain(5);
    meta[1] = { ...meta[1]!, metadata_text: '{"note": "Cafe"}' };
    expect(reasons(meta)).toEqual([['wled_0002', 'entry_hash_mismatch']]);
  });

  it('detects a deleted entry', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(reasons(rows)).toEqual([
      ['wled_0004', 'chain_seq_mismatch'],
      ['wled_0004', 'prev_hash_mismatch'],
      ['wled_0005', 'chain_seq_mismatch'],
    ]);
  });

  it('detects a deletion that renumbered and relinked the rest without the hashes moving', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    for (let i = 2; i < rows.length; i += 1) rows[i] = { ...rows[i]!, chain_seq: String(i + 1), prev_hash: rows[i - 1]!.entry_hash };
    const result = verifyWalletLedgerChain(WALLET, rows);
    expect(result.valid).toBe(false);
    expect(result.failures.every((f) => f.reason === 'entry_hash_mismatch')).toBe(true);
    expect(result.failures.map((f) => f.entry_id)).toEqual(['wled_0004', 'wled_0005']);
  });

  it('detects reordered entries', () => {
    const rows = chain(5);
    [rows[1], rows[3]] = [rows[3]!, rows[1]!];
    const result = verifyWalletLedgerChain(WALLET, rows);
    expect(result.valid).toBe(false);
    expect(new Set(result.failures.map((f) => f.entry_id))).toEqual(new Set(['wled_0002', 'wled_0003', 'wled_0004', 'wled_0005']));
  });

  it('detects swapped positions even when each row keeps its own hash', () => {
    const rows = chain(4);
    // Swap chain_seq values of entries 2 and 3, then present them in that order.
    const a = { ...rows[1]!, chain_seq: '3' };
    const b = { ...rows[2]!, chain_seq: '2' };
    expect(reasons([rows[0]!, b, a, rows[3]!])).toEqual(expect.arrayContaining([
      ['wled_0003', 'prev_hash_mismatch'],
      ['wled_0003', 'entry_hash_mismatch'],
      ['wled_0002', 'entry_hash_mismatch'],
    ]));
  });

  it('detects an inserted entry and an entry of another wallet', () => {
    const rows = chain(3);
    const forged = { ...rows[1]!, id: 'wled_forged' };
    expect(verifyWalletLedgerChain(WALLET, [rows[0]!, forged, rows[1]!, rows[2]!]).valid).toBe(false);
    const other = chain(2);
    other[1] = { ...other[1]!, wallet_id: 'pwal_OTHER' };
    expect(reasons(other)).toEqual(expect.arrayContaining([['wled_0002', 'wallet_mismatch']]));
  });
});

describe('wallet ledger verification routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  it('the admin route needs the admin credential', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/admin/prepaid-wallets/${WALLET}/ledger/verification` });
    expect(res.statusCode).toBe(401);
  });

  it('the admin route answers 404 for an unknown wallet and the verification for a known one', async () => {
    const auth = { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };
    sqlMock.mockResolvedValueOnce([]);
    const missing = await app.inject({ method: 'GET', url: `/v1/admin/prepaid-wallets/${WALLET}/ledger/verification`, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'WALLET_NOT_FOUND' });

    const rows = chain(3);
    rows[1] = { ...rows[1]!, available_after: '1' };
    sqlMock.mockResolvedValueOnce([{ id: WALLET }]).mockResolvedValueOnce(rows);
    const res = await app.inject({ method: 'GET', url: `/v1/admin/prepaid-wallets/${WALLET}/ledger/verification`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      wallet_id: WALLET, valid: false, entries: 3, head_seq: 3,
      failures: [{ position: 1, entry_id: 'wled_0002', chain_seq: '2', reason: 'entry_hash_mismatch' }],
    });
  });

  it('the principal route needs a principal session', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/principal/prepaid-wallets/${WALLET}/ledger/verification` });
    expect(res.statusCode).toBe(401);
  });
});
