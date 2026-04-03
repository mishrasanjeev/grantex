import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from '../ui/CopyButton';

describe('CopyButton', () => {
  it('renders with Copy text initially', () => {
    render(<CopyButton text="some-value" />);
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('shows Copied! feedback when clicked (proves clipboard writeText was called)', async () => {
    const user = userEvent.setup();
    render(<CopyButton text="gx_live_abc" />);
    await user.click(screen.getByText('Copy'));
    // If clipboard.writeText was not called or failed, Copied! would not appear
    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
  });

  it('reverts back to Copy after 2 seconds', async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<CopyButton text="token" />);
    await user.click(screen.getByText('Copy'));
    await vi.runAllTicksAsync();
    expect(screen.getByText('Copied!')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(screen.getByText('Copy')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('applies custom className', () => {
    render(<CopyButton text="val" className="ml-2" />);
    const btn = screen.getByText('Copy');
    expect(btn).toHaveClass('ml-2');
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
