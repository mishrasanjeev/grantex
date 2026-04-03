import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { searchRegistryOrgs } from '../../api/registry';
import type { RegistryOrg } from '../../api/registry';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { truncateId } from '../../lib/format';

const BADGE_OPTIONS = [
  { value: '', label: 'All Badges' },
  { value: 'soc2', label: 'SOC 2 Type II' },
  { value: 'gdpr', label: 'GDPR' },
  { value: 'dpdp', label: 'DPDP' },
  { value: 'iso27001', label: 'ISO 27001' },
];

export function RegistrySearch() {
  const [orgs, setOrgs] = useState<RegistryOrg[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [badgeFilter, setBadgeFilter] = useState('');
  const { show } = useToast();

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await searchRegistryOrgs({
        q: query || undefined,
        verified: verifiedOnly || undefined,
        badge: badgeFilter || undefined,
      });
      setOrgs(res.data);
      setTotal(res.meta.total);
    } catch {
      show('Failed to load registry', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, verifiedOnly, badgeFilter, show]);

  useEffect(() => {
    const timeout = setTimeout(fetchOrgs, 300);
    return () => clearTimeout(timeout);
  }, [fetchOrgs]);

  // Aggregate stats
  const totalAgents = orgs.reduce((sum, o) => sum + o.stats.totalAgents, 0);
  const totalGrants = orgs.reduce((sum, o) => sum + o.stats.weeklyActiveGrants, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Trust Registry</h1>
        <Link to="/dashboard/registry/register">
          <Button size="sm">Register Your Organization</Button>
        </Link>
      </div>

      {/* Search & Filters */}
      <Card className="mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* Search input */}
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gx-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Search organizations by name or DID..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
            />
          </div>

          {/* Verified toggle */}
          <label className="flex items-center gap-2 text-sm text-gx-muted cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
              className="rounded border-gx-border accent-gx-accent"
            />
            Verified only
          </label>

          {/* Badge filter */}
          <select
            value={badgeFilter}
            onChange={(e) => setBadgeFilter(e.target.value)}
            className="text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text px-3 py-2 focus:outline-none focus:border-gx-accent"
          >
            {BADGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Org Cards Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner className="h-8 w-8" />
        </div>
      ) : orgs.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="No organizations found"
            description="Try adjusting your search or filters."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {orgs.map((org) => (
              <Link
                key={org.did}
                to={`/dashboard/registry/${encodeURIComponent(org.did)}`}
                className="block no-underline"
              >
                <Card className="h-full hover:border-gx-accent2 transition-colors cursor-pointer">
                  <div className="flex items-start gap-3 mb-3">
                    {org.logoUrl ? (
                      <img
                        src={org.logoUrl}
                        alt={org.name}
                        className="w-10 h-10 rounded-md object-cover border border-gx-border"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-md bg-gx-bg border border-gx-border flex items-center justify-center">
                        <svg className="w-5 h-5 text-gx-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
                        </svg>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gx-text truncate">{org.name}</h3>
                      <span className="text-xs font-mono text-gx-accent2">
                        {truncateId(org.did, 28)}
                      </span>
                    </div>
                  </div>

                  {/* Badges */}
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {org.verificationLevel === 'verified' && (
                      <Badge variant="success">Verified</Badge>
                    )}
                    {org.badges.map((badge) => (
                      <Badge key={badge}>{badge}</Badge>
                    ))}
                  </div>

                  {/* Description */}
                  {org.description && (
                    <p className="text-xs text-gx-muted line-clamp-2 mb-3">{org.description}</p>
                  )}

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-xs text-gx-muted border-t border-gx-border/50 pt-3 mt-auto">
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                      </svg>
                      {org.stats.totalAgents} agents
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                      {org.stats.weeklyActiveGrants}/wk
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                      </svg>
                      {org.stats.averageRating.toFixed(1)}
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>

          {/* Stats bar */}
          <div className="text-center text-xs text-gx-muted py-4 border-t border-gx-border/50">
            {total} org{total !== 1 ? 's' : ''} &middot; {totalAgents} agent{totalAgents !== 1 ? 's' : ''} &middot; {totalGrants.toLocaleString()} grants/week
          </div>
        </>
      )}
    </div>
  );
}
