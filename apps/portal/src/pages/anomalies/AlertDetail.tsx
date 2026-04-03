import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getAlert,
  acknowledgeAlert,
  resolveAlert,
  type AnomalyAlert,
} from '../../api/anomalies';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { formatDateTime, truncateId } from '../../lib/format';

const severityVariant: Record<string, 'danger' | 'warning' | 'default'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'warning',
  low: 'default',
};

const statusVariant: Record<string, 'success' | 'warning' | 'default'> = {
  open: 'danger' as 'default',
  acknowledged: 'warning',
  resolved: 'success',
};

export function AlertDetail() {
  const { alertId } = useParams<{ alertId: string }>();
  const [alert, setAlert] = useState<AnomalyAlert | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  const { show } = useToast();

  useEffect(() => {
    if (!alertId) return;
    getAlert(alertId)
      .then(setAlert)
      .catch(() => show('Failed to load alert', 'error'))
      .finally(() => setLoading(false));
  }, [alertId, show]);

  async function handleAcknowledge() {
    if (!alertId) return;
    setActing(true);
    try {
      await acknowledgeAlert(alertId, note || undefined);
      const updated = await getAlert(alertId);
      setAlert(updated);
      setNote('');
      show('Alert acknowledged', 'success');
    } catch {
      show('Failed to acknowledge alert', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handleResolve() {
    if (!alertId) return;
    setActing(true);
    try {
      await resolveAlert(alertId, note || undefined);
      const updated = await getAlert(alertId);
      setAlert(updated);
      setNote('');
      show('Alert resolved', 'success');
    } catch {
      show('Failed to resolve alert', 'error');
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!alert) {
    return <p className="text-gx-muted">Alert not found.</p>;
  }

  return (
    <div>
      {/* Back + header */}
      <div className="flex items-center gap-2 mb-6">
        <Link
          to="/dashboard/anomalies"
          className="text-gx-muted hover:text-gx-text transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 19.5L8.25 12l7.5-7.5"
            />
          </svg>
        </Link>
        <h1 className="text-xl font-semibold text-gx-text">
          Alert — <span className="font-mono">{truncateId(alert.alertId)}</span>
        </h1>
      </div>

      {/* Alert metadata */}
      <Card className="mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gx-muted mb-1">Rule</p>
            <p className="text-sm font-medium text-gx-text">{alert.ruleName}</p>
            <p className="text-xs text-gx-muted font-mono mt-0.5">{alert.ruleId}</p>
          </div>
          <div>
            <p className="text-xs text-gx-muted mb-1">Severity</p>
            <Badge variant={severityVariant[alert.severity] ?? 'default'}>
              {alert.severity}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-gx-muted mb-1">Status</p>
            <Badge variant={statusVariant[alert.status] ?? 'default'}>
              {alert.status}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-gx-muted mb-1">Agent</p>
            {alert.agentId ? (
              <Link
                to={`/dashboard/agents/${alert.agentId}`}
                className="text-sm font-mono text-gx-accent2 hover:underline"
              >
                {truncateId(alert.agentId)}
              </Link>
            ) : (
              <span className="text-sm text-gx-muted">N/A</span>
            )}
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gx-border">
          <p className="text-sm text-gx-text">{alert.description}</p>
        </div>
      </Card>

      {/* Timeline */}
      <Card className="mb-6">
        <h3 className="text-sm font-medium text-gx-text mb-4">Timeline</h3>
        <div className="space-y-0">
          {/* Detected */}
          <div className="flex gap-3 pb-4 relative">
            <div className="flex flex-col items-center">
              <div className="w-3 h-3 rounded-full bg-gx-danger border-2 border-gx-danger/30 z-10" />
              {(alert.acknowledgedAt || alert.resolvedAt) && (
                <div className="w-0.5 flex-1 bg-gx-border" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-gx-text">Detected</p>
              <p className="text-xs text-gx-muted">{formatDateTime(alert.detectedAt)}</p>
            </div>
          </div>

          {/* Acknowledged */}
          {alert.acknowledgedAt && (
            <div className="flex gap-3 pb-4 relative">
              <div className="flex flex-col items-center">
                <div className="w-3 h-3 rounded-full bg-gx-warning border-2 border-gx-warning/30 z-10" />
                {alert.resolvedAt && (
                  <div className="w-0.5 flex-1 bg-gx-border" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-gx-text">Acknowledged</p>
                <p className="text-xs text-gx-muted">
                  {formatDateTime(alert.acknowledgedAt)}
                </p>
              </div>
            </div>
          )}

          {/* Resolved */}
          {alert.resolvedAt && (
            <div className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-3 h-3 rounded-full bg-gx-accent border-2 border-gx-accent/30 z-10" />
              </div>
              <div>
                <p className="text-sm font-medium text-gx-text">Resolved</p>
                <p className="text-xs text-gx-muted">
                  {formatDateTime(alert.resolvedAt)}
                </p>
              </div>
            </div>
          )}

          {/* Pending */}
          {!alert.resolvedAt && (
            <div className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-3 h-3 rounded-full border-2 border-gx-border bg-gx-surface z-10" />
              </div>
              <div>
                <p className="text-sm text-gx-muted">
                  {alert.acknowledgedAt ? 'Awaiting resolution' : 'Awaiting acknowledgement'}
                </p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Context */}
      <Card className="mb-6">
        <h3 className="text-sm font-medium text-gx-text mb-3">Context</h3>
        <pre className="bg-gx-bg border border-gx-border rounded-md p-4 text-xs font-mono text-gx-muted overflow-x-auto">
          {JSON.stringify(alert.context, null, 2)}
        </pre>
      </Card>

      {/* Actions */}
      {alert.status !== 'resolved' && (
        <Card>
          <h3 className="text-sm font-medium text-gx-text mb-3">Resolution Note</h3>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note about the action taken..."
            className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent resize-y min-h-[80px] mb-4"
            rows={3}
          />
          <div className="flex gap-2">
            {alert.status === 'open' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAcknowledge}
                disabled={acting}
              >
                {acting ? <Spinner className="h-4 w-4" /> : 'Acknowledge'}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleResolve}
              disabled={acting}
            >
              {acting ? <Spinner className="h-4 w-4" /> : 'Resolve'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
