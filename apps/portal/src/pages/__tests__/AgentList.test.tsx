import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AgentList } from '../agents/AgentList';

const mockListAgents = vi.fn();
const mockDeleteAgent = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/agents', () => ({
  listAgents: () => mockListAgents(),
  deleteAgent: (...a: unknown[]) => mockDeleteAgent(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const agents = [
  { agentId: 'a1', did: 'did:web:a1', developerId: 'd1', name: 'Agent One', description: null, scopes: ['read', 'write'], status: 'active' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { agentId: 'a2', did: 'did:web:a2', developerId: 'd1', name: 'Agent Two', description: 'Desc', scopes: ['read'], status: 'suspended' as const, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
];

function r() { return render(<MemoryRouter><AgentList /></MemoryRouter>); }

describe('AgentList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListAgents.mockResolvedValue(agents); });

  it('renders agent table after loading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    expect(screen.getByText('Agent Two')).toBeInTheDocument();
  });

  it('shows empty state when no agents', async () => {
    mockListAgents.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No agents yet')).toBeInTheDocument());
  });

  it('has Create Agent link', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Agents')).toBeInTheDocument());
    expect(screen.getAllByText('Create Agent').length).toBeGreaterThanOrEqual(1);
  });

  it('shows error toast on load failure', async () => {
    mockListAgents.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load agents', 'error'));
  });

  it('opens delete confirmation dialog', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(screen.getByText('Delete Agent')).toBeInTheDocument());
  });

  it('deletes agent and shows success toast', async () => {
    mockDeleteAgent.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(screen.getByText('Delete Agent')).toBeInTheDocument());
    const modal = screen.getByText('Delete Agent').closest('div[class*="fixed"]')!;
    const btns = within(modal as HTMLElement).getAllByRole('button', { name: 'Delete' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Agent deleted', 'success'));
  });

  it('shows error toast on delete failure', async () => {
    mockDeleteAgent.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(screen.getByText('Delete Agent')).toBeInTheDocument());
    const modal = screen.getByText('Delete Agent').closest('div[class*="fixed"]')!;
    const btns = within(modal as HTMLElement).getAllByRole('button', { name: 'Delete' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to delete agent', 'error'));
  });

  it('displays status badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    expect(screen.getByText('suspended')).toBeInTheDocument();
  });
});
