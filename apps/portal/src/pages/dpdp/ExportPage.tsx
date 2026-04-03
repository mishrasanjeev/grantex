import { useState } from 'react';
import { createExport } from '../../api/dpdp';
import type { DpdpExport, CreateExportRequest } from '../../api/dpdp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { formatDateTime } from '../../lib/format';

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EXPORT_TYPES: { value: CreateExportRequest['type']; label: string; description: string }[] = [
  { value: 'dpdp-audit', label: 'DPDP Audit', description: 'Consent records, grievances, and audit log for DPDP Act 2023 compliance' },
  { value: 'gdpr-article-15', label: 'GDPR Article 15', description: 'Right of access export for GDPR compliance' },
  { value: 'eu-ai-act-conformance', label: 'EU AI Act Conformance', description: 'AI system audit trail for EU AI Act compliance' },
];

export function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [recentExports, setRecentExports] = useState<DpdpExport[]>([]);
  const [form, setForm] = useState({
    type: 'dpdp-audit' as CreateExportRequest['type'],
    dateFrom: '',
    dateTo: '',
    format: 'json',
    includeActionLog: true,
    includeConsentRecords: true,
    dataPrincipalId: '',
  });
  const { show } = useToast();

  // Set default date range (last 30 days)
  const today = new Date().toISOString().split('T')[0]!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]!;

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    const dateFrom = form.dateFrom || thirtyDaysAgo;
    const dateTo = form.dateTo || today;

    setExporting(true);
    try {
      const result = await createExport({
        type: form.type,
        dateFrom,
        dateTo,
        format: form.format,
        includeActionLog: form.includeActionLog,
        includeConsentRecords: form.includeConsentRecords,
        ...(form.dataPrincipalId.trim() ? { dataPrincipalId: form.dataPrincipalId.trim() } : {}),
      });

      setRecentExports((prev) => [result, ...prev]);

      // Auto-download if JSON format
      if (form.format === 'json' && result.data) {
        downloadJson(result.data, `grantex-${form.type}-${Date.now()}.json`);
      }

      show(`Export generated: ${result.recordCount} records`, 'success');
    } catch {
      show('Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Compliance Exports</h1>
      </div>

      {/* Export Form */}
      <Card className="mb-8">
        <h2 className="text-sm font-semibold text-gx-text mb-4">Generate Export</h2>
        <form onSubmit={handleExport} className="space-y-4">
          {/* Export Type */}
          <div>
            <label className="block text-xs font-medium text-gx-muted mb-2">Export Type</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {EXPORT_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, type: t.value }))}
                  className={`text-left p-3 rounded-md border transition-colors ${
                    form.type === t.value
                      ? 'border-gx-accent bg-gx-accent/5'
                      : 'border-gx-border bg-gx-bg hover:border-gx-muted'
                  }`}
                >
                  <p className={`text-sm font-medium ${form.type === t.value ? 'text-gx-accent' : 'text-gx-text'}`}>
                    {t.label}
                  </p>
                  <p className="text-xs text-gx-muted mt-0.5">{t.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Date From</label>
              <input
                type="date"
                value={form.dateFrom || thirtyDaysAgo}
                onChange={(e) => setForm((prev) => ({ ...prev, dateFrom: e.target.value }))}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Date To</label>
              <input
                type="date"
                value={form.dateTo || today}
                onChange={(e) => setForm((prev) => ({ ...prev, dateTo: e.target.value }))}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
              />
            </div>
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Format</label>
              <select
                value={form.format}
                onChange={(e) => setForm((prev) => ({ ...prev, format: e.target.value }))}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID (optional)</label>
              <input
                type="text"
                value={form.dataPrincipalId}
                onChange={(e) => setForm((prev) => ({ ...prev, dataPrincipalId: e.target.value }))}
                placeholder="Filter by principal"
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
              />
            </div>
          </div>

          {/* Checkboxes */}
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.includeConsentRecords}
                onChange={(e) => setForm((prev) => ({ ...prev, includeConsentRecords: e.target.checked }))}
                className="rounded border-gx-border text-gx-accent focus:ring-gx-accent"
              />
              <span className="text-sm text-gx-text">Include Consent Records</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.includeActionLog}
                onChange={(e) => setForm((prev) => ({ ...prev, includeActionLog: e.target.checked }))}
                className="rounded border-gx-border text-gx-accent focus:ring-gx-accent"
              />
              <span className="text-sm text-gx-text">Include Action Log</span>
            </label>
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={exporting}>
              {exporting ? (
                <>
                  <Spinner className="h-3 w-3" />
                  Generating...
                </>
              ) : (
                'Generate Export'
              )}
            </Button>
          </div>
        </form>
      </Card>

      {/* Recent Exports */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">Recent Exports</h2>
        {recentExports.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">No exports generated yet in this session</p>
        ) : (
          <div className="space-y-3">
            {recentExports.map((exp) => (
              <div
                key={exp.exportId}
                className="flex items-center justify-between p-3 bg-gx-bg rounded-md border border-gx-border"
              >
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gx-text">
                      {EXPORT_TYPES.find((t) => t.value === exp.type)?.label ?? exp.type}
                    </span>
                    <Badge variant="success">complete</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gx-muted">
                    <span>{exp.recordCount} records</span>
                    <span>{exp.format.toUpperCase()}</span>
                    <span>{formatDateTime(exp.createdAt)}</span>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (exp.data) {
                      downloadJson(exp.data, `grantex-${exp.type}-${exp.exportId}.json`);
                    }
                  }}
                  disabled={!exp.data}
                >
                  Download
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
