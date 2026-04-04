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

      {/* Scope enforcement breakdown */}
      {grant.scopes.length > 0 && (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">Scope Enforcement Breakdown</h2>
          <p className="text-xs text-gx-muted mb-3">
            What this grant token allows and denies based on the permission hierarchy.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gx-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Scope</th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Connector</th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Granted Level</th>
                  <th className="text-left py-2 text-xs font-medium text-gx-muted">Tool Access</th>
                </tr>
              </thead>
              <tbody>
                {grant.scopes.map((scope) => {
                  const parts = scope.split(':');
                  const connector = parts[1] ?? '—';
                  const perm = parts[2] ?? 'read';
                  const permColors: Record<string, string> = { admin: 'bg-purple-500/15 text-purple-400', delete: 'bg-gx-danger/15 text-gx-danger', write: 'bg-gx-warning/15 text-gx-warning', read: 'bg-gx-accent/15 text-gx-accent' };
                  const levels = ['read', 'write', 'delete', 'admin'];
                  const grantedIdx = levels.indexOf(perm);
                  return (
                    <tr key={scope} className="border-b border-gx-border/50 last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-xs text-gx-accent2">{scope}</td>
                      <td className="py-2.5 pr-4 text-xs text-gx-text">{connector}</td>
                      <td className="py-2.5 pr-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase ${permColors[perm] ?? permColors['read']}`}>
                          {perm}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <div className="flex gap-1.5">
                          {levels.map((level, i) => (
                            <span
                              key={level}
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                                i <= grantedIdx
                                  ? 'bg-gx-accent/10 text-gx-accent'
                                  : 'bg-gx-border/30 text-gx-muted line-through'
                              }`}
                            >
                              {level}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Sample tool-level breakdown for known connectors */}
          <h3 className="text-xs font-medium text-gx-muted mt-6 mb-3">Tool-Level Access (based on permission hierarchy)</h3>
          <div className="space-y-3">
            {grant.scopes.map((scope) => {
              const parts = scope.split(':');
              const connector = parts[1] ?? '';
              const grantedPerm = parts[2] ?? 'read';
              const levels = ['read', 'write', 'delete', 'admin'];
              const grantedIdx = levels.indexOf(grantedPerm);
              // Sample tools for this connector
              const sampleTools: Record<string, {name: string; perm: string}[]> = {
                salesforce: [{name:'query',perm:'read'},{name:'create_lead',perm:'write'},{name:'delete_contact',perm:'delete'}],
                hubspot: [{name:'list_contacts',perm:'read'},{name:'create_deal',perm:'write'}],
                jira: [{name:'search_issues',perm:'read'},{name:'create_issue',perm:'write'},{name:'transition_issue',perm:'write'}],
                stripe: [{name:'list_charges',perm:'read'},{name:'create_payment_intent',perm:'write'},{name:'create_refund',perm:'write'}],
                s3: [{name:'list_objects',perm:'read'},{name:'upload_document',perm:'write'},{name:'delete_object',perm:'delete'}],
              };
              const tools = sampleTools[connector];
              if (!tools) return null;
              return (
                <div key={scope} className="bg-gx-bg rounded-lg p-3">
                  <div className="text-xs font-mono text-gx-accent2 mb-2">{connector} (granted: {grantedPerm})</div>
                  <div className="flex flex-wrap gap-2">
                    {tools.map(t => {
                      const toolIdx = levels.indexOf(t.perm);
                      const allowed = toolIdx <= grantedIdx;
                      return (
                        <span key={t.name} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono ${allowed ? 'bg-gx-accent/10 text-gx-accent' : 'bg-gx-danger/10 text-gx-danger line-through'}`}>
                          {allowed ? '\u2713' : '\u2717'} {t.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

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
