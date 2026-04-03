import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from '../toast';

// Helper component that exposes the toast API for testing
function ToastTestHarness() {
  const { toasts, show, dismiss } = useToast();
  return (
    <div>
      <button onClick={() => show('Info toast')}>Show Info</button>
      <button onClick={() => show('Success!', 'success')}>Show Success</button>
      <button onClick={() => show('Error!', 'error')}>Show Error</button>
      <div data-testid="toast-count">{toasts.length}</div>
      {toasts.map((t) => (
        <div key={t.id} data-testid={`toast-${t.id}`}>
          <span data-testid={`toast-msg-${t.id}`}>{t.message}</span>
          <span data-testid={`toast-type-${t.id}`}>{t.type}</span>
          <button onClick={() => dismiss(t.id)}>Dismiss {t.id}</button>
        </div>
      ))}
    </div>
  );
}

function renderToastHarness() {
  return render(
    <ToastProvider>
      <ToastTestHarness />
    </ToastProvider>,
  );
}

describe('Toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no toasts', () => {
    renderToastHarness();
    expect(screen.getByTestId('toast-count')).toHaveTextContent('0');
  });

  it('adds a toast when show is called', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    expect(screen.getByTestId('toast-count')).toHaveTextContent('1');
  });

  it('toast defaults to info type', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    const toasts = screen.getAllByTestId(/^toast-type-/);
    expect(toasts[0]).toHaveTextContent('info');
  });

  it('supports success type', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Success'));
    const toasts = screen.getAllByTestId(/^toast-type-/);
    expect(toasts[0]).toHaveTextContent('success');
  });

  it('supports error type', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Error'));
    const toasts = screen.getAllByTestId(/^toast-type-/);
    expect(toasts[0]).toHaveTextContent('error');
  });

  it('dismisses a toast when dismiss is called', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    expect(screen.getByTestId('toast-count')).toHaveTextContent('1');

    const dismissBtns = screen.getAllByText(/^Dismiss /);
    fireEvent.click(dismissBtns[0]!);

    expect(screen.getByTestId('toast-count')).toHaveTextContent('0');
  });

  it('auto-dismisses toast after 4 seconds', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    expect(screen.getByTestId('toast-count')).toHaveTextContent('1');

    act(() => {
      vi.advanceTimersByTime(4100);
    });

    expect(screen.getByTestId('toast-count')).toHaveTextContent('0');
  });

  it('can show multiple toasts simultaneously', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    fireEvent.click(screen.getByText('Show Success'));
    fireEvent.click(screen.getByText('Show Error'));
    expect(screen.getByTestId('toast-count')).toHaveTextContent('3');
  });

  it('preserves other toasts when one is dismissed', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByTestId('toast-count')).toHaveTextContent('2');

    const dismissBtns = screen.getAllByText(/^Dismiss /);
    fireEvent.click(dismissBtns[0]!);

    expect(screen.getByTestId('toast-count')).toHaveTextContent('1');
  });

  it('stores correct message in toast', () => {
    renderToastHarness();
    fireEvent.click(screen.getByText('Show Info'));
    const msgs = screen.getAllByTestId(/^toast-msg-/);
    expect(msgs[0]).toHaveTextContent('Info toast');
  });

  it('throws error when useToast is used outside ToastProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ToastTestHarness />)).toThrow('useToast must be used within ToastProvider');
  });
});
