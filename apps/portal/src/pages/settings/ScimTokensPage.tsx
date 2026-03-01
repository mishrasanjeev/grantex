import { useState, useEffect } from 'react';
import {
  listScimTokens,
  createScimToken,
  deleteScimToken,
  type ScimToken,
  type ScimTokenWithSecret,
} from '../../api/scim';
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

export function ScimTokensPage() {
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ScimToken | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<ScimTokenWithSecret | null>(null);
  const { show } = useToast();

  useEffect(() => {
    listScimTokens()
      .then(setTokens)
      .catch(() => show('Failed to load SCIM tokens', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleCreate() {
    if (!label) return;
    setCreating(true);
    try {
      const result = await createScimToken({ label });
      setTokens((prev) => [...prev, result]);
      setShowCreate(false);
      setLabel('');
      setCreatedToken(result);
    } catch {
      show('Failed to create SCIM token', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteScimToken(deleteTarget.id);
      setTokens((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      show('SCIM token revoked', 'success');
    } catch {
      show('Failed to revoke SCIM token', 'error');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
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
        <h1 className="text-xl font-semibold text-gx-text">SCIM Provisioning Tokens</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          Create Token
        </Button>
      </div>

      <Card className="p-0 mb-6">
        {tokens.length === 0 ? (
          <EmptyState
            title="No SCIM tokens"
            description="Create a provisioning token to enable SCIM 2.0 user provisioning from your identity provider."
            action={
              <Button size="sm" onClick={() => setShowCreate(true)}>
                Create Token
              </Button>
            }
          />
        ) : (
          <div className="p-4">
            <Table
              data={tokens}
              rowKey={(t) => t.id}
              columns={[
                {
                  key: 'id',
                  header: 'ID',
                  render: (t) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(t.id)}
                    </span>
                  ),
                },
                {
                  key: 'label',
                  header: 'Label',
                  render: (t) => (
                    <span className="text-sm text-gx-text">{t.label}</span>
                  ),
                },
                {
                  key: 'created',
                  header: 'Created',
                  render: (t) => (
                    <span className="text-gx-muted text-xs">{formatDate(t.createdAt)}</span>
                  ),
                },
                {
                  key: 'lastUsed',
                  header: 'Last Used',
                  render: (t) => (
                    <span className="text-gx-muted text-xs">
                      {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'Never'}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  render: (t) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(t);
                      }}
                    >
                      Revoke
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-2">About SCIM Provisioning</h2>
        <p className="text-xs text-gx-muted leading-relaxed">
          SCIM 2.0 tokens allow your identity provider (Okta, Azure AD, OneLogin, etc.) to
          automatically provision and deprovision users in your Grantex organization. SCIM is
          available on the Enterprise plan.
        </p>
      </Card>

      {/* Create token modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create SCIM Token">
        <div className="space-y-4">
          <Input
            label="Label"
            placeholder="e.g., Okta Production"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!label || creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Token reveal modal */}
      <Modal
        open={!!createdToken}
        onClose={() => setCreatedToken(null)}
        title="SCIM Token Created"
      >
        <div className="space-y-4">
          <p className="text-sm text-gx-muted">
            Save this token — it will only be shown once. Use it as the Bearer token in your
            identity provider's SCIM configuration.
          </p>
          <div className="flex items-center gap-2 p-3 bg-gx-bg border border-gx-border rounded-md">
            <code className="text-sm text-gx-text font-mono flex-1 break-all">
              {createdToken?.token}
            </code>
            <CopyButton text={createdToken?.token ?? ''} />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setCreatedToken(null)}>
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
        title="Revoke SCIM Token"
        message={`Are you sure you want to revoke the token "${deleteTarget?.label}"? Your identity provider will no longer be able to provision users with this token.`}
        confirmLabel="Revoke"
        loading={deleting}
      />
    </div>
  );
}
