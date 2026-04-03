import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { listBundles, revokeBundle } from '../../api/bundles';
import { listAgents } from '../../api/agents';
import type { ConsentBundle } from '../../api/bundles';
import type { Agent } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CopyButton } from '../../components/ui/CopyButton';
import { Select } from '../../components/ui/Select';
import { formatDate, truncateId, timeAgo } from '../../lib/format';

const statusVariant: Record<string, 'success' | 'danger' | 'warning'> = {
  active: 'success',
  revoked: 'danger',
  expired: 'warning',
};

export function BundleList() {
  const [bundles, setBundles] = useState<ConsentBundle[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<ConsentBundle | null>(null);
  const [revoking, setRevoking] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  const fetchBundles = useCallback(() => {
    setLoading(true);
    const params: { status?: string; agentId?: string } = {};
    if (statusFilter) params.status = statusFilter;
    if (agentFilter) params.agentId = agentFilter;
    listBundles(params)
      .then(setBundles)
      .catch(() => show('Failed to load bundles', 'error'))
      .finally(() => setLoading(false));
  }, [statusFilter, agentFilter, show]);

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchBundles();
  }, [fetchBundles]);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeBundle(revokeTarget.id);
      setBundles((prev) =>
        prev.map((b) =>
          b.id === revokeTarget.id ? { ...b, status: 'revoked' as const } : b,
        ),
      );
      show('Bundle revoked', 'success');
    } catch {
      show('Failed to revoke bundle', 'error');
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
        <h1 className="text-xl font-semibold text-gx-text">Offline Consent Bundles</h1>
        <Link to="/dashboard/bundles/new">
          <Button size="sm">+ New Bundle</Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex items-end gap-4 mb-4">
        <Select
          id="status-filter"
          label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={[
            { value: '', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'revoked', label: 'Revoked' },
            { value: 'expired', label: 'Expired' },
          ]}
        />
        <Select
          id="agent-filter"
          label="Agent"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          options={[
            { value: '', label: 'All Agents' },
            ...agents.map((a) => ({ value: a.agentId, label: a.name })),
          ]}
        />
      </div>

      <Card className="p-0">
        {bundles.length === 0 ? (
          <EmptyState
            title="No bundles found"
            description="Issue an offline consent bundle to enable disconnected agent authorization."
            action={
              <Link to="/dashboard/bundles/new">
                <Button size="sm">+ New Bundle</Button>
              </Link>
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={bundles}
              rowKey={(b) => b.id}
              onRowClick={(b) => navigate(`/dashboard/bundles/${b.id}`)}
              columns={[
                {
                  key: 'id',
                  header: 'Bundle ID',
                  render: (b) => (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gx-accent2">
                        {truncateId(b.id)}
                      </span>
                      <span onClick={(e) => e.stopPropagation()}>
                        <CopyButton text={b.id} />
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'agent',
                  header: 'Agent',
                  render: (b) => (
                    <span className="font-mono text-xs text-gx-text">
                      {truncateId(b.agentId)}
                    </span>
                  ),
                },
                {
                  key: 'user',
                  header: 'User',
                  render: (b) => (
                    <span className="text-xs text-gx-muted">{b.userId}</span>
                  ),
                },
                {
                  key: 'platform',
                  header: 'Platform',
                  render: (b) =>
                    b.devicePlatform ? (
                      <Badge>{b.devicePlatform}</Badge>
                    ) : (
                      <span className="text-xs text-gx-muted">--</span>
                    ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (b) => (
                    <Badge variant={statusVariant[b.status] ?? 'default'}>
                      {b.status}
                    </Badge>
                  ),
                },
                {
                  key: 'offlineUntil',
                  header: 'Offline Until',
                  render: (b) => (
                    <span className="text-xs text-gx-muted">
                      {formatDate(b.offlineExpiresAt)}
                    </span>
                  ),
                },
                {
                  key: 'lastSync',
                  header: 'Last Sync',
                  render: (b) => (
                    <span className="text-xs text-gx-muted">
                      {b.lastSyncAt ? timeAgo(b.lastSyncAt) : 'Never'}
                    </span>
                  ),
                },
                {
                  key: 'auditEntries',
                  header: 'Audit Entries',
                  render: (b) => (
                    <span className="font-mono text-xs text-gx-text">
                      {b.auditEntryCount}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (b) => (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/dashboard/bundles/${b.id}`);
                        }}
                      >
                        View
                      </Button>
                      {b.status === 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRevokeTarget(b);
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ),
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
        title="Revoke Bundle"
        message={`Are you sure you want to revoke bundle "${truncateId(revokeTarget?.id ?? '')}"? The device will lose offline authorization on its next sync.`}
        confirmLabel="Revoke"
        loading={revoking}
      />
    </div>
  );
}
