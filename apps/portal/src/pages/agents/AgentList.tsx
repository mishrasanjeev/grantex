import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { listAgents, deleteAgent } from '../../api/agents';
import type { Agent } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ScopePills } from '../../components/ui/ScopePills';
import { formatDate, truncateId } from '../../lib/format';

export function AgentList() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => show('Failed to load agents', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAgent(deleteTarget.agentId);
      setAgents((prev) => prev.filter((a) => a.agentId !== deleteTarget.agentId));
      show('Agent deleted', 'success');
    } catch {
      show('Failed to delete agent', 'error');
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
        <h1 className="text-xl font-semibold text-gx-text">Agents</h1>
        <Link to="/dashboard/agents/new">
          <Button size="sm">Create Agent</Button>
        </Link>
      </div>

      <Card className="p-0">
        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Register your first agent to start issuing grants."
            action={
              <Link to="/dashboard/agents/new">
                <Button size="sm">Create Agent</Button>
              </Link>
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={agents}
              rowKey={(a) => a.agentId}
              onRowClick={(a) => navigate(`/dashboard/agents/${a.agentId}`)}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: (a) => (
                    <span className="font-medium text-gx-text">{a.name}</span>
                  ),
                },
                {
                  key: 'id',
                  header: 'ID',
                  render: (a) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(a.agentId)}
                    </span>
                  ),
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  render: (a) => <ScopePills scopes={a.scopes} />,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (a) => (
                    <Badge variant={a.status === 'active' ? 'success' : 'warning'}>
                      {a.status}
                    </Badge>
                  ),
                },
                {
                  key: 'created',
                  header: 'Created',
                  render: (a) => (
                    <span className="text-gx-muted text-xs">{formatDate(a.createdAt)}</span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (a) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(a);
                      }}
                    >
                      Delete
                    </Button>
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
        title="Delete Agent"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
