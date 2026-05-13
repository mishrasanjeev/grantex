import { useEffect, useMemo, useState } from 'react';
import { listCommerceAuditEvents, type CommerceAuditEvent } from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { formatDateTime } from '../../lib/format';
import { ErrorPanel, IdText, LoadingPanel, PageHeader } from './CommerceShared';

export function CommerceAudit() {
  const [events, setEvents] = useState<CommerceAuditEvent[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [eventType, setEventType] = useState('');
  const [paymentIntentId, setPaymentIntentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { show } = useToast();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listCommerceAuditEvents({
        merchantId: merchantId || undefined,
        eventType: eventType || undefined,
        limit: 100,
      });
      setEvents(res.items);
    } catch {
      setError('Failed to load commerce audit events.');
      show('Failed to load commerce audit events', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = paymentIntentId.trim().toLowerCase();
    if (!q) return events;
    return events.filter((event) =>
      event.resource_id?.toLowerCase().includes(q)
      || JSON.stringify(event.metadata ?? {}).toLowerCase().includes(q),
    );
  }, [events, paymentIntentId]);

  return (
    <div>
      <PageHeader
        title="Commerce Audit"
        description="Append-only commerce audit events for payments, passports, policies, idempotency conflicts, and provider webhook decisions. Rows are read-only."
        action={<Button variant="secondary" size="sm" onClick={load}>Refresh</Button>}
      />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <Input id="commerce-audit-merchant" label="Merchant ID" placeholder="mch_..." value={merchantId} onChange={(e) => setMerchantId(e.target.value)} />
          <Input id="commerce-audit-event" label="Event type" placeholder="payment_intent.paid" value={eventType} onChange={(e) => setEventType(e.target.value)} />
          <Input id="commerce-audit-payment" label="Payment intent search" placeholder="cpi_..." value={paymentIntentId} onChange={(e) => setPaymentIntentId(e.target.value)} />
          <Button onClick={load}>Apply</Button>
        </div>
      </Card>

      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <Card className="p-0">
          {filtered.length === 0 ? (
            <EmptyState title="No commerce audit events" description="No audit events matched the current filters." />
          ) : (
            <div className="p-4">
              <Table
                data={filtered}
                rowKey={(event) => event.id}
                columns={[
                  { key: 'event', header: 'Event', render: (event) => <Badge>{event.event_type}</Badge> },
                  { key: 'resource', header: 'Resource', render: (event) => <IdText value={event.resource_id} /> },
                  { key: 'merchant', header: 'Merchant', render: (event) => <IdText value={event.merchant_id} /> },
                  { key: 'agent', header: 'Agent', render: (event) => <IdText value={event.agent_id} /> },
                  {
                    key: 'evidence',
                    header: 'Evidence',
                    render: (event) => (
                      <div className="space-y-1">
                        <IdText value={event.policy_version} />
                        <IdText value={event.decision_id} />
                        <IdText value={event.idempotency_key_hash} />
                      </div>
                    ),
                  },
                  { key: 'time', header: 'Time', render: (event) => <span className="text-xs text-gx-muted">{formatDateTime(event.occurred_at)}</span> },
                ]}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
