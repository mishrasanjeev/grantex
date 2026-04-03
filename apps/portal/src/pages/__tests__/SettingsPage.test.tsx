import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../settings/SettingsPage';

const mockLogin = vi.fn();
const mockShow = vi.fn();
const mockRotateKey = vi.fn();
const mockSetApiKey = vi.fn();
const mockApiPatch = vi.fn();

const developer = {
  developerId: 'dev-1', name: 'Test Dev', email: 'dev@test.com',
  mode: 'live' as const, plan: 'pro', fidoRequired: false,
  fidoRpName: null, createdAt: '2026-01-01T00:00:00Z',
};

vi.mock('../../store/auth', () => ({
  useAuth: () => ({ developer, apiKey: 'gx_live_xxx', login: mockLogin }),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('../../api/auth', () => ({ rotateKey: () => mockRotateKey() }));
vi.mock('../../api/client', () => ({
  setApiKey: (...a: unknown[]) => mockSetApiKey(...a),
  api: { patch: (...a: unknown[]) => mockApiPatch(...a) },
}));

describe('SettingsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('displays developer profile', () => {
    render(<SettingsPage />);
    expect(screen.getByText('dev-1')).toBeInTheDocument();
    expect(screen.getByText('Test Dev')).toBeInTheDocument();
    expect(screen.getByText('dev@test.com')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('pro')).toBeInTheDocument();
  });

  it('shows masked API key', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
  });

  it('rotates API key successfully', async () => {
    mockRotateKey.mockResolvedValueOnce({ apiKey: 'gx_live_new456' });
    mockLogin.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Rotate Key' }));
    await waitFor(() => expect(mockRotateKey).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('API key rotated successfully', 'success');
    expect(screen.getByText('gx_live_new456')).toBeInTheDocument();
  });

  it('shows error toast on rotate failure', async () => {
    mockRotateKey.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Rotate Key' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to rotate API key', 'error'));
  });

  it('has FIDO2 toggle checkbox', () => {
    render(<SettingsPage />);
    expect(screen.getByText('FIDO2 / WebAuthn')).toBeInTheDocument();
    expect(screen.getByText('Require FIDO2 for consent flows')).toBeInTheDocument();
  });

  it('saves FIDO2 settings', async () => {
    mockApiPatch.mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('Require FIDO2 for consent flows'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApiPatch).toHaveBeenCalledWith('/v1/me', { fidoRequired: true, fidoRpName: '' }));
    expect(mockShow).toHaveBeenCalledWith('FIDO2 settings saved', 'success');
  });

  it('shows error toast on FIDO2 save failure', async () => {
    mockApiPatch.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to save FIDO2 settings', 'error'));
  });

  it('has Relying Party Name input', () => {
    render(<SettingsPage />);
    expect(screen.getByPlaceholderText('My Organization')).toBeInTheDocument();
  });
});
