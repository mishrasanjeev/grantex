import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { listBudgets } from '../../api/budgets';
import type { BudgetAllocation } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { formatDate, truncateId } from '../../lib/format';

function usagePercent(initial: string, remaining: string): number {
  const i = parseFloat(initial);
  if (i === 0) return 0;
  return Math.round(((i - parseFloat(remaining)) / i) * 100);
}

function usageBadge(pct: number) {
  if (pct >= 100) return <Badge variant="danger">Exhausted</Badge>;
  if (pct >= 80) return <Badge variant="warning">{'>'} 80%</Badge>;
  if (pct >= 50) return <Badge variant="info">{'>'} 50%</Badge>;
  return <Badge variant="success">Healthy</Badge>;
}

export function BudgetList() {
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listBudgets()
      .then(setAllocations)
      .catch(() => show('Failed to load budgets', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  if (loading) return <Spinner />;

  // Summary stats
  const totalAllocated = allocations.reduce((s, a) => s + parseFloat(a.initialBudget), 0);
  const totalRemaining = allocations.reduce((s, a) => s + parseFloat(a.remainingBudget), 0);
  const totalSpent = totalAllocated - totalRemaining;

  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Budgets</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-sm text-gx-muted">Total Allocated</p>
          <p className="text-2xl font-semibold text-gx-text mt-1">${totalAllocated.toFixed(2)}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Total Spent</p>
          <p className="text-2xl font-semibold text-gx-warning mt-1">${totalSpent.toFixed(2)}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Total Remaining</p>
          <p className="text-2xl font-semibold text-gx-accent mt-1">${totalRemaining.toFixed(2)}</p>
        </Card>
      </div>

      {/* Allocations table */}
      <Card className="p-0">
        {allocations.length === 0 ? (
          <EmptyState title="No budget allocations" description="Allocate a budget to a grant to get started." />
        ) : (
          <div className="p-4">
            <Table
              data={allocations}
              rowKey={(a) => a.id}
              onRowClick={(a) => navigate(`/dashboard/budgets/${a.grantId}`)}
              columns={[
                {
                  key: 'grantId',
                  header: 'Grant',
                  render: (a) => (
                    <span className="font-mono text-sm text-gx-text">{truncateId(a.grantId)}</span>
                  ),
                },
                {
                  key: 'initial',
                  header: 'Allocated',
                  render: (a) => (
                    <span className="text-gx-text">${parseFloat(a.initialBudget).toFixed(2)} {a.currency}</span>
                  ),
                },
                {
                  key: 'remaining',
                  header: 'Remaining',
                  render: (a) => (
                    <span className="text-gx-text">${parseFloat(a.remainingBudget).toFixed(2)}</span>
                  ),
                },
                {
                  key: 'usage',
                  header: 'Usage',
                  render: (a) => {
                    const pct = usagePercent(a.initialBudget, a.remainingBudget);
                    return (
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 rounded-full bg-gx-border overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct >= 80 ? 'bg-gx-warning' : 'bg-gx-accent'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gx-muted">{pct}%</span>
                      </div>
                    );
                  },
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (a) => usageBadge(usagePercent(a.initialBudget, a.remainingBudget)),
                },
                {
                  key: 'createdAt',
                  header: 'Created',
                  render: (a) => <span className="text-gx-muted text-sm">{formatDate(a.createdAt)}</span>,
                },
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
