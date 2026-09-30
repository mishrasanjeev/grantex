import { useState } from 'react';
import { createExport, getExport } from '../../api/dpdp';
import type { DpdpExport, CreateExportRequest, ExportType } from '../../api/dpdp';
import { ApiError } from '../../api/client';
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

/** Start of a calendar day (YYYY-MM-DD) in UTC. */
function startOfDayUtc(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** End of a calendar day (YYYY-MM-DD) in UTC, so the whole day is included. */
function endOfDayUtc(date: string): string {
  return `${date}T23:59:59.999Z`;
}

const EXPORT_TYPES: { value: ExportType; label: string; description: string }[] = [
  { value: 'dpdp-audit', label: 'DPDP Audit', description: 'Consent records, grievances and audit log to help evidence DPDP Act obligations' },
  { value: 'gdpr-article-15', label: 'GDPR Article 15', description: 'Access export to help evidence answers to GDPR Art. 15 requests' },
  { value: 'eu-ai-act-conformance', label: 'EU AI Act Conformance', description: 'AI system audit trail to help evidence EU AI Act record-keeping' },
];

export function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [recentExports, setRecentExports] = useState<DpdpExport[]>([]);
  const [lookupId, setLookupId] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [form, setForm] = useState({
    type: 'dpdp-audit' as CreateExportRequest['type'],
    dateFrom: '',
    dateTo: '',
    includeActionLog: true,
    includeConsentRecords: true,
    dataPrincipalId: '',
  });
  const { show } = useToast();

  // Default date range: the last 30 days, including today (UTC dates).
  const today = new Date().toISOString().split('T')[0]!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]!;

  function remember(exp: DpdpExport) {
    setRecentExports((prev) => [exp, ...prev.filter((e) => e.exportId !== exp.exportId)]);
  }

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    const dateFrom = startOfDayUtc(form.dateFrom || thirtyDaysAgo);
    const dateTo = endOfDayUtc(form.dateTo || today);

    setExporting(true);
    try {
      const result = await createExport({
        type: form.type,
        dateFrom,
        dateTo,
        includeActionLog: form.includeActionLog,
        includeConsentRecords: form.includeConsentRecords,
        ...(form.dataPrincipalId.trim() ? { dataPrincipalId: form.dataPrincipalId.trim() } : {}),
      });

      remember(result);

      if (result.data) {
        downloadJson(result.data, `grantex-${form.type}-${Date.now()}.json`);
      }

      show(`Export generated: ${result.recordCount} records`, 'success');
    } catch {
      show('Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const id = lookupId.trim();
    if (!id) return;
    setLookingUp(true);
    try {
      remember(await getExport(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        show('This export has expired and its data was purged. Generate a new export.', 'error');
      } else if (err instanceof ApiError && err.status === 404) {
        show('Export not found', 'error');
      } else {
        show('Failed to load export', 'error');
      }
    } finally {
      setLookingUp(false);
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
              <label htmlFor="export-date-from" className="block text-xs font-medium text-gx-muted mb-1">Date From</label>
              <input
                id="export-date-from"
                type="date"
                value={form.dateFrom || thirtyDaysAgo}
                onChange={(e) => setForm((prev) => ({ ...prev, dateFrom: e.target.value }))}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
              />
            </div>
            <div>
              <label htmlFor="export-date-to" className="block text-xs font-medium text-gx-muted mb-1">Date To</label>
              <input
                id="export-date-to"
                type="date"
                value={form.dateTo || today}
                onChange={(e) => setForm((prev) => ({ ...prev, dateTo: e.target.value }))}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
              />
            </div>
          </div>
          <p className="text-xs text-gx-muted">
            Dates are UTC and inclusive: the export covers the start of the first day to the end of the last day. Exports are JSON.
          </p>

          {/* Options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="export-principal" className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID (optional)</label>
              <input
                id="export-principal"
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

      {/* Fetch an existing export */}
      <Card className="mb-8">
        <form onSubmit={handleLookup} className="flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor="export-lookup" className="block text-xs font-medium text-gx-muted mb-1">Export ID</label>
            <input
              id="export-lookup"
              type="text"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="e.g. exp_01ABCDEF..."
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={lookingUp || !lookupId.trim()}>
            {lookingUp ? <Spinner className="h-3 w-3" /> : 'Fetch'}
          </Button>
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
                    {exp.truncated && <Badge variant="warning">truncated</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-gx-muted">
                    <span>{exp.recordCount} records</span>
                    {exp.truncated && <span>Audit log capped at {exp.auditLogLimit} entries</span>}
                    <span>Created {formatDateTime(exp.createdAt)}</span>
                    <span>Expires {formatDateTime(exp.expiresAt)}</span>
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
