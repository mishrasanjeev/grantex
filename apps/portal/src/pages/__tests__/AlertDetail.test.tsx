import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AlertDetail } from '../anomalies/AlertDetail';

const mockGetAlert = vi.fn();
const mockAcknowledgeAlert = vi.fn();
const mockResolveAlert = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/anomalies', () => ({
  getAlert: (...a: unknown[]) => mockGetAlert(...a),
  acknowledgeAlert: (...a: unknown[]) => mockAcknowledgeAlert(...a),
  resolveAlert: (...a: unknown[]) => mockResolveAlert(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const alert = {
  alertId: 'al1', ruleId: 'r1', ruleName: 'Velocity Check', severity: 'critical', status: 'open',
  agentId: 'a1', description: 'High velocity detected',
  detectedAt: '2026-01-01T00:00:00Z', acknowledgedAt: null, resolvedAt: null,
  context: { grantId: 'g1', ip: '1.2.3.4' },
};

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/anomalies/al1']}>
      <Routes><Route path="/dashboard/anomalies/:alertId" element={<AlertDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('AlertDetail', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetAlert.mockResolvedValue(alert); });

  it('displays alert metadata', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Velocity Check')).toBeInTheDocument());
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('High velocity detected')).toBeInTheDocument();
  });

  it('displays timeline with Detected event', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Detected')).toBeInTheDocument());
    expect(screen.getByText('Awaiting acknowledgement')).toBeInTheDocument();
  });

  it('displays context JSON', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Context')).toBeInTheDocument());
  });

  it('has Acknowledge button for open alert', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument());
  });

  it('has Resolve button for open alert', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument());
  });

  it('acknowledges alert on button click', async () => {
    mockAcknowledgeAlert.mockResolvedValueOnce(undefined);
    // Initial fetch: open (so the Acknowledge button renders). Post-ack refresh:
    // acknowledged. Previously this used mockResolvedValue with the final state,
    // which hid the button at mount time.
    mockGetAlert
      .mockResolvedValueOnce(alert)
      .mockResolvedValueOnce({ ...alert, status: 'acknowledged', acknowledgedAt: new Date().toISOString() });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(mockAcknowledgeAlert).toHaveBeenCalledWith('al1', undefined));
  });

  it('shows not found when alert is null', async () => {
    mockGetAlert.mockRejectedValue(new Error('not found'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load alert', 'error'));
    expect(screen.getByText('Alert not found.')).toBeInTheDocument();
  });

  it('hides action buttons for resolved alert', async () => {
    mockGetAlert.mockResolvedValue({
      ...alert, status: 'resolved', resolvedAt: new Date().toISOString(),
    });
    r();
    await waitFor(() => expect(screen.getByText('Resolved')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution Note')).not.toBeInTheDocument();
  });
});
