import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { listAgents } from '../api/agents';
import { listGrants } from '../api/grants';
import { listAuditEntries } from '../api/audit';
import { listAnomalies } from '../api/anomalies';
import type { DashboardStats, AuditEntry } from '../api/types';
import { timeAgo, truncateId } from '../lib/format';

const statCards: { key: keyof DashboardStats; label: string; href: string; color: string }[] = [
  { key: 'agents', label: 'Agents', href: '/dashboard/agents', color: 'text-gx-accent2' },
  { key: 'activeGrants', label: 'Active Grants', href: '/dashboard/grants', color: 'text-gx-accent' },
  { key: 'auditEntries', label: 'Audit Entries', href: '/dashboard/audit', color: 'text-gx-text' },
  { key: 'anomalies', label: 'Anomalies', href: '/dashboard/anomalies', color: 'text-gx-warning' },
];

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [agents, grants, audit, anomalies] = await Promise.all([
          listAgents().catch(() => []),
          listGrants({ status: 'active' }).catch(() => []),
          listAuditEntries().catch(() => []),
          listAnomalies().catch(() => []),
        ]);
        setStats({
          agents: agents.length,
          activeGrants: grants.length,
          auditEntries: audit.length,
          anomalies: anomalies.length,
        });
        setRecent(audit.slice(-10).reverse());
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Overview</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((card) => (
          <Link key={card.key} to={card.href} className="no-underline">
            <Card className="hover:border-gx-muted transition-colors">
              <p className="text-xs text-gx-muted mb-1">{card.label}</p>
              <p className={`text-2xl font-bold font-mono ${card.color}`}>
                {stats?.[card.key] ?? 0}
              </p>
            </Card>
          </Link>
        ))}
      </div>

      {/* Recent activity */}
      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-4">Recent Activity</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">No recent activity</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gx-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Action</th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Agent</th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Grant</th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Status</th>
                  <th className="text-right py-2 text-xs font-medium text-gx-muted">Time</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((entry) => (
                  <tr key={entry.entryId} className="border-b border-gx-border/50 last:border-0">
                    <td className="py-2.5 pr-4">
                      <Badge>{entry.action}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-gx-muted">
                      {truncateId(entry.agentId)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-gx-accent2">
                      {truncateId(entry.grantId)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={entry.status === 'success' ? 'success' : entry.status === 'blocked' ? 'warning' : 'danger'}>
                        {entry.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-right text-gx-muted text-xs">
                      {timeAgo(entry.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
