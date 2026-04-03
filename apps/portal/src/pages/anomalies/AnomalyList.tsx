import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  listAlerts,
  getMetrics,
  acknowledgeAlert,
  resolveAlert,
  type AnomalyAlert,
  type AnomalyMetrics,
} from '../../api/anomalies';
import { revokeGrant } from '../../api/grants';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { timeAgo, truncateId } from '../../lib/format';

const severityColors: Record<string, string> = {
  critical: '#f85149',
  high: '#f0883e',
  medium: '#d29922',
  low: '#8b949e',
};

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

export function AnomalyList() {
  const [alerts, setAlerts] = useState<AnomalyAlert[]>([]);
  const [metrics, setMetrics] = useState<AnomalyMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [revokeTarget, setRevokeTarget] = useState<AnomalyAlert | null>(null);
  const [revoking, setRevoking] = useState(false);
  const { show } = useToast();
  const navigate = useNavigate();

  const loadData = useCallback(async () => {
    try {
      const [alertData, metricsData] = await Promise.all([
        listAlerts({
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(severityFilter ? { severity: severityFilter } : {}),
        }),
        getMetrics(),
      ]);
      setAlerts(alertData);
      setMetrics(metricsData);
    } catch {
      show('Failed to load anomaly data', 'error');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter, show]);

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [loadData]);

  async function handleAcknowledge(alert: AnomalyAlert) {
    try {
      await acknowledgeAlert(alert.alertId);
      show('Alert acknowledged', 'success');
      loadData();
    } catch {
      show('Failed to acknowledge alert', 'error');
    }
  }

  async function handleResolve(alert: AnomalyAlert) {
    try {
      await resolveAlert(alert.alertId);
      show('Alert resolved', 'success');
      loadData();
    } catch {
      show('Failed to resolve alert', 'error');
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    const grantId = revokeTarget.context.grantId as string | undefined;
    if (!grantId) {
      show('No grant associated with this alert', 'error');
      setRevokeTarget(null);
      return;
    }
    setRevoking(true);
    try {
      await revokeGrant(grantId);
      show('Grant revoked', 'success');
      setRevokeTarget(null);
      loadData();
    } catch {
      show('Failed to revoke grant', 'error');
    } finally {
      setRevoking(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const openCritical = metrics?.bySeverity?.critical ?? 0;
  const openHigh = metrics?.bySeverity?.high ?? 0;
  const openMedium = metrics?.bySeverity?.medium ?? 0;
  const openLow = metrics?.bySeverity?.low ?? 0;

  // Build sparkline data (last 14 days)
  const activityData = metrics?.recentActivity ?? [];
  const maxActivity = Math.max(...activityData.map((d) => d.count), 1);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gx-text">Anomaly Detection</h1>
          <p className="text-sm text-gx-muted mt-1">Last updated: just now</p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/anomalies/rules">
            <Button size="sm" variant="secondary">Rules</Button>
          </Link>
          <Button size="sm" variant="secondary" onClick={() => loadData()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Severity counts */}
        <Card className="col-span-1">
          <h3 className="text-sm font-medium text-gx-muted mb-4">Open Alerts by Severity</h3>
          <div className="space-y-3">
            {[
              { label: 'Critical', count: openCritical, color: severityColors.critical },
              { label: 'High', count: openHigh, color: severityColors.high },
              { label: 'Medium', count: openMedium, color: severityColors.medium },
              { label: 'Low', count: openLow, color: severityColors.low },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: item.color }}
                  />
                  <span className="text-sm text-gx-text">{item.label}</span>
                </div>
                <span
                  className="text-lg font-bold font-mono"
                  style={{ color: item.count > 0 ? item.color : 'var(--gx-muted)' }}
                >
                  {item.count}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-gx-border flex items-center justify-between">
            <span className="text-sm text-gx-muted">Total open</span>
            <span className="text-xl font-bold text-gx-text font-mono">
              {metrics?.openAlerts ?? 0}
            </span>
          </div>
        </Card>

        {/* Activity sparkline */}
        <Card className="col-span-1 lg:col-span-2">
          <h3 className="text-sm font-medium text-gx-muted mb-4">Recent Activity (14 days)</h3>
          <div className="flex items-end gap-1 h-24">
            {activityData.length === 0 ? (
              <p className="text-sm text-gx-muted self-center w-full text-center">
                No recent activity data
              </p>
            ) : (
              activityData.map((day, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-all hover:opacity-80"
                  style={{
                    height: `${Math.max((day.count / maxActivity) * 100, 4)}%`,
                    background:
                      day.count === 0
                        ? 'var(--gx-border, #30363d)'
                        : day.count > maxActivity * 0.7
                          ? severityColors.high
                          : 'var(--gx-accent, #3fb950)',
                    minHeight: '4px',
                  }}
                  title={`${day.date}: ${day.count} alerts`}
                />
              ))
            )}
          </div>
          <div className="flex justify-between mt-2 text-xs text-gx-muted">
            <span>{activityData[0]?.date ?? ''}</span>
            <span>{activityData[activityData.length - 1]?.date ?? ''}</span>
          </div>
          <div className="mt-3 pt-3 border-t border-gx-border">
            <span className="text-sm text-gx-muted">
              Total alerts (all time):{' '}
              <span className="font-mono font-bold text-gx-text">
                {metrics?.totalAlerts ?? 0}
              </span>
            </span>
          </div>
        </Card>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gx-surface border border-gx-border rounded-md px-3 py-1.5 text-sm text-gx-text focus:outline-none focus:border-gx-accent"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="bg-gx-surface border border-gx-border rounded-md px-3 py-1.5 text-sm text-gx-text focus:outline-none focus:border-gx-accent"
        >
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <span className="text-sm text-gx-muted ml-auto">
          {alerts.length} alert{alerts.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Alerts list */}
      {alerts.length === 0 ? (
        <Card>
          <EmptyState
            title="No alerts found"
            description="No anomaly alerts match the current filters."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div
              key={alert.alertId}
              className={`bg-gx-surface border border-gx-border rounded-lg p-6 cursor-pointer transition-colors hover:border-gx-accent/30 ${
                alert.status === 'resolved' ? 'opacity-60' : ''
              }`}
              onClick={() => navigate(`/dashboard/anomalies/${alert.alertId}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    {/* Severity dot + badge */}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: severityColors[alert.severity] }}
                    />
                    <Badge variant={severityVariant[alert.severity] ?? 'default'}>
                      {alert.severity}
                    </Badge>
                    <Badge variant={statusVariant[alert.status] ?? 'default'}>
                      {alert.status}
                    </Badge>
                    <span className="text-xs text-gx-muted font-mono">{alert.ruleName}</span>
                  </div>
                  <p className="text-sm text-gx-text mb-2">{alert.description}</p>
                  <div className="flex items-center gap-4 text-xs text-gx-muted flex-wrap">
                    {alert.agentId && (
                      <span>
                        Agent:{' '}
                        <span className="font-mono text-gx-accent2">
                          {truncateId(alert.agentId)}
                        </span>
                      </span>
                    )}
                    <span>Detected: {timeAgo(alert.detectedAt)}</span>
                    {alert.acknowledgedAt && (
                      <span>Acknowledged: {timeAgo(alert.acknowledgedAt)}</span>
                    )}
                    {alert.resolvedAt && (
                      <span>Resolved: {timeAgo(alert.resolvedAt)}</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div
                  className="flex gap-2 flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {alert.status === 'open' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleAcknowledge(alert)}
                    >
                      Acknowledge
                    </Button>
                  )}
                  {alert.status !== 'resolved' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleResolve(alert)}
                    >
                      Resolve
                    </Button>
                  )}
                  {!!(alert.context as Record<string, unknown>).grantId && alert.status !== 'resolved' && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setRevokeTarget(alert)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Revoke confirm dialog */}
      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke Grant"
        message={`This will immediately revoke grant ${
          revokeTarget && (revokeTarget.context as Record<string, unknown>).grantId
            ? truncateId((revokeTarget.context as Record<string, unknown>).grantId as string)
            : ''
        } associated with this alert. The agent will lose all access.`}
        confirmLabel="Revoke Grant"
        variant="danger"
        loading={revoking}
      />
    </div>
  );
}
