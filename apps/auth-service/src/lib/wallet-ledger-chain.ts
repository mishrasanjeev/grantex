/**
 * Tamper evidence for `wallet_ledger_entries` (G16).
 *
 * Every ledger entry is chained to the one before it in its wallet by a
 * database trigger (migration 134_commerce_ledger.sql, which defines the hash
 * and why it is computed there). This module recomputes the same hash from
 * the same text forms and walks a wallet's chain, so an edited, deleted,
 * inserted or reordered entry is found, whether the rows come from the
 * database or from an export of these columns.
 *
 * The chain proves the entries below its head are the ones written. It
 * cannot, alone, prove the newest entries were not removed from the top: for
 * that, compare `head_seq` / `head_hash` with a head recorded elsewhere.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { PrepaidWalletError } from './prepaid-wallet.js';

type Sql = ReturnType<typeof postgres>;

export const WALLET_LEDGER_HASH_DOMAIN = 'grantex.wallet_ledger_entry.v1';

/** One entry's chained columns, as text in the forms the hash covers. */
export interface WalletLedgerChainRow {
  chain_seq: string;
  prev_hash: string | null;
  entry_hash: string;
  id: string;
  wallet_id: string;
  developer_id: string;
  principal_id: string;
  entry_type: string;
  amount: string;
  available_after: string;
  reserved_after: string;
  reservation_id: string | null;
  reload_request_id: string | null;
  external_reference: string | null;
  /** `metadata::text`: the jsonb text form. */
  metadata_text: string;
  /** `created_at` in UTC as `YYYY-MM-DDTHH:MI:SS.ffffffZ`. */
  created_at_text: string;
}

export type WalletLedgerChainFailureReason =
  /** The entry's columns no longer hash to its entry_hash: it was edited. */
  | 'entry_hash_mismatch'
  /** The entry does not point at the entry before it: one was deleted, inserted or moved. */
  | 'prev_hash_mismatch'
  /** The entry is not at the next position: one was deleted, inserted or moved. */
  | 'chain_seq_mismatch'
  /** The entry belongs to another wallet. */
  | 'wallet_mismatch';

export interface WalletLedgerChainFailure {
  /** Zero-based position in the rows verified. */
  position: number;
  entry_id: string;
  chain_seq: string;
  reason: WalletLedgerChainFailureReason;
}

export interface WalletLedgerChainVerification {
  wallet_id: string;
  valid: boolean;
  entries: number;
  /** The last entry's position and hash, to compare with a head recorded elsewhere. */
  head_seq: number;
  head_hash: string | null;
  failures: WalletLedgerChainFailure[];
}

function field(value: string | null): string {
  return value === null ? '~\n' : `${Buffer.byteLength(value, 'utf8')}:${value}\n`;
}

/** The entry hash the database trigger computes, from the same text forms. */
export function walletLedgerEntryHash(row: Omit<WalletLedgerChainRow, 'entry_hash'>): string {
  const preimage = `${WALLET_LEDGER_HASH_DOMAIN}\n`
    + field(row.chain_seq)
    + field(row.prev_hash)
    + field(row.id)
    + field(row.wallet_id)
    + field(row.developer_id)
    + field(row.principal_id)
    + field(row.entry_type)
    + field(row.amount)
    + field(row.available_after)
    + field(row.reserved_after)
    + field(row.reservation_id)
    + field(row.reload_request_id)
    + field(row.external_reference)
    + field(row.metadata_text)
    + field(row.created_at_text);
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Walks one wallet's entries in the order given, which must be chain order
 * (position 1 first). The order is not corrected: rows out of order are
 * failures. Every failure is reported, not only the first.
 */
export function verifyWalletLedgerChain(walletId: string, rows: readonly WalletLedgerChainRow[]): WalletLedgerChainVerification {
  const failures: WalletLedgerChainFailure[] = [];
  let previous: WalletLedgerChainRow | undefined;
  rows.forEach((row, position) => {
    const fail = (reason: WalletLedgerChainFailureReason) => failures.push({ position, entry_id: row.id, chain_seq: row.chain_seq, reason });
    if (row.wallet_id !== walletId) fail('wallet_mismatch');
    if (row.chain_seq !== String(position + 1)) fail('chain_seq_mismatch');
    if (row.prev_hash !== (previous?.entry_hash ?? null)) fail('prev_hash_mismatch');
    if (walletLedgerEntryHash(row) !== row.entry_hash) fail('entry_hash_mismatch');
    previous = row;
  });
  return {
    wallet_id: walletId,
    valid: failures.length === 0,
    entries: rows.length,
    head_seq: rows.length === 0 ? 0 : Number(previous!.chain_seq),
    head_hash: previous?.entry_hash ?? null,
    failures,
  };
}

/** A wallet's chained ledger columns in chain order, as the hash covers them. */
export async function loadWalletLedgerChain(sql: Sql, walletId: string): Promise<WalletLedgerChainRow[]> {
  return sql<WalletLedgerChainRow[]>`
    SELECT chain_seq::text AS chain_seq, prev_hash, entry_hash, id, wallet_id, developer_id, principal_id,
           entry_type, amount::text AS amount, available_after::text AS available_after,
           reserved_after::text AS reserved_after, reservation_id, reload_request_id, external_reference,
           metadata::text AS metadata_text,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
      FROM wallet_ledger_entries
     WHERE wallet_id = ${walletId}
     -- Qualified: the numeric column, not its text alias (which would sort 10 before 2).
     ORDER BY wallet_ledger_entries.chain_seq, wallet_ledger_entries.id
  `;
}

/**
 * Verifies one wallet's ledger chain. With `owner`, the wallet must belong
 * to that developer and principal (404 otherwise); without it (the service
 * administrator), it must exist.
 */
export async function verifyWalletLedger(
  sql: Sql,
  walletId: string,
  owner?: { developerId: string; principalId: string },
): Promise<WalletLedgerChainVerification> {
  const wallets = owner === undefined
    ? await sql`SELECT id FROM prepaid_wallets WHERE id = ${walletId}`
    : await sql`SELECT id FROM prepaid_wallets WHERE id = ${walletId} AND developer_id = ${owner.developerId} AND principal_id = ${owner.principalId}`;
  if (!wallets[0]) throw new PrepaidWalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  return verifyWalletLedgerChain(walletId, await loadWalletLedgerChain(sql, walletId));
}
