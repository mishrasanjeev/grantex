import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDataPrincipalRecords, withdrawConsent } from '../../api/dpdp';
import type { ConsentRecord } from '../../api/dpdp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { formatDate, truncateId } from '../../lib/format';

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  switch (status) {
    case 'active': return 'success';
    case 'withdrawn': return 'danger';
    case 'expired': return 'warning';
    default: return 'default';
  }
}

export function ConsentRecordList() {
  const [records, setRecords] = useState<ConsentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [principalId, setPrincipalId] = useState('');
  const [searchedPrincipal, setSearchedPrincipal] = useState('');
  const [withdrawTarget, setWithdrawTarget] = useState<ConsentRecord | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  const fetchRecords = useCallback(
    async (pid: string) => {
      if (!pid.trim()) return;
      setLoading(true);
      try {
        const res = await getDataPrincipalRecords(pid.trim());
        setRecords(res.records);
        setSearchedPrincipal(pid.trim());
      } catch {
        show('Failed to load consent records', 'error');
      } finally {
        setLoading(false);
      }
    },
    [show],
  );

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchRecords(principalId);
  }

  async function handleWithdraw() {
    if (!withdrawTarget) return;
    const reason = withdrawReason.trim() || 'Consent withdrawn by data fiduciary';
    setWithdrawing(true);
    try {
      await withdrawConsent(withdrawTarget.recordId, { reason });
      setRecords((prev) =>
        prev.map((r) =>
          r.recordId === withdrawTarget.recordId
            ? { ...r, status: 'withdrawn' as const, withdrawnAt: new Date().toISOString(), withdrawnReason: withdrawReason }
            : r,
        ),
      );
      show('Consent withdrawn', 'success');
    } catch {
      show('Failed to withdraw consent', 'error');
    } finally {
      setWithdrawing(false);
      setWithdrawTarget(null);
      setWithdrawReason('');
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
            <label className="block text-xs font-medium text-gx-muted mb-1">Data Principal ID</label>
            <input
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
                {records.length} record{records.length !== 1 ? 's' : ''} for{' '}
                <span className="font-mono text-gx-accent2">{searchedPrincipal}</span>
              </p>
            </div>
            <Table
              data={records}
              rowKey={(r) => r.recordId}
              onRowClick={(r) => navigate(`/dashboard/dpdp/records/${r.recordId}`)}
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
                    <span className="font-mono text-xs text-gx-muted">{truncateId(r.dataPrincipalId ?? '')}</span>
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
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
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
          </div>
        )}
      </Card>

      {/* Withdraw dialog */}
      <ConfirmDialog
        open={!!withdrawTarget}
        onClose={() => {
          setWithdrawTarget(null);
          setWithdrawReason('');
        }}
        onConfirm={handleWithdraw}
        title="Withdraw Consent"
        message={`Are you sure you want to withdraw consent for record ${withdrawTarget?.recordId ?? ''}? This action cannot be undone.`}
        confirmLabel="Withdraw"
        loading={withdrawing}
      />
    </div>
  );
}
