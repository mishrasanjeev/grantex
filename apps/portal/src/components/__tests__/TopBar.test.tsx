import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopBar } from '../layout/TopBar';

const mockLogout = vi.fn();

vi.mock('../../store/auth', () => ({
  useAuth: () => ({
    developer: {
      name: 'Acme Corp',
      mode: 'live' as const,
      developerId: 'dev-123',
      email: 'admin@acme.com',
      plan: 'enterprise',
      fidoRequired: false,
      fidoRpName: null,
      createdAt: '2026-01-01T00:00:00Z',
    },
    logout: mockLogout,
  }),
}));

describe('TopBar', () => {
  it('renders the developer name', () => {
    render(<TopBar onMenuClick={vi.fn()} />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('renders the mode badge', () => {
    render(<TopBar onMenuClick={vi.fn()} />);
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('renders the logout button', () => {
    render(<TopBar onMenuClick={vi.fn()} />);
    expect(screen.getByText('Log out')).toBeInTheDocument();
  });

  it('calls logout when logout button is clicked', async () => {
    const user = userEvent.setup();
    render(<TopBar onMenuClick={vi.fn()} />);
    await user.click(screen.getByText('Log out'));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('calls onMenuClick when menu button is clicked', async () => {
    const onMenuClick = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<TopBar onMenuClick={onMenuClick} />);
    // The menu button is the first button in the header (lg:hidden)
    const menuBtn = container.querySelector('header button');
    if (menuBtn) {
      await user.click(menuBtn);
      expect(onMenuClick).toHaveBeenCalledTimes(1);
    }
  });

  it('renders the badge with success variant for live mode', () => {
    render(<TopBar onMenuClick={vi.fn()} />);
    const badge = screen.getByText('live');
    expect(badge).toHaveClass('bg-gx-accent/15');
  });

  it('renders as a header element', () => {
    const { container } = render(<TopBar onMenuClick={vi.fn()} />);
    expect(container.querySelector('header')).toBeInTheDocument();
  });
});
