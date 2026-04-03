import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageDashboard } from '../usage/UsageDashboard';

const mockGetUsage = vi.fn();
const mockGetUsageHistory = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/usage', () => ({
  getUsage: () => mockGetUsage(),
  getUsageHistory: (...a: unknown[]) => mockGetUsageHistory(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const usage = {
  developerId: 'd1', period: 'current',
  tokenExchanges: 1500, authorizations: 200, verifications: 3000, totalRequests: 4700,
};

const history = {
  entries: [
    { date: '2026-03-01', tokenExchanges: 100, authorizations: 20, verifications: 200, totalRequests: 320 },
    { date: '2026-03-02', tokenExchanges: 150, authorizations: 25, verifications: 250, totalRequests: 425 },
  ],
};

function r() { return render(<UsageDashboard />); }

describe('UsageDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue(usage);
    mockGetUsageHistory.mockResolvedValue(history);
  });

  it('renders usage stat cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Token Exchanges')).toBeInTheDocument());
    expect(screen.getAllByText('Authorizations').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Verifications').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Total Requests').length).toBeGreaterThanOrEqual(1);
  });

  it('displays correct values', async () => {
    r();
    await waitFor(() => expect(screen.getByText('1,500')).toBeInTheDocument());
    expect(screen.getByText('4,700')).toBeInTheDocument();
  });

  it('renders daily history table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Daily History')).toBeInTheDocument());
    expect(screen.getByText('Exchanges')).toBeInTheDocument();
  });

  it('has period selector buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByText('7d')).toBeInTheDocument());
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('90d')).toBeInTheDocument();
  });

  it('switches period on click', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('7d')).toBeInTheDocument());
    await user.click(screen.getByText('7d'));
    await waitFor(() => expect(mockGetUsageHistory).toHaveBeenCalledWith(7));
  });

  it('shows empty state for no history', async () => {
    mockGetUsageHistory.mockResolvedValue({ entries: [] });
    r();
    await waitFor(() => expect(screen.getByText('No usage data for this period')).toBeInTheDocument());
  });

  it('handles usage API failure', async () => {
    mockGetUsage.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load usage data', 'error'));
  });

  it('handles history API failure', async () => {
    mockGetUsageHistory.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load usage history', 'error'));
  });
});
