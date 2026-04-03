import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from '../ui/CopyButton';

describe('CopyButton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders with Copy text initially', () => {
    render(<CopyButton text="some-value" />);
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('shows Copied! feedback when clicked', async () => {
    const user = userEvent.setup();
    render(<CopyButton text="gx_live_abc" />);
    await user.click(screen.getByText('Copy'));
    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
  });

  it('changes styling to accent when copied', async () => {
    const user = userEvent.setup();
    render(<CopyButton text="val" />);
    await user.click(screen.getByText('Copy'));
    await waitFor(() => {
      const el = screen.getByText('Copied!');
      expect(el).toHaveClass('border-gx-accent');
      expect(el).toHaveClass('text-gx-accent');
    });
  });

  it('reverts back to Copy after 2 seconds', async () => {
    vi.useFakeTimers();
    render(<CopyButton text="token" />);
    // Use fireEvent to avoid userEvent + fake timers conflict
    fireEvent.click(screen.getByText('Copy'));
    // Flush microtasks from clipboard promise
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Copied!')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<CopyButton text="val" className="ml-2" />);
    const btn = screen.getByText('Copy');
    expect(btn).toHaveClass('ml-2');
  });

  it('has muted styling before copying', () => {
    render(<CopyButton text="val" />);
    const el = screen.getByText('Copy');
    expect(el).toHaveClass('border-gx-border');
    expect(el).toHaveClass('text-gx-muted');
  });

  it('uses monospace font', () => {
    render(<CopyButton text="val" />);
    expect(screen.getByText('Copy')).toHaveClass('font-mono');
  });

  it('renders as a button element', () => {
    render(<CopyButton text="val" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('uses extra-small text size', () => {
    render(<CopyButton text="val" />);
    expect(screen.getByText('Copy')).toHaveClass('text-xs');
  });
});
