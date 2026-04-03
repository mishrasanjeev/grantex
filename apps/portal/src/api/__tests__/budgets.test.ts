import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { listBudgets, getBudget, listTransactions } from '../budgets';

describe('budgets', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listBudgets ───────────────────────────────────────────────────────

  it('listBudgets sends GET /v1/budget/allocations and unwraps .allocations', async () => {
    ok({ allocations: [{ id: 'b1', grantId: 'g1', remainingBudget: 100 }] });
    const result = await listBudgets();
    expect(result).toEqual([{ id: 'b1', grantId: 'g1', remainingBudget: 100 }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/budget/allocations', expect.objectContaining({ method: 'GET' }));
  });

  it('listBudgets throws on error', async () => {
    err(500, 'INTERNAL', 'DB error');
    await expect(listBudgets()).rejects.toThrow('DB error');
  });

  // ── getBudget ─────────────────────────────────────────────────────────

  it('getBudget sends GET /v1/budget/balance/:grantId', async () => {
    const budget = { id: 'b1', grantId: 'g1', remainingBudget: 50 };
    ok(budget);
    const result = await getBudget('g1');
    expect(result).toEqual(budget);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/budget/balance/g1', expect.objectContaining({ method: 'GET' }));
  });

  it('getBudget encodes grantId', async () => {
    ok({ id: 'b1' });
    await getBudget('g/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/budget/balance/g%2F1');
  });

  it('getBudget throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Budget not found');
    await expect(getBudget('missing')).rejects.toThrow('Budget not found');
  });

  // ── listTransactions ──────────────────────────────────────────────────

  it('listTransactions sends GET with default page and pageSize', async () => {
    const data = { transactions: [{ id: 't1' }], total: 1 };
    ok(data);
    const result = await listTransactions('g1');
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/budget/transactions/g1?page=1&pageSize=20',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listTransactions sends GET with custom page and pageSize', async () => {
    ok({ transactions: [], total: 0 });
    await listTransactions('g1', 3, 50);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/budget/transactions/g1?page=3&pageSize=50',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listTransactions encodes grantId', async () => {
    ok({ transactions: [], total: 0 });
    await listTransactions('g/1', 1, 20);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/budget/transactions/g%2F1?page=1&pageSize=20');
  });

  it('listTransactions throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listTransactions('g1')).rejects.toThrow('Failed');
  });
});
