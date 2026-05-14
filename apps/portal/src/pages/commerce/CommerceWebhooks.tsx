import { useEffect, useState } from 'react';
import {
  createCommerceWebhookSource,
  listCommerceWebhookSources,
  rotateCommerceWebhookSourceSecret,
  updateCommerceWebhookSource,
  type CommerceWebhookSource,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { BlockerBanner, DateText, ErrorPanel, IdText, LoadingPanel, PageHeader, statusVariant } from './CommerceShared';

export function CommerceWebhooks() {
  const [merchantId, setMerchantId] = useState('');
  const [sources, setSources] = useState<CommerceWebhookSource[]>([]);
  const [selected, setSelected] = useState<CommerceWebhookSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ source_key: '', display_name: '' });
  const [editForm, setEditForm] = useState({ display_name: '', status: 'active' as 'active' | 'disabled' });
  const [oneTimeSecret, setOneTimeSecret] = useState<{ source_key: string; secret: string; action: 'created' | 'rotated' } | null>(null);
  const { show } = useToast();

  async function load() {
    const id = merchantId.trim();
    if (!id) {
      show('Enter a merchant ID before loading webhook sources', 'error');
      return;
    }
    setLoading(true);
    setError(null);
    setOneTimeSecret(null);
    try {
      const res = await listCommerceWebhookSources({ merchantId: id });
      setSources(res.items);
      setSelected(res.items[0] ?? null);
    } catch {
      setError('Failed to load commerce webhook sources.');
      show('Failed to load webhook sources', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!selected) {
      setEditForm({ display_name: '', status: 'active' });
      return;
    }
    setEditForm({ display_name: selected.display_name, status: selected.status });
  }, [selected]);

  async function createSource() {
    if (!merchantId.trim()) return;
    setCreating(true);
    try {
      const res = await createCommerceWebhookSource({
        merchantId: merchantId.trim(),
        sourceKey: createForm.source_key.trim(),
        displayName: createForm.display_name.trim(),
      });
      setSources((prev) => [res.data, ...prev]);
      setSelected(res.data);
      setOneTimeSecret({ source_key: res.data.source_key, secret: res.data.webhook_secret, action: 'created' });
      setCreateForm({ source_key: '', display_name: '' });
      show('Webhook source created', 'success');
    } catch {
      show('Failed to create webhook source', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function saveSource() {
    if (!selected || !merchantId.trim()) return;
    setSaving(true);
    try {
      const res = await updateCommerceWebhookSource(selected.source_key, {
        merchantId: merchantId.trim(),
        displayName: editForm.display_name,
        status: editForm.status,
      });
      setSources((prev) => prev.map((source) => (source.source_key === selected.source_key ? res.data : source)));
      setSelected(res.data);
      show('Webhook source updated', 'success');
    } catch {
      show('Failed to update webhook source', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function rotateSecret() {
    if (!selected || !merchantId.trim()) return;
    setRotating(true);
    try {
      const res = await rotateCommerceWebhookSourceSecret(selected.source_key, merchantId.trim());
      setSources((prev) => prev.map((source) => (source.source_key === selected.source_key ? res.data : source)));
      setSelected(res.data);
      setOneTimeSecret({ source_key: res.data.source_key, secret: res.data.webhook_secret, action: 'rotated' });
      show('Webhook source secret rotated', 'success');
    } catch {
      show('Failed to rotate webhook source secret', 'error');
    } finally {
      setRotating(false);
      setRotateOpen(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Commerce Webhooks"
        description="Merchant inbound webhook source management for signed catalog.product.updated events. Secrets are shown once and never persisted in browser storage."
        action={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Input
            id="commerce-webhook-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => {
              setMerchantId(e.target.value);
              setOneTimeSecret(null);
            }}
          />
          <Button onClick={load} disabled={loading || !merchantId.trim()}>{loading ? 'Loading' : 'Load webhooks'}</Button>
        </div>
      </Card>

      {oneTimeSecret && (
        <Card className="mb-4 border-gx-warning/50">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold text-gx-text">
                One-time webhook secret {oneTimeSecret.action} for {oneTimeSecret.source_key}
              </div>
              <div className="mt-1 max-w-full overflow-hidden text-ellipsis font-mono text-xs text-gx-warning">
                {oneTimeSecret.secret}
              </div>
              <p className="mt-2 text-xs text-gx-muted">
                Store this outside the portal. It will disappear when this action state is cleared or the page is refreshed.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <CopyButton text={oneTimeSecret.secret} />
              <Button variant="secondary" size="sm" onClick={() => setOneTimeSecret(null)}>Clear secret</Button>
            </div>
          </div>
        </Card>
      )}

      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <Card className="p-0">
            {sources.length === 0 ? (
              <EmptyState title="No webhook sources" description="Create a signed source before accepting merchant catalog webhooks." />
            ) : (
              <div className="p-4">
                <Table
                  data={sources}
                  rowKey={(source) => source.source_key}
                  onRowClick={setSelected}
                  columns={[
                    {
                      key: 'source',
                      header: 'Source',
                      render: (source) => (
                        <div>
                          <IdText value={source.source_key} />
                          <div className="mt-1 text-xs text-gx-muted">{source.display_name}</div>
                        </div>
                      ),
                    },
                    { key: 'status', header: 'Status', render: (source) => <Badge variant={statusVariant(source.status)}>{source.status}</Badge> },
                    { key: 'rotated', header: 'Secret rotated', render: (source) => <DateText value={source.secret_last_rotated_at} /> },
                    { key: 'updated', header: 'Updated', render: (source) => <DateText value={source.updated_at} /> },
                  ]}
                />
              </div>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <h2 className="mb-3 text-base font-semibold text-gx-text">Create source</h2>
              <div className="space-y-3">
                <Input
                  id="webhook-source-key"
                  label="Source key"
                  placeholder="erp_sync"
                  value={createForm.source_key}
                  onChange={(e) => setCreateForm({ ...createForm, source_key: e.target.value })}
                />
                <Input
                  id="webhook-display-name"
                  label="New display name"
                  placeholder="ERP Sync"
                  value={createForm.display_name}
                  onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })}
                />
                <Button
                  onClick={createSource}
                  disabled={creating || !merchantId.trim() || !createForm.source_key.trim() || !createForm.display_name.trim()}
                >
                  {creating ? 'Creating' : 'Create source'}
                </Button>
              </div>
            </Card>

            <Card>
              <h2 className="mb-3 text-base font-semibold text-gx-text">Update source</h2>
              {!selected ? (
                <p className="text-sm text-gx-muted">Select a webhook source to update display name, status, or rotate its secret.</p>
              ) : (
                <div className="space-y-3">
                  <IdText value={selected.source_key} />
                  <Input
                    id="webhook-edit-display-name"
                    label="Display name"
                    value={editForm.display_name}
                    onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })}
                  />
                  <div>
                    <label htmlFor="webhook-edit-status" className="mb-1.5 block text-sm font-medium text-gx-text">Status</label>
                    <select
                      id="webhook-edit-status"
                      value={editForm.status}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value as 'active' | 'disabled' })}
                      className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
                    >
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={saveSource} disabled={saving}>{saving ? 'Saving' : 'Save source'}</Button>
                    <Button variant="secondary" onClick={() => setRotateOpen(true)}>Rotate secret</Button>
                  </div>
                  <p className="text-xs text-gx-muted">
                    Source lists never return webhook secrets, secret hashes, encrypted secret blobs, raw payloads, or signatures.
                  </p>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        onConfirm={rotateSecret}
        title="Rotate webhook secret"
        message={`Rotate the signing secret for ${selected?.source_key ?? 'this source'}? Existing configured senders must be updated immediately.`}
        confirmLabel="Rotate"
        loading={rotating}
      />
    </div>
  );
}
