import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GrantDetail } from '../grants/GrantDetail';

const mockGetGrant = vi.fn();
const mockRevokeGrant = vi.fn();
const mockListAuditEntries = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/grants', () => ({
  getGrant: (...a: unknown[]) => mockGetGrant(...a),
  revokeGrant: (...a: unknown[]) => mockRevokeGrant(...a),
}));
vi.mock('../../api/audit', () => ({ listAuditEntries: (...a: unknown[]) => mockListAuditEntries(...a) }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const grant = {
  grantId: 'g1', agentId: 'a1', principalId: 'user@t.com', developerId: 'd1',
  scopes: ['read', 'write'], status: 'active' as const,
  issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z',
  delegationDepth: 1, parentGrantId: 'g0',
};

const auditEntries = [{
  entryId: 'e1', agentId: 'a1', agentDid: 'did:web:a1', grantId: 'g1',
  principalId: 'user@t.com', developerId: 'd1', action: 'token.exchange',
  metadata: {}, hash: 'abc', prevHash: null, timestamp: '2026-01-01T00:00:00Z', status: 'success' as const,
}];

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/grants/g1']}>
      <Routes><Route path='/dashboard/grants/:id' element={<GrantDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('GrantDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGrant.mockResolvedValue(grant);
    mockListAuditEntries.mockResolvedValue(auditEntries);
  });

  it('displays grant metadata', async () => {
    r();
    await waitFor(() => expect(screen.getByText('g1')).toBeInTheDocument());
    expect(screen.getByText('user@t.com')).toBeInTheDocument();
  });

  it('shows delegation info', async () => {
    r();
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument()); // delegationDepth
    expect(screen.getByText('g0')).toBeInTheDocument(); // parentGrantId
  });

  it('links agent to agent detail', async () => {
    r();
    await waitFor(() => {
      const links = screen.getAllByText('a1');
      const link = links.find(l => l.closest('a'));
      expect(link.closest('a')).toHaveAttribute('href', '/dashboard/agents/a1');
    });
  });

  it('renders audit trail', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Audit Trail (1)')).toBeInTheDocument());
    expect(screen.getByText('token.exchange')).toBeInTheDocument();
  });

  it('shows no audit entries message when empty', async () => {
    mockListAuditEntries.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No audit entries for this grant')).toBeInTheDocument());
  });

  it('has Revoke button for active grant', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument());
  });

  it('revokes grant on confirm', async () => {
    mockRevokeGrant.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByText('Revoke Grant')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Revoke' }).pop()!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grant revoked', 'success'));
  });

  it('hides Revoke for already revoked grants', async () => {
    mockGetGrant.mockResolvedValue({ ...grant, status: 'revoked' });
    r();
    await waitFor(() => expect(screen.getByText('g1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('redirects when grant not found', async () => {
    mockGetGrant.mockRejectedValue(new Error('not found'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grant not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/grants');
  });
});
