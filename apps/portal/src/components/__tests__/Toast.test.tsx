import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastContainer } from '../ui/Toast';
import { ToastProvider, useToast } from '../../store/toast';

function ToastTrigger({ message, type }: { message: string; type?: 'success' | 'error' | 'info' }) {
  const { show } = useToast();
  return <button onClick={() => show(message, type)}>Show Toast</button>;
}

function renderWithToast(type?: 'success' | 'error' | 'info') {
  return render(
    <ToastProvider>
      <ToastTrigger message="Test message" type={type} />
      <ToastContainer />
    </ToastProvider>,
  );
}

describe('ToastContainer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing when there are no toasts', () => {
    renderWithToast();
    expect(screen.queryByText('Test message')).not.toBeInTheDocument();
  });

  it('renders a toast when triggered', () => {
    renderWithToast();
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('auto-dismisses toast after 4 seconds', () => {
    renderWithToast();
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    expect(screen.getByText('Test message')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(screen.queryByText('Test message')).not.toBeInTheDocument();
  });

  it('renders success toast with correct styling', () => {
    renderWithToast('success');
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    const el = screen.getByText('Test message').closest('[class*="border-gx"]');
    expect(el?.className).toContain('border-gx-accent/50');
  });

  it('renders error toast with correct styling', () => {
    renderWithToast('error');
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    const el = screen.getByText('Test message').closest('[class*="border-gx"]');
    expect(el?.className).toContain('border-gx-danger/50');
  });

  it('renders info toast with correct styling', () => {
    renderWithToast('info');
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    const el = screen.getByText('Test message').closest('[class*="border-gx"]');
    expect(el?.className).toContain('border-gx-accent2/50');
  });

  it('dismisses toast when close button is clicked', () => {
    renderWithToast();
    act(() => { fireEvent.click(screen.getByText('Show Toast')); });
    expect(screen.getByText('Test message')).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByText('×')); });
    expect(screen.queryByText('Test message')).not.toBeInTheDocument();
  });

  it('can show multiple toasts', () => {
    function MultiTrigger() {
      const { show } = useToast();
      return (
        <>
          <button onClick={() => show('First')}>Add First</button>
          <button onClick={() => show('Second')}>Add Second</button>
        </>
      );
    }
    render(
      <ToastProvider>
        <MultiTrigger />
        <ToastContainer />
      </ToastProvider>,
    );
    act(() => { fireEvent.click(screen.getByText('Add First')); });
    act(() => { fireEvent.click(screen.getByText('Add Second')); });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});
