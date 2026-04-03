import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Signup } from '../Signup';

const mockLogin = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();
const mockSignup = vi.fn();
const mockSendVerificationEmail = vi.fn();
const mockSetApiKey = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../../store/auth', () => ({ useAuth: () => ({ login: mockLogin }) }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('../../api/auth', () => ({
  signup: (...a: unknown[]) => mockSignup(...a),
  sendVerificationEmail: (...a: unknown[]) => mockSendVerificationEmail(...a),
}));
vi.mock('../../api/client', () => ({ setApiKey: (...a: unknown[]) => mockSetApiKey(...a) }));

function renderSignup() {
  return render(<MemoryRouter><Signup /></MemoryRouter>);
}

describe('Signup', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the signup form', () => {
    renderSignup();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();
  });

  it('has a link to login', () => {
    renderSignup();
    expect(screen.getByText('Sign in')).toHaveAttribute('href', '/dashboard/login');
  });

  it('disables submit when name is empty', () => {
    renderSignup();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeDisabled();
  });

  it('enables submit when name is provided', async () => {
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeEnabled();
  });

  it('calls signup with name only', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_new' });
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(mockSignup).toHaveBeenCalledWith({ name: 'Acme' }));
  });

  it('calls signup with name and email', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_new' });
    mockSendVerificationEmail.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.type(screen.getByLabelText(/Email/), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(mockSignup).toHaveBeenCalledWith({ name: 'Acme', email: 'a@b.com' }));
  });

  it('shows API key after successful signup', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_live_key123' });
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByText('gx_live_key123')).toBeInTheDocument());
    expect(screen.getByText('Account created')).toBeInTheDocument();
    expect(screen.getByText(/Save your API key/)).toBeInTheDocument();
  });

  it('shows success toast', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_new' });
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Account created!', 'success'));
  });

  it('shows error toast on failure', async () => {
    mockSignup.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to create account', 'error'));
  });

  it('Continue to Dashboard calls login and navigates', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_key' });
    mockLogin.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByText('Continue to Dashboard')).toBeInTheDocument());
    await user.click(screen.getByText('Continue to Dashboard'));
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('gx_key');
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('shows error toast if continue fails', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_key' });
    mockLogin.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByText('Continue to Dashboard')).toBeInTheDocument());
    await user.click(screen.getByText('Continue to Dashboard'));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to authenticate', 'error'));
  });

  it('shows verification email notice', async () => {
    mockSignup.mockResolvedValueOnce({ apiKey: 'gx_key' });
    mockSendVerificationEmail.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderSignup();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.type(screen.getByLabelText(/Email/), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByText(/verification email has been sent/)).toBeInTheDocument());
  });
});
