import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScimTokensPage } from '../settings/ScimTokensPage';

const mockListScimTokens = vi.fn();
const mockCreateScimToken = vi.fn();
const mockDeleteScimToken = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/scim', () => ({
  listScimTokens: () => mockListScimTokens(),
  createScimToken: (...a: unknown[]) => mockCreateScimToken(...a),
  deleteScimToken: (...a: unknown[]) => mockDeleteScimToken(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const tokens = [
  { id: 'st1', label: 'Okta Prod', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-03-01T00:00:00Z' },
  { id: 'st2', label: 'Azure AD', createdAt: '2026-02-01T00:00:00Z', lastUsedAt: null },
];

describe('ScimTokensPage', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListScimTokens.mockResolvedValue(tokens); });

  it('renders token table', async () => {
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('Okta Prod')).toBeInTheDocument());
    expect(screen.getByText('Azure AD')).toBeInTheDocument();
  });

  it('shows Never for unused tokens', async () => {
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('Never')).toBeInTheDocument());
  });

  it('shows empty state when no tokens', async () => {
    mockListScimTokens.mockResolvedValue([]);
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('No SCIM tokens')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListScimTokens.mockRejectedValue(new Error('fail'));
    render(<ScimTokensPage />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load SCIM tokens', 'error'));
  });

  it('has Create Token button', async () => {
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('SCIM Provisioning Tokens')).toBeInTheDocument());
    expect(screen.getAllByText('Create Token').length).toBeGreaterThanOrEqual(1);
  });

  it('creates token and shows secret', async () => {
    mockCreateScimToken.mockResolvedValueOnce({ id: 'st3', label: 'New', token: 'scim_secret_abc', createdAt: '2026-03-01T00:00:00Z', lastUsedAt: null });
    const user = userEvent.setup();
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('SCIM Provisioning Tokens')).toBeInTheDocument());
    await user.click(screen.getAllByText('Create Token')[0]!);
    await waitFor(() => expect(screen.getByText('Create SCIM Token')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g., Okta Production'), 'New');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByText('SCIM Token Created')).toBeInTheDocument());
    expect(screen.getByText('scim_secret_abc')).toBeInTheDocument();
  });

  it('has Revoke buttons', async () => {
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Revoke' }).length).toBeGreaterThanOrEqual(1));
  });

  it('revokes token on confirm', async () => {
    mockDeleteScimToken.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('Okta Prod')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await waitFor(() => expect(screen.getByText('Revoke SCIM Token')).toBeInTheDocument());
    const modal = screen.getByText('Revoke SCIM Token').closest('div[class*="fixed"]')!;
    const btns = within(modal as HTMLElement).getAllByRole('button', { name: 'Revoke' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('SCIM token revoked', 'success'));
  });

  it('has About SCIM section', async () => {
    render(<ScimTokensPage />);
    await waitFor(() => expect(screen.getByText('About SCIM Provisioning')).toBeInTheDocument());
  });
});
