import { useState, useEffect } from 'react';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../store/toast';
import { getUsage, getUsageHistory } from '../../api/usage';
import type { UsageResponse, UsageHistoryEntry } from '../../api/types';
import { formatDate } from '../../lib/format';

const periods = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const;

const statCards: { key: keyof Pick<UsageResponse, 'tokenExchanges' | 'authorizations' | 'verifications' | 'totalRequests'>; label: string; color: string }[] = [
  { key: 'tokenExchanges', label: 'Token Exchanges', color: 'text-gx-accent' },
  { key: 'authorizations', label: 'Authorizations', color: 'text-gx-accent2' },
  { key: 'verifications', label: 'Verifications', color: 'text-gx-text' },
  { key: 'totalRequests', label: 'Total Requests', color: 'text-gx-warning' },
];

export function UsageDashboard() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [history, setHistory] = useState<UsageHistoryEntry[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState(30);
  const [loading, setLoading] = useState(true);
  const { show } = useToast();

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getUsage().catch(() => {
        show('Failed to load usage data', 'error');
        return null;
      }),
      getUsageHistory(selectedPeriod).catch(() => {
        show('Failed to load usage history', 'error');
        return null;
      }),
    ])
      .then(([usageData, historyData]) => {
        if (usageData) setUsage(usageData);
        if (historyData) setHistory(historyData.entries);
      })
      .finally(() => setLoading(false));
  }, [selectedPeriod, show]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Usage</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {statCards.map((card) => (
          <Card key={card.key}>
            <p className="text-xs text-gx-muted mb-1">{card.label}</p>
            <p className={`text-2xl font-bold font-mono ${card.color}`}>
              {usage?.[card.key]?.toLocaleString() ?? 0}
            </p>
          </Card>
        ))}
      </div>

      {/* Period selector + history */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gx-text">Daily History</h2>
          <div className="flex gap-1">
            {periods.map((p) => (
              <button
                key={p.days}
                onClick={() => setSelectedPeriod(p.days)}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                  selectedPeriod === p.days
                    ? 'bg-gx-accent/10 text-gx-accent'
                    : 'text-gx-muted hover:text-gx-text hover:bg-gx-bg'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">No usage data for this period</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gx-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-gx-muted">Date</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-gx-muted">Exchanges</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-gx-muted">Authorizations</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-gx-muted">Verifications</th>
                  <th className="text-right py-2 text-xs font-medium text-gx-muted">Total</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.date} className="border-b border-gx-border/50 last:border-0">
                    <td className="py-2.5 pr-4 text-gx-text">{formatDate(entry.date)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gx-accent">{entry.tokenExchanges.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gx-accent2">{entry.authorizations.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-gx-text">{entry.verifications.toLocaleString()}</td>
                    <td className="py-2.5 text-right font-mono text-gx-warning">{entry.totalRequests.toLocaleString()}</td>
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
