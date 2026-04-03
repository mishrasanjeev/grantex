import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from '../admin/AdminPage';

const mockFetchStats = vi.fn();
const mockFetchDevelopers = vi.fn();
const mockGetAdminKey = vi.fn();
const mockSetAdminKey = vi.fn();
const mockClearAdminKey = vi.fn();

vi.mock('../../api/admin', () => ({
  fetchStats: () => mockFetchStats(),
  fetchDevelopers: (...a: unknown[]) => mockFetchDevelopers(...a),
  getAdminKey: () => mockGetAdminKey(),
  setAdminKey: (...a: unknown[]) => mockSetAdminKey(...a),
  clearAdminKey: () => mockClearAdminKey(),
}));

const stats = {
  totalDevelopers: 42, last24h: 5, last7d: 12, last30d: 30,
  byMode: { live: 30, sandbox: 12 }, totalAgents: 100, totalGrants: 200,
};

const developers = {
  developers: [
    { id: 'd1', name: 'Dev One', email: 'dev1@test.com', mode: 'live', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'd2', name: 'Dev Two', email: null, mode: 'sandbox', createdAt: '2026-02-01T00:00:00Z' },
  ],
  total: 2, page: 1, pageSize: 50,
};

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdminKey.mockReturnValue(null);
    mockFetchStats.mockResolvedValue(stats);
    mockFetchDevelopers.mockResolvedValue(developers);
  });

  it('shows login form when not authenticated', () => {
    render(<AdminPage />);
    expect(screen.getByText('Admin Access')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('ADMIN_API_KEY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticate' })).toBeInTheDocument();
  });

  it('shows error for empty key submission', async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(screen.getByText('Please enter an API key')).toBeInTheDocument();
  });

  it('authenticates and loads data', async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.type(screen.getByPlaceholderText('ADMIN_API_KEY'), 'admin_key_123');
    await user.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(mockSetAdminKey).toHaveBeenCalledWith('admin_key_123');
    await waitFor(() => expect(screen.getByText('Admin Dashboard')).toBeInTheDocument());
    expect(screen.getByText('42')).toBeInTheDocument(); // totalDevelopers
  });

  it('shows stat cards after authentication', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Admin Dashboard')).toBeInTheDocument());
    expect(screen.getByText('Total Developers')).toBeInTheDocument();
    expect(screen.getByText('Last 24 Hours')).toBeInTheDocument();
    expect(screen.getByText('Last 7 Days')).toBeInTheDocument();
    expect(screen.getByText('Last 30 Days')).toBeInTheDocument();
  });

  it('shows developer table', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Dev One')).toBeInTheDocument());
    expect(screen.getByText('Dev Two')).toBeInTheDocument();
  });

  it('shows developer email or dash', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('dev1@test.com')).toBeInTheDocument());
  });

  it('has Sign out button', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
  });

  it('signs out and shows login', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    const user = userEvent.setup();
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockClearAdminKey).toHaveBeenCalled();
    expect(screen.getByText('Admin Access')).toBeInTheDocument();
  });

  it('handles unauthorized and returns to login', async () => {
    mockGetAdminKey.mockReturnValue('bad_key');
    mockFetchStats.mockRejectedValue(new Error('Unauthorized'));
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Admin Access')).toBeInTheDocument());
    expect(screen.getByText('Invalid API key')).toBeInTheDocument();
  });

  it('shows mode badges', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument());
    expect(screen.getByText('sandbox')).toBeInTheDocument();
  });

  it('shows agents and grants totals', async () => {
    mockGetAdminKey.mockReturnValue('admin_key');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Total Agents')).toBeInTheDocument());
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('Total Grants')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });
});
