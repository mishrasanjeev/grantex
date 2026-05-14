import { useEffect, useMemo, useState } from 'react';
import {
  getCommerceOpsHealth,
  listCommercePaymentIntents,
  listCommerceProviderWebhookEvents,
  reconcileCommercePaymentIntent,
  replayCommerceProviderWebhookEvent,
  type CommerceOpsHealth,
  type CommercePaymentIntent,
  type CommerceProviderWebhookEvent,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import {
  BlockerBanner,
  DateText,
  ErrorPanel,
  IdText,
  LoadingPanel,
  PageHeader,
  PaymentStatusBadge,
  money,
  statusVariant,
} from './CommerceShared';

const slaTargets = [
  {
    key: 'payment_intent_create',
    label: 'Payment intent create',
    target: '10 RPS, p95 < 500 ms',
    scope: 'Excludes provider latency',
    state: 'not-yet-measured',
  },
  {
    key: 'catalog_search',
    label: 'Catalog search',
    target: '50 RPS, p95 < 300 ms',
    scope: 'Pilot catalog size',
    state: 'not-yet-measured',
  },
  {
    key: 'provider_webhooks',
    label: 'Provider webhooks',
    target: '5 events/sec, p95 < 500 ms',
    scope: 'Excludes provider verification latency',
    state: 'not-yet-measured',
  },
  {
    key: 'plural_live',
    label: 'Plural live readiness',
    target: 'External signoff required',
    scope: 'API, webhook signature, legal, security, ops',
    state: 'blocked',
  },
] as const;

function stateVariant(state: string): 'default' | 'success' | 'warning' | 'danger' {
  if (state === 'passing') return 'success';
  if (state === 'blocked') return 'danger';
  if (state === 'not-yet-measured') return 'warning';
  return 'default';
}

function checkLabel(check: Record<string, unknown> | undefined): string {
  if (!check) return 'unknown';
  if (typeof check['status'] === 'string') return check['status'];
  if (check['ok'] === true) return 'healthy';
  if (check['ok'] === false) return 'down';
  return 'unknown';
}

export function CommerceOps() {
  const [merchantId, setMerchantId] = useState('');
  const [health, setHealth] = useState<CommerceOpsHealth | null>(null);
  const [pendingPayments, setPendingPayments] = useState<CommercePaymentIntent[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<CommerceProviderWebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [replayEvent, setReplayEvent] = useState<CommerceProviderWebhookEvent | null>(null);
  const [replayReason, setReplayReason] = useState('');
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const { show } = useToast();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const merchantFilter = merchantId.trim() || undefined;
      const [healthRes, pendingRes, webhookRes] = await Promise.all([
        getCommerceOpsHealth({ merchantId: merchantFilter, environment: 'sandbox' }),
        listCommercePaymentIntents({ merchantId: merchantFilter, status: 'payment_pending', limit: 50 }),
        listCommerceProviderWebhookEvents({
          merchantId: merchantFilter,
          processingStatus: 'failed',
          limit: 50,
        }),
      ]);
      setHealth(healthRes);
      setPendingPayments(pendingRes.items);
      setWebhookEvents(webhookRes.items);
    } catch {
      setError('Failed to load commerce operations readiness.');
      show('Failed to load commerce operations readiness', 'error');
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
      setPendingPayments((prev) => prev.filter((p) => p.id !== payment.id || res.data.status === 'payment_pending'));
      show('Payment reconciliation completed', 'success');
    } catch {
      show('Payment reconciliation failed', 'error');
    } finally {
      setReconcilingId(null);
    }
  }

  async function replayProviderWebhook(dryRun: boolean) {
    if (!replayEvent) return;
    const reason = replayReason.trim();
    if (!reason) {
      show('Enter a replay reason before continuing', 'error');
      return;
    }
    setReplayingId(replayEvent.id);
    try {
      await replayCommerceProviderWebhookEvent(replayEvent.id, { reason, dryRun });
      show(dryRun ? 'Provider webhook replay dry-run passed' : 'Provider webhook replay completed', 'success');
      setReplayEvent(null);
      setReplayReason('');
      await load();
    } catch {
      show('Provider webhook replay was denied', 'error');
    } finally {
      setReplayingId(null);
    }
  }

  const healthChecks = useMemo(() => {
    if (!health) return [];
    return [
      { label: 'API', value: checkLabel(health.checks.api), variant: statusVariant(checkLabel(health.checks.api)) },
      { label: 'Database', value: checkLabel(health.checks.database), variant: statusVariant(checkLabel(health.checks.database)) },
      { label: 'Mock provider', value: checkLabel(health.checks.provider_adapters.mock), variant: statusVariant(checkLabel(health.checks.provider_adapters.mock)) },
      { label: 'Plural provider', value: checkLabel(health.checks.provider_adapters.plural), variant: 'danger' as const },
      { label: 'Reconciliation worker', value: checkLabel(health.checks.reconciliation_worker), variant: statusVariant(checkLabel(health.checks.reconciliation_worker)) },
    ];
  }, [health]);

  return (
    <div>
      <PageHeader
        title="Commerce Ops"
        description="Pilot readiness view for API health, SLA evidence, stuck payments, and failed provider webhook metadata."
        action={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Input
            id="commerce-ops-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
          />
          <Button onClick={load} disabled={loading}>{loading ? 'Loading' : 'Load readiness'}</Button>
        </div>
      </Card>

      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-gx-text">Health</h2>
                {health ? <Badge variant={statusVariant(health.status)}>{health.status}</Badge> : null}
              </div>
              {health ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {healthChecks.map((check) => (
                      <div key={check.label} className="rounded-md border border-gx-border p-3">
                        <div className="text-xs text-gx-muted">{check.label}</div>
                        <div className="mt-2"><Badge variant={check.variant}>{check.value}</Badge></div>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-gx-border p-3">
                      <div className="text-xs text-gx-muted">Webhook backlog</div>
                      <div className="mt-1 text-lg font-semibold text-gx-text">{health.checks.webhook_backlog.backlog_count ?? 'unknown'}</div>
                    </div>
                    <div className="rounded-md border border-gx-border p-3">
                      <div className="text-xs text-gx-muted">Recent failures</div>
                      <div className="mt-1 text-lg font-semibold text-gx-text">{health.checks.webhook_backlog.recent_failure_count ?? 'unknown'}</div>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-xs text-gx-muted">Known blockers</div>
                    <div className="flex flex-wrap gap-2">
                      {health.blockers.length === 0 ? <Badge variant="success">none</Badge> : health.blockers.map((blocker) => (
                        <Badge key={blocker} variant="warning">{blocker}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState title="No health data" description="Load readiness to inspect commerce operations health." />
              )}
            </Card>

            <Card>
              <h2 className="mb-3 text-base font-semibold text-gx-text">Pilot SLA targets</h2>
              <div className="mb-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-gx-border p-2 text-xs text-gx-muted">
                  <Badge variant="default">measured</Badge>
                  <span className="ml-2">health checks from ops API</span>
                </div>
                <div className="rounded-md border border-gx-border p-2 text-xs text-gx-muted">
                  <Badge variant="success">passing</Badge>
                  <span className="ml-2">mock/database when healthy</span>
                </div>
                <div className="rounded-md border border-gx-border p-2 text-xs text-gx-muted">
                  <Badge variant="warning">not-yet-measured</Badge>
                  <span className="ml-2">load targets need local run</span>
                </div>
                <div className="rounded-md border border-gx-border p-2 text-xs text-gx-muted">
                  <Badge variant="danger">blocked</Badge>
                  <span className="ml-2">live Plural and replay</span>
                </div>
              </div>
              <div className="space-y-3">
                {slaTargets.map((target) => (
                  <div key={target.key} className="rounded-md border border-gx-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-gx-text">{target.label}</div>
                        <div className="mt-1 text-xs text-gx-muted">{target.target}</div>
                        <div className="mt-1 text-xs text-gx-muted">{target.scope}</div>
                      </div>
                      <Badge variant={stateVariant(target.state)}>{target.state}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="p-0">
            <div className="border-b border-gx-border p-4">
              <h2 className="text-base font-semibold text-gx-text">Stuck pending payments</h2>
              <p className="mt-1 text-sm text-gx-muted">Payment_pending intents are shown from the payment API and can be reconciled manually through the safe reconcile API.</p>
            </div>
            {pendingPayments.length === 0 ? (
              <EmptyState title="No stuck pending payments" description="No payment_pending intents matched the current merchant filter." />
            ) : (
              <div className="p-4">
                <Table
                  data={pendingPayments}
                  rowKey={(payment) => payment.id}
                  columns={[
                    { key: 'intent', header: 'Intent', render: (payment) => <IdText value={payment.id} /> },
                    { key: 'status', header: 'Status', render: (payment) => <PaymentStatusBadge status={payment.status} /> },
                    { key: 'amount', header: 'Amount', render: (payment) => <span className="text-sm text-gx-text">{money(payment.amount_minor_units ?? payment.amount, payment.currency)}</span> },
                    { key: 'merchant', header: 'Merchant', render: (payment) => <IdText value={payment.merchant_id} /> },
                    { key: 'provider', header: 'Provider', render: (payment) => <IdText value={payment.provider_payment_id} /> },
                    { key: 'updated', header: 'Updated', render: (payment) => <DateText value={payment.updated_at} /> },
                    {
                      key: 'actions',
                      header: '',
                      className: 'text-right',
                      render: (payment) => (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reconcilingId === payment.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void reconcile(payment);
                          }}
                        >
                          {reconcilingId === payment.id ? 'Reconciling' : 'Reconcile'}
                        </Button>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </Card>

          <Card className="p-0">
            <div className="border-b border-gx-border p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-gx-text">Failed provider webhook events</h2>
                  <p className="mt-1 text-sm text-gx-muted">Metadata-only view. Raw provider payloads, signatures, and secrets are not exposed.</p>
                </div>
                <Badge variant={webhookEvents.some((event) => event.replay_available) ? 'warning' : 'danger'}>
                  {webhookEvents.some((event) => event.replay_available) ? 'Replay available' : 'Replay blocked'}
                </Badge>
              </div>
            </div>
            {webhookEvents.length === 0 ? (
              <EmptyState title="No failed webhook events" description="No failed provider webhook events matched the current merchant filter." />
            ) : (
              <div className="p-4">
                <Table
                  data={webhookEvents}
                  rowKey={(event) => event.id}
                  columns={[
                    { key: 'event', header: 'Event', render: (event) => <IdText value={event.provider_event_id} /> },
                    { key: 'type', header: 'Type', render: (event) => <span className="text-sm text-gx-text">{event.provider_event_type}</span> },
                    { key: 'status', header: 'Status', render: (event) => <Badge variant={event.processing_status === 'failed' ? 'danger' : 'warning'}>{event.processing_status}</Badge> },
                    { key: 'signature', header: 'Signature', render: (event) => <Badge variant={event.signature_validation_status === 'valid' ? 'success' : 'danger'}>{event.signature_validation_status}</Badge> },
                    { key: 'payment', header: 'Payment', render: (event) => <IdText value={event.payment_intent_id} /> },
                    { key: 'error', header: 'Error', render: (event) => <IdText value={event.error_code} /> },
                    { key: 'replay', header: 'Replay', render: (event) => (
                      <div className="space-y-1">
                        <Badge variant={event.replay_available ? 'warning' : 'default'}>
                          {event.replay_available ? 'available' : 'blocked'}
                        </Badge>
                        <div className="text-xs text-gx-muted">count {event.replay_count ?? 0}</div>
                        {event.last_replayed_at ? <DateText value={event.last_replayed_at} /> : null}
                      </div>
                    ) },
                    { key: 'received', header: 'Received', render: (event) => <DateText value={event.received_at} /> },
                    {
                      key: 'actions',
                      header: '',
                      className: 'text-right',
                      render: (event) => (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!event.replay_available}
                          onClick={(e) => {
                            e.stopPropagation();
                            setReplayEvent(event);
                            setReplayReason('');
                          }}
                        >
                          Replay
                        </Button>
                      ),
                    },
                  ]}
                />
                {replayEvent ? (
                  <div className="mt-4 rounded-md border border-gx-border p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-end">
                      <Input
                        id="provider-webhook-replay-reason"
                        label="Replay reason"
                        placeholder="incident review reference"
                        value={replayReason}
                        onChange={(e) => setReplayReason(e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        disabled={replayingId === replayEvent.id || !replayReason.trim()}
                        onClick={() => void replayProviderWebhook(true)}
                      >
                        Dry-run replay
                      </Button>
                      <Button
                        disabled={replayingId === replayEvent.id || !replayReason.trim()}
                        onClick={() => void replayProviderWebhook(false)}
                      >
                        Replay webhook
                      </Button>
                      <Button variant="ghost" onClick={() => setReplayEvent(null)}>Cancel</Button>
                    </div>
                    <p className="mt-2 text-xs text-gx-muted">
                      Replay uses encrypted stored payload material and never displays raw payloads, signatures, or provider secrets.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-gx-muted">
                    Replay is operator-only and available only for failed provider events with valid original signatures and encrypted replay material.
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
