import { useState, useEffect, useCallback, useId } from 'react';
import { fileGrievance, getGrievance, listGrievances, updateGrievance } from '../../api/dpdp';
import type { Grievance, GrievanceStatus, GrievanceSummary, UpdateGrievanceRequest } from '../../api/dpdp';
import { ApiError } from '../../api/client';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { formatDate } from '../../lib/format';
import { grievanceStatusLabel, grievanceStatusVariant, isGrievanceOverdue } from './status';

const PAGE_SIZE = 50;

/** Suggestions only: the server accepts any type up to 128 characters. */
const GRIEVANCE_TYPE_SUGGESTIONS = [
  'consent-violation',
  'data-breach',
  'unauthorized-processing',
  'data-correction',
  'data-erasure',
  'access-request',
];

const STATUS_FILTERS: { value: '' | GrievanceStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'in_review', label: 'In review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'rejected', label: 'Rejected' },
];

const EMPTY_FORM = {
  dataPrincipalId: '',
  type: 'consent-violation',
  description: '',
  recordId: '',
  responsePeriodDays: '',
};

const inputClass =
  'w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent';

type FinalStatus = 'resolved' | 'rejected';

export function GrievanceList() {
  const [grievances, setGrievances] = useState<GrievanceSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | GrievanceStatus>('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [filing, setFiling] = useState(false);
  const [formError, setFormError] = useState('');
  const [lookupId, setLookupId] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [lookedUp, setLookedUp] = useState<Grievance | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [finalTarget, setFinalTarget] = useState<{ grievance: GrievanceSummary; status: FinalStatus } | null>(null);
  const [resolution, setResolution] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const { show } = useToast();
  const ids = { principal: useId(), type: useId(), record: useId(), period: useId(), description: useId(), status: useId(), resolution: useId() };

  const load = useCallback(async (status: '' | GrievanceStatus) => {
    setLoading(true);
    try {
      const res = await listGrievances({ ...(status ? { status } : {}), limit: PAGE_SIZE });
      setGrievances(res.grievances);
      setNextCursor(res.nextCursor);
    } catch {
      show('Failed to load grievances', 'error');
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    void load(statusFilter);
  }, [load, statusFilter]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await listGrievances({ ...(statusFilter ? { status: statusFilter } : {}), limit: PAGE_SIZE, cursor: nextCursor });
      setGrievances((prev) => [...prev, ...res.grievances]);
      setNextCursor(res.nextCursor);
    } catch {
      show('Failed to load grievances', 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupId.trim()) return;
    setLookingUp(true);
    try {
      setLookedUp(await getGrievance(lookupId.trim()));
    } catch {
      setLookedUp(null);
      show('Grievance not found', 'error');
    } finally {
      setLookingUp(false);
    }
  }

  async function applyUpdate(g: GrievanceSummary, request: UpdateGrievanceRequest) {
    setUpdatingId(g.grievanceId);
    try {
      const updated = await updateGrievance(g.grievanceId, request);
      // Under a status filter, a row that moved to another status no longer belongs on this page.
      setGrievances((prev) =>
        statusFilter && updated.status !== statusFilter
          ? prev.filter((x) => x.grievanceId !== updated.grievanceId)
          : prev.map((x) => (x.grievanceId === updated.grievanceId ? { ...x, ...updated } : x)),
      );
      if (lookedUp?.grievanceId === updated.grievanceId) setLookedUp(updated);
      show(`Grievance ${updated.referenceNumber} is now ${grievanceStatusLabel(updated.status)}`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'INVALID_TRANSITION') {
        show('This grievance has already moved to another status. The list has been refreshed.', 'error');
        void load(statusFilter);
      } else if (err instanceof ApiError && err.status === 404) {
        show('Grievance not found. The list has been refreshed.', 'error');
        void load(statusFilter);
      } else {
        show('Failed to update grievance', 'error');
      }
    } finally {
      setUpdatingId(null);
      setFinalTarget(null);
      setResolution('');
    }
  }

  async function handleFile(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!form.dataPrincipalId.trim() || !form.description.trim() || !form.type.trim()) return;
    let responsePeriodDays: number | undefined;
    if (form.responsePeriodDays.trim()) {
      const n = Number(form.responsePeriodDays);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        setFormError('Response period must be a whole number of days from 1 to 90.');
        return;
      }
      responsePeriodDays = n;
    }
    setFiling(true);
    try {
      const res = await fileGrievance({
        dataPrincipalId: form.dataPrincipalId.trim(),
        type: form.type.trim(),
        description: form.description.trim(),
        ...(form.recordId.trim() ? { recordId: form.recordId.trim() } : {}),
        ...(responsePeriodDays !== undefined ? { responsePeriodDays } : {}),
      });
      show(`Grievance filed: ${res.referenceNumber}`, 'success');
      setShowForm(false);
      setForm(EMPTY_FORM);
      void load(statusFilter);
    } catch {
      show('Failed to file grievance', 'error');
    } finally {
      setFiling(false);
    }
  }

  function actions(g: GrievanceSummary) {
    const busy = updatingId === g.grievanceId;
    if (g.status === 'submitted') {
      return (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => applyUpdate(g, { status: 'in_review' })}>
          Start review
        </Button>
      );
    }
    if (g.status === 'in_review') {
      return (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setFinalTarget({ grievance: g, status: 'resolved' })}>
            Resolve
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFinalTarget({ grievance: g, status: 'rejected' })}>
            Reject
          </Button>
        </div>
      );
    }
    return null;
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
              className={inputClass}
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={lookingUp || !lookupId.trim()}>
            {lookingUp ? <Spinner className="h-3 w-3" /> : 'Lookup'}
          </Button>
        </form>
        {lookedUp && (
          <div className="mt-4 p-3 bg-gx-bg rounded-md border border-gx-border text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-gx-accent2">{lookedUp.referenceNumber}</span>
              <Badge variant={grievanceStatusVariant(lookedUp.status)}>{grievanceStatusLabel(lookedUp.status)}</Badge>
              <span className="text-xs text-gx-muted">{lookedUp.type}</span>
            </div>
            <p className="text-gx-text">{lookedUp.description}</p>
            {lookedUp.resolution && <p className="text-xs text-gx-muted">Resolution: {lookedUp.resolution}</p>}
          </div>
        )}
      </Card>

      {/* File Grievance Form */}
      {showForm && (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">File New Grievance</h2>
          <form onSubmit={handleFile} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={ids.principal} className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID *</label>
                <input
                  id={ids.principal}
                  type="text"
                  value={form.dataPrincipalId}
                  onChange={(e) => setForm((prev) => ({ ...prev, dataPrincipalId: e.target.value }))}
                  placeholder="e.g. user_123"
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label htmlFor={ids.type} className="block text-xs font-medium text-gx-muted mb-1">Type *</label>
                <input
                  id={ids.type}
                  type="text"
                  list={`${ids.type}-suggestions`}
                  maxLength={128}
                  value={form.type}
                  onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
                  className={inputClass}
                  required
                />
                <datalist id={`${ids.type}-suggestions`}>
                  {GRIEVANCE_TYPE_SUGGESTIONS.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={ids.record} className="block text-xs font-medium text-gx-muted mb-1">Consent Record ID (optional)</label>
                <input
                  id={ids.record}
                  type="text"
                  value={form.recordId}
                  onChange={(e) => setForm((prev) => ({ ...prev, recordId: e.target.value }))}
                  placeholder="e.g. crec_..."
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor={ids.period} className="block text-xs font-medium text-gx-muted mb-1">
                  Response period (days)
                </label>
                <input
                  id={ids.period}
                  type="text"
                  inputMode="numeric"
                  value={form.responsePeriodDays}
                  onChange={(e) => setForm((prev) => ({ ...prev, responsePeriodDays: e.target.value }))}
                  placeholder="Optional, 1-90 (default 7)"
                  className={inputClass}
                />
                <p className="text-xs text-gx-muted mt-1">
                  The response period you publish to data principals, at most 90 days. The 7-day default is a product default.
                </p>
              </div>
            </div>
            <div>
              <label htmlFor={ids.description} className="block text-xs font-medium text-gx-muted mb-1">Description *</label>
              <textarea
                id={ids.description}
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Describe the grievance..."
                rows={3}
                className={`${inputClass} resize-none`}
                required
              />
            </div>
            {formError && <p className="text-xs text-gx-danger">{formError}</p>}
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

      {/* Filter */}
      <div className="flex items-end gap-3 mb-3">
        <div>
          <label htmlFor={ids.status} className="block text-xs font-medium text-gx-muted mb-1">Status</label>
          <select
            id={ids.status}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | GrievanceStatus)}
            className="px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Grievance Table */}
      <Card className="p-0">
        {loading && grievances.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="h-6 w-6" />
          </div>
        ) : grievances.length === 0 ? (
          <EmptyState
            title="No grievances"
            description={statusFilter ? 'No grievances with this status.' : 'No grievances have been filed yet.'}
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
                    <span className="font-mono text-xs font-medium text-gx-accent2">{g.referenceNumber}</span>
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
                  render: (g) => <span className="text-sm text-gx-text">{g.type}</span>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (g) => (
                    <Badge variant={grievanceStatusVariant(g.status)}>{grievanceStatusLabel(g.status)}</Badge>
                  ),
                },
                {
                  key: 'filed',
                  header: 'Filed At',
                  render: (g) => <span className="text-gx-muted text-xs">{formatDate(g.createdAt)}</span>,
                },
                {
                  key: 'period',
                  header: 'Response Period',
                  render: (g) => (
                    <span className="text-gx-muted text-xs">
                      {g.responsePeriodDays} day{g.responsePeriodDays !== 1 ? 's' : ''}
                    </span>
                  ),
                },
                {
                  key: 'due',
                  header: 'Response Due',
                  render: (g) => (
                    <span className="flex items-center gap-2 text-xs">
                      <span className={isGrievanceOverdue(g) ? 'text-gx-danger' : 'text-gx-muted'}>
                        {formatDate(g.expectedResolutionBy)}
                      </span>
                      {isGrievanceOverdue(g) && <Badge variant="danger">overdue</Badge>}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: actions,
                },
              ]}
            />
            {nextCursor && (
              <div className="flex justify-center mt-4">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <Spinner className="h-3 w-3" /> : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Modal
        open={!!finalTarget}
        onClose={() => { setFinalTarget(null); setResolution(''); }}
        title={finalTarget?.status === 'rejected' ? 'Reject Grievance' : 'Resolve Grievance'}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!finalTarget || !resolution.trim()) return;
            void applyUpdate(finalTarget.grievance, { status: finalTarget.status, resolution: resolution.trim() });
          }}
          className="space-y-4"
        >
          <p className="text-sm text-gx-muted">
            Grievance <span className="font-mono text-gx-text">{finalTarget?.grievance.referenceNumber}</span> will be
            closed as {finalTarget?.status}. Closed grievances cannot change status again.
          </p>
          <div>
            <label htmlFor={ids.resolution} className="block text-xs font-medium text-gx-muted mb-1">
              Resolution (required)
            </label>
            <textarea
              id={ids.resolution}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={3}
              placeholder="What was done, as communicated to the data principal"
              className={`${inputClass} resize-none`}
              required
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => { setFinalTarget(null); setResolution(''); }}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={finalTarget?.status === 'rejected' ? 'danger' : 'primary'}
              size="sm"
              disabled={!resolution.trim() || updatingId !== null}
            >
              {finalTarget?.status === 'rejected' ? 'Mark rejected' : 'Mark resolved'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
