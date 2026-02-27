import { useState, useEffect } from 'react';
import { listAnomalies, detectAnomalies, acknowledgeAnomaly } from '../../api/anomalies';
import type { Anomaly } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDateTime, truncateId } from '../../lib/format';

const severityVariant = {
  low: 'default',
  medium: 'warning',
  high: 'danger',
} as const;

const typeLabels: Record<Anomaly['type'], string> = {
  rate_spike: 'Rate Spike',
  high_failure_rate: 'High Failure Rate',
  new_principal: 'New Principal',
  off_hours_activity: 'Off-Hours Activity',
};

export function AnomalyList() {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const { show } = useToast();

  useEffect(() => {
    listAnomalies()
      .then(setAnomalies)
      .catch(() => show('Failed to load anomalies', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleDetect() {
    setDetecting(true);
    try {
      const result = await detectAnomalies();
      show(`Detection complete: ${result.total} anomal${result.total === 1 ? 'y' : 'ies'} found`, 'info');
      // Reload the full list
      const fresh = await listAnomalies();
      setAnomalies(fresh);
    } catch {
      show('Detection failed', 'error');
    } finally {
      setDetecting(false);
    }
  }

  async function handleAcknowledge(id: string) {
    try {
      const updated = await acknowledgeAnomaly(id);
      setAnomalies((prev) => prev.map((a) => (a.id === id ? updated : a)));
      show('Anomaly acknowledged', 'success');
    } catch {
      show('Failed to acknowledge', 'error');
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
        <h1 className="text-xl font-semibold text-gx-text">Anomalies</h1>
        <Button size="sm" variant="secondary" onClick={handleDetect} disabled={detecting}>
          {detecting ? <Spinner className="h-4 w-4" /> : 'Run Detection'}
        </Button>
      </div>

      {anomalies.length === 0 ? (
        <Card>
          <EmptyState
            title="No anomalies detected"
            description="Run detection to scan for unusual patterns."
            action={
              <Button size="sm" variant="secondary" onClick={handleDetect} disabled={detecting}>
                Run Detection
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {anomalies.map((a) => (
            <Card key={a.id} className={a.acknowledgedAt ? 'opacity-60' : ''}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge variant={severityVariant[a.severity]}>
                      {a.severity}
                    </Badge>
                    <Badge>{typeLabels[a.type]}</Badge>
                    {a.acknowledgedAt && (
                      <Badge variant="success">acknowledged</Badge>
                    )}
                  </div>
                  <p className="text-sm text-gx-text mb-2">{a.description}</p>
                  <div className="flex items-center gap-4 text-xs text-gx-muted">
                    {a.agentId && (
                      <span>
                        Agent: <span className="font-mono text-gx-accent2">{truncateId(a.agentId)}</span>
                      </span>
                    )}
                    {a.principalId && (
                      <span>
                        Principal: <span className="font-mono">{a.principalId}</span>
                      </span>
                    )}
                    <span>Detected: {formatDateTime(a.detectedAt)}</span>
                    {a.acknowledgedAt && (
                      <span>Acknowledged: {formatDateTime(a.acknowledgedAt)}</span>
                    )}
                  </div>
                </div>
                {!a.acknowledgedAt && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAcknowledge(a.id)}
                  >
                    Acknowledge
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
