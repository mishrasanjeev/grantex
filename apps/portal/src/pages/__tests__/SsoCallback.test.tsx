import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SsoCallback } from '../SsoCallback';

const mockLogin = vi.fn();
const mockNavigate = vi.fn();
vi.mock('../../store/auth', () => ({ useAuth: () => ({ login: mockLogin }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('SSO browser callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/dashboard/sso/callback');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a callback not bound to a login from this browser', async () => {
    window.history.replaceState({}, '', '/dashboard/sso/callback?code=test&state=unbound');
    render(<MemoryRouter><SsoCallback /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('exchanges a bound code and uses only an admin-scoped session for dashboard login', async () => {
    window.history.replaceState({}, '', '/dashboard/sso/callback?code=test&state=bound');
    sessionStorage.setItem('grantex_sso_login_state', 'bound');
    mockLogin.mockResolvedValueOnce(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ sessionToken: `gx_sso_${'a'.repeat(43)}` }),
    }));
    render(<MemoryRouter><SsoCallback /></MemoryRouter>);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true }));
    expect(mockLogin).toHaveBeenCalledWith(`gx_sso_${'a'.repeat(43)}`);
    expect(sessionStorage.getItem('grantex_sso_login_state')).toBeNull();
    expect(window.location.search).toBe('');
  });
});
