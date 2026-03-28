import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { budgetsCommand } from '../src/commands/budgets.js';
import { setJsonMode } from '../src/format.js';

const allocateResponse = {
  id: 'bdg_1',
  grantId: 'grnt_1',
  initialBudget: '100',
  remainingBudget: '100',
};

const debitResponse = {
  remaining: '75',
  transactionId: 'btx_1',
  grantId: 'grnt_1',
};

const balanceResponse = {
  grantId: 'grnt_1',
  initialBudget: '100',
  remainingBudget: '75',
  currency: 'USD',
};

const transactionsResponse = {
  transactions: [
    {
      id: 'btx_1',
      grantId: 'grnt_1',
      allocationId: 'bdg_1',
      amount: '25',
      description: 'test debit',
      metadata: {},
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  total: 1,
};

const mockClient = {
  budgets: {
    allocate: vi.fn(),
    debit: vi.fn(),
    balance: vi.fn(),
    transactions: vi.fn(),
  },
};

describe('budgetsCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "budgets" command name', () => {
    const cmd = budgetsCommand();
    expect(cmd.name()).toBe('budgets');
  });

  it('has allocate, debit, balance, transactions subcommands', () => {
    const cmd = budgetsCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('allocate');
    expect(names).toContain('debit');
    expect(names).toContain('balance');
    expect(names).toContain('transactions');
  });

  // ── allocate ──────────────────────────────────────────────────────────

  it('allocate calls budgets.allocate with grantId and amount', async () => {
    mockClient.budgets.allocate.mockResolvedValue(allocateResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'allocate',
      '--grant-id',
      'grnt_1',
      '--amount',
      '100',
    ]);
    expect(mockClient.budgets.allocate).toHaveBeenCalledWith({
      grantId: 'grnt_1',
      initialBudget: 100,
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('allocate passes currency when --currency is set', async () => {
    mockClient.budgets.allocate.mockResolvedValue(allocateResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'allocate',
      '--grant-id',
      'grnt_1',
      '--amount',
      '100',
      '--currency',
      'EUR',
    ]);
    expect(mockClient.budgets.allocate).toHaveBeenCalledWith({
      grantId: 'grnt_1',
      initialBudget: 100,
      currency: 'EUR',
    });
  });

  it('allocate --json outputs JSON', async () => {
    mockClient.budgets.allocate.mockResolvedValue(allocateResponse);
    setJsonMode(true);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'allocate',
      '--grant-id',
      'grnt_1',
      '--amount',
      '100',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('bdg_1');
    expect(parsed.grantId).toBe('grnt_1');
  });

  it('allocate prints record fields in text mode', async () => {
    mockClient.budgets.allocate.mockResolvedValue(allocateResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'allocate',
      '--grant-id',
      'grnt_1',
      '--amount',
      '100',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('bdg_1');
    expect(allArgs).toContain('Budget allocated');
  });

  // ── debit ─────────────────────────────────────────────────────────────

  it('debit calls budgets.debit with grantId and amount', async () => {
    mockClient.budgets.debit.mockResolvedValue(debitResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'debit',
      '--grant-id',
      'grnt_1',
      '--amount',
      '25',
    ]);
    expect(mockClient.budgets.debit).toHaveBeenCalledWith({
      grantId: 'grnt_1',
      amount: 25,
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('debit passes description when --description is set', async () => {
    mockClient.budgets.debit.mockResolvedValue(debitResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'debit',
      '--grant-id',
      'grnt_1',
      '--amount',
      '25',
      '--description',
      'API call charge',
    ]);
    expect(mockClient.budgets.debit).toHaveBeenCalledWith({
      grantId: 'grnt_1',
      amount: 25,
      description: 'API call charge',
    });
  });

  it('debit --json outputs JSON', async () => {
    mockClient.budgets.debit.mockResolvedValue(debitResponse);
    setJsonMode(true);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'debit',
      '--grant-id',
      'grnt_1',
      '--amount',
      '25',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.remaining).toBe('75');
    expect(parsed.transactionId).toBe('btx_1');
  });

  it('debit prints remaining balance in text mode', async () => {
    mockClient.budgets.debit.mockResolvedValue(debitResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'debit',
      '--grant-id',
      'grnt_1',
      '--amount',
      '25',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('75');
    expect(allArgs).toContain('Debited');
  });

  // ── balance ───────────────────────────────────────────────────────────

  it('balance calls budgets.balance with grantId', async () => {
    mockClient.budgets.balance.mockResolvedValue(balanceResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'balance', 'grnt_1']);
    expect(mockClient.budgets.balance).toHaveBeenCalledWith('grnt_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('balance --json outputs JSON', async () => {
    mockClient.budgets.balance.mockResolvedValue(balanceResponse);
    setJsonMode(true);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'balance', 'grnt_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.grantId).toBe('grnt_1');
    expect(parsed.remainingBudget).toBe('75');
    expect(parsed.currency).toBe('USD');
  });

  it('balance prints record fields in text mode', async () => {
    mockClient.budgets.balance.mockResolvedValue(balanceResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'balance', 'grnt_1']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('grnt_1');
    expect(allArgs).toContain('75');
    expect(allArgs).toContain('USD');
  });

  // ── transactions ──────────────────────────────────────────────────────

  it('transactions calls budgets.transactions with grantId', async () => {
    mockClient.budgets.transactions.mockResolvedValue(transactionsResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'transactions', 'grnt_1']);
    expect(mockClient.budgets.transactions).toHaveBeenCalledWith('grnt_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('transactions prints "(no results)" for empty list', async () => {
    mockClient.budgets.transactions.mockResolvedValue({ transactions: [], total: 0 });
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'transactions', 'grnt_1']);
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });

  it('transactions --json outputs JSON array', async () => {
    mockClient.budgets.transactions.mockResolvedValue(transactionsResponse);
    setJsonMode(true);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'transactions', 'grnt_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('btx_1');
    expect(parsed[0].amount).toBe('25');
  });

  it('transactions displays table rows in text mode', async () => {
    mockClient.budgets.transactions.mockResolvedValue(transactionsResponse);
    const cmd = budgetsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'transactions', 'grnt_1']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('btx_1');
    expect(allArgs).toContain('25');
  });
});
