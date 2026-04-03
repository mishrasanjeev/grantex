import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Login } from '../Login';

const mockLogin = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../store/auth', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('../../store/toast', () => ({
  useToast: () => ({ show: mockShow }),
}));

function renderLogin() {
  return render(<MemoryRouter><Login /></MemoryRouter>);
}

describe('Login', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the login form with API key input', () => {
    renderLogin();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Sign in to your developer dashboard/)).toBeInTheDocument();
  });

  it('has a link to the signup page', () => {
    renderLogin();
    expect(screen.getByText('Create one')).toHaveAttribute('href', '/dashboard/signup');
  });

  it('disables the submit button when input is empty', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('enables the submit button when API key is entered', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), 'gx_live_abc123');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('calls login and navigates to dashboard on success', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), 'gx_live_abc123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('gx_live_abc123');
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('trims whitespace from the API key', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), '  gx_live_abc  ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('gx_live_abc'));
  });

  it('shows error toast on login failure', async () => {
    mockLogin.mockRejectedValueOnce(new Error('bad'));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), 'gx_live_bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Invalid API key', 'error'));
  });

  it('does not navigate on login failure', async () => {
    mockLogin.mockRejectedValueOnce(new Error('bad'));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), 'gx_live_bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not submit if only whitespace is entered', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('API Key'), '   ');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });
});
