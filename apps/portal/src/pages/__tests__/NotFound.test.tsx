import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotFound } from '../NotFound';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('NotFound', () => {
  it('renders 404 message', () => {
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });

  it('has Back to Dashboard button', () => {
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Back to Dashboard' })).toBeInTheDocument();
  });

  it('navigates to dashboard on click', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Back to Dashboard' }));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });
});
