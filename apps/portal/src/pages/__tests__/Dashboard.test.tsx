import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../Dashboard';

const mockListAgents = vi.fn();
const mockListGrants = vi.fn();
const mockListAuditEntries = vi.fn();
const mockListAnomalies = vi.fn();

vi.mock('../../api/agents', () => ({ listAgents: () => mockListAgents() }));
vi.mock('../../api/grants', () => ({ listGrants: (...a: unknown[]) => mockListGrants(...a) }));
vi.mock('../../api/audit', () => ({ listAuditEntries: () => mockListAuditEntries() }));
vi.mock('../../api/anomalies', () => ({ listAnomalies: () => mockListAnomalies() }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: vi.fn() }) }));

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

const entry = {
  entryId: 'e1', agentId: 'agent-001', agentDid: 'did:web:t', grantId: 'grant-001',
  principalId: 'user@test.com', developerId: 'dev1', action: 'token.exchange',
  metadata: {}, hash: 'abc', prevHash: null, timestamp: new Date().toISOString(), status: 'success' as const,
};

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue([{ agentId: 'a1' }, { agentId: 'a2' }]);
    mockListGrants.mockResolvedValue([{ grantId: 'g1' }]);
    mockListAuditEntries.mockResolvedValue([entry]);
    mockListAnomalies.mockResolvedValue([{ id: 'an1' }]);
  });

  it('renders stat cards after loading', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Active Grants')).toBeInTheDocument();
    expect(screen.getByText('Audit Entries')).toBeInTheDocument();
    expect(screen.getByText('Anomalies')).toBeInTheDocument();
  });

  it('shows correct agent count', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  });

  it('renders recent activity table', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Recent Activity')).toBeInTheDocument());
    expect(screen.getByText('token.exchange')).toBeInTheDocument();
  });

  it('shows empty state when no audit entries', async () => {
    mockListAuditEntries.mockResolvedValue([]);
    renderDashboard();
    await waitFor(() => expect(screen.getByText('No recent activity')).toBeInTheDocument());
  });

  it('stat cards link to their pages', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Agents')).toBeInTheDocument());
    expect(screen.getByText('Agents').closest('a')).toHaveAttribute('href', '/dashboard/agents');
  });

  it('handles all API failures gracefully', async () => {
    mockListAgents.mockRejectedValue(new Error('fail'));
    mockListGrants.mockRejectedValue(new Error('fail'));
    mockListAuditEntries.mockRejectedValue(new Error('fail'));
    mockListAnomalies.mockRejectedValue(new Error('fail'));
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(4);
  });
});
