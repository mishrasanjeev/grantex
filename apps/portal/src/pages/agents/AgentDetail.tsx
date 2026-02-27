import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getAgent, deleteAgent, updateAgent } from '../../api/agents';
import { listGrants } from '../../api/grants';
import type { Agent, Grant } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Table } from '../../components/ui/Table';
import { formatDate, formatDateTime, truncateId } from '../../lib/format';

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getAgent(id),
      listGrants({ agentId: id }).catch(() => []),
    ])
      .then(([a, g]) => {
        setAgent(a);
        setGrants(g);
      })
      .catch(() => {
        show('Agent not found', 'error');
        navigate('/dashboard/agents');
      })
      .finally(() => setLoading(false));
  }, [id, show, navigate]);

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await deleteAgent(id);
      show('Agent deleted', 'success');
      navigate('/dashboard/agents');
    } catch {
      show('Failed to delete agent', 'error');
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  }

  async function toggleStatus() {
    if (!id || !agent) return;
    setTogglingStatus(true);
    const newStatus = agent.status === 'active' ? 'suspended' : 'active';
    try {
      const updated = await updateAgent(id, { status: newStatus });
      setAgent(updated);
      show(`Agent ${newStatus}`, 'success');
    } catch {
      show('Failed to update status', 'error');
    } finally {
      setTogglingStatus(false);
    }
  }

  if (loading || !agent) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/dashboard/agents" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
            &larr; Agents
          </Link>
          <h1 className="text-xl font-semibold text-gx-text mt-1">{agent.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleStatus}
            disabled={togglingStatus}
          >
            {agent.status === 'active' ? 'Suspend' : 'Activate'}
          </Button>
          <Link to={`/dashboard/agents/${agent.agentId}/edit`}>
            <Button variant="secondary" size="sm">Edit</Button>
          </Link>
          <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Agent details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Details</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Agent ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{agent.agentId}</code>
                <CopyButton text={agent.agentId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">DID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text">{agent.did}</code>
                <CopyButton text={agent.did} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge variant={agent.status === 'active' ? 'success' : 'warning'}>
                  {agent.status}
                </Badge>
              </dd>
            </div>
            {agent.description && (
              <div>
                <dt className="text-xs text-gx-muted">Description</dt>
                <dd className="text-sm text-gx-text mt-0.5">{agent.description}</dd>
              </div>
            )}
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Metadata</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Scopes</dt>
              <dd className="mt-1">
                <ScopePills scopes={agent.scopes} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Created</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(agent.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Last Updated</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(agent.updatedAt)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Associated grants */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">
          Grants ({grants.length})
        </h2>
        {grants.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">No grants for this agent</p>
        ) : (
          <Table
            data={grants}
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
            ]}
          />
        )}
      </Card>

      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete Agent"
        message={`Are you sure you want to delete "${agent.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
