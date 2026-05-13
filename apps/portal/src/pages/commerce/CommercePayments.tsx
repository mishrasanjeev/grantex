import { useEffect, useMemo, useState } from 'react';
import {
  listCommercePaymentIntents,
  reconcileCommercePaymentIntent,
  type CommercePaymentIntent,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { formatDateTime } from '../../lib/format';
import {
  BlockerBanner,
  DateText,
  ErrorPanel,
  IdText,
  LoadingPanel,
  PageHeader,
  PaymentStatusBadge,
  money,
} from './CommerceShared';

const statusOptions = ['', 'payment_pending', 'paid', 'failed', 'expired', 'created', 'authorized', 'checkout_created'];

export function CommercePayments() {
  const [payments, setPayments] = useState<CommercePaymentIntent[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const { show } = useToast();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listCommercePaymentIntents({
        merchantId: merchantId || undefined,
        status: status || undefined,
        limit: 100,
      });
      setPayments(res.items);
    } catch {
      setError('Failed to load commerce payment intents.');
      show('Failed to load commerce payments', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reconcile(payment: CommercePaymentIntent) {
    setReconcilingId(payment.id);
    try {
      const res = await reconcileCommercePaymentIntent(payment.id);
      setPayments((prev) => prev.map((p) => (p.id === payment.id ? res.data : p)));
      show('Payment reconciliation completed', 'success');
    } catch {
      show('Payment reconciliation failed', 'error');
    } finally {
      setReconcilingId(null);
    }
  }

  const pendingCount = useMemo(
    () => payments.filter((p) => p.status === 'payment_pending').length,
    [payments],
  );

  return (
    <div>
      <PageHeader
        title="Commerce Payments"
        description="API-backed payment intent operations with safe provider references, policy evidence, and manual reconciliation for stuck pending payments."
        action={<Button variant="secondary" size="sm" onClick={load}>Refresh</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-end">
          <Input
            id="commerce-payment-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
          />
          <div>
            <label htmlFor="commerce-payment-status" className="mb-1.5 block text-sm font-medium text-gx-text">
              Status
            </label>
            <select
              id="commerce-payment-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
            >
              {statusOptions.map((option) => (
                <option key={option || 'all'} value={option}>{option || 'all statuses'}</option>
              ))}
            </select>
          </div>
          <Button onClick={load}>Apply</Button>
        </div>
      </Card>

      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <Card className="p-0">
          {payments.length === 0 ? (
            <EmptyState
              title="No payment intents"
              description="No commerce payment intents matched the current filters."
            />
          ) : (
            <div className="p-4">
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-gx-muted">
                <Badge variant={pendingCount > 0 ? 'warning' : 'default'}>{pendingCount} pending</Badge>
                <span>Manual reconcile is available only for payment_pending intents.</span>
              </div>
              <Table
                data={payments}
                rowKey={(p) => p.id}
                columns={[
                  {
                    key: 'intent',
                    header: 'Intent',
                    render: (p) => (
                      <div>
                        <IdText value={p.id} />
                        <div className="mt-1 text-xs text-gx-muted">{money(p.amount_minor_units ?? p.amount, p.currency)}</div>
                      </div>
                    ),
                  },
                  { key: 'status', header: 'Status', render: (p) => <PaymentStatusBadge status={p.status} /> },
                  { key: 'merchant', header: 'Merchant', render: (p) => <IdText value={p.merchant_id} /> },
                  { key: 'agent', header: 'Agent', render: (p) => <IdText value={p.agent_id} /> },
                  {
                    key: 'provider',
                    header: 'Provider',
                    render: (p) => (
                      <div className="space-y-1">
                        <Badge variant={p.provider === 'plural' ? 'danger' : 'default'}>{p.provider}</Badge>
                        <div className="text-xs text-gx-muted">{p.provider_environment}</div>
                        <IdText value={p.provider_payment_id} />
                      </div>
                    ),
                  },
                  {
                    key: 'evidence',
                    header: 'Evidence',
                    render: (p) => (
                      <div className="space-y-1">
                        <IdText value={p.policy_version} />
                        <IdText value={p.decision_id} />
                        <IdText value={p.idempotency_key_hash ?? null} />
                      </div>
                    ),
                  },
                  {
                    key: 'timeline',
                    header: 'Timeline',
                    render: (p) => (
                      <div className="space-y-1">
                        <div className="text-xs text-gx-muted">Created {formatDateTime(p.created_at)}</div>
                        <div className="text-xs text-gx-muted">Updated {formatDateTime(p.updated_at)}</div>
                        <DateText value={p.last_reconciliation_attempt_at} />
                      </div>
                    ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right',
                    render: (p) => (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={p.status !== 'payment_pending' || reconcilingId === p.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void reconcile(p);
                        }}
                      >
                        {reconcilingId === p.id ? 'Reconciling' : 'Reconcile'}
                      </Button>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
