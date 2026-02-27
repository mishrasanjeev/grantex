import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getGrant, revokeGrant } from '../../api/grants';
import { listAuditEntries } from '../../api/audit';
import type { Grant, AuditEntry } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Table } from '../../components/ui/Table';
import { formatDateTime, truncateId } from '../../lib/format';

export function GrantDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();

  const [grant, setGrant] = useState<Grant | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRevoke, setShowRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getGrant(id),
      listAuditEntries({ grantId: id }).catch(() => []),
    ])
      .then(([g, a]) => {
        setGrant(g);
        setAuditEntries(a);
      })
      .catch(() => {
        show('Grant not found', 'error');
        navigate('/dashboard/grants');
      })
      .finally(() => setLoading(false));
  }, [id, show, navigate]);

  async function handleRevoke() {
    if (!id) return;
    setRevoking(true);
    try {
      await revokeGrant(id);
      setGrant((prev) => prev ? { ...prev, status: 'revoked' as const } : prev);
      show('Grant revoked', 'success');
    } catch {
      show('Failed to revoke grant', 'error');
    } finally {
      setRevoking(false);
      setShowRevoke(false);
    }
  }

  if (loading || !grant) {
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
          <Link to="/dashboard/grants" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
            &larr; Grants
          </Link>
          <h1 className="text-xl font-semibold text-gx-text mt-1">
            Grant {truncateId(grant.grantId)}
          </h1>
        </div>
        {grant.status === 'active' && (
          <Button variant="danger" size="sm" onClick={() => setShowRevoke(true)}>
            Revoke
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Details</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Grant ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{grant.grantId}</code>
                <CopyButton text={grant.grantId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Agent</dt>
              <dd className="mt-0.5">
                <Link
                  to={`/dashboard/agents/${grant.agentId}`}
                  className="text-sm font-mono text-gx-accent2 hover:underline"
                >
                  {grant.agentId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Principal</dt>
              <dd className="text-sm font-mono text-gx-text mt-0.5">{grant.principalId}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge
                  variant={
                    grant.status === 'active' ? 'success' : grant.status === 'revoked' ? 'danger' : 'default'
                  }
                >
                  {grant.status}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Metadata</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Scopes</dt>
              <dd className="mt-1">
                <ScopePills scopes={grant.scopes} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Delegation Depth</dt>
              <dd className="text-sm font-mono text-gx-text mt-0.5">{grant.delegationDepth}</dd>
            </div>
            {grant.parentGrantId && (
              <div>
                <dt className="text-xs text-gx-muted">Parent Grant</dt>
                <dd className="mt-0.5">
                  <Link
                    to={`/dashboard/grants/${grant.parentGrantId}`}
                    className="text-sm font-mono text-gx-accent2 hover:underline"
                  >
                    {grant.parentGrantId}
                  </Link>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-gx-muted">Issued</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(grant.issuedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Expires</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(grant.expiresAt)}</dd>
            </div>
            {grant.revokedAt && (
              <div>
                <dt className="text-xs text-gx-muted">Revoked</dt>
                <dd className="text-sm text-gx-danger mt-0.5">{formatDateTime(grant.revokedAt)}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      {/* Related audit entries */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">
          Audit Trail ({auditEntries.length})
        </h2>
        {auditEntries.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">No audit entries for this grant</p>
        ) : (
          <Table
            data={auditEntries}
            rowKey={(e) => e.entryId}
            onRowClick={(e) => navigate(`/dashboard/audit/${e.entryId}`)}
            columns={[
              {
                key: 'action',
                header: 'Action',
                render: (e) => <Badge>{e.action}</Badge>,
              },
              {
                key: 'status',
                header: 'Status',
                render: (e) => (
                  <Badge variant={e.status === 'success' ? 'success' : e.status === 'blocked' ? 'warning' : 'danger'}>
                    {e.status}
                  </Badge>
                ),
              },
              {
                key: 'agent',
                header: 'Agent',
                render: (e) => (
                  <span className="font-mono text-xs text-gx-muted">{truncateId(e.agentId)}</span>
                ),
              },
              {
                key: 'time',
                header: 'Time',
                render: (e) => (
                  <span className="text-gx-muted text-xs">{formatDateTime(e.timestamp)}</span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <ConfirmDialog
        open={showRevoke}
        onClose={() => setShowRevoke(false)}
        onConfirm={handleRevoke}
        title="Revoke Grant"
        message="Are you sure you want to revoke this grant? All sub-delegated grants will also be revoked. This cannot be undone."
        confirmLabel="Revoke"
        loading={revoking}
      />
    </div>
  );
}
