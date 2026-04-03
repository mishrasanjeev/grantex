import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BundleDetail } from '../bundles/BundleDetail';

const mockGetBundle = vi.fn();
const mockRevokeBundle = vi.fn();
const mockGetBundleAuditEntries = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/bundles', () => ({
  getBundle: (...a: unknown[]) => mockGetBundle(...a),
  revokeBundle: (...a: unknown[]) => mockRevokeBundle(...a),
  getBundleAuditEntries: (...a: unknown[]) => mockGetBundleAuditEntries(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const bundle = {
  id: 'bnd-1', agentId: 'agent-1', userId: 'user-1', grantId: 'g-1',
  scopes: ['read', 'write'], status: 'active', devicePlatform: 'iOS',
  deviceId: 'dev-001', offlineTTL: '24h',
  offlineExpiresAt: '2026-05-01T00:00:00Z', lastSyncAt: null,
  auditEntryCount: 2, createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
};

const entries = [
  { id: 'ae-1', seq: 1, timestamp: '2026-04-01T00:00:00Z', action: 'token.verify', scopes: ['read'], result: 'allow', metadata: { ip: '1.2.3.4' } },
  { id: 'ae-2', seq: 2, timestamp: '2026-04-01T01:00:00Z', action: 'data.access', scopes: ['write'], result: 'deny', metadata: {} },
];

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/bundles/bnd-1']}>
      <Routes><Route path="/dashboard/bundles/:bundleId" element={<BundleDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('BundleDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBundle.mockResolvedValue(bundle);
    mockGetBundleAuditEntries.mockResolvedValue(entries);
  });

  it('renders bundle details', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Details')).toBeInTheDocument());
    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('user-1')).toBeInTheDocument();
    expect(screen.getByText('g-1')).toBeInTheDocument();
  });

  it('shows bundle status badge', async () => {
    r();
    await waitFor(() => expect(screen.getAllByText('active').length).toBeGreaterThanOrEqual(1));
  });

  it('shows metadata section with scopes and platform', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Metadata')).toBeInTheDocument());
    expect(screen.getByText('iOS')).toBeInTheDocument();
    expect(screen.getByText('24h')).toBeInTheDocument();
  });

  it('displays offline audit log', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Offline Audit Log (2)')).toBeInTheDocument());
    expect(screen.getByText('token.verify')).toBeInTheDocument();
    expect(screen.getByText('data.access')).toBeInTheDocument();
  });

  it('shows audit result badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('allow')).toBeInTheDocument());
    expect(screen.getByText('deny')).toBeInTheDocument();
  });

  it('shows Scope Usage chart', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Scope Usage')).toBeInTheDocument());
  });

  it('shows empty audit state when no entries', async () => {
    mockGetBundleAuditEntries.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No offline audit entries recorded yet.')).toBeInTheDocument());
  });

  it('shows Revoke Bundle button for active bundles', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Revoke Bundle')).toBeInTheDocument());
  });

  it('hides Revoke button for revoked bundles', async () => {
    mockGetBundle.mockResolvedValue({ ...bundle, status: 'revoked' });
    r();
    await waitFor(() => expect(screen.getByText('Details')).toBeInTheDocument());
    expect(screen.queryByText('Revoke Bundle')).not.toBeInTheDocument();
  });

  it('revokes bundle on confirm', async () => {
    mockRevokeBundle.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Revoke Bundle')).toBeInTheDocument());
    await user.click(screen.getByText('Revoke Bundle'));
    await waitFor(() => {
      const dialog = screen.getByText('Are you sure you want to revoke this bundle?').closest('div[class*="fixed"]')!;
      expect(dialog).toBeInTheDocument();
    });
    const dialog = screen.getByText('Are you sure you want to revoke this bundle?').closest('div[class*="fixed"]')!;
    const btns = within(dialog as HTMLElement).getAllByRole('button', { name: 'Revoke' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Bundle revoked', 'success'));
  });

  it('shows error toast on load failure and navigates back', async () => {
    mockGetBundle.mockRejectedValue(new Error('not found'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Bundle not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/bundles');
  });

  it('has Refresh Bundle button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Refresh Bundle')).toBeInTheDocument());
  });

  it('has Download JWKS button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Download JWKS')).toBeInTheDocument());
  });
});
