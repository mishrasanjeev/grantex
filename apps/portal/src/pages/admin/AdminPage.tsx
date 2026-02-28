import { useState, useEffect, useCallback } from 'react';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { Table } from '../../components/ui/Table';
import {
  fetchStats,
  fetchDevelopers,
  getAdminKey,
  setAdminKey,
  clearAdminKey,
  type AdminStats,
  type Developer,
} from '../../api/admin';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminPage() {
  const [authenticated, setAuthenticated] = useState(!!getAdminKey());
  const [keyInput, setKeyInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const pageSize = 50;

  const loadData = useCallback(async (p: number) => {
    setLoading(true);
    setError('');
    try {
      const [s, d] = await Promise.all([fetchStats(), fetchDevelopers(p, pageSize)]);
      setStats(s);
      setDevelopers(d.developers);
      setTotal(d.total);
      setPage(d.page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load data';
      if (msg === 'Unauthorized') {
        clearAdminKey();
        setAuthenticated(false);
        setAuthError('Invalid API key');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) {
      void loadData(1);
    }
  }, [authenticated, loadData]);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    if (!keyInput.trim()) {
      setAuthError('Please enter an API key');
      return;
    }
    setAdminKey(keyInput.trim());
    setKeyInput('');
    setAuthenticated(true);
  }

  function handleLogout() {
    clearAdminKey();
    setAuthenticated(false);
    setStats(null);
    setDevelopers([]);
  }

  const totalPages = Math.ceil(total / pageSize);

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center py-20">
        <Card className="w-full max-w-sm">
          <h1 className="text-lg font-semibold text-gx-text mb-1">Admin Access</h1>
          <p className="text-sm text-gx-muted mb-4">Enter the admin API key to continue.</p>
          {authError && (
            <p className="text-sm text-gx-danger mb-3">{authError}</p>
          )}
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="ADMIN_API_KEY"
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none focus:border-gx-accent transition-colors mb-3"
            />
            <Button type="submit" className="w-full">
              Authenticate
            </Button>
          </form>
        </Card>
      </div>
    );
  }

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Admin Dashboard</h1>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          Sign out
        </Button>
      </div>

      {error && (
        <Card className="mb-4 border-gx-danger/50">
          <p className="text-sm text-gx-danger">{error}</p>
        </Card>
      )}

      {/* Stat cards */}
      {stats && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Card>
              <p className="text-xs text-gx-muted mb-1">Total Developers</p>
              <p className="text-2xl font-bold font-mono text-gx-text">{stats.totalDevelopers}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Last 24 Hours</p>
              <p className="text-2xl font-bold font-mono text-gx-accent">{stats.last24h}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Last 7 Days</p>
              <p className="text-2xl font-bold font-mono text-gx-accent2">{stats.last7d}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Last 30 Days</p>
              <p className="text-2xl font-bold font-mono text-gx-text">{stats.last30d}</p>
            </Card>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <Card>
              <p className="text-xs text-gx-muted mb-1">Live Mode</p>
              <p className="text-lg font-bold font-mono text-gx-accent">{stats.byMode['live'] ?? 0}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Sandbox Mode</p>
              <p className="text-lg font-bold font-mono text-gx-warning">{stats.byMode['sandbox'] ?? 0}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Total Agents</p>
              <p className="text-lg font-bold font-mono text-gx-accent2">{stats.totalAgents}</p>
            </Card>
            <Card>
              <p className="text-xs text-gx-muted mb-1">Total Grants</p>
              <p className="text-lg font-bold font-mono text-gx-text">{stats.totalGrants}</p>
            </Card>
          </div>
        </>
      )}

      {/* Developers table */}
      <Card className="p-0">
        <div className="p-4 border-b border-gx-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gx-text">
            Developers {total > 0 && <span className="text-gx-muted font-normal">({total})</span>}
          </h2>
          {loading && <Spinner className="h-4 w-4" />}
        </div>
        <div className="p-4">
          {developers.length === 0 ? (
            <p className="text-sm text-gx-muted py-4 text-center">No developers found</p>
          ) : (
            <>
              <Table
                data={developers}
                rowKey={(d) => d.id}
                columns={[
                  {
                    key: 'name',
                    header: 'Name',
                    render: (d) => <span className="text-gx-text font-medium">{d.name}</span>,
                  },
                  {
                    key: 'email',
                    header: 'Email',
                    render: (d) => (
                      <span className="text-gx-muted text-xs">{d.email ?? '—'}</span>
                    ),
                  },
                  {
                    key: 'mode',
                    header: 'Mode',
                    render: (d) => (
                      <Badge variant={d.mode === 'live' ? 'success' : 'warning'}>
                        {d.mode}
                      </Badge>
                    ),
                  },
                  {
                    key: 'createdAt',
                    header: 'Signed Up',
                    render: (d) => (
                      <span className="text-gx-muted text-xs">{formatDate(d.createdAt)}</span>
                    ),
                  },
                ]}
              />
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t border-gx-border">
                  <p className="text-xs text-gx-muted">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => void loadData(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => void loadData(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
