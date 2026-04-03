import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getRegistryOrg, verifyOrgDns } from '../../api/registry';
import type { RegistryOrgDetail as OrgDetail } from '../../api/registry';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { ScopePills } from '../../components/ui/ScopePills';
import { truncateId } from '../../lib/format';

export function RegistryOrgDetail() {
  const { did } = useParams<{ did: string }>();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const { show } = useToast();

  useEffect(() => {
    if (!did) return;
    getRegistryOrg(did)
      .then(setOrg)
      .catch(() => show('Failed to load organization', 'error'))
      .finally(() => setLoading(false));
  }, [did, show]);

  async function handleVerifyDns() {
    if (!org) return;
    setVerifying(true);
    try {
      const res = await verifyOrgDns(org.did);
      if (res.verified) {
        setOrg((prev) => prev ? { ...prev, verificationLevel: 'verified', verifiedAt: new Date().toISOString() } : prev);
        show('DID verified successfully', 'success');
      } else {
        show('DNS verification failed. Check your TXT record.', 'error');
      }
    } catch {
      show('Failed to verify DID', 'error');
    } finally {
      setVerifying(false);
    }
  }

  function copyDid() {
    if (!org) return;
    navigator.clipboard.writeText(org.did);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="text-center py-20">
        <p className="text-gx-muted">Organization not found.</p>
        <Link to="/dashboard/registry" className="text-gx-accent2 text-sm mt-2 inline-block">
          Back to Registry
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link to="/dashboard/registry" className="text-sm text-gx-muted hover:text-gx-text mb-4 inline-flex items-center gap-1">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Registry
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4 mb-6 mt-4">
        {org.logoUrl ? (
          <img
            src={org.logoUrl}
            alt={org.name}
            className="w-14 h-14 rounded-lg object-cover border border-gx-border"
          />
        ) : (
          <div className="w-14 h-14 rounded-lg bg-gx-surface border border-gx-border flex items-center justify-center">
            <svg className="w-7 h-7 text-gx-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
          </div>
        )}
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-gx-text mb-1">{org.name}</h1>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-mono text-gx-accent2">{org.did}</span>
            <button
              onClick={copyDid}
              className="text-xs text-gx-muted hover:text-gx-text transition-colors"
              title="Copy DID"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {org.verificationLevel === 'verified' && (
              <Badge variant="success">Verified</Badge>
            )}
            {org.badges.map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
            {org.website && (
              <a
                href={org.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gx-accent2 hover:underline"
              >
                {org.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>
        </div>
        {org.verificationLevel !== 'verified' && (
          <Button
            size="sm"
            onClick={handleVerifyDns}
            disabled={verifying}
          >
            {verifying ? 'Verifying...' : 'Verify DID'}
          </Button>
        )}
      </div>

      {org.description && (
        <p className="text-sm text-gx-muted mb-6">{org.description}</p>
      )}

      {/* Compliance & Contact */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Compliance */}
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Compliance</h2>
          <div className="space-y-3">
            <ComplianceRow label="SOC 2 Type II" passed={org.compliance.soc2} />
            <ComplianceRow label="DPDP Compliant" passed={org.compliance.dpdp} />
            <ComplianceRow label="GDPR Compliant" passed={org.compliance.gdpr} />
          </div>
        </Card>

        {/* Contact Info */}
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Contact</h2>
          <div className="space-y-3">
            <div>
              <span className="text-xs text-gx-muted block mb-0.5">Security</span>
              <a href={`mailto:${org.contact.security}`} className="text-sm text-gx-accent2 hover:underline">
                {org.contact.security}
              </a>
            </div>
            {org.contact.dpo && (
              <div>
                <span className="text-xs text-gx-muted block mb-0.5">Data Protection Officer</span>
                <a href={`mailto:${org.contact.dpo}`} className="text-sm text-gx-accent2 hover:underline">
                  {org.contact.dpo}
                </a>
              </div>
            )}
            {org.verifiedAt && (
              <div>
                <span className="text-xs text-gx-muted block mb-0.5">Verified</span>
                <span className="text-sm text-gx-text">
                  {new Date(org.verifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {org.verificationMethod && (
                    <span className="text-gx-muted ml-1">via {org.verificationMethod}</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Agents */}
      <Card className="p-0 mb-6">
        <div className="px-6 py-4 border-b border-gx-border">
          <h2 className="text-sm font-semibold text-gx-text">
            Agents ({org.agents.length})
          </h2>
        </div>
        {org.agents.length === 0 ? (
          <div className="py-12 text-center text-sm text-gx-muted">
            No registered agents yet.
          </div>
        ) : (
          <div className="p-4">
            <Table
              data={org.agents}
              rowKey={(a) => a.agentDid}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: (a) => (
                    <span className="font-medium text-gx-text">{a.name}</span>
                  ),
                },
                {
                  key: 'did',
                  header: 'DID',
                  render: (a) => (
                    <span className="font-mono text-xs text-gx-accent2">
                      {truncateId(a.agentDid, 20)}
                    </span>
                  ),
                },
                {
                  key: 'category',
                  header: 'Category',
                  render: (a) => <Badge>{a.category}</Badge>,
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  render: (a) => <ScopePills scopes={a.scopes.slice(0, 3)} />,
                },
                {
                  key: 'grants',
                  header: 'Grants/wk',
                  render: (a) => (
                    <span className="text-sm text-gx-muted">{a.weeklyActiveGrants}</span>
                  ),
                },
                {
                  key: 'rating',
                  header: 'Rating',
                  render: (a) => (
                    <span className="text-sm text-gx-text">{a.rating.toFixed(1)}</span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      {/* Public Keys */}
      {org.publicKeys.length > 0 && (
        <Card className="mb-6">
          <h2 className="text-sm font-semibold text-gx-text mb-4">Public Keys</h2>
          <div className="bg-gx-bg border border-gx-border rounded-md p-4 overflow-x-auto">
            <pre className="text-xs font-mono text-gx-text leading-relaxed">
              {JSON.stringify(org.publicKeys, null, 2)}
            </pre>
          </div>
        </Card>
      )}
    </div>
  );
}

function ComplianceRow({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {passed ? (
        <svg className="w-4 h-4 text-gx-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-gx-muted flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
      <span className={`text-sm ${passed ? 'text-gx-text' : 'text-gx-muted'}`}>{label}</span>
    </div>
  );
}
