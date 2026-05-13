import { useEffect, useMemo, useState } from 'react';
import { listCommercePassports, revokeCommercePassport, type CommercePassport } from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { DateText, ErrorPanel, IdText, LoadingPanel, PageHeader, money } from './CommerceShared';

export function CommercePassports() {
  const [passports, setPassports] = useState<CommercePassport[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<CommercePassport | null>(null);
  const [revoking, setRevoking] = useState(false);
  const { show } = useToast();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listCommercePassports();
      setPassports(res.items);
    } catch {
      setError('Failed to load commerce passports.');
      show('Failed to load commerce passports', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return passports;
    return passports.filter((p) =>
      p.jti.toLowerCase().includes(q)
      || p.merchant_id.toLowerCase().includes(q)
      || p.agent_id.toLowerCase().includes(q)
      || p.passport_type.includes(q),
    );
  }, [passports, search]);

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await revokeCommercePassport({
        jti: revokeTarget.jti,
        reason: 'dashboard_emergency_review',
      });
      setPassports((prev) => prev.map((p) => (
        p.jti === res.data.jti ? { ...p, revoked: true, revocation_reason: res.data.reason } : p
      )));
      show('Commerce Passport revoked', 'success');
    } catch {
      show('Failed to revoke Commerce Passport', 'error');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Commerce Passports"
        description="Safe passport metadata only. Raw passport tokens are never displayed or stored in the portal."
        action={<Button variant="secondary" size="sm" onClick={load}>Refresh</Button>}
      />
      <div className="mb-4">
        <Input
          id="commerce-passport-search"
          label="Search"
          placeholder="Search by JTI, merchant, agent, or type"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <Card className="p-0">
          {filtered.length === 0 ? (
            <EmptyState title="No Commerce Passports" description="No passport metadata matched the current search." />
          ) : (
            <div className="p-4">
              <Table
                data={filtered}
                rowKey={(p) => p.jti}
                columns={[
                  {
                    key: 'jti',
                    header: 'Passport JTI',
                    render: (p) => <IdText value={p.jti} />,
                  },
                  {
                    key: 'type',
                    header: 'Type',
                    render: (p) => <Badge variant={p.passport_type === 'checkout' ? 'warning' : 'default'}>{p.passport_type}</Badge>,
                  },
                  { key: 'merchant', header: 'Merchant', render: (p) => <IdText value={p.merchant_id} /> },
                  { key: 'agent', header: 'Agent', render: (p) => <IdText value={p.agent_id} /> },
                  {
                    key: 'scope',
                    header: 'Scope',
                    render: (p) => (
                      <div className="max-w-xs text-xs text-gx-muted">
                        {p.scopes.join(', ')}
                        {p.max_amount !== null && <div>{money(p.max_amount, p.currency)}</div>}
                      </div>
                    ),
                  },
                  {
                    key: 'state',
                    header: 'State',
                    render: (p) => (
                      <div className="space-y-1">
                        <Badge variant={p.revoked ? 'danger' : 'success'}>{p.revoked ? 'revoked' : 'active'}</Badge>
                        {p.revocation_reason && <div className="text-xs text-gx-muted">{p.revocation_reason}</div>}
                      </div>
                    ),
                  },
                  {
                    key: 'expiry',
                    header: 'Expires',
                    render: (p) => <DateText value={p.expires_at} />,
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right',
                    render: (p) => (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={p.revoked}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRevokeTarget(p);
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
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        title="Revoke Commerce Passport"
        message={`Revoke passport ${revokeTarget?.jti ?? ''}? This blocks future protected actions using this passport.`}
        confirmLabel="Revoke"
        loading={revoking}
      />
    </div>
  );
}
