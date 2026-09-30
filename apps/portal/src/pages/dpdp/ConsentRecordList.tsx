import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { listConsentRecords, requestErasure, withdrawConsent } from '../../api/dpdp';
import type { ConsentRecord, ErasureRequest, WithdrawConsentRequest } from '../../api/dpdp';
import { ApiError } from '../../api/client';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { formatDate, formatDateTime, truncateId } from '../../lib/format';
import { consentStatusVariant } from './status';
import { WithdrawConsentDialog, withdrawErrorMessage, withdrawSuccessMessage } from './WithdrawConsentDialog';

const PAGE_SIZE = 50;

export function ConsentRecordList() {
  const [records, setRecords] = useState<ConsentRecord[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [principalId, setPrincipalId] = useState('');
  const [searchedPrincipal, setSearchedPrincipal] = useState('');
  const [withdrawTarget, setWithdrawTarget] = useState<ConsentRecord | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [showErase, setShowErase] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [erasure, setErasure] = useState<ErasureRequest | null>(null);
  const navigate = useNavigate();
  const { show } = useToast();

  const fetchRecords = useCallback(
    async (pid: string) => {
      const id = pid.trim();
      if (!id) return;
      setLoading(true);
      try {
        const res = await listConsentRecords({ dataPrincipalId: id, limit: PAGE_SIZE });
        setRecords(res.records);
        setTotalRecords(res.totalRecords);
        setNextCursor(res.nextCursor);
        setSearchedPrincipal(id);
      } catch {
        show('Failed to load consent records', 'error');
      } finally {
        setLoading(false);
      }
    },
    [show],
  );

  async function loadMore() {
    if (!nextCursor || !searchedPrincipal) return;
    setLoadingMore(true);
    try {
      const res = await listConsentRecords({ dataPrincipalId: searchedPrincipal, limit: PAGE_SIZE, cursor: nextCursor });
      setRecords((prev) => [...prev, ...res.records]);
      setTotalRecords(res.totalRecords);
      setNextCursor(res.nextCursor);
    } catch {
      show('Failed to load consent records', 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setErasure(null);
    void fetchRecords(principalId);
  }

  async function handleWithdraw(request: WithdrawConsentRequest) {
    if (!withdrawTarget) return;
    const target = withdrawTarget;
    setWithdrawing(true);
    try {
      const res = await withdrawConsent(target.recordId, request);
      setRecords((prev) =>
        prev.map((r) =>
          r.recordId === target.recordId
            ? { ...r, status: res.status, withdrawnAt: res.withdrawnAt, withdrawnReason: request.reason }
            : r,
        ),
      );
      show(withdrawSuccessMessage(res.grantRevoked), 'success');
    } catch (err) {
      const { message, conflict } = withdrawErrorMessage(err);
      show(message, 'error');
      if (conflict) void fetchRecords(searchedPrincipal);
    } finally {
      setWithdrawing(false);
      setWithdrawTarget(null);
    }
  }

  async function handleErase() {
    if (!searchedPrincipal) return;
    setErasing(true);
    try {
      const res = await requestErasure(searchedPrincipal);
      setErasure(res);
      show(`Erasure ${res.requestId} completed`, 'success');
      void fetchRecords(searchedPrincipal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        show(`No consent records found for ${searchedPrincipal}; nothing was erased.`, 'error');
      } else {
        show('Erasure failed', 'error');
      }
    } finally {
      setErasing(false);
      setShowErase(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Consent Records</h1>
      </div>

      {/* Search */}
      <Card className="mb-6">
        <form onSubmit={handleSearch} className="flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor="consent-search-principal" className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID</label>
            <input
              id="consent-search-principal"
              type="text"
              value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
              placeholder="e.g. user_123"
              className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
            />
          </div>
          <Button type="submit" size="sm" disabled={loading || !principalId.trim()}>
            {loading ? <Spinner className="h-3 w-3" /> : 'Search'}
          </Button>
        </form>
      </Card>

      {erasure && <ErasureResult erasure={erasure} />}

      {/* Results */}
      <Card className="p-0">
        {!searchedPrincipal ? (
          <EmptyState
            title="Search for consent records"
            description="Enter a data principal ID to view their consent records."
          />
        ) : records.length === 0 ? (
          <EmptyState
            title="No consent records"
            description={`No consent records found for ${searchedPrincipal}.`}
          />
        ) : (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gx-muted">
                Showing {records.length} of {totalRecords} record{totalRecords !== 1 ? 's' : ''} for{' '}
                <span className="font-mono text-gx-accent2">{searchedPrincipal}</span>
              </p>
              <Button variant="danger" size="sm" onClick={() => setShowErase(true)}>
                Erase data principal
              </Button>
            </div>
            <Table
              data={records}
              rowKey={(r) => r.recordId}
              onRowClick={(r) => navigate(`/dashboard/dpdp/records/${encodeURIComponent(r.recordId)}`)}
              columns={[
                {
                  key: 'id',
                  header: 'Record ID',
                  render: (r) => (
                    <span className="font-mono text-xs text-gx-accent2">{truncateId(r.recordId)}</span>
                  ),
                },
                {
                  key: 'principal',
                  header: 'Principal',
                  render: (r) => (
                    <span className="font-mono text-xs text-gx-muted">
                      {truncateId(r.dataPrincipalId ?? searchedPrincipal)}
                    </span>
                  ),
                },
                {
                  key: 'purpose',
                  header: 'Purpose',
                  render: (r) => (
                    <span className="text-sm text-gx-text">
                      {r.purposes.map((p) => p.code).join(', ')}
                    </span>
                  ),
                },
                {
                  key: 'grant',
                  header: 'Grant',
                  render: (r) => (
                    <span className="font-mono text-xs text-gx-muted">{truncateId(r.grantId)}</span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (r) => (
                    <Badge variant={consentStatusVariant(r.status)}>{r.status}</Badge>
                  ),
                },
                {
                  key: 'consented',
                  header: 'Consented At',
                  render: (r) => (
                    <span className="text-gx-muted text-xs">{formatDate(r.consentGivenAt)}</span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (r) =>
                    r.status === 'active' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWithdrawTarget(r);
                        }}
                      >
                        Withdraw
                      </Button>
                    ) : null,
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

      <WithdrawConsentDialog
        open={!!withdrawTarget}
        recordId={withdrawTarget?.recordId ?? ''}
        grantId={withdrawTarget?.grantId ?? ''}
        loading={withdrawing}
        onClose={() => setWithdrawTarget(null)}
        onConfirm={handleWithdraw}
      />

      <Modal open={showErase} onClose={() => setShowErase(false)} title="Erase Data Principal">
        <div className="space-y-4 text-sm">
          <p className="text-gx-muted">
            Erase <span className="font-mono text-gx-text">{searchedPrincipal}</span> (DPDP s.12). This takes effect
            immediately and cannot be undone.
          </p>
          <div>
            <p className="text-xs font-medium text-gx-text mb-1">What is erased</p>
            <ul className="list-disc ml-5 space-y-1 text-gx-muted">
              <li>Grants for this data principal are revoked, including grants delegated from them.</li>
              <li>Consent records are marked erased; processing under them stops.</li>
              <li>Grievance descriptions and evidence are redacted.</li>
              <li>Stored exports are deleted.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium text-gx-text mb-1">What is retained</p>
            <ul className="list-disc ml-5 space-y-1 text-gx-muted">
              <li>Consent records are kept (marked erased) as proof that consent was given.</li>
              <li>The audit log is retained unchanged; its entries form a tamper-evident chain.</li>
              <li>Grievances are kept as the record of grievance handling, with their text redacted.</li>
              <li>Personal data held in your own systems and your processors&apos; must be erased there.</li>
            </ul>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" size="sm" onClick={() => setShowErase(false)} disabled={erasing}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleErase} disabled={erasing}>
              Erase
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ErasureResult({ erasure }: { erasure: ErasureRequest }) {
  const counts: [string, number][] = [
    ['Records erased', erasure.recordsErased],
    ['Grants revoked', erasure.grantsRevoked],
    ['Delegated grants revoked', erasure.delegatedGrantsRevoked],
    ['Grievances redacted', erasure.grievancesRedacted],
    ['Exports deleted', erasure.exportsDeleted],
  ];
  return (
    <section aria-label="Erasure result" className="mb-6">
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gx-text">Erasure {erasure.status}</h2>
          <code className="text-xs font-mono text-gx-accent2">{erasure.requestId}</code>
        </div>
        <p className="text-xs text-gx-muted mb-4">
          <span className="font-mono">{erasure.dataPrincipalId}</span>, completed {formatDateTime(erasure.completedAt)}
        </p>
        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          {counts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-gx-muted">{label}</dt>
              <dd className="text-lg font-mono text-gx-text">{value}</dd>
            </div>
          ))}
        </dl>
        <h3 className="text-xs font-medium text-gx-text mb-2">Retained</h3>
        <ul className="space-y-2">
          {erasure.retained.map((item) => (
            <li key={item.category} className="text-xs">
              <p className="text-gx-text">
                <span className="font-mono">{item.category}</span>
                {item.count !== undefined && <span className="text-gx-muted"> ({item.count})</span>}
              </p>
              <p className="text-gx-muted">{item.reason}</p>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
