import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getBudget, listTransactions } from '../../api/budgets';
import type { BudgetAllocation, BudgetTransaction } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { formatDate, formatDateTime, truncateId } from '../../lib/format';

export function BudgetDetail() {
  const { grantId } = useParams<{ grantId: string }>();
  const [allocation, setAllocation] = useState<BudgetAllocation | null>(null);
  const [transactions, setTransactions] = useState<BudgetTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const { show } = useToast();

  useEffect(() => {
    if (!grantId) return;
    Promise.all([
      getBudget(grantId),
      listTransactions(grantId, page),
    ])
      .then(([alloc, txRes]) => {
        setAllocation(alloc);
        setTransactions(txRes.transactions);
        setTotal(txRes.total);
      })
      .catch(() => show('Failed to load budget details', 'error'))
      .finally(() => setLoading(false));
  }, [grantId, page, show]);

  if (loading) return <Spinner />;
  if (!allocation) return <p className="text-gx-muted">Budget allocation not found.</p>;

  const initial = parseFloat(allocation.initialBudget);
  const remaining = parseFloat(allocation.remainingBudget);
  const spent = initial - remaining;
  const pct = initial > 0 ? Math.round((spent / initial) * 100) : 0;
  const pageSize = 20;
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <Link to="/dashboard/budgets" className="text-gx-muted hover:text-gx-text transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </Link>
        <h1 className="text-xl font-semibold text-gx-text">
          Budget — <span className="font-mono">{truncateId(grantId!)}</span>
        </h1>
      </div>

      {/* Spending bar */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm text-gx-muted">Spending</p>
            <p className="text-lg font-semibold text-gx-text">
              ${spent.toFixed(2)} / ${initial.toFixed(2)} {allocation.currency}
            </p>
          </div>
          <span className="text-2xl font-bold text-gx-accent">{pct}%</span>
        </div>
        <div className="w-full h-3 rounded-full bg-gx-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${pct >= 80 ? 'bg-gx-warning' : 'bg-gx-accent'}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-gx-muted">
          <span>Remaining: ${remaining.toFixed(2)}</span>
          <span>Created: {formatDate(allocation.createdAt)}</span>
        </div>
      </Card>

      {/* Transaction history */}
      <h2 className="text-lg font-semibold text-gx-text mb-4">Transactions</h2>
      <Card className="p-0">
        {transactions.length === 0 ? (
          <p className="p-6 text-center text-gx-muted">No transactions yet.</p>
        ) : (
          <div className="p-4">
            <Table
              data={transactions}
              rowKey={(t) => t.id}
              columns={[
                {
                  key: 'id',
                  header: 'ID',
                  render: (t) => <span className="font-mono text-sm text-gx-muted">{truncateId(t.id)}</span>,
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  render: (t) => (
                    <span className="font-medium text-gx-text">-${parseFloat(t.amount).toFixed(2)}</span>
                  ),
                },
                {
                  key: 'description',
                  header: 'Description',
                  render: (t) => <span className="text-gx-text">{t.description || '—'}</span>,
                },
                {
                  key: 'createdAt',
                  header: 'Date',
                  render: (t) => <span className="text-gx-muted text-sm">{formatDateTime(t.createdAt)}</span>,
                },
              ]}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gx-border">
                <span className="text-sm text-gx-muted">
                  Page {page} of {totalPages} ({total} total)
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
