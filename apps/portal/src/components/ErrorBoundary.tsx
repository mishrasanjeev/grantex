import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Card } from './ui/Card';
import { Button } from './ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// The portal is built with Vite `base: '/dashboard/'` (see vite.config.ts), so
// the app shell answers only on that exact path, trailing slash included.
const PORTAL_ROOT_PATH = '/dashboard/';

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  private readonly leaveToPortalRoot = (): void => {
    // A full page load, not client-side routing: the subtree that failed is discarded.
    window.location.href = PORTAL_ROOT_PATH;
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gx-bg flex items-center justify-center p-6">
          <Card className="max-w-lg w-full text-center">
            <div className="text-4xl mb-4">!</div>
            <h1 className="text-lg font-semibold text-gx-text mb-2">Something went wrong</h1>
            <p className="text-sm text-gx-muted mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <div className="flex justify-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => this.setState({ hasError: false, error: null })}
              >
                Try Again
              </Button>
              <Button
                size="sm"
                onClick={this.leaveToPortalRoot}
              >
                Go to Dashboard
              </Button>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
