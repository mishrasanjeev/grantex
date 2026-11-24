import type postgres from 'postgres';
import type { TxSql } from '../db/client.js';
import { newBudgetAllocationId, newBudgetTransactionId } from './ids.js';
import { emitEvent } from './events.js';
import { canonicalJson, sha256hex } from './hash.js';

export interface BudgetAllocation {
  id: string;
  grantId: string;
  developerId: string;
  initialBudget: string;
  remainingBudget: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetTransaction {
  id: string;
  grantId: string;
  allocationId: string;
  amount: string;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface BudgetDebitResult {
  remaining: string;
  transactionId: string;
}

export async function createBudgetAllocation(
  sql: ReturnType<typeof postgres>,
  grantId: string,
  developerId: string,
  initialBudget: number,
  currency = 'USD',
): Promise<BudgetAllocation> {
  const id = newBudgetAllocationId();

  // Single statement: insert only if the grant is currently active and not
  // expired. Closes the race where a concurrent revoke between a separate
  // pre-check and the insert would still allow allocation against a dead grant.
  const rows = await sql`
    INSERT INTO budget_allocations (id, grant_id, developer_id, initial_budget, remaining_budget, currency)
    SELECT ${id}, g.id, g.developer_id, ${initialBudget}, ${initialBudget}, ${currency}
    FROM grants g
    WHERE g.id = ${grantId}
      AND g.developer_id = ${developerId}
      AND g.status = 'active'
      AND g.expires_at > NOW()
    RETURNING id, grant_id, developer_id, initial_budget, remaining_budget, currency, created_at, updated_at
  `;

  if (rows.length === 0) {
    // Disambiguate: missing entirely vs. revoked/expired.
    const grantCheck = await sql<{ status: string; expires_at: Date }[]>`
      SELECT status, expires_at FROM grants
      WHERE id = ${grantId} AND developer_id = ${developerId}
    `;
    const g = grantCheck[0];
    if (!g) throw new GrantNotFoundError(grantId);
    throw new GrantInactiveError(grantId);
  }

  return mapAllocationRow(rows[0]!);
}

export async function debitBudget(
  sql: ReturnType<typeof postgres>,
  grantId: string,
  developerId: string,
  amount: number,
  description?: string,
  metadata?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<BudgetDebitResult> {
  if (idempotencyKey !== undefined && (idempotencyKey.length < 16 || idempotencyKey.length > 256)) {
    throw new RangeError('Idempotency-Key must contain 16 to 256 characters');
  }
  const idempotency = idempotencyKey === undefined ? undefined : {
    keyHash: sha256hex(idempotencyKey),
    requestHash: sha256hex(canonicalJson({
      grantId, amount, description: description ?? null, metadata: metadata ?? {},
    })),
  };
  const txId = newBudgetTransactionId();
  let alloc: Record<string, unknown> | undefined;
  let result: BudgetDebitResult | undefined;
  let replayed = false;

  // The balance update and its ledger row are one unit. Without a transaction,
  // an INSERT failure permanently reduced the balance with no audit trail.
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    if (idempotency !== undefined) {
      // All keyed debits for a grant serialize on its existing allocation row.
      // The same transaction holds this lock through the ledger and replay write.
      const allocation = await tx<{ id: string }[]>`
        SELECT id FROM budget_allocations
        WHERE grant_id = ${grantId} AND developer_id = ${developerId}
        FOR UPDATE
      `;
      const grants = await tx<{ active: boolean }[]>`
        SELECT (status = 'active' AND expires_at > NOW()) AS active FROM grants
        WHERE id = ${grantId} AND developer_id = ${developerId}
      `;
      const grant = grants[0];
      if (!grant) throw new GrantNotFoundError(grantId);
      if (!grant.active) throw new GrantInactiveError(grantId);
      if (!allocation[0]) throw new InsufficientBudgetError(grantId);

      const existing = await tx<{
        request_hash: string; remaining_budget: string; transaction_id: string;
      }[]>`
        SELECT request_hash, remaining_budget, transaction_id
        FROM budget_debit_idempotency
        WHERE developer_id = ${developerId} AND grant_id = ${grantId}
          AND key_hash = ${idempotency.keyHash} AND expires_at > NOW()
      `;
      const prior = existing[0];
      if (prior) {
        if (prior.request_hash !== idempotency.requestHash) throw new BudgetIdempotencyConflictError();
        result = { remaining: prior.remaining_budget, transactionId: prior.transaction_id };
        replayed = true;
        return;
      }
      await tx`
        DELETE FROM budget_debit_idempotency
        WHERE developer_id = ${developerId} AND grant_id = ${grantId}
          AND expires_at <= NOW()
      `;
    }
    const rows = await tx`
      UPDATE budget_allocations ba
      SET remaining_budget = remaining_budget - ${amount},
          updated_at = NOW()
      FROM grants g
      WHERE ba.grant_id = ${grantId}
        AND ba.developer_id = ${developerId}
        AND ba.remaining_budget >= ${amount}
        AND g.id = ba.grant_id
        AND g.status = 'active'
        AND g.expires_at > NOW()
      RETURNING ba.id, ba.initial_budget, ba.remaining_budget
    `;

    if (rows.length === 0) {
      const grantCheck = await tx<{ status: string; expires_at: Date }[]>`
        SELECT status, expires_at FROM grants
        WHERE id = ${grantId} AND developer_id = ${developerId}
      `;
      const grant = grantCheck[0];
      if (!grant) throw new GrantNotFoundError(grantId);
      if (grant.status !== 'active' || new Date(grant.expires_at) <= new Date()) {
        throw new GrantInactiveError(grantId);
      }
      throw new InsufficientBudgetError(grantId);
    }

    alloc = rows[0] as Record<string, unknown>;
    await tx`
      INSERT INTO budget_transactions (id, grant_id, allocation_id, amount, description, metadata)
      VALUES (${txId}, ${grantId}, ${alloc['id'] as string}, ${amount}, ${description ?? null}, ${JSON.stringify(metadata ?? {})})
    `;
    result = { remaining: alloc['remaining_budget'] as string, transactionId: txId };
    if (idempotency !== undefined) {
      await tx`
        INSERT INTO budget_debit_idempotency
          (developer_id, grant_id, key_hash, request_hash, remaining_budget, transaction_id)
        VALUES
          (${developerId}, ${grantId}, ${idempotency.keyHash}, ${idempotency.requestHash}, ${result.remaining}, ${txId})
      `;
    }
  });
  if (!result) throw new Error('Budget debit returned no result');
  if (replayed) return result;
  if (!alloc) throw new Error('Budget debit returned no allocation');

  // Check thresholds and emit events
  const initial = parseFloat(alloc['initial_budget'] as string);
  const remaining = parseFloat(alloc['remaining_budget'] as string);
  const usedPct = ((initial - remaining) / initial) * 100;

  if (remaining <= 0) {
    emitEvent(developerId, 'budget.exhausted', { grantId, remaining: '0' }).catch(() => {});
  } else if (usedPct >= 80) {
    emitEvent(developerId, 'budget.threshold', { grantId, pct: 80, remaining: alloc['remaining_budget'] as string }).catch(() => {});
  } else if (usedPct >= 50) {
    emitEvent(developerId, 'budget.threshold', { grantId, pct: 50, remaining: alloc['remaining_budget'] as string }).catch(() => {});
  }

  return result;
}

export async function getBudgetBalance(
  sql: ReturnType<typeof postgres>,
  grantId: string,
  developerId: string,
): Promise<BudgetAllocation | null> {
  const rows = await sql`
    SELECT id, grant_id, developer_id, initial_budget, remaining_budget, currency, created_at, updated_at
    FROM budget_allocations
    WHERE grant_id = ${grantId} AND developer_id = ${developerId}
  `;

  if (rows.length === 0) return null;
  return mapAllocationRow(rows[0]!);
}

export async function listBudgetTransactions(
  sql: ReturnType<typeof postgres>,
  grantId: string,
  developerId: string,
  page = 1,
  pageSize = 50,
): Promise<{ transactions: BudgetTransaction[]; total: number }> {
  const offset = (page - 1) * pageSize;

  const [txRows, countRows] = await Promise.all([
    sql`
      SELECT bt.id, bt.grant_id, bt.allocation_id, bt.amount, bt.description, bt.metadata, bt.created_at
      FROM budget_transactions bt
      JOIN budget_allocations ba ON ba.id = bt.allocation_id
      WHERE bt.grant_id = ${grantId} AND ba.developer_id = ${developerId}
      ORDER BY bt.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `,
    sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM budget_transactions bt
      JOIN budget_allocations ba ON ba.id = bt.allocation_id
      WHERE bt.grant_id = ${grantId} AND ba.developer_id = ${developerId}
    `,
  ]);

  const transactions = txRows.map((r) => ({
    id: r['id'] as string,
    grantId: r['grant_id'] as string,
    allocationId: r['allocation_id'] as string,
    amount: r['amount'] as string,
    description: r['description'] as string | null,
    metadata: (r['metadata'] ?? {}) as Record<string, unknown>,
    createdAt: (r['created_at'] as Date).toISOString(),
  }));

  return { transactions, total: parseInt(countRows[0]?.count ?? '0', 10) };
}

function mapAllocationRow(row: Record<string, unknown>): BudgetAllocation {
  return {
    id: row['id'] as string,
    grantId: row['grant_id'] as string,
    developerId: row['developer_id'] as string,
    initialBudget: row['initial_budget'] as string,
    remainingBudget: row['remaining_budget'] as string,
    currency: row['currency'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

export async function listBudgetAllocations(
  sql: ReturnType<typeof postgres>,
  developerId: string,
): Promise<BudgetAllocation[]> {
  const rows = await sql`
    SELECT id, grant_id, developer_id, initial_budget, remaining_budget, currency, created_at, updated_at
    FROM budget_allocations
    WHERE developer_id = ${developerId}
    ORDER BY created_at DESC
  `;

  return rows.map(mapAllocationRow);
}

export class InsufficientBudgetError extends Error {
  constructor(grantId: string) {
    super(`Insufficient budget for grant ${grantId}`);
    this.name = 'InsufficientBudgetError';
  }
}

export class GrantInactiveError extends Error {
  constructor(grantId: string) {
    super(`Grant ${grantId} is not active (revoked or expired)`);
    this.name = 'GrantInactiveError';
  }
}

export class GrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`Grant ${grantId} not found`);
    this.name = 'GrantNotFoundError';
  }
}

export class BudgetIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different budget debit');
    this.name = 'BudgetIdempotencyConflictError';
  }
}
