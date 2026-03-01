import type { HttpClient } from '../http.js';
import type {
  AllocateBudgetParams,
  BudgetAllocation,
  BudgetTransactionsResponse,
  DebitBudgetParams,
  DebitBudgetResponse,
} from '../types.js';

export class BudgetsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Allocate a spending budget for a grant. */
  allocate(params: AllocateBudgetParams): Promise<BudgetAllocation> {
    return this.#http.post<BudgetAllocation>('/v1/budget/allocate', params);
  }

  /** Debit an amount from a grant's budget. */
  debit(params: DebitBudgetParams): Promise<DebitBudgetResponse> {
    return this.#http.post<DebitBudgetResponse>('/v1/budget/debit', params);
  }

  /** Get the current budget balance for a grant. */
  balance(grantId: string): Promise<BudgetAllocation> {
    return this.#http.get<BudgetAllocation>(`/v1/budget/balance/${grantId}`);
  }

  /** List budget transactions for a grant. */
  transactions(
    grantId: string,
    params?: { page?: number; pageSize?: number },
  ): Promise<BudgetTransactionsResponse> {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return this.#http.get<BudgetTransactionsResponse>(
      `/v1/budget/transactions/${grantId}${qs ? `?${qs}` : ''}`,
    );
  }
}
