import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '../layout/Shell';
import { ToastProvider } from '../../store/toast';

// Mock the auth store for TopBar
vi.mock('../../store/auth', () => ({
  useAuth: () => ({
    developer: { name: 'TestDev', mode: 'live' as const, developerId: 'dev-1', email: null, plan: 'pro', fidoRequired: false, fidoRpName: null, createdAt: '' },
    logout: vi.fn(),
  }),
}));

function renderShell(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/dashboard" element={<div>Dashboard Content</div>} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Shell', () => {
  it('renders the sidebar with navigation links', () => {
    renderShell();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Grants')).toBeInTheDocument();
  });

  it('renders the top bar', () => {
    renderShell();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  });

  it('renders the outlet content', () => {
    renderShell();
    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
  });

  it('renders the grantex logo in sidebar', () => {
    renderShell();
    expect(screen.getByText('grant')).toBeInTheDocument();
  });

  it('renders the developer name in top bar', () => {
    renderShell();
    expect(screen.getByText('TestDev')).toBeInTheDocument();
  });

  it('renders the mode badge', () => {
    renderShell();
    expect(screen.getByText('live')).toBeInTheDocument();
  });
});
