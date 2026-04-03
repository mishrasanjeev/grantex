import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BudgetDetail } from '../budgets/BudgetDetail';

const mockGetBudget = vi.fn();
const mockListTransactions = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/budgets', () => ({
  getBudget: (...a: unknown[]) => mockGetBudget(...a),
  listTransactions: (...a: unknown[]) => mockListTransactions(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const allocation = {
  id: 'b1', grantId: 'g1', developerId: 'd1',
  initialBudget: '100.00', remainingBudget: '60.00', currency: 'USD',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const transactions = [
  { id: 'tx1', grantId: 'g1', amount: '20.00', description: 'API call', createdAt: '2026-01-02T00:00:00Z' },
  { id: 'tx2', grantId: 'g1', amount: '20.00', description: 'Compute', createdAt: '2026-01-03T00:00:00Z' },
];

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/budgets/g1']}>
      <Routes><Route path="/dashboard/budgets/:grantId" element={<BudgetDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('BudgetDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBudget.mockResolvedValue(allocation);
    mockListTransactions.mockResolvedValue({ transactions, total: 2 });
  });

  it('displays spending bar', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Spending')).toBeInTheDocument());
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('displays remaining amount', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/60\.00/)).toBeInTheDocument());
  });

  it('renders transaction history', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Transactions')).toBeInTheDocument());
    expect(screen.getByText('API call')).toBeInTheDocument();
    expect(screen.getByText('Compute')).toBeInTheDocument();
  });

  it('shows no transactions message when empty', async () => {
    mockListTransactions.mockResolvedValue({ transactions: [], total: 0 });
    r();
    await waitFor(() => expect(screen.getByText('No transactions yet.')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockGetBudget.mockRejectedValue(new Error('fail'));
    mockListTransactions.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load budget details', 'error'));
  });

  it('shows allocation not found when budget is null', async () => {
    mockGetBudget.mockResolvedValue(null);
    mockListTransactions.mockResolvedValue({ transactions: [], total: 0 });
    r();
    await waitFor(() => expect(screen.getByText('Budget allocation not found.')).toBeInTheDocument());
  });

  it('has back link to budgets', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/Budget/)).toBeInTheDocument());
  });
});
