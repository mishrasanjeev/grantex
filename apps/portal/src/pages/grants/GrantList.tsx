import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { listGrants, revokeGrant } from '../../api/grants';
import type { Grant } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { formatDate, truncateId } from '../../lib/format';

const statusOptions = ['all', 'active', 'revoked', 'expired'] as const;

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-gx-border bg-gx-surface p-3 min-w-[100px]">
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-xs text-gx-muted mt-0.5">{label}</span>
    </div>
  );
}

export function GrantList() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [principalFilter, setPrincipalFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);
  const [bulkRevokeOpen, setBulkRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listGrants()
      .then(setGrants)
      .catch(() => show('Failed to load grants', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  // Analytics computed from all grants
  const stats = useMemo(() => {
    const total = grants.length;
    const active = grants.filter((g) => g.status === 'active').length;
    const revoked = grants.filter((g) => g.status === 'revoked').length;
    const expired = grants.filter((g) => g.status === 'expired').length;
    return { total, active, revoked, expired };
  }, [grants]);

  // Top 5 scopes across all grants
  const topScopes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of grants) {
      for (const scope of g.scopes) {
        counts.set(scope, (counts.get(scope) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [grants]);

  // Unique agent IDs for filter dropdown
  const agentIds = useMemo(() => {
    const ids = new Set(grants.map((g) => g.agentId));
    return [...ids].sort();
  }, [grants]);

  const filtered = useMemo(() => {
    let result = grants;
    if (statusFilter !== 'all') {
      result = result.filter((g) => g.status === statusFilter);
    }
    if (principalFilter) {
      const lower = principalFilter.toLowerCase();
      result = result.filter((g) => g.principalId.toLowerCase().includes(lower));
    }
    if (agentFilter) {
      result = result.filter((g) => g.agentId === agentFilter);
    }
    return result;
  }, [grants, statusFilter, principalFilter, agentFilter]);

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter, principalFilter, agentFilter]);

  const toggleSelect = useCallback((grantId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(grantId)) {
        next.delete(grantId);
      } else {
        next.add(grantId);
      }
      return next;
    });
  }, []);

  const selectableGrants = useMemo(
    () => filtered.filter((g) => g.status === 'active'),
    [filtered],
  );

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === selectableGrants.length && selectableGrants.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableGrants.map((g) => g.grantId)));
    }
  }, [selectableGrants, selectedIds.size]);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeGrant(revokeTarget.grantId);
      setGrants((prev) =>
        prev.map((g) =>
          g.grantId === revokeTarget.grantId ? { ...g, status: 'revoked' as const } : g,
        ),
      );
      show('Grant revoked', 'success');
    } catch {
      show('Failed to revoke grant', 'error');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  }

  async function handleBulkRevoke() {
    setRevoking(true);
    const ids = [...selectedIds];
    let succeeded = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        await revokeGrant(id);
        succeeded++;
      } catch {
        failed++;
      }
    }

    setGrants((prev) =>
      prev.map((g) =>
        selectedIds.has(g.grantId) && g.status === 'active'
          ? { ...g, status: 'revoked' as const }
          : g,
      ),
    );
    setSelectedIds(new Set());
    setRevoking(false);
    setBulkRevokeOpen(false);

    if (failed === 0) {
      show(`${succeeded} grant${succeeded === 1 ? '' : 's'} revoked`, 'success');
    } else {
      show(`${succeeded} revoked, ${failed} failed`, 'error');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      {/* Analytics Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total" value={stats.total} color="text-gx-text" />
        <StatCard label="Active" value={stats.active} color="text-green-500" />
        <StatCard label="Revoked" value={stats.revoked} color="text-red-500" />
        <StatCard label="Expired" value={stats.expired} color="text-gx-muted" />
      </div>

      {/* Scope Frequency */}
      {topScopes.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gx-muted mb-2">Top Scopes</h2>
          <div className="flex flex-wrap gap-2">
            {topScopes.map(([scope, count]) => (
              <span
                key={scope}
                className="inline-flex items-center gap-1.5 rounded-full bg-gx-accent/10 px-2.5 py-0.5 text-xs font-medium text-gx-accent"
              >
                {scope}
                <span className="rounded-full bg-gx-accent/20 px-1.5 text-[10px]">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Header + Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h1 className="text-xl font-semibold text-gx-text">Grants</h1>
        <div className="flex items-center gap-1">
          {statusOptions.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-gx-accent/15 text-gx-accent'
                  : 'text-gx-muted hover:text-gx-text hover:bg-gx-bg'
              }`}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Principal + Agent Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Filter by principal ID..."
          value={principalFilter}
          onChange={(e) => setPrincipalFilter(e.target.value)}
          className="rounded-md border border-gx-border bg-gx-surface px-3 py-1.5 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:ring-1 focus:ring-gx-accent sm:w-64"
        />
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-gx-border bg-gx-surface px-3 py-1.5 text-sm text-gx-text focus:outline-none focus:ring-1 focus:ring-gx-accent sm:w-64"
        >
          <option value="">All agents</option>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {truncateId(id)}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk Revoke Bar */}
      {selectableGrants.length > 0 && (
        <div className="flex items-center gap-3 mb-4 rounded-md border border-gx-border bg-gx-surface px-4 py-2">
          <button
            onClick={toggleSelectAll}
            className="text-xs font-medium text-gx-accent hover:underline"
          >
            {selectedIds.size === selectableGrants.length ? 'Deselect all' : 'Select all active'}
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className="text-sm text-gx-text">
                {selectedIds.size} grant{selectedIds.size === 1 ? '' : 's'} selected
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setBulkRevokeOpen(true)}
              >
                Revoke Selected
              </Button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-gx-muted hover:text-gx-text"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      <Card className="p-0">
        {filtered.length === 0 ? (
          <EmptyState
            title="No grants found"
            description={statusFilter === 'all' ? 'No grants have been issued yet.' : `No ${statusFilter} grants.`}
          />
        ) : (
          <div className="p-4">
            <Table
              data={filtered}
              rowKey={(g) => g.grantId}
              onRowClick={(g) => navigate(`/dashboard/grants/${g.grantId}`)}
              columns={[
                {
                  key: 'select',
                  header: '',
                  className: 'w-8',
                  render: (g) =>
                    g.status === 'active' ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(g.grantId)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelect(g.grantId);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 rounded border-gx-border"
                      />
                    ) : null,
                },
                {
                  key: 'id',
                  header: 'Grant ID',
                  render: (g) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(g.grantId)}
                    </span>
                  ),
                },
                {
                  key: 'agent',
                  header: 'Agent',
                  render: (g) => (
                    <span className="font-mono text-xs text-gx-muted">
                      {truncateId(g.agentId)}
                    </span>
                  ),
                },
                {
                  key: 'principal',
                  header: 'Principal',
                  render: (g) => (
                    <span className="text-gx-muted text-xs">{g.principalId}</span>
                  ),
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  render: (g) => <ScopePills scopes={g.scopes} />,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (g) => (
                    <Badge
                      variant={
                        g.status === 'active' ? 'success' : g.status === 'revoked' ? 'danger' : 'default'
                      }
                    >
                      {g.status}
                    </Badge>
                  ),
                },
                {
                  key: 'issued',
                  header: 'Issued',
                  render: (g) => (
                    <span className="text-gx-muted text-xs">{formatDate(g.issuedAt)}</span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (g) =>
                    g.status === 'active' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRevokeTarget(g);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null,
                },
              ]}
            />
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke Grant"
        message="Are you sure you want to revoke this grant? All sub-delegated grants will also be revoked. This cannot be undone."
        confirmLabel="Revoke"
        loading={revoking}
      />

      <ConfirmDialog
        open={bulkRevokeOpen}
        onClose={() => setBulkRevokeOpen(false)}
        onConfirm={handleBulkRevoke}
        title="Revoke Selected Grants"
        message={`Are you sure you want to revoke ${selectedIds.size} grant${selectedIds.size === 1 ? '' : 's'}? All sub-delegated grants will also be revoked. This cannot be undone.`}
        confirmLabel={`Revoke ${selectedIds.size}`}
        loading={revoking}
      />
    </div>
  );
}
