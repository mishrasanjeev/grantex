import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  getBundle,
  revokeBundle,
  getBundleAuditEntries,
} from '../../api/bundles';
import type { ConsentBundle, OfflineAuditEntry } from '../../api/bundles';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { formatDateTime, truncateId, timeAgo } from '../../lib/format';

const statusVariant: Record<string, 'success' | 'danger' | 'warning'> = {
  active: 'success',
  revoked: 'danger',
  expired: 'warning',
};

export function BundleDetail() {
  const { bundleId } = useParams<{ bundleId: string }>();
  const navigate = useNavigate();
  const { show } = useToast();

  const [bundle, setBundle] = useState<ConsentBundle | null>(null);
  const [entries, setEntries] = useState<OfflineAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRevoke, setShowRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function fetchData() {
    if (!bundleId) return;
    setLoading(true);
    Promise.all([
      getBundle(bundleId),
      getBundleAuditEntries(bundleId).catch(() => []),
    ])
      .then(([b, e]) => {
        setBundle(b);
        setEntries(e);
      })
      .catch(() => {
        show('Bundle not found', 'error');
        navigate('/dashboard/bundles');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId]);

  async function handleRevoke() {
    if (!bundleId) return;
    setRevoking(true);
    try {
      await revokeBundle(bundleId);
      setBundle((prev) => (prev ? { ...prev, status: 'revoked' as const } : prev));
      show('Bundle revoked', 'success');
    } catch {
      show('Failed to revoke bundle', 'error');
    } finally {
      setRevoking(false);
      setShowRevoke(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [b, e] = await Promise.all([
        getBundle(bundleId!),
        getBundleAuditEntries(bundleId!).catch(() => []),
      ]);
      setBundle(b);
      setEntries(e);
      show('Bundle refreshed', 'success');
    } catch {
      show('Failed to refresh bundle', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  // Scope usage counts for the bar chart
  const scopeUsage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      for (const scope of entry.scopes) {
        counts[scope] = (counts[scope] || 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const maxScopeCount = useMemo(
    () => Math.max(1, ...scopeUsage.map(([, c]) => c)),
    [scopeUsage],
  );

  if (loading || !bundle) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link
            to="/dashboard/bundles"
            className="text-xs text-gx-muted hover:text-gx-text transition-colors"
          >
            &larr; Bundles
          </Link>
          <h1 className="text-xl font-semibold text-gx-text mt-1">
            Bundle — <span className="font-mono">{truncateId(bundle.id)}</span>
          </h1>
        </div>
        <Badge variant={statusVariant[bundle.status] ?? 'default'}>
          {bundle.status}
        </Badge>
      </div>

      {/* Metadata cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Details</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Bundle ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{bundle.id}</code>
                <CopyButton text={bundle.id} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Agent ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text">{bundle.agentId}</code>
                <CopyButton text={bundle.agentId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">User ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text">{bundle.userId}</code>
                <CopyButton text={bundle.userId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Grant ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{bundle.grantId}</code>
                <CopyButton text={bundle.grantId} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge variant={statusVariant[bundle.status] ?? 'default'}>
                  {bundle.status}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-xs font-medium text-gx-muted mb-4">Metadata</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-gx-muted">Scopes</dt>
              <dd className="mt-1">
                <ScopePills scopes={bundle.scopes} />
              </dd>
            </div>
            {bundle.devicePlatform && (
              <div>
                <dt className="text-xs text-gx-muted">Device Platform</dt>
                <dd className="mt-0.5">
                  <Badge>{bundle.devicePlatform}</Badge>
                </dd>
              </div>
            )}
            {bundle.deviceId && (
              <div>
                <dt className="text-xs text-gx-muted">Device ID</dt>
                <dd className="flex items-center gap-2 mt-0.5">
                  <code className="text-sm font-mono text-gx-text">{bundle.deviceId}</code>
                  <CopyButton text={bundle.deviceId} />
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-gx-muted">Offline TTL</dt>
              <dd className="text-sm text-gx-text mt-0.5">{bundle.offlineTTL}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Offline Until</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(bundle.offlineExpiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Created</dt>
              <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(bundle.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gx-muted">Last Sync</dt>
              <dd className="text-sm text-gx-text mt-0.5">
                {bundle.lastSyncAt ? timeAgo(bundle.lastSyncAt) : 'Never'}
              </dd>
            </div>
            {bundle.revokedAt && (
              <div>
                <dt className="text-xs text-gx-muted">Revoked At</dt>
                <dd className="text-sm text-gx-danger mt-0.5">{formatDateTime(bundle.revokedAt)}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      {/* Scope Usage Chart */}
      {scopeUsage.length > 0 && (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">
            Scope Usage
          </h2>
          <div className="space-y-3">
            {scopeUsage.map(([scope, count]) => (
              <div key={scope}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-gx-accent2">{scope}</span>
                  <span className="text-xs text-gx-muted">{count}</span>
                </div>
                <div className="w-full h-2 rounded-full bg-gx-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gx-accent transition-all"
                    style={{ width: `${(count / maxScopeCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Audit Log */}
      <Card className="mb-6 p-0">
        <div className="p-6 pb-0">
          <h2 className="text-sm font-semibold text-gx-text mb-4">
            Offline Audit Log ({entries.length})
          </h2>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-gx-muted py-6 text-center">
            No offline audit entries recorded yet.
          </p>
        ) : (
          <div className="p-4">
            <Table
              data={entries}
              rowKey={(e) => e.id}
              onRowClick={(e) =>
                setExpandedEntry((prev) => (prev === e.id ? null : e.id))
              }
              columns={[
                {
                  key: 'seq',
                  header: 'Seq',
                  render: (e) => (
                    <span className="font-mono text-xs text-gx-muted">{e.seq}</span>
                  ),
                },
                {
                  key: 'timestamp',
                  header: 'Timestamp',
                  render: (e) => (
                    <span className="text-xs text-gx-muted">
                      {formatDateTime(e.timestamp)}
                    </span>
                  ),
                },
                {
                  key: 'action',
                  header: 'Action',
                  render: (e) => (
                    <span className="font-mono text-xs text-gx-text">{e.action}</span>
                  ),
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  render: (e) => <ScopePills scopes={e.scopes} />,
                },
                {
                  key: 'result',
                  header: 'Result',
                  render: (e) => (
                    <Badge
                      variant={
                        e.result === 'allow' || e.result === 'success'
                          ? 'success'
                          : e.result === 'deny' || e.result === 'error'
                            ? 'danger'
                            : 'default'
                      }
                    >
                      {e.result}
                    </Badge>
                  ),
                },
                {
                  key: 'expand',
                  header: '',
                  className: 'text-right',
                  render: (e) => (
                    <svg
                      className={`w-4 h-4 text-gx-muted transition-transform ${
                        expandedEntry === e.id ? 'rotate-180' : ''
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  ),
                },
              ]}
            />

            {/* Expanded metadata rows */}
            {entries
              .filter((e) => expandedEntry === e.id)
              .map((e) => (
                <div
                  key={`meta-${e.id}`}
                  className="border-t border-gx-border/50 bg-gx-bg/50 px-4 py-3"
                >
                  <p className="text-xs font-medium text-gx-muted mb-2">Metadata</p>
                  <pre className="text-xs font-mono text-gx-text whitespace-pre-wrap break-all bg-gx-bg border border-gx-border rounded p-3">
                    {JSON.stringify(e.metadata, null, 2)}
                  </pre>
                </div>
              ))}
          </div>
        )}
      </Card>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        {bundle.status === 'active' && (
          <Button variant="danger" size="sm" onClick={() => setShowRevoke(true)}>
            Revoke Bundle
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? <Spinner className="h-4 w-4" /> : 'Refresh Bundle'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const url = `/v1/bundles/${encodeURIComponent(bundle.id)}/jwks`;
            window.open(url, '_blank');
          }}
        >
          Download JWKS
        </Button>
      </div>

      <ConfirmDialog
        open={showRevoke}
        onClose={() => setShowRevoke(false)}
        onConfirm={handleRevoke}
        title="Revoke Bundle"
        message={`Are you sure you want to revoke this bundle? The device will lose offline authorization on its next sync.`}
        confirmLabel="Revoke"
        loading={revoking}
      />
    </div>
  );
}
