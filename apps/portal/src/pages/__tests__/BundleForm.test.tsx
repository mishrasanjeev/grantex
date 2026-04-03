import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BundleForm } from '../bundles/BundleForm';

const mockCreateBundle = vi.fn();
const mockListAgents = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/bundles', () => ({
  createBundle: (...a: unknown[]) => mockCreateBundle(...a),
}));
vi.mock('../../api/agents', () => ({
  listAgents: () => mockListAgents(),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const agents = [
  { agentId: 'agent-1', name: 'Test Agent', createdAt: '2026-01-01T00:00:00Z' },
];

function r() { return render(<MemoryRouter><BundleForm /></MemoryRouter>); }

describe('BundleForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue(agents);
  });

  it('renders step 1 heading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('New Offline Consent Bundle')).toBeInTheDocument());
    expect(screen.getByText('Agent & User')).toBeInTheDocument();
  });

  it('shows step indicators', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Scopes & TTL')).toBeInTheDocument());
    expect(screen.getByText('Review & Issue')).toBeInTheDocument();
  });

  it('disables Next when userId is empty', async () => {
    r();
    await waitFor(() => expect(screen.getByText('New Offline Consent Bundle')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('advances to step 2 when step 1 is filled', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('New Offline Consent Bundle')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g., user@example.com or user-id'), 'user-123');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Scopes')).toBeInTheDocument());
  });

  it('shows platform selection buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Android')).toBeInTheDocument());
    expect(screen.getByText('iOS')).toBeInTheDocument();
    expect(screen.getByText('Raspberry Pi')).toBeInTheDocument();
  });

  it('shows error toast on agent load failure', async () => {
    mockListAgents.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load agents', 'error'));
  });

  it('shows success result after bundle creation', async () => {
    mockCreateBundle.mockResolvedValueOnce({
      bundle: { id: 'bnd-new' },
      grantToken: 'jwt-token-xyz',
      jwks: { keys: [] },
      auditKey: 'audit-key-secret',
    });
    const user = userEvent.setup();
    r();
    // Step 1
    await waitFor(() => expect(screen.getByText('New Offline Consent Bundle')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g., user@example.com or user-id'), 'user-123');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2 - add scope
    await waitFor(() => expect(screen.getByText('Scopes')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Type a scope and press Enter'), 'read{enter}');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3 - review and submit
    await waitFor(() => expect(screen.getByText('Review Bundle')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Issue Bundle' }));
    await waitFor(() => expect(screen.getByText('Bundle Issued')).toBeInTheDocument());
    expect(screen.getByText('audit-key-secret')).toBeInTheDocument();
    expect(mockShow).toHaveBeenCalledWith('Bundle issued successfully', 'success');
  });

  it('shows error toast on bundle creation failure', async () => {
    mockCreateBundle.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    // Step 1
    await waitFor(() => expect(screen.getByText('New Offline Consent Bundle')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g., user@example.com or user-id'), 'user-123');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2
    await waitFor(() => expect(screen.getByText('Scopes')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Type a scope and press Enter'), 'read{enter}');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3
    await waitFor(() => expect(screen.getByText('Review Bundle')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Issue Bundle' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to issue bundle', 'error'));
  });
});
