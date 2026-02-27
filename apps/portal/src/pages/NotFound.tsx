import { useNavigate } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-center py-20">
      <Card className="max-w-md w-full text-center">
        <p className="text-5xl font-bold font-mono text-gx-muted mb-2">404</p>
        <h1 className="text-lg font-semibold text-gx-text mb-2">Page not found</h1>
        <p className="text-sm text-gx-muted mb-6">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Button size="sm" onClick={() => navigate('/dashboard')}>
          Back to Dashboard
        </Button>
      </Card>
    </div>
  );
}
