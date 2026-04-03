import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuditLog } from '../audit/AuditLog';

const mockListAuditEntries = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/audit', () => ({ listAuditEntries: () => mockListAuditEntries() }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const entries = [
  { entryId: 'e1', agentId: 'agent-1', agentDid: 'did:web:a1', grantId: 'grant-1', principalId: 'user1', developerId: 'd1', action: 'token.exchange', metadata: {}, hash: 'h1', prevHash: null, timestamp: new Date().toISOString(), status: 'success' as const },
  { entryId: 'e2', agentId: 'agent-2', agentDid: 'did:web:a2', grantId: 'grant-2', principalId: 'user2', developerId: 'd1', action: 'grant.revoke', metadata: {}, hash: 'h2', prevHash: 'h1', timestamp: new Date().toISOString(), status: 'blocked' as const },
];

function r() { return render(<MemoryRouter><AuditLog /></MemoryRouter>); }

describe('AuditLog', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListAuditEntries.mockResolvedValue(entries); });

  it('renders audit table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Audit Log')).toBeInTheDocument());
    expect(screen.getByText('token.exchange')).toBeInTheDocument();
    expect(screen.getByText('grant.revoke')).toBeInTheDocument();
  });

  it('has search input', async () => {
    r();
    await waitFor(() => expect(screen.getByPlaceholderText(/Search by action/)).toBeInTheDocument());
  });

  it('filters entries by search', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('token.exchange')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/Search by action/), 'grant.revoke');
    await waitFor(() => expect(screen.queryByText('token.exchange')).not.toBeInTheDocument());
    expect(screen.getByText('grant.revoke')).toBeInTheDocument();
  });

  it('shows empty state when no entries', async () => {
    mockListAuditEntries.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No audit entries')).toBeInTheDocument());
  });

  it('shows empty state for no search matches', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Audit Log')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/Search by action/), 'nonexistent');
    await waitFor(() => expect(screen.getByText('No audit entries')).toBeInTheDocument());
    expect(screen.getByText(/No entries match your search/)).toBeInTheDocument();
  });

  it('shows error toast on load failure', async () => {
    mockListAuditEntries.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load audit entries', 'error'));
  });

  it('has date range filter buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Audit Log')).toBeInTheDocument());
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('displays status badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('success')).toBeInTheDocument());
    expect(screen.getByText('blocked')).toBeInTheDocument();
  });
});
