import { useState, useEffect, useMemo } from 'react';
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

export function GrantList() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);
  const [revoking, setRevoking] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listGrants()
      .then(setGrants)
      .catch(() => show('Failed to load grants', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return grants;
    return grants.filter((g) => g.status === statusFilter);
  }, [grants, statusFilter]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
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
    </div>
  );
}
