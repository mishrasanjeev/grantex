import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GrantList } from '../grants/GrantList';

const mockListGrants = vi.fn();
const mockRevokeGrant = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/grants', () => ({
  listGrants: () => mockListGrants(),
  revokeGrant: (...a: unknown[]) => mockRevokeGrant(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const grants = [
  { grantId: 'g1', agentId: 'a1', principalId: 'user1', developerId: 'd1', scopes: ['read'], status: 'active' as const, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z', delegationDepth: 0 },
  { grantId: 'g2', agentId: 'a2', principalId: 'user2', developerId: 'd1', scopes: ['write'], status: 'revoked' as const, issuedAt: '2026-01-02T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z', delegationDepth: 0 },
  { grantId: 'g3', agentId: 'a1', principalId: 'user1', developerId: 'd1', scopes: ['admin'], status: 'expired' as const, issuedAt: '2025-01-01T00:00:00Z', expiresAt: '2025-12-31T00:00:00Z', delegationDepth: 0 },
];

function r() { return render(<MemoryRouter><GrantList /></MemoryRouter>); }

describe('GrantList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListGrants.mockResolvedValue(grants); });

  it('renders analytics stat cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Revoked').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Expired').length).toBeGreaterThanOrEqual(1);
  });

  it('shows correct stat values', async () => {
    r();
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument()); // total
  });

  it('renders grant table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Grants')).toBeInTheDocument());
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Grants')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Active' }));
    // Only active grants shown - g2 (revoked) and g3 (expired) should be filtered
    await waitFor(() => expect(screen.queryByText('revoked')).not.toBeInTheDocument());
  });

  it('shows empty state when no grants match filter', async () => {
    mockListGrants.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No grants found')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListGrants.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load grants', 'error'));
  });

  it('opens revoke confirmation for active grant', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Grants')).toBeInTheDocument());
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    await user.click(revokeButtons[0]!);
    await waitFor(() => expect(screen.getByText('Revoke Grant')).toBeInTheDocument());
  });

  it('shows top scopes section', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Top Scopes')).toBeInTheDocument());
  });

  it('has principal filter input', async () => {
    r();
    await waitFor(() => expect(screen.getByPlaceholderText('Filter by principal ID...')).toBeInTheDocument());
  });

  it('has select all active button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Select all active')).toBeInTheDocument());
  });
});
