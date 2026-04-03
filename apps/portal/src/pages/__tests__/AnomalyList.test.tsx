import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AnomalyList } from '../anomalies/AnomalyList';

const mockListAlerts = vi.fn();
const mockGetMetrics = vi.fn();
const mockAcknowledgeAlert = vi.fn();
const mockResolveAlert = vi.fn();
const mockRevokeGrant = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/anomalies', () => ({
  listAlerts: (...a: unknown[]) => mockListAlerts(...a),
  getMetrics: () => mockGetMetrics(),
  acknowledgeAlert: (...a: unknown[]) => mockAcknowledgeAlert(...a),
  resolveAlert: (...a: unknown[]) => mockResolveAlert(...a),
}));
vi.mock('../../api/grants', () => ({ revokeGrant: (...a: unknown[]) => mockRevokeGrant(...a) }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const alerts = [
  { alertId: 'al1', ruleId: 'r1', ruleName: 'rate_spike', severity: 'critical' as const, status: 'open' as const, agentId: 'a1', detectedAt: new Date().toISOString(), description: 'High rate detected', context: { grantId: 'g1' }, acknowledgedAt: null, resolvedAt: null },
  { alertId: 'al2', ruleId: 'r2', ruleName: 'off_hours', severity: 'low' as const, status: 'resolved' as const, agentId: null, detectedAt: new Date().toISOString(), description: 'Off hours activity', context: {}, acknowledgedAt: null, resolvedAt: new Date().toISOString() },
];

const metrics = {
  totalAlerts: 5, openAlerts: 2,
  bySeverity: { critical: 1, high: 0, medium: 0, low: 1 },
  byRule: {}, recentActivity: [{ date: '2026-03-01', count: 2 }],
};

function r() { return render(<MemoryRouter><AnomalyList /></MemoryRouter>); }

describe('AnomalyList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAlerts.mockResolvedValue(alerts);
    mockGetMetrics.mockResolvedValue(metrics);
  });

  it('renders alert cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('High rate detected')).toBeInTheDocument());
    expect(screen.getByText('Off hours activity')).toBeInTheDocument();
  });

  it('displays severity badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('critical')).toBeInTheDocument());
    expect(screen.getByText('low')).toBeInTheDocument();
  });

  it('displays status badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('open')).toBeInTheDocument());
    expect(screen.getByText('resolved')).toBeInTheDocument();
  });

  it('renders metrics cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Open Alerts by Severity')).toBeInTheDocument());
    expect(screen.getAllByText('Critical').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Total open')).toBeInTheDocument();
  });

  it('has status and severity filter dropdowns', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Anomaly Detection')).toBeInTheDocument());
    expect(screen.getByDisplayValue('All statuses')).toBeInTheDocument();
    expect(screen.getByDisplayValue('All severities')).toBeInTheDocument();
  });

  it('shows Acknowledge button for open alerts', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument());
  });

  it('acknowledges alert on click', async () => {
    mockAcknowledgeAlert.mockResolvedValueOnce(undefined);
    mockListAlerts.mockResolvedValue(alerts);
    mockGetMetrics.mockResolvedValue(metrics);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(mockAcknowledgeAlert).toHaveBeenCalledWith('al1'));
  });

  it('shows Resolve button for non-resolved alerts', async () => {
    r();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Resolve' }).length).toBeGreaterThanOrEqual(1));
  });

  it('shows empty state when no alerts', async () => {
    mockListAlerts.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No alerts found')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListAlerts.mockRejectedValue(new Error('fail'));
    mockGetMetrics.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load anomaly data', 'error'));
  });

  it('has Refresh button', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument());
  });

  it('shows alert count', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/2 alerts/)).toBeInTheDocument());
  });
});
