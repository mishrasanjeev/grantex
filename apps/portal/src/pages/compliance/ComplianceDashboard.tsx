import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getComplianceSummary, exportGrants, exportAudit, exportEvidencePack } from '../../api/compliance';
import type { ComplianceSummary } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ScoreCard({ label, score, variant }: { label: string; score: number; variant: 'success' | 'warning' | 'danger' }) {
  const color =
    variant === 'success'
      ? 'text-gx-accent'
      : variant === 'warning'
        ? 'text-gx-warning'
        : 'text-gx-danger';
  const bgColor =
    variant === 'success'
      ? 'bg-gx-accent/10'
      : variant === 'warning'
        ? 'bg-gx-warning/10'
        : 'bg-gx-danger/10';
  return (
    <Card className="relative overflow-hidden">
      <div className={`absolute inset-0 ${bgColor} opacity-50`} />
      <div className="relative">
        <p className="text-xs text-gx-muted mb-1">{label}</p>
        <p className={`text-3xl font-bold font-mono ${color}`}>{score}%</p>
        <div className="mt-2 h-1.5 bg-gx-border/50 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              variant === 'success'
                ? 'bg-gx-accent'
                : variant === 'warning'
                  ? 'bg-gx-warning'
                  : 'bg-gx-danger'
            }`}
            style={{ width: `${score}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

export function ComplianceDashboard() {
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const { show } = useToast();

  useEffect(() => {
    getComplianceSummary()
      .then(setSummary)
      .catch(() => show('Failed to load compliance data', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleExport(type: string) {
    setExporting(type);
    try {
      if (type === 'grants') {
        const data = await exportGrants();
        downloadJson(data, `grantex-grants-${Date.now()}.json`);
      } else if (type === 'audit') {
        const data = await exportAudit();
        downloadJson(data, `grantex-audit-${Date.now()}.json`);
      } else {
        const data = await exportEvidencePack(type);
        downloadJson(data, `grantex-evidence-${type}-${Date.now()}.json`);
      }
      show('Export downloaded', 'success');
    } catch {
      show('Export failed', 'error');
    } finally {
      setExporting(null);
    }
  }

  if (loading || !summary) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  // Compute compliance scores based on summary data
  const hasPolicies = summary.policies.total > 0;
  const hasAudit = summary.auditEntries.total > 0;
  const lowFailureRate =
    summary.auditEntries.total > 0
      ? summary.auditEntries.failure / summary.auditEntries.total < 0.1
      : true;

  const dpdpScore = Math.min(
    100,
    (hasPolicies ? 30 : 0) + (hasAudit ? 30 : 0) + (lowFailureRate ? 20 : 0) + (summary.grants.active > 0 ? 20 : 0),
  );
  const euAiScore = Math.min(
    100,
    (hasAudit ? 35 : 0) + (hasPolicies ? 35 : 0) + (summary.agents.total > 0 ? 30 : 0),
  );
  const owaspScore = Math.min(
    100,
    (hasPolicies ? 25 : 0) +
      (hasAudit ? 25 : 0) +
      (lowFailureRate ? 25 : 0) +
      (summary.grants.revoked + summary.grants.expired > 0 || summary.grants.active > 0 ? 25 : 0),
  );

  const dpdpVariant = dpdpScore >= 80 ? 'success' : dpdpScore >= 50 ? 'warning' : 'danger';
  const euAiVariant = euAiScore >= 80 ? 'success' : euAiScore >= 50 ? 'warning' : 'danger';
  const owaspVariant = owaspScore >= 80 ? 'success' : owaspScore >= 50 ? 'warning' : 'danger';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Compliance</h1>
        <Badge>{summary.plan} plan</Badge>
      </div>

      {/* Compliance Scores */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <ScoreCard label="DPDP 2023" score={dpdpScore} variant={dpdpVariant} />
        <ScoreCard label="EU AI Act" score={euAiScore} variant={euAiVariant} />
        <ScoreCard label="OWASP Agentic Top 10" score={owaspScore} variant={owaspVariant} />
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card>
          <p className="text-xs text-gx-muted mb-1">Agents</p>
          <p className="text-2xl font-bold font-mono text-gx-accent2">{summary.agents.total}</p>
          <div className="flex gap-2 mt-2 text-xs text-gx-muted">
            <span>{summary.agents.active} active</span>
            <span>{summary.agents.suspended} suspended</span>
          </div>
        </Card>
        <Card>
          <p className="text-xs text-gx-muted mb-1">Grants</p>
          <p className="text-2xl font-bold font-mono text-gx-accent">{summary.grants.total}</p>
          <div className="flex gap-2 mt-2 text-xs text-gx-muted">
            <span>{summary.grants.active} active</span>
            <span>{summary.grants.revoked} revoked</span>
            <span>{summary.grants.expired} expired</span>
          </div>
        </Card>
        <Card>
          <p className="text-xs text-gx-muted mb-1">Audit Entries</p>
          <p className="text-2xl font-bold font-mono text-gx-text">{summary.auditEntries.total}</p>
          <div className="flex gap-2 mt-2 text-xs text-gx-muted">
            <span className="text-gx-accent">{summary.auditEntries.success} success</span>
            <span className="text-gx-danger">{summary.auditEntries.failure} failure</span>
            <span className="text-gx-warning">{summary.auditEntries.blocked} blocked</span>
          </div>
        </Card>
        <Card>
          <p className="text-xs text-gx-muted mb-1">Policies</p>
          <p className="text-2xl font-bold font-mono text-gx-text">{summary.policies.total}</p>
        </Card>
      </div>

      {/* Open Action Items */}
      <Card className="mb-8">
        <h2 className="text-sm font-semibold text-gx-text mb-4">Open Action Items</h2>
        <div className="space-y-3">
          {!hasPolicies && (
            <div className="flex items-center justify-between p-3 bg-gx-warning/5 rounded-md border border-gx-warning/20">
              <div className="flex items-center gap-3">
                <Badge variant="warning">Action</Badge>
                <span className="text-sm text-gx-text">Create authorization policies for your agents</span>
              </div>
              <Link to="/dashboard/policies/new">
                <Button variant="secondary" size="sm">Create Policy</Button>
              </Link>
            </div>
          )}
          {!hasAudit && (
            <div className="flex items-center justify-between p-3 bg-gx-warning/5 rounded-md border border-gx-warning/20">
              <div className="flex items-center gap-3">
                <Badge variant="warning">Action</Badge>
                <span className="text-sm text-gx-text">Enable audit logging for compliance tracking</span>
              </div>
              <Link to="/dashboard/audit">
                <Button variant="secondary" size="sm">View Audit</Button>
              </Link>
            </div>
          )}
          {!lowFailureRate && (
            <div className="flex items-center justify-between p-3 bg-gx-danger/5 rounded-md border border-gx-danger/20">
              <div className="flex items-center gap-3">
                <Badge variant="danger">Critical</Badge>
                <span className="text-sm text-gx-text">High failure rate detected in audit log — investigate anomalies</span>
              </div>
              <Link to="/dashboard/anomalies">
                <Button variant="secondary" size="sm">View Anomalies</Button>
              </Link>
            </div>
          )}
          {hasPolicies && hasAudit && lowFailureRate && (
            <p className="text-sm text-gx-muted py-2 text-center">No open action items</p>
          )}
        </div>
      </Card>

      {/* DPDP Consent Records & Grievances quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-3">DPDP Consent Records</h2>
          <p className="text-xs text-gx-muted mb-4">
            Manage data principal consent records under the DPDP Act 2023.
          </p>
          <Link to="/dashboard/dpdp/records">
            <Button variant="secondary" size="sm">View Records</Button>
          </Link>
        </Card>
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-3">Grievances</h2>
          <p className="text-xs text-gx-muted mb-4">
            Track and resolve data principal grievances per DPDP section 13(6).
          </p>
          <Link to="/dashboard/dpdp/grievances">
            <Button variant="secondary" size="sm">View Grievances</Button>
          </Link>
        </Card>
      </div>

      {/* Exports */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">Exports</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border">
            <div>
              <p className="text-sm font-medium text-gx-text">Grants Export</p>
              <p className="text-xs text-gx-muted">All grants with delegation info</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('grants')}
              disabled={exporting === 'grants'}
            >
              {exporting === 'grants' ? <Spinner className="h-3 w-3" /> : 'Download'}
            </Button>
          </div>
          <div className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border">
            <div>
              <p className="text-sm font-medium text-gx-text">Audit Log Export</p>
              <p className="text-xs text-gx-muted">Full audit trail with hash chain</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('audit')}
              disabled={exporting === 'audit'}
            >
              {exporting === 'audit' ? <Spinner className="h-3 w-3" /> : 'Download'}
            </Button>
          </div>
          <div className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border">
            <div>
              <p className="text-sm font-medium text-gx-text">SOC 2 Evidence Pack</p>
              <p className="text-xs text-gx-muted">Summary + grants + audit + policies + chain integrity</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('soc2')}
              disabled={exporting === 'soc2'}
            >
              {exporting === 'soc2' ? <Spinner className="h-3 w-3" /> : 'Download'}
            </Button>
          </div>
          <div className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border">
            <div>
              <p className="text-sm font-medium text-gx-text">GDPR Evidence Pack</p>
              <p className="text-xs text-gx-muted">Full evidence pack for GDPR compliance</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('gdpr')}
              disabled={exporting === 'gdpr'}
            >
              {exporting === 'gdpr' ? <Spinner className="h-3 w-3" /> : 'Download'}
            </Button>
          </div>
          <div className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border">
            <div>
              <p className="text-sm font-medium text-gx-text">DPDP Compliance Export</p>
              <p className="text-xs text-gx-muted">Consent records, grievances, and audit log for DPDP Act</p>
            </div>
            <Link to="/dashboard/dpdp/exports">
              <Button variant="secondary" size="sm">Configure</Button>
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
