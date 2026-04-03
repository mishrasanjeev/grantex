import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BundleList } from '../bundles/BundleList';

const mockListBundles = vi.fn();
const mockRevokeBundle = vi.fn();
const mockListAgents = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/bundles', () => ({
  listBundles: (...a: unknown[]) => mockListBundles(...a),
  revokeBundle: (...a: unknown[]) => mockRevokeBundle(...a),
}));
vi.mock('../../api/agents', () => ({
  listAgents: () => mockListAgents(),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const bundles = [
  {
    id: 'bnd-1', agentId: 'agent-1', userId: 'user-1', grantId: 'g-1',
    scopes: ['read'], status: 'active', devicePlatform: 'Android', deviceId: null,
    offlineTTL: '24h', offlineExpiresAt: '2026-05-01T00:00:00Z',
    lastSyncAt: '2026-04-01T00:00:00Z', auditEntryCount: 5, createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'bnd-2', agentId: 'agent-2', userId: 'user-2', grantId: 'g-2',
    scopes: ['write'], status: 'revoked', devicePlatform: null, deviceId: null,
    offlineTTL: '48h', offlineExpiresAt: '2026-05-02T00:00:00Z',
    lastSyncAt: null, auditEntryCount: 0, createdAt: '2026-01-02T00:00:00Z',
  },
];

function r() { return render(<MemoryRouter><BundleList /></MemoryRouter>); }

describe('BundleList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListBundles.mockResolvedValue(bundles);
    mockListAgents.mockResolvedValue([]);
  });

  it('renders heading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Offline Consent Bundles')).toBeInTheDocument());
  });

  it('shows bundle rows', async () => {
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    expect(screen.getByText('revoked')).toBeInTheDocument();
  });

  it('shows empty state when no bundles', async () => {
    mockListBundles.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No bundles found')).toBeInTheDocument());
  });

  it('has New Bundle button', async () => {
    r();
    await waitFor(() => expect(screen.getAllByText('+ New Bundle').length).toBeGreaterThanOrEqual(1));
  });

  it('shows error toast on load failure', async () => {
    mockListBundles.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load bundles', 'error'));
  });

  it('shows Revoke button only for active bundles', async () => {
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    const revokeButtons = screen.getAllByText('Revoke');
    expect(revokeButtons.length).toBe(1);
  });

  it('opens revoke confirmation dialog', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    await user.click(screen.getByText('Revoke'));
    await waitFor(() => expect(screen.getByText('Revoke Bundle')).toBeInTheDocument());
  });

  it('revokes bundle on confirm', async () => {
    mockRevokeBundle.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    await user.click(screen.getByText('Revoke'));
    await waitFor(() => expect(screen.getByText('Revoke Bundle')).toBeInTheDocument());
    const dialog = screen.getByText('Revoke Bundle').closest('div[class*="fixed"]')!;
    const btns = within(dialog as HTMLElement).getAllByRole('button', { name: 'Revoke' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Bundle revoked', 'success'));
  });

  it('displays platform badge for bundles with platform', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Android')).toBeInTheDocument());
  });

  it('shows last sync info', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Never')).toBeInTheDocument());
  });
});
