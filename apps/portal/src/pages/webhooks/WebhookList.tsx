import { useState, useEffect } from 'react';
import {
  listWebhooks,
  createWebhook,
  deleteWebhook,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
} from '../../api/webhooks';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import { CopyButton } from '../../components/ui/CopyButton';
import { formatDate, truncateId } from '../../lib/format';

const EVENT_OPTIONS = ['grant.created', 'grant.revoked', 'token.issued'];

export function WebhookList() {
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [createdSecret, setCreatedSecret] = useState<WebhookEndpointWithSecret | null>(null);
  const { show } = useToast();

  useEffect(() => {
    listWebhooks()
      .then(setWebhooks)
      .catch(() => show('Failed to load webhooks', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleCreate() {
    if (!url || selectedEvents.length === 0) return;
    setCreating(true);
    try {
      const result = await createWebhook({ url, events: selectedEvents });
      setWebhooks((prev) => [...prev, result]);
      setShowCreate(false);
      setUrl('');
      setSelectedEvents([]);
      setCreatedSecret(result);
    } catch {
      show('Failed to create webhook', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteWebhook(deleteTarget.id);
      setWebhooks((prev) => prev.filter((w) => w.id !== deleteTarget.id));
      show('Webhook deleted', 'success');
    } catch {
      show('Failed to delete webhook', 'error');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

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
        <h1 className="text-xl font-semibold text-gx-text">Webhooks</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          Add Endpoint
        </Button>
      </div>

      <Card className="p-0">
        {webhooks.length === 0 ? (
          <EmptyState
            title="No webhooks yet"
            description="Add an endpoint to receive real-time event notifications."
            action={
              <Button size="sm" onClick={() => setShowCreate(true)}>
                Add Endpoint
              </Button>
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={webhooks}
              rowKey={(w) => w.id}
              columns={[
                {
                  key: 'id',
                  header: 'ID',
                  render: (w) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(w.id)}
                    </span>
                  ),
                },
                {
                  key: 'url',
                  header: 'URL',
                  render: (w) => (
                    <span className="font-mono text-xs text-gx-text truncate max-w-xs block">
                      {w.url}
                    </span>
                  ),
                },
                {
                  key: 'events',
                  header: 'Events',
                  render: (w) => (
                    <span className="text-xs text-gx-muted">{w.events.join(', ')}</span>
                  ),
                },
                {
                  key: 'created',
                  header: 'Created',
                  render: (w) => (
                    <span className="text-gx-muted text-xs">{formatDate(w.createdAt)}</span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (w) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(w);
                      }}
                    >
                      Delete
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      {/* Create webhook modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Add Webhook Endpoint">
        <div className="space-y-4">
          <Input
            label="Endpoint URL"
            placeholder="https://example.com/webhook"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div>
            <label className="block text-sm font-medium text-gx-text mb-2">Events</label>
            <div className="flex flex-wrap gap-2">
              {EVENT_OPTIONS.map((event) => (
                <button
                  key={event}
                  onClick={() => toggleEvent(event)}
                  className={`px-3 py-1.5 rounded-md border text-xs font-mono transition-colors ${
                    selectedEvents.includes(event)
                      ? 'border-gx-accent bg-gx-accent/10 text-gx-accent'
                      : 'border-gx-border text-gx-muted hover:border-gx-muted'
                  }`}
                >
                  {event}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!url || selectedEvents.length === 0 || creating}
            >
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Secret reveal modal */}
      <Modal
        open={!!createdSecret}
        onClose={() => setCreatedSecret(null)}
        title="Webhook Created"
      >
        <div className="space-y-4">
          <p className="text-sm text-gx-muted">
            Save this signing secret — it will only be shown once.
          </p>
          <div className="flex items-center gap-2 p-3 bg-gx-bg border border-gx-border rounded-md">
            <code className="text-sm text-gx-text font-mono flex-1 break-all">
              {createdSecret?.secret}
            </code>
            <CopyButton text={createdSecret?.secret ?? ''} />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setCreatedSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Webhook"
        message={`Are you sure you want to delete the webhook for "${deleteTarget?.url}"? This action cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
