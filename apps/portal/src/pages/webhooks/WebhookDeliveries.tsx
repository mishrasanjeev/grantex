import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  listDeliveries,
  type WebhookDelivery,
} from '../../api/webhooks';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDate, truncateId } from '../../lib/format';

const STATUS_STYLES: Record<string, string> = {
  delivered: 'bg-green-500/10 text-green-400 border-green-500/20',
  pending: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] ?? 'bg-gx-card text-gx-muted border-gx-border'}`}
    >
      {status}
    </span>
  );
}

export function WebhookDeliveries() {
  const { id: webhookId } = useParams<{ id: string }>();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const pageSize = 20;
  const { show } = useToast();

  useEffect(() => {
    if (!webhookId) return;
    setLoading(true);
    listDeliveries(webhookId, {
      page,
      pageSize,
      ...(statusFilter ? { status: statusFilter } : {}),
    })
      .then((res) => {
        setDeliveries(res.deliveries);
        setTotal(res.total);
      })
      .catch(() => show('Failed to load deliveries', 'error'))
      .finally(() => setLoading(false));
  }, [webhookId, page, statusFilter, show]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
        <div className="flex items-center gap-3">
          <Link
            to="/dashboard/webhooks"
            className="text-gx-muted hover:text-gx-text transition-colors text-sm"
          >
            Webhooks
          </Link>
          <span className="text-gx-muted">/</span>
          <h1 className="text-xl font-semibold text-gx-text">Deliveries</h1>
          <span className="font-mono text-xs text-gx-muted">
            {webhookId ? truncateId(webhookId) : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {['', 'delivered', 'pending', 'failed'].map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${
                statusFilter === s
                  ? 'border-gx-accent bg-gx-accent/10 text-gx-accent'
                  : 'border-gx-border text-gx-muted hover:border-gx-muted'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      <Card className="p-0">
        {deliveries.length === 0 ? (
          <EmptyState
            title="No deliveries"
            description={
              statusFilter
                ? `No ${statusFilter} deliveries found.`
                : 'No webhook deliveries recorded yet.'
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={deliveries}
              rowKey={(d) => d.id}
              columns={[
                {
                  key: 'id',
                  header: 'ID',
                  render: (d) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(d.id)}
                    </span>
                  ),
                },
                {
                  key: 'eventType',
                  header: 'Event',
                  render: (d) => (
                    <span className="font-mono text-xs text-gx-text">{d.eventType}</span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (d) => <StatusBadge status={d.status} />,
                },
                {
                  key: 'attempts',
                  header: 'Attempts',
                  render: (d) => (
                    <span className="text-xs text-gx-muted">
                      {d.attempts}/{d.maxAttempts}
                    </span>
                  ),
                },
                {
                  key: 'error',
                  header: 'Error',
                  render: (d) => (
                    <span className="text-xs text-red-400 truncate max-w-xs block">
                      {d.lastError ?? '-'}
                    </span>
                  ),
                },
                {
                  key: 'created',
                  header: 'Created',
                  render: (d) => (
                    <span className="text-gx-muted text-xs">{formatDate(d.createdAt)}</span>
                  ),
                },
              ]}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gx-border">
                <span className="text-xs text-gx-muted">
                  {total} total deliveries
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-gx-muted">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
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
