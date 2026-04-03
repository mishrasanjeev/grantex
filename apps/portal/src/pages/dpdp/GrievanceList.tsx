import { useState } from 'react';
import { fileGrievance, getGrievance } from '../../api/dpdp';
import type { Grievance } from '../../api/dpdp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDate } from '../../lib/format';

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  switch (status) {
    case 'submitted': return 'warning';
    case 'in-progress': return 'default';
    case 'resolved': return 'success';
    case 'rejected': return 'danger';
    default: return 'default';
  }
}

const GRIEVANCE_TYPES = [
  'data-erasure',
  'data-correction',
  'consent-dispute',
  'data-breach',
  'processing-objection',
  'access-request',
  'other',
];

export function GrievanceList() {
  const [grievances, setGrievances] = useState<Grievance[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [filing, setFiling] = useState(false);
  const [lookupId, setLookupId] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [form, setForm] = useState({
    dataPrincipalId: '',
    type: 'data-erasure',
    description: '',
    recordId: '',
  });
  const { show } = useToast();

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupId.trim()) return;
    setLookingUp(true);
    try {
      const g = await getGrievance(lookupId.trim());
      // Add to list if not already present
      setGrievances((prev) => {
        const exists = prev.find((gr) => gr.grievanceId === g.grievanceId);
        if (exists) return prev;
        return [g, ...prev];
      });
    } catch {
      show('Grievance not found', 'error');
    } finally {
      setLookingUp(false);
    }
  }

  async function handleFile(e: React.FormEvent) {
    e.preventDefault();
    if (!form.dataPrincipalId.trim() || !form.description.trim()) return;
    setFiling(true);
    try {
      const res = await fileGrievance({
        dataPrincipalId: form.dataPrincipalId.trim(),
        type: form.type,
        description: form.description.trim(),
        ...(form.recordId.trim() ? { recordId: form.recordId.trim() } : {}),
      });
      // Add filed grievance to list
      setGrievances((prev) => [
        {
          grievanceId: res.grievanceId,
          dataPrincipalId: form.dataPrincipalId.trim(),
          recordId: form.recordId.trim() || null,
          type: res.type,
          description: form.description.trim(),
          evidence: {},
          status: 'submitted' as const,
          referenceNumber: res.referenceNumber,
          expectedResolutionBy: res.expectedResolutionBy,
          resolvedAt: null,
          resolution: null,
          createdAt: res.createdAt,
        },
        ...prev,
      ]);
      show(`Grievance filed: ${res.referenceNumber}`, 'success');
      setShowForm(false);
      setForm({ dataPrincipalId: '', type: 'data-erasure', description: '', recordId: '' });
    } catch {
      show('Failed to file grievance', 'error');
    } finally {
      setFiling(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Grievances</h1>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'File Grievance'}
        </Button>
      </div>

      {/* Lookup */}
      <Card className="mb-6">
        <form onSubmit={handleLookup} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gx-muted mb-1">Grievance ID</label>
            <input
              type="text"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="e.g. grv_01ABCDEF..."
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={lookingUp || !lookupId.trim()}>
            {lookingUp ? <Spinner className="h-3 w-3" /> : 'Lookup'}
          </Button>
        </form>
      </Card>

      {/* File Grievance Form */}
      {showForm && (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">File New Grievance</h2>
          <form onSubmit={handleFile} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID *</label>
                <input
                  type="text"
                  value={form.dataPrincipalId}
                  onChange={(e) => setForm((prev) => ({ ...prev, dataPrincipalId: e.target.value }))}
                  placeholder="e.g. user_123"
                  className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gx-muted mb-1">Type *</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
                  className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
                >
                  {GRIEVANCE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Consent Record ID (optional)</label>
              <input
                type="text"
                value={form.recordId}
                onChange={(e) => setForm((prev) => ({ ...prev, recordId: e.target.value }))}
                placeholder="e.g. crec_..."
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1">Description *</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Describe the grievance..."
                rows={3}
                className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent resize-none"
                required
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" size="sm" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" disabled={filing}>
                {filing ? <Spinner className="h-3 w-3" /> : 'File Grievance'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Grievance Table */}
      <Card className="p-0">
        {grievances.length === 0 ? (
          <EmptyState
            title="No grievances"
            description="File a grievance or look up an existing one by ID."
            action={
              !showForm ? (
                <Button size="sm" onClick={() => setShowForm(true)}>File Grievance</Button>
              ) : undefined
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={grievances}
              rowKey={(g) => g.grievanceId}
              columns={[
                {
                  key: 'ref',
                  header: 'Reference #',
                  render: (g) => (
                    <span className="font-mono text-xs font-medium text-gx-accent2">
                      {g.referenceNumber}
                    </span>
                  ),
                },
                {
                  key: 'principal',
                  header: 'Principal',
                  render: (g) => (
                    <span className="font-mono text-xs text-gx-muted">{g.dataPrincipalId}</span>
                  ),
                },
                {
                  key: 'type',
                  header: 'Type',
                  render: (g) => (
                    <span className="text-sm text-gx-text">{g.type}</span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (g) => (
                    <Badge variant={statusVariant(g.status)}>{g.status}</Badge>
                  ),
                },
                {
                  key: 'filed',
                  header: 'Filed At',
                  render: (g) => (
                    <span className="text-gx-muted text-xs">{formatDate(g.createdAt)}</span>
                  ),
                },
                {
                  key: 'resolution',
                  header: 'Expected Resolution',
                  render: (g) => (
                    <span className="text-gx-muted text-xs">{formatDate(g.expectedResolutionBy)}</span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
