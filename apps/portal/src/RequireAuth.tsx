import { Navigate } from 'react-router-dom';
import { useAuth } from './store/auth';
import { Spinner } from './components/ui/Spinner';
import { type ReactNode } from 'react';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { apiKey, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gx-bg flex items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!apiKey) {
    return <Navigate to="/dashboard/login" replace />;
  }

  return <>{children}</>;
}
