import { api } from './client';
import type { BudgetAllocation, BudgetTransaction } from './types';

export async function listBudgets(): Promise<BudgetAllocation[]> {
  // List all budget allocations for the authenticated developer
  const res = await api.get<{ allocations: BudgetAllocation[] }>('/v1/budget/allocations');
  return res.allocations;
}

export function getBudget(grantId: string): Promise<BudgetAllocation> {
  return api.get<BudgetAllocation>(`/v1/budget/balance/${encodeURIComponent(grantId)}`);
}

export async function listTransactions(
  grantId: string,
  page = 1,
  pageSize = 20,
): Promise<{ transactions: BudgetTransaction[]; total: number }> {
  return api.get<{ transactions: BudgetTransaction[]; total: number }>(
    `/v1/budget/transactions/${encodeURIComponent(grantId)}?page=${page}&pageSize=${pageSize}`,
  );
}
