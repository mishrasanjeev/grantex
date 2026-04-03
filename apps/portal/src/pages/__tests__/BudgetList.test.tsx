import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BudgetList } from '../budgets/BudgetList';

const mockListBudgets = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/budgets', () => ({ listBudgets: () => mockListBudgets() }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const allocations = [
  { id: 'b1', grantId: 'g1', developerId: 'd1', initialBudget: '100.00', remainingBudget: '75.00', currency: 'USD', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'b2', grantId: 'g2', developerId: 'd1', initialBudget: '50.00', remainingBudget: '0.00', currency: 'USD', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
];

function r() { return render(<MemoryRouter><BudgetList /></MemoryRouter>); }

describe('BudgetList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListBudgets.mockResolvedValue(allocations); });

  it('renders budget table with allocations', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Budgets')).toBeInTheDocument());
  });

  it('shows summary cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Total Allocated')).toBeInTheDocument());
    expect(screen.getByText('Total Spent')).toBeInTheDocument();
    expect(screen.getByText('Total Remaining')).toBeInTheDocument();
  });

  it('calculates total allocated correctly', async () => {
    r();
    await waitFor(() => expect(screen.getByText(String.fromCharCode(36) + '150.00')).toBeInTheDocument());
  });

  it('shows empty state when no allocations', async () => {
    mockListBudgets.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No budget allocations')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListBudgets.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load budgets', 'error'));
  });

  it('displays usage status badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Healthy')).toBeInTheDocument());
    expect(screen.getByText('Exhausted')).toBeInTheDocument();
  });

  it('displays usage percentage', async () => {
    r();
    await waitFor(() => expect(screen.getByText('25%')).toBeInTheDocument()); // b1: 25% used
    expect(screen.getByText('100%')).toBeInTheDocument(); // b2: 100% used
  });
});
