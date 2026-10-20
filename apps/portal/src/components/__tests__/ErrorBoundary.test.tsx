import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../ErrorBoundary';

// Component that throws an error
function ThrowError({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>Content renders fine</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // Suppress console.error from React's error boundary logging
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Content renders fine')).toBeInTheDocument();
  });

  it('renders error UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('displays the error message', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Test error message')).toBeInTheDocument();
  });

  it('renders a Try Again button', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('renders a Go to Dashboard button', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Go to Dashboard' })).toBeInTheDocument();
  });

  describe('Go to Dashboard', () => {
    // Swap window.location for a recorder so a click can be observed without jsdom
    // attempting a real navigation. Returns the recorded hrefs and a restore hook.
    function recordLocationAssignments(): { assigned: string[]; restore: () => void } {
      const realLocation = Object.getOwnPropertyDescriptor(window, 'location');
      const assigned: string[] = [];
      const recorder = {
        get href(): string {
          return assigned[assigned.length - 1] ?? 'http://localhost/dashboard/agents';
        },
        set href(next: string) {
          assigned.push(next);
        },
      };
      Object.defineProperty(window, 'location', { configurable: true, value: recorder });
      return {
        assigned,
        restore: () => {
          if (realLocation) Object.defineProperty(window, 'location', realLocation);
        },
      };
    }

    function renderFailure() {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>,
      );
    }

    it('loads the portal root at the Vite base path, slash included', async () => {
      const nav = recordLocationAssignments();
      try {
        renderFailure();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Go to Dashboard' }));
        // '/dashboard' without the slash is not served by the SPA build.
        expect(nav.assigned).toEqual(['/dashboard/']);
      } finally {
        nav.restore();
      }
    });

    it('does not navigate when Try Again is chosen instead', async () => {
      const nav = recordLocationAssignments();
      try {
        renderFailure();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try Again' }));
        expect(nav.assigned).toEqual([]);
      } finally {
        nav.restore();
      }
    });
  });

  it('resets error state when Try Again is clicked', async () => {
    const user = userEvent.setup();

    // We need a stateful wrapper to control the throw
    let shouldThrow = true;
    function Wrapper() {
      if (shouldThrow) throw new Error('Boom');
      return <div>Recovered</div>;
    }

    const { rerender: _rerender } = render(
      <ErrorBoundary>
        <Wrapper />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Stop throwing and click Try Again
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try Again' }));

    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });

  it('shows fallback message when error has no message', () => {
    function ThrowEmpty(): never {
      throw new Error();
    }
    render(
      <ErrorBoundary>
        <ThrowEmpty />
      </ErrorBoundary>,
    );
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  });

  it('logs the error and component stack to console.error', () => {
    const consoleSpy = vi.spyOn(console, 'error');
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );
    // React and our ErrorBoundary both log errors
    expect(consoleSpy).toHaveBeenCalled();
  });
});
