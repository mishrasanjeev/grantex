import { useAuth } from '../../store/auth';
import { Badge } from '../ui/Badge';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const { developer, logout } = useAuth();

  return (
    <header className="h-14 border-b border-gx-border bg-gx-surface/80 backdrop-blur-sm flex items-center justify-between px-6">
      <button
        onClick={onMenuClick}
        className="lg:hidden text-gx-muted hover:text-gx-text transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div className="hidden lg:block" />
      <div className="flex items-center gap-4">
        {developer && (
          <>
            <Badge variant={developer.mode === 'live' ? 'success' : 'warning'}>
              {developer.mode}
            </Badge>
            <span className="text-sm text-gx-muted hidden sm:inline">{developer.name}</span>
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
