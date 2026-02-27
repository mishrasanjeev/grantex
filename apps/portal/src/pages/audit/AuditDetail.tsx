import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getAuditEntry } from '../../api/audit';
import type { AuditEntry } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { formatDateTime } from '../../lib/format';

export function AuditDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();

  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    getAuditEntry(id)
      .then(setEntry)
      .catch(() => {
        show('Audit entry not found', 'error');
        navigate('/dashboard/audit');
      })
      .finally(() => setLoading(false));
  }, [id, show, navigate]);

  if (loading || !entry) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link to="/dashboard/audit" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
          &larr; Audit Log
        </Link>
        <h1 className="text-xl font-semibold text-gx-text mt-1">Audit Entry</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Entry Details</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Entry ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{entry.entryId}</code>
                <CopyButton text={entry.entryId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Action</dt>
              <dd className="mt-0.5">
                <Badge>{entry.action}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge variant={entry.status === 'success' ? 'success' : entry.status === 'blocked' ? 'warning' : 'danger'}>
                  {entry.status}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Timestamp</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(entry.timestamp)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">References</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Agent</dt>
              <dd className="mt-0.5">
                <Link
                  to={`/dashboard/agents/${entry.agentId}`}
                  className="text-sm font-mono text-gx-accent2 hover:underline"
                >
                  {entry.agentId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Agent DID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text">{entry.agentDid}</code>
                <CopyButton text={entry.agentDid} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Grant</dt>
              <dd className="mt-0.5">
                <Link
                  to={`/dashboard/grants/${entry.grantId}`}
                  className="text-sm font-mono text-gx-accent2 hover:underline"
                >
                  {entry.grantId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Principal</dt>
              <dd className="text-sm font-mono text-gx-text mt-0.5">{entry.principalId}</dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Hash chain */}
      <Card className="mb-6">
        <h2 className="text-xs font-medium text-gx-muted mb-4">Hash Chain</h2>
        <dl className="space-y-3">
          <div>
            <dt className="text-xs text-gx-muted">Hash</dt>
            <dd className="flex items-center gap-2 mt-0.5">
              <code className="text-xs font-mono text-gx-accent break-all">{entry.hash}</code>
              <CopyButton text={entry.hash} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gx-muted">Previous Hash</dt>
            <dd className="mt-0.5">
              {entry.prevHash ? (
                <code className="text-xs font-mono text-gx-muted break-all">{entry.prevHash}</code>
              ) : (
                <span className="text-xs text-gx-muted italic">Genesis entry (no previous hash)</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Metadata JSON */}
      {Object.keys(entry.metadata).length > 0 && (
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Metadata</h2>
          <pre className="text-xs font-mono text-gx-text bg-gx-bg rounded-md p-4 overflow-x-auto">
            {JSON.stringify(entry.metadata, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
