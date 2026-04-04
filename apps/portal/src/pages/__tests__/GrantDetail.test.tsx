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

const grantWithEnforcement = {
  ...grant,
  scopes: ['grantex:hubspot:read', 'grantex:stripe:write', 'grantex:jira:delete', 'grantex:sap:admin'],
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
      expect(link!.closest('a')).toHaveAttribute('href', '/dashboard/agents/a1');
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

  it('renders "Scope Enforcement Breakdown" card', async () => {
    mockGetGrant.mockResolvedValue(grantWithEnforcement);
    r();
    await waitFor(() => expect(screen.getByText('Scope Enforcement Breakdown')).toBeInTheDocument());
    expect(screen.getByText(/What this grant token allows and denies/)).toBeInTheDocument();
  });

  it('shows permission badges with correct colors', async () => {
    mockGetGrant.mockResolvedValue(grantWithEnforcement);
    r();
    await waitFor(() => expect(screen.getByText('Scope Enforcement Breakdown')).toBeInTheDocument());

    // The "Granted Level" column shows permission badges
    // read -> green (bg-gx-accent/15 text-gx-accent)
    const readBadge = screen.getByText((content, el) =>
      content === 'read' &&
      el?.tagName === 'SPAN' &&
      (el?.className ?? '').includes('bg-gx-accent/15'),
    );
    expect(readBadge).toBeInTheDocument();

    // write -> yellow (bg-gx-warning/15 text-gx-warning)
    const writeBadge = screen.getByText((content, el) =>
      content === 'write' &&
      el?.tagName === 'SPAN' &&
      (el?.className ?? '').includes('bg-gx-warning/15'),
    );
    expect(writeBadge).toBeInTheDocument();

    // delete -> red (bg-gx-danger/15 text-gx-danger)
    const deleteBadge = screen.getByText((content, el) =>
      content === 'delete' &&
      el?.tagName === 'SPAN' &&
      (el?.className ?? '').includes('bg-gx-danger/15'),
    );
    expect(deleteBadge).toBeInTheDocument();

    // admin -> purple (bg-purple-500/15 text-purple-400)
    const adminBadge = screen.getByText((content, el) =>
      content === 'admin' &&
      el?.tagName === 'SPAN' &&
      (el?.className ?? '').includes('bg-purple-500/15'),
    );
    expect(adminBadge).toBeInTheDocument();
  });

  it('shows level pills (read/write/delete/admin) with allowed/denied styling', async () => {
    mockGetGrant.mockResolvedValue(grantWithEnforcement);
    r();
    await waitFor(() => expect(screen.getByText('Scope Enforcement Breakdown')).toBeInTheDocument());

    // For the "read" scope row, only "read" should be allowed (bg-gx-accent/10), others should be struck through
    // For the "admin" scope row, all levels should be allowed
    // Check that "Tool Access" column header exists
    expect(screen.getByText('Tool Access')).toBeInTheDocument();

    // All four level pills should appear in every scope row (4 scopes x 4 levels = 16 pills in the Tool Access column)
    // Allowed pills use: bg-gx-accent/10 text-gx-accent
    // Denied pills use: bg-gx-border/30 text-gx-muted line-through
    const allPills = screen.getAllByText((content, el) =>
      ['read', 'write', 'delete', 'admin'].includes(content) &&
      el?.tagName === 'SPAN' &&
      (el?.className ?? '').includes('text-[10px]'),
    );
    // 4 scopes x 4 level pills = 16
    expect(allPills.length).toBe(16);

    // Count allowed pills (bg-gx-accent/10) — read:1, write:2, delete:3, admin:4 = 10
    const allowedPills = allPills.filter((el) => el.className.includes('bg-gx-accent/10'));
    expect(allowedPills.length).toBe(10);

    // Count denied pills (line-through) — read:3, write:2, delete:1, admin:0 = 6
    const deniedPills = allPills.filter((el) => el.className.includes('line-through'));
    expect(deniedPills.length).toBe(6);
  });
});
