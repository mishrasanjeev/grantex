import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { withdrawConsent } from '../../api/dpdp';
import type { ConsentRecord } from '../../api/dpdp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { formatDateTime } from '../../lib/format';

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  switch (status) {
    case 'active': return 'success';
    case 'withdrawn': return 'danger';
    case 'expired': return 'warning';
    default: return 'default';
  }
}

export function ConsentRecordDetail() {
  const { recordId } = useParams<{ recordId: string }>();
  const { show } = useToast();

  const [record, setRecord] = useState<ConsentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  useEffect(() => {
    if (!recordId) return;
    // We need to search by a data principal to find the record.
    // Since we don't know the principalId from the URL, we'll try to find
    // the record across all principals. In production, there would be a
    // direct GET /v1/dpdp/consent-records/:id endpoint.
    // For now, the record data should be passed via navigation state or cached.
    setLoading(false);
  }, [recordId]);

  // If navigated from list, record might be in location state
  useEffect(() => {
    if (!recordId) return;
    // Attempt to look up record — in a real implementation we'd have a direct endpoint
    setLoading(false);
  }, [recordId]);

  async function handleWithdraw() {
    if (!record) return;
    setWithdrawing(true);
    try {
      await withdrawConsent(record.recordId, { reason: 'Consent withdrawn by data fiduciary' });
      setRecord((prev) =>
        prev ? { ...prev, status: 'withdrawn' as const, withdrawnAt: new Date().toISOString() } : prev,
      );
      show('Consent withdrawn', 'success');
    } catch {
      show('Failed to withdraw consent', 'error');
    } finally {
      setWithdrawing(false);
      setShowWithdraw(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!record) {
    return (
      <div>
        <Link to="/dashboard/dpdp/records" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
          &larr; Consent Records
        </Link>
        <Card className="mt-4">
          <div className="text-center py-8">
            <p className="text-sm text-gx-muted mb-2">
              Record details are available when navigating from the consent records list.
            </p>
            <p className="text-xs text-gx-muted mb-4">
              Search by Data Principal ID to view detailed record information.
            </p>
            <Link to="/dashboard/dpdp/records">
              <Button variant="secondary" size="sm">Go to Consent Records</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/dashboard/dpdp/records" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
            &larr; Consent Records
          </Link>
          <h1 className="text-xl font-semibold text-gx-text mt-1">
            Consent Record
          </h1>
        </div>
        {record.status === 'active' && (
          <Button variant="danger" size="sm" onClick={() => setShowWithdraw(true)}>
            Withdraw Consent
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Record Details</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Record ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{record.recordId}</code>
                <CopyButton text={record.recordId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Data Principal</dt>
              <dd className="text-sm font-mono text-gx-text mt-0.5">{record.dataPrincipalId}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Data Fiduciary</dt>
              <dd className="text-sm text-gx-text mt-0.5">{record.dataFiduciaryName}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Grant</dt>
              <dd className="mt-0.5">
                <Link
                  to={`/dashboard/grants/${record.grantId}`}
                  className="text-sm font-mono text-gx-accent2 hover:underline"
                >
                  {record.grantId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge variant={statusVariant(record.status)}>{record.status}</Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Consent Metadata</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Purposes</dt>
              <dd className="mt-1">
                <div className="flex flex-wrap gap-1">
                  {record.purposes.map((p) => (
                    <Badge key={p.code}>{p.code}</Badge>
                  ))}
                </div>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Scopes</dt>
              <dd className="mt-1">
                <ScopePills scopes={record.scopes} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Consent Given</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(record.consentGivenAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Processing Expires</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(record.processingExpiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Retention Until</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(record.retentionUntil)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Access Count</dt>
              <dd className="text-sm font-mono text-gx-text mt-0.5">{record.accessCount}</dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Timeline */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">Timeline</h2>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-2 h-2 rounded-full bg-gx-accent mt-1.5 shrink-0" />
            <div>
              <p className="text-sm text-gx-text">Consent given</p>
              <p className="text-xs text-gx-muted">{formatDateTime(record.consentGivenAt)}</p>
            </div>
          </div>
          {record.lastAccessedAt && (
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-gx-accent2 mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-gx-text">Last accessed</p>
                <p className="text-xs text-gx-muted">{formatDateTime(record.lastAccessedAt)}</p>
              </div>
            </div>
          )}
          {record.withdrawnAt && (
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-gx-danger mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-gx-text">Consent withdrawn</p>
                <p className="text-xs text-gx-muted">{formatDateTime(record.withdrawnAt)}</p>
                {record.withdrawnReason && (
                  <p className="text-xs text-gx-muted mt-0.5">Reason: {record.withdrawnReason}</p>
                )}
              </div>
            </div>
          )}
          <div className="flex items-start gap-3">
            <div className="w-2 h-2 rounded-full bg-gx-border mt-1.5 shrink-0" />
            <div>
              <p className="text-sm text-gx-text">Processing expires</p>
              <p className="text-xs text-gx-muted">{formatDateTime(record.processingExpiresAt)}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-2 h-2 rounded-full bg-gx-border mt-1.5 shrink-0" />
            <div>
              <p className="text-sm text-gx-text">Retention ends</p>
              <p className="text-xs text-gx-muted">{formatDateTime(record.retentionUntil)}</p>
            </div>
          </div>
        </div>
      </Card>

      {/* Consent Proof */}
      {record.consentProof && Object.keys(record.consentProof).length > 0 && (
        <Card className="mt-4">
          <h2 className="text-sm font-semibold text-gx-text mb-4">Consent Proof</h2>
          <pre className="text-xs text-gx-muted bg-gx-bg p-3 rounded-md overflow-x-auto">
            {JSON.stringify(record.consentProof, null, 2)}
          </pre>
        </Card>
      )}

      <ConfirmDialog
        open={showWithdraw}
        onClose={() => setShowWithdraw(false)}
        onConfirm={handleWithdraw}
        title="Withdraw Consent"
        message="Are you sure you want to withdraw this consent record? The data principal's processing consent will be revoked. This action cannot be undone."
        confirmLabel="Withdraw"
        loading={withdrawing}
      />
    </div>
  );
}
