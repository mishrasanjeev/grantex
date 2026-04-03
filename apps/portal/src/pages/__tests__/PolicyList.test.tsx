import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PolicyList } from '../policies/PolicyList';

const mockListPolicies = vi.fn();
const mockDeletePolicy = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/policies', () => ({
  listPolicies: () => mockListPolicies(),
  deletePolicy: (...a: unknown[]) => mockDeletePolicy(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const policies = [
  { id: 'p1', name: 'Allow Read', effect: 'allow' as const, priority: 1, agentId: 'a1', principalId: null, scopes: ['read'], timeOfDayStart: null, timeOfDayEnd: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'p2', name: 'Deny Write', effect: 'deny' as const, priority: 2, agentId: null, principalId: null, scopes: null, timeOfDayStart: '09:00', timeOfDayEnd: '17:00', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
];

function r() { return render(<MemoryRouter><PolicyList /></MemoryRouter>); }

describe('PolicyList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListPolicies.mockResolvedValue(policies); });

  it('renders policy table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Allow Read')).toBeInTheDocument());
    expect(screen.getByText('Deny Write')).toBeInTheDocument();
  });

  it('shows empty state when no policies', async () => {
    mockListPolicies.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No policies')).toBeInTheDocument());
  });

  it('has Create Policy link', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Policies')).toBeInTheDocument());
    expect(screen.getAllByText('Create Policy').length).toBeGreaterThanOrEqual(1);
  });

  it('shows error toast on load failure', async () => {
    mockListPolicies.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load policies', 'error'));
  });

  it('has Edit and Delete buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Allow Read')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to edit on Edit click', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Allow Read')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/policies/p1/edit');
  });

  it('deletes policy on confirm', async () => {
    mockDeletePolicy.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Allow Read')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(screen.getByText('Delete Policy')).toBeInTheDocument());
    const modal = screen.getByText('Delete Policy').closest('div[class*="fixed"]')!;
    const btns = within(modal as HTMLElement).getAllByRole('button', { name: 'Delete' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Policy deleted', 'success'));
  });

  it('displays effect badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('allow')).toBeInTheDocument());
    expect(screen.getByText('deny')).toBeInTheDocument();
  });

  it('displays time window', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Allow Read')).toBeInTheDocument());
    expect(screen.getByText(/09:00/)).toBeInTheDocument();
  });
});
