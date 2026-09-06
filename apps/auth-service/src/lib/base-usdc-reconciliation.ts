import type postgres from 'postgres';
import type { TxSql } from '../db/client.js';
import { baseUsdcCustody, BaseUsdcError } from './base-usdc-custody.js';
import { readEvmPayment } from './prepaid-wallet.js';
import { newWalletLedgerEntryId } from './ids.js';

type Sql = ReturnType<typeof postgres>;

/** Chain facts, not a merchant HTTP response, finalize the wallet ledger. */
export async function reconcileBaseReservation(sql: Sql, owner: { developerId: string; principalId: string; agentId?: string }, id: string) {
  const rows = await sql`SELECT r.*, w.provider_wallet_id, w.wallet_address
    FROM wallet_payment_reservations r JOIN prepaid_wallets w ON w.id = r.wallet_id
    WHERE r.id = ${id} AND r.developer_id = ${owner.developerId} AND r.principal_id = ${owner.principalId}
      AND (${owner.agentId ?? null}::text IS NULL OR r.agent_id = ${owner.agentId ?? null})
      AND r.evm_payment_ciphertext IS NOT NULL`;
  const row = rows[0];
  if (!row) throw new BaseUsdcError('RESERVATION_NOT_FOUND', 'EVM reservation not found', 404);
  if (row['status'] !== 'reserved') return { reservationId: id, status: String(row['status']), transaction: row['evm_transaction_hash'] as string | null };
  const payment = readEvmPayment(row);
  const custody = baseUsdcCustody({ ...owner, providerWalletId: String(row['provider_wallet_id']),
    walletAddress: String(row['wallet_address']), network: String(row['network']), asset: String(row['asset']) });
  const outcome = await custody.reconcile(payment, String(row['evm_from_block']));
  let result = { reservationId: id, status: 'reserved', transaction: null as string | null };
  await sql.begin(async transaction => {
    const tx = transaction as unknown as TxSql;
    await tx`SELECT id FROM prepaid_wallets WHERE id = ${String(row['wallet_id'])} FOR UPDATE`;
    const current = await tx`SELECT status, evm_transaction_hash FROM wallet_payment_reservations WHERE id = ${id} FOR UPDATE`;
    if (current[0]!['status'] !== 'reserved') {
      result = { reservationId: id, status: String(current[0]!['status']), transaction: current[0]!['evm_transaction_hash'] as string | null };
      return;
    }
    if (outcome.status === 'reserved') {
      if ('nextBlock' in outcome) {
        await tx`UPDATE wallet_payment_reservations SET evm_from_block = ${outcome.nextBlock!}, updated_at = NOW()
          WHERE id = ${id} AND evm_from_block = ${String(row['evm_from_block'])}`;
      } else {
        await tx`UPDATE wallet_payment_reservations SET updated_at = NOW() WHERE id = ${id}`;
      }
      return;
    }
    const settled = outcome.status === 'settled';
    const hash = settled ? outcome.transaction : null;
    const amount = String(row['amount']);
    const wallet = await tx`UPDATE prepaid_wallets SET reserved_amount = reserved_amount - ${amount},
      available_amount = available_amount + ${settled ? '0' : amount}, updated_at = NOW()
      WHERE id = ${String(row['wallet_id'])} AND reserved_amount >= ${amount}
      RETURNING available_amount, reserved_amount`;
    if (!wallet[0]) throw new Error('EVM wallet balance invariant failed');
    await tx`UPDATE wallet_payment_reservations SET status = ${outcome.status}, evm_transaction_hash = ${hash},
      transaction_id = ${hash ? `base:${hash}:${payment.authorization.nonce}` : null},
      settled_at = CASE WHEN ${settled} THEN NOW() ELSE NULL END,
      released_at = CASE WHEN ${settled} THEN NULL ELSE NOW() END,
      release_reason = ${settled ? null : 'finalized_evm_expiry'}, updated_at = NOW() WHERE id = ${id}`;
    await tx`INSERT INTO wallet_ledger_entries (id, wallet_id, developer_id, principal_id,
      entry_type, amount, available_after, reserved_after, reservation_id, metadata)
      VALUES (${newWalletLedgerEntryId()}, ${String(row['wallet_id'])}, ${owner.developerId}, ${owner.principalId},
        ${settled ? 'settlement' : 'expiry_release'}, ${amount}, ${String(wallet[0]['available_amount'])},
        ${String(wallet[0]['reserved_amount'])}, ${id}, ${JSON.stringify({ network: row['network'], transaction: hash, finalized: true })})`;
    result = { reservationId: id, status: outcome.status, transaction: hash };
  });
  return result;
}

export async function reconcileBaseReservations(sql: Sql): Promise<{ checked: number; failed: number }> {
  if (!process.env['BASE_USDC_WALLETS']) return { checked: 0, failed: 0 };
  let failed = 0;
  const rows = await sql`SELECT id, developer_id, principal_id FROM wallet_payment_reservations
    WHERE status = 'reserved' AND evm_payment_ciphertext IS NOT NULL ORDER BY updated_at, id LIMIT 20`;
  for (const row of rows) {
    try {
      await reconcileBaseReservation(sql, { developerId: String(row['developer_id']), principalId: String(row['principal_id']) }, String(row['id']));
    } catch {
      failed++;
      // Rotate failed providers through the bounded queue; never release on error.
      await sql`UPDATE wallet_payment_reservations SET updated_at = NOW() WHERE id = ${String(row['id'])} AND status = 'reserved'`;
    }
  }
  return { checked: rows.length, failed };
}
