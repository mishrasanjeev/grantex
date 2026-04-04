import { useState, useMemo } from 'react';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { cn } from '../../lib/cn';

interface EnforceEntry {
  id: string;
  timestamp: string;
  agent: string;
  connector: string;
  tool: string;
  permission: string;
  grantedScopes: string[];
  result: 'allowed' | 'denied';
  reason: string;
}

// Demo data — enforce() runs client-side in the SDK, so this page shows
// representative enforcement events reported by the application.
const DEMO_ENTRIES: EnforceEntry[] = [
  { id: 'enf_001', timestamp: '2026-04-03T10:23:41Z', agent: 'agent:finance-bot', connector: 'quickbooks', tool: 'get_invoice', permission: 'read', grantedScopes: ['finance:read', 'finance:write'], result: 'allowed', reason: 'Scope finance:read covers read permission' },
  { id: 'enf_002', timestamp: '2026-04-03T10:23:44Z', agent: 'agent:finance-bot', connector: 'quickbooks', tool: 'create_invoice', permission: 'write', grantedScopes: ['finance:read', 'finance:write'], result: 'allowed', reason: 'Scope finance:write covers write permission' },
  { id: 'enf_003', timestamp: '2026-04-03T10:24:02Z', agent: 'agent:finance-bot', connector: 'stripe', tool: 'run_payment', permission: 'admin', grantedScopes: ['finance:read', 'finance:write'], result: 'denied', reason: 'admin permission requires finance:admin scope' },
  { id: 'enf_004', timestamp: '2026-04-03T10:25:11Z', agent: 'agent:marketing-ai', connector: 'hubspot', tool: 'list_deals', permission: 'read', grantedScopes: ['crm:read'], result: 'allowed', reason: 'Scope crm:read covers read permission' },
  { id: 'enf_005', timestamp: '2026-04-03T10:25:15Z', agent: 'agent:marketing-ai', connector: 'hubspot', tool: 'create_contact', permission: 'write', grantedScopes: ['crm:read'], result: 'denied', reason: 'write permission requires crm:write scope' },
  { id: 'enf_006', timestamp: '2026-04-03T10:26:33Z', agent: 'agent:ops-runner', connector: 'jira', tool: 'get_issue', permission: 'read', grantedScopes: ['project:read', 'project:write'], result: 'allowed', reason: 'Scope project:read covers read permission' },
  { id: 'enf_007', timestamp: '2026-04-03T10:26:35Z', agent: 'agent:ops-runner', connector: 'jira', tool: 'create_issue', permission: 'write', grantedScopes: ['project:read', 'project:write'], result: 'allowed', reason: 'Scope project:write covers write permission' },
  { id: 'enf_008', timestamp: '2026-04-03T10:26:38Z', agent: 'agent:ops-runner', connector: 'jira', tool: 'delete_issue', permission: 'delete', grantedScopes: ['project:read', 'project:write'], result: 'denied', reason: 'delete permission requires project:delete scope' },
  { id: 'enf_009', timestamp: '2026-04-03T10:27:02Z', agent: 'agent:comms-bot', connector: 'slack', tool: 'send_message', permission: 'write', grantedScopes: ['comms:read', 'comms:write'], result: 'allowed', reason: 'Scope comms:write covers write permission' },
  { id: 'enf_010', timestamp: '2026-04-03T10:27:05Z', agent: 'agent:comms-bot', connector: 'slack', tool: 'delete_message', permission: 'delete', grantedScopes: ['comms:read', 'comms:write'], result: 'denied', reason: 'delete permission requires comms:delete scope' },
  { id: 'enf_011', timestamp: '2026-04-03T10:28:11Z', agent: 'agent:hr-assistant', connector: 'greenhouse', tool: 'list_candidates', permission: 'read', grantedScopes: ['hr:read'], result: 'allowed', reason: 'Scope hr:read covers read permission' },
  { id: 'enf_012', timestamp: '2026-04-03T10:28:14Z', agent: 'agent:hr-assistant', connector: 'greenhouse', tool: 'create_application', permission: 'write', grantedScopes: ['hr:read'], result: 'denied', reason: 'write permission requires hr:write scope' },
  { id: 'enf_013', timestamp: '2026-04-03T10:29:01Z', agent: 'agent:finance-bot', connector: 'netsuite', tool: 'get_vendor', permission: 'read', grantedScopes: ['finance:read', 'finance:write'], result: 'allowed', reason: 'Scope finance:read covers read permission' },
  { id: 'enf_014', timestamp: '2026-04-03T10:29:08Z', agent: 'agent:finance-bot', connector: 'netsuite', tool: 'create_journal_entry', permission: 'write', grantedScopes: ['finance:read', 'finance:write'], result: 'allowed', reason: 'Scope finance:write covers write permission' },
  { id: 'enf_015', timestamp: '2026-04-03T10:30:22Z', agent: 'agent:marketing-ai', connector: 'mailchimp', tool: 'send_campaign', permission: 'write', grantedScopes: ['crm:read'], result: 'denied', reason: 'write permission requires crm:write scope' },
  { id: 'enf_016', timestamp: '2026-04-03T10:30:45Z', agent: 'agent:ops-runner', connector: 'servicenow', tool: 'get_incident', permission: 'read', grantedScopes: ['project:read', 'project:write'], result: 'allowed', reason: 'Scope project:read covers read permission' },
  { id: 'enf_017', timestamp: '2026-04-03T10:31:02Z', agent: 'agent:comms-bot', connector: 'gmail', tool: 'list_messages', permission: 'read', grantedScopes: ['comms:read', 'comms:write'], result: 'allowed', reason: 'Scope comms:read covers read permission' },
  { id: 'enf_018', timestamp: '2026-04-03T10:31:06Z', agent: 'agent:comms-bot', connector: 'gmail', tool: 'send_message', permission: 'write', grantedScopes: ['comms:read', 'comms:write'], result: 'allowed', reason: 'Scope comms:write covers write permission' },
  { id: 'enf_019', timestamp: '2026-04-03T10:32:11Z', agent: 'agent:finance-bot', connector: 'sap', tool: 'run_payroll', permission: 'admin', grantedScopes: ['finance:read', 'finance:write'], result: 'denied', reason: 'admin permission requires finance:admin scope' },
  { id: 'enf_020', timestamp: '2026-04-03T10:32:44Z', agent: 'agent:marketing-ai', connector: 'google_ads', tool: 'list_campaigns', permission: 'read', grantedScopes: ['crm:read'], result: 'allowed', reason: 'Scope crm:read covers read permission' },
  { id: 'enf_021', timestamp: '2026-04-03T10:33:01Z', agent: 'agent:ops-runner', connector: 'pagerduty', tool: 'create_incident', permission: 'write', grantedScopes: ['project:read', 'project:write'], result: 'allowed', reason: 'Scope project:write covers write permission' },
  { id: 'enf_022', timestamp: '2026-04-03T10:33:15Z', agent: 'agent:hr-assistant', connector: 'darwinbox', tool: 'update_employee', permission: 'write', grantedScopes: ['hr:read'], result: 'denied', reason: 'write permission requires hr:write scope' },
  { id: 'enf_023', timestamp: '2026-04-03T10:34:02Z', agent: 'agent:comms-bot', connector: 'github', tool: 'create_issue', permission: 'write', grantedScopes: ['comms:read', 'comms:write'], result: 'allowed', reason: 'Scope comms:write covers write permission' },
  { id: 'enf_024', timestamp: '2026-04-03T10:34:22Z', agent: 'agent:finance-bot', connector: 'zoho_books', tool: 'list_invoices', permission: 'read', grantedScopes: ['finance:read', 'finance:write'], result: 'allowed', reason: 'Scope finance:read covers read permission' },
  { id: 'enf_025', timestamp: '2026-04-03T10:35:01Z', agent: 'agent:marketing-ai', connector: 'meta_ads', tool: 'create_ad_set', permission: 'write', grantedScopes: ['crm:read'], result: 'denied', reason: 'write permission requires crm:write scope' },
];

