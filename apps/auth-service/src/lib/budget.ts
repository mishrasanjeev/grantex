import type postgres from 'postgres';
import { newBudgetAllocationId, newBudgetTransactionId } from './ids.js';
import { emitEvent } from './events.js';

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
): Promise<{ remaining: string; transactionId: string }> {
  // Atomic debit — race-condition safe via WHERE clause.
  // Joins grants so a revoked or expired grant cannot be debited even
  // if a budget_allocations row still exists.
  const rows = await sql`
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
    // Disambiguate: missing entirely, dead, or just out of funds?
    const grantCheck = await sql<{ status: string; expires_at: Date }[]>`
      SELECT status, expires_at FROM grants
      WHERE id = ${grantId} AND developer_id = ${developerId}
    `;
    const g = grantCheck[0];
    if (!g) {
      throw new GrantNotFoundError(grantId);
    }
    if (g.status !== 'active' || new Date(g.expires_at) <= new Date()) {
      throw new GrantInactiveError(grantId);
    }
    throw new InsufficientBudgetError(grantId);
  }

  const alloc = rows[0]!;
  const txId = newBudgetTransactionId();

  await sql`
    INSERT INTO budget_transactions (id, grant_id, allocation_id, amount, description, metadata)
    VALUES (${txId}, ${grantId}, ${alloc['id'] as string}, ${amount}, ${description ?? null}, ${JSON.stringify(metadata ?? {})})
  `;

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

  return { remaining: alloc['remaining_budget'] as string, transactionId: txId };
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
