import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SsoConfigPage } from '../settings/SsoConfigPage';

const mockListConnections = vi.fn();
const mockCreateConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockTestConnection = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/sso', () => ({
  listSsoConnections: () => mockListConnections(),
  createSsoConnection: (...a: unknown[]) => mockCreateConnection(...a),
  deleteSsoConnection: (...a: unknown[]) => mockDeleteConnection(...a),
  testSsoConnection: (...a: unknown[]) => mockTestConnection(...a),
}));
vi.mock('../../api/client', () => ({
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } },
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const connections = [
  { id: 'sso1', name: 'Corporate Okta', protocol: 'oidc', status: 'active', domains: ['corp.com'], enforce: true, jitProvisioning: false, createdAt: '2026-01-01T00:00:00Z' },
];

describe('SsoConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListConnections.mockResolvedValue({ connections });
  });

  it('renders SSO connections table', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText('Corporate Okta')).toBeInTheDocument());
  });

  it('displays protocol badge', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText('OIDC')).toBeInTheDocument());
  });

  it('displays status badge', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
  });

  it('shows empty state when no connections', async () => {
    mockListConnections.mockResolvedValue({ connections: [] });
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText(/No SSO connections configured/)).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListConnections.mockRejectedValue(new Error('fail'));
    render(<SsoConfigPage />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load SSO connections', 'error'));
  });

  it('has Create Connection button', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Connection' })).toBeInTheDocument());
  });

  it('opens create modal', async () => {
    const user = userEvent.setup();
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText('SSO Connections')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Create Connection' }));
    await waitFor(() => expect(screen.getByText('Create SSO Connection')).toBeInTheDocument());
  });

  it('has Test and Delete buttons per connection', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('tests connection successfully', async () => {
    mockTestConnection.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Connection test passed', 'success'));
  });

  it('has About SSO section', async () => {
    render(<SsoConfigPage />);
    await waitFor(() => expect(screen.getByText('About SSO')).toBeInTheDocument());
  });
});