const PAGE_SIZE = 50;

const RESULT_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'allowed', label: 'Allowed' },
  { value: 'denied', label: 'Denied' },
];

const connectorOptions = [
  { value: 'all', label: 'All connectors' },
  ...Array.from(new Set(DEMO_ENTRIES.map((e) => e.connector)))
    .sort()
    .map((c) => ({ value: c, label: c })),
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function EnforceLog() {
  const [resultFilter, setResultFilter] = useState('all');
  const [connector, setConnector] = useState('all');
  const [agentSearch, setAgentSearch] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let entries = DEMO_ENTRIES;
    if (resultFilter !== 'all') {
      entries = entries.filter((e) => e.result === resultFilter);
    }
    if (connector !== 'all') {
      entries = entries.filter((e) => e.connector === connector);
    }
    if (agentSearch.trim()) {
      const q = agentSearch.toLowerCase();
      entries = entries.filter((e) => e.agent.toLowerCase().includes(q));
    }
    return entries;
  }, [resultFilter, connector, agentSearch]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const allowedCount = filtered.filter((e) => e.result === 'allowed').length;
  const deniedCount = filtered.filter((e) => e.result === 'denied').length;
  const denialRate = filtered.length > 0 ? ((deniedCount / filtered.length) * 100).toFixed(1) : '0.0';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Enforce Audit Log</h1>
        <p className="text-sm text-gx-muted mt-1">
          Scope enforcement runs client-side in the SDK. This log shows enforcement events reported by your application.
        </p>
      </div>

      {/* Filter row */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="flex gap-1.5 items-center">
          {RESULT_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setResultFilter(f.value); setPage(0); }}
              className={cn(
                'px-3 py-1.5 text-xs rounded-full font-medium transition-colors border',
                resultFilter === f.value
                  ? 'bg-gx-accent/15 text-gx-accent border-gx-accent/30'
                  : 'bg-gx-surface text-gx-muted border-gx-border hover:text-gx-text hover:border-gx-accent/30',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="sm:w-48">
          <Select
            options={connectorOptions}
            value={connector}
            onChange={(e) => { setConnector(e.target.value); setPage(0); }}
          />
        </div>
        <div className="sm:w-56">
          <Input
            placeholder="Search agent..."
            value={agentSearch}
            onChange={(e) => { setAgentSearch(e.target.value); setPage(0); }}
          />
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <Card>
          <p className="text-sm text-gx-muted">Total Calls</p>
          <p className="text-2xl font-semibold text-gx-text mt-1">{filtered.length}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Allowed</p>
          <p className="text-2xl font-semibold text-gx-accent mt-1">{allowedCount}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Denied</p>
          <p className="text-2xl font-semibold text-gx-danger mt-1">{deniedCount}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Denial Rate</p>
          <p className="text-2xl font-semibold text-gx-warning mt-1">{denialRate}%</p>
        </Card>
      </div>

      {/* Table */}
      <Card className="p-0">
        {paged.length === 0 ? (
          <EmptyState
            title="No enforce events"
            description="No enforcement events match the current filters. Adjust your filters or wait for events to be reported."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gx-border">
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Timestamp</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Agent</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Connector</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Tool</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Permission</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Result</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Reason</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((entry) => (
                  <tr key={entry.id} className="border-b border-gx-border/50 last:border-0">
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className="font-mono text-xs text-gx-muted">{formatTimestamp(entry.timestamp)}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-xs text-gx-text">{entry.agent}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-xs text-gx-text">{entry.connector}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-xs text-gx-accent">{entry.tool}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-gx-muted uppercase">{entry.permission}</span>
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={entry.result === 'allowed' ? 'success' : 'danger'}>
                        {entry.result === 'allowed' ? 'ALLOWED' : 'DENIED'}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-gx-muted">{entry.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gx-border">
            <span className="text-xs text-gx-muted">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 text-xs rounded-md font-medium transition-colors bg-gx-surface border border-gx-border text-gx-muted hover:text-gx-text disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 text-xs rounded-md font-medium transition-colors bg-gx-surface border border-gx-border text-gx-muted hover:text-gx-text disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
