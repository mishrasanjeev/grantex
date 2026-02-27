import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listPolicies, deletePolicy } from '../../api/policies';
import type { Policy } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { truncateId } from '../../lib/format';

export function PolicyList() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listPolicies()
      .then(setPolicies)
      .catch(() => show('Failed to load policies', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePolicy(deleteTarget.id);
      setPolicies((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      show('Policy deleted', 'success');
    } catch {
      show('Failed to delete policy', 'error');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
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
        <h1 className="text-xl font-semibold text-gx-text">Policies</h1>
        <Link to="/dashboard/policies/new">
          <Button size="sm">Create Policy</Button>
        </Link>
      </div>

      <Card className="p-0">
        {policies.length === 0 ? (
          <EmptyState
            title="No policies"
            description="Create a policy to control agent permissions."
            action={
              <Link to="/dashboard/policies/new">
                <Button size="sm">Create Policy</Button>
              </Link>
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={policies}
              rowKey={(p) => p.id}
              columns={[
                {
                  key: 'priority',
                  header: '#',
                  className: 'w-12',
                  render: (p) => (
                    <span className="font-mono text-xs text-gx-muted">{p.priority}</span>
                  ),
                },
                {
                  key: 'name',
                  header: 'Name',
                  render: (p) => (
                    <span className="font-medium text-gx-text">{p.name}</span>
                  ),
                },
                {
                  key: 'effect',
                  header: 'Effect',
                  render: (p) => (
                    <Badge variant={p.effect === 'allow' ? 'success' : 'danger'}>
                      {p.effect}
                    </Badge>
                  ),
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  render: (p) =>
                    p.scopes ? (
                      <ScopePills scopes={p.scopes} />
                    ) : (
                      <span className="text-xs text-gx-muted italic">all</span>
                    ),
                },
                {
                  key: 'agent',
                  header: 'Agent',
                  render: (p) =>
                    p.agentId ? (
                      <span className="font-mono text-xs text-gx-accent2">{truncateId(p.agentId)}</span>
                    ) : (
                      <span className="text-xs text-gx-muted italic">any</span>
                    ),
                },
                {
                  key: 'time',
                  header: 'Time Window',
                  render: (p) =>
                    p.timeOfDayStart && p.timeOfDayEnd ? (
                      <span className="font-mono text-xs text-gx-muted">
                        {p.timeOfDayStart}–{p.timeOfDayEnd}
                      </span>
                    ) : (
                      <span className="text-xs text-gx-muted italic">always</span>
                    ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (p) => (
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/dashboard/policies/${p.id}/edit`)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(p)}
                      >
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Policy"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
