import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { listAuditEntries } from '../../api/audit';
import type { AuditEntry } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { DateRangeFilter, filterByDays } from '../../components/ui/DateRangeFilter';
import { formatDateTime, truncateId } from '../../lib/format';

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(0);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    listAuditEntries()
      .then(setEntries)
      .catch(() => show('Failed to load audit entries', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  const filtered = useMemo(() => {
    let result = filterByDays(entries, days, (e) => e.timestamp);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.action.toLowerCase().includes(q) ||
          e.agentId.toLowerCase().includes(q) ||
          e.grantId.toLowerCase().includes(q) ||
          e.principalId.toLowerCase().includes(q) ||
          e.entryId.toLowerCase().includes(q),
      );
    }
    return result.slice().reverse();
  }, [entries, days, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Audit Log</h1>
        <DateRangeFilter activeDays={days} onChange={setDays} />
      </div>

      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by action, agent, grant, or principal..."
          className="w-full max-w-md px-3 py-2 bg-gx-surface border border-gx-border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none focus:border-gx-accent transition-colors"
        />
      </div>

      <Card className="p-0">
        {filtered.length === 0 ? (
          <EmptyState
            title="No audit entries"
            description={search ? 'No entries match your search.' : 'No audit entries recorded yet.'}
          />
        ) : (
          <div className="p-4">
            <Table
              data={filtered}
              rowKey={(e) => e.entryId}
              onRowClick={(e) => navigate(`/dashboard/audit/${e.entryId}`)}
              columns={[
                {
                  key: 'action',
                  header: 'Action',
                  render: (e) => <Badge>{e.action}</Badge>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (e) => (
                    <Badge variant={e.status === 'success' ? 'success' : e.status === 'blocked' ? 'warning' : 'danger'}>
                      {e.status}
                    </Badge>
                  ),
                },
                {
                  key: 'agent',
                  header: 'Agent',
                  render: (e) => (
                    <span className="font-mono text-xs text-gx-muted">{truncateId(e.agentId)}</span>
                  ),
                },
                {
                  key: 'grant',
                  header: 'Grant',
                  render: (e) => (
                    <span className="font-mono text-xs text-gx-accent2">{truncateId(e.grantId)}</span>
                  ),
                },
                {
                  key: 'principal',
                  header: 'Principal',
                  render: (e) => (
                    <span className="text-gx-muted text-xs">{e.principalId}</span>
                  ),
                },
                {
                  key: 'time',
                  header: 'Time',
                  render: (e) => (
                    <span className="text-gx-muted text-xs">{formatDateTime(e.timestamp)}</span>
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
