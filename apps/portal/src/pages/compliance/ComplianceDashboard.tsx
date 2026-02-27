import { useState, useEffect } from 'react';
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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Compliance</h1>
        <Badge>{summary.plan} plan</Badge>
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
        </div>
      </Card>
    </div>
  );
}
