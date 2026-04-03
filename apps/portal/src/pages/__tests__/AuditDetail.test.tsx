import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuditDetail } from '../audit/AuditDetail';

const mockGetAuditEntry = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/audit', () => ({
  getAuditEntry: (...a: unknown[]) => mockGetAuditEntry(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const entry = {
  entryId: 'e1',
  agentId: 'agent-1',
  agentDid: 'did:web:a1',
  grantId: 'grant-1',
  principalId: 'user@test.com',
  developerId: 'd1',
  action: 'token.exchange',
  metadata: { ip: '1.2.3.4' },
  hash: 'abc123hash',
  prevHash: 'prev-hash-value',
  timestamp: '2026-01-01T00:00:00Z',
  status: 'success' as const,
};

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/audit/e1']}>
      <Routes><Route path="/dashboard/audit/:id" element={<AuditDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('AuditDetail', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetAuditEntry.mockResolvedValue(entry); });

  it('displays entry details after loading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('e1')).toBeInTheDocument());
    expect(screen.getByText('token.exchange')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
  });

  it('displays references section with links', async () => {
    r();
    await waitFor(() => expect(screen.getByText('agent-1')).toBeInTheDocument());
    expect(screen.getByText('did:web:a1')).toBeInTheDocument();
    expect(screen.getByText('grant-1')).toBeInTheDocument();
    expect(screen.getByText('user@test.com')).toBeInTheDocument();
  });

  it('displays hash chain info', async () => {
    r();
    await waitFor(() => expect(screen.getByText('abc123hash')).toBeInTheDocument());
    expect(screen.getByText('prev-hash-value')).toBeInTheDocument();
  });

  it('shows genesis entry message when no prevHash', async () => {
    mockGetAuditEntry.mockResolvedValue({ ...entry, prevHash: null });
    r();
    await waitFor(() => expect(screen.getByText(/Genesis entry/)).toBeInTheDocument());
  });

  it('displays metadata JSON', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/1\.2\.3\.4/)).toBeInTheDocument());
  });

  it('hides metadata section when empty', async () => {
    mockGetAuditEntry.mockResolvedValue({ ...entry, metadata: {} });
    r();
    await waitFor(() => expect(screen.getByText('e1')).toBeInTheDocument());
    expect(screen.queryByText('Metadata')).not.toBeInTheDocument();
  });

  it('redirects on entry not found', async () => {
    mockGetAuditEntry.mockRejectedValue(new Error('not found'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Audit entry not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/audit');
  });

  it('has back link to audit log', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Audit Entry')).toBeInTheDocument());
  });
});
