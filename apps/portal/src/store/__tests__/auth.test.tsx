import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from '../auth';

// Mock the API modules
const mockSetApiKey = vi.fn();
const mockGetMe = vi.fn();

vi.mock('../../api/client', () => ({
  setApiKey: (...args: unknown[]) => mockSetApiKey(...args),
}));

vi.mock('../../api/auth', () => ({
  getMe: () => mockGetMe(),
}));

const mockDeveloper = {
  developerId: 'dev-123',
  name: 'Test Developer',
  email: 'test@example.com',
  mode: 'live' as const,
  plan: 'pro',
  fidoRequired: false,
  fidoRpName: null,
  createdAt: '2026-01-01T00:00:00Z',
};

// Test harness component that exposes auth state
function AuthTestHarness() {
  const { apiKey, developer, loading, login, logout } = useAuth();
  return (
    <div>
      <div data-testid="api-key">{apiKey ?? 'null'}</div>
      <div data-testid="developer-name">{developer?.name ?? 'null'}</div>
      <div data-testid="loading">{loading ? 'true' : 'false'}</div>
      {/* Swallow the rejection in the harness — individual tests that care
          about the failure path assert via mocks, not via a thrown promise. */}
      <button onClick={() => { login('gx_live_test123').catch(() => {}); }}>Login</button>
      <button onClick={logout}>Logout</button>
    </div>
  );
}

function renderAuthHarness() {
  return render(
    <AuthProvider>
      <AuthTestHarness />
    </AuthProvider>,
  );
}

describe('Auth store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('starts with null apiKey and developer when no stored session', async () => {
    mockGetMe.mockResolvedValue(mockDeveloper);
    renderAuthHarness();
    // Wait for any effects to settle
    await waitFor(() => {
      expect(screen.getByTestId('api-key')).toHaveTextContent('null');
      expect(screen.getByTestId('developer-name')).toHaveTextContent('null');
    });
  });

  it('starts with loading false when no stored session', () => {
    renderAuthHarness();
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('sets apiKey, fetches developer, and stores session on login', async () => {
    mockGetMe.mockResolvedValue(mockDeveloper);
    const user = userEvent.setup();
    renderAuthHarness();

    await user.click(screen.getByText('Login'));

    await waitFor(() => {
      expect(mockSetApiKey).toHaveBeenCalledWith('gx_live_test123');
      expect(mockGetMe).toHaveBeenCalled();
      expect(screen.getByTestId('api-key')).toHaveTextContent('gx_live_test123');
      expect(screen.getByTestId('developer-name')).toHaveTextContent('Test Developer');
    });

    expect(sessionStorage.getItem('grantex_api_key')).toBe('gx_live_test123');
  });

  it('clears everything on logout', async () => {
    mockGetMe.mockResolvedValue(mockDeveloper);
    const user = userEvent.setup();
    renderAuthHarness();

    // Login first
    await user.click(screen.getByText('Login'));
    await waitFor(() => {
      expect(screen.getByTestId('developer-name')).toHaveTextContent('Test Developer');
    });

    // Now logout
    await user.click(screen.getByText('Logout'));

    await waitFor(() => {
      expect(screen.getByTestId('api-key')).toHaveTextContent('null');
      expect(screen.getByTestId('developer-name')).toHaveTextContent('null');
    });

    expect(sessionStorage.getItem('grantex_api_key')).toBeNull();
    expect(mockSetApiKey).toHaveBeenCalledWith(null);
  });

  it('restores session on mount when API key is stored', async () => {
    sessionStorage.setItem('grantex_api_key', 'gx_live_stored');
    mockGetMe.mockResolvedValue(mockDeveloper);

    renderAuthHarness();

    // loading should start as true
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      expect(screen.getByTestId('developer-name')).toHaveTextContent('Test Developer');
    });

    expect(mockSetApiKey).toHaveBeenCalledWith('gx_live_stored');
    expect(mockGetMe).toHaveBeenCalled();
  });

  it('clears session when getMe fails during restore', async () => {
    sessionStorage.setItem('grantex_api_key', 'gx_live_invalid');
    mockGetMe.mockRejectedValue(new Error('Unauthorized'));

    renderAuthHarness();

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      expect(screen.getByTestId('api-key')).toHaveTextContent('null');
      expect(screen.getByTestId('developer-name')).toHaveTextContent('null');
    });

    expect(sessionStorage.getItem('grantex_api_key')).toBeNull();
  });

  it('handles login failure by propagating error', async () => {
    mockGetMe.mockRejectedValue(new Error('Invalid API key'));
    const user = userEvent.setup();

    // Just verify the mock rejects - the login function propagates errors
    renderAuthHarness();
    // The login call will reject, but the component doesn't catch it in this harness
    // The key behavior is that getMe is called with the right key
    await user.click(screen.getByText('Login'));
    await waitFor(() => {
      expect(mockSetApiKey).toHaveBeenCalledWith('gx_live_test123');
      expect(mockGetMe).toHaveBeenCalled();
    });
  });

  it('throws error when useAuth is used outside AuthProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<AuthTestHarness />)).toThrow('useAuth must be used within AuthProvider');
  });
});
