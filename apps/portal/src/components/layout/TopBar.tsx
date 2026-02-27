import { useAuth } from '../../store/auth';
import { Badge } from '../ui/Badge';

export function TopBar() {
  const { developer, logout } = useAuth();

  return (
    <header className="h-14 border-b border-gx-border bg-gx-surface/80 backdrop-blur-sm flex items-center justify-between px-6">
      <div />
      <div className="flex items-center gap-4">
        {developer && (
          <>
            <Badge variant={developer.mode === 'live' ? 'success' : 'warning'}>
              {developer.mode}
            </Badge>
            <span className="text-sm text-gx-muted">{developer.name}</span>
          </>
        )}
        <button
          onClick={logout}
          className="text-sm text-gx-muted hover:text-gx-text transition-colors"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
