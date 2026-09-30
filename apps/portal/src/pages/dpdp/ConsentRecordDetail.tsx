import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getConsentRecord, withdrawConsent } from '../../api/dpdp';
import type { ConsentRecord, WithdrawConsentRequest } from '../../api/dpdp';
import { ApiError } from '../../api/client';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { formatDateTime } from '../../lib/format';
import { consentStatusVariant } from './status';
import { WithdrawConsentDialog, withdrawErrorMessage, withdrawSuccessMessage } from './WithdrawConsentDialog';

export function ConsentRecordDetail() {
  const { recordId } = useParams<{ recordId: string }>();
  const { show } = useToast();

  const [record, setRecord] = useState<ConsentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    if (!recordId) return;
    try {
      const rec = await getConsentRecord(recordId);
      setRecord(rec);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setRecord(null);
        setNotFound(true);
      } else {
        show('Failed to load consent record', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [recordId, show]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function handleWithdraw(request: WithdrawConsentRequest) {
    if (!record) return;
    setWithdrawing(true);
    try {
      const res = await withdrawConsent(record.recordId, request);
      setRecord((prev) =>
        prev
          ? { ...prev, status: res.status, withdrawnAt: res.withdrawnAt, withdrawnReason: request.reason }
          : prev,
      );
      show(withdrawSuccessMessage(res.grantRevoked), 'success');
    } catch (err) {
      const { message, conflict } = withdrawErrorMessage(err);
      show(message, 'error');
      if (conflict) void load();
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
            <p className="text-sm text-gx-text mb-2">
              {notFound ? 'Consent record not found' : 'Consent record unavailable'}
            </p>
            <p className="text-xs text-gx-muted mb-4">
              {notFound
                ? <>No consent record <span className="font-mono">{recordId}</span> exists for this account.</>
                : 'The record could not be loaded. Try again later.'}
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
              <dd className="text-sm font-mono text-gx-text mt-0.5">{record.dataPrincipalId ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Data Fiduciary</dt>
              <dd className="text-sm text-gx-text mt-0.5">{record.dataFiduciaryName}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Grant</dt>
              <dd className="mt-0.5">
                <Link
                  to={`/dashboard/grants/${encodeURIComponent(record.grantId)}`}
                  className="text-sm font-mono text-gx-accent2 hover:underline"
                >
                  {record.grantId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge variant={consentStatusVariant(record.status)}>{record.status}</Badge>
              </dd>
            </div>
            {record.withdrawnReason && (
              <div>
                <dt className="text-xs text-gx-muted">Withdrawal reason</dt>
                <dd className="text-sm text-gx-text mt-0.5">{record.withdrawnReason}</dd>
              </div>
            )}
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Consent Metadata</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Consent Notice</dt>
              <dd className="text-sm text-gx-text mt-0.5">
                <span className="font-mono">{record.consentNoticeId}</span>
                <span className="text-gx-muted"> version </span>
                {record.consentNoticeVersion
                  ? <span className="font-mono">{record.consentNoticeVersion}</span>
                  : <span className="text-gx-muted">not recorded</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Purposes</dt>
              <dd className="mt-1">
                <ul className="space-y-1">
                  {record.purposes.map((p) => (
                    <li key={p.code} className="flex items-baseline gap-2">
                      <Badge>{p.code}</Badge>
                      <span className="text-sm text-gx-text">{p.description}</span>
                    </li>
                  ))}
                </ul>
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
              </div>
            </div>
          )}
          {record.erasedAt && (
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-gx-danger mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-gx-text">Data erased</p>
                <p className="text-xs text-gx-muted">{formatDateTime(record.erasedAt)}</p>
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

      <WithdrawConsentDialog
        open={showWithdraw}
        recordId={record.recordId}
        grantId={record.grantId}
        loading={withdrawing}
        onClose={() => setShowWithdraw(false)}
        onConfirm={handleWithdraw}
      />
    </div>
  );
}
