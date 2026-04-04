import { useState, useMemo, Fragment } from 'react';
import { BUNDLED_MANIFESTS, CATEGORIES, type Category } from '../../api/manifests';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { cn } from '../../lib/cn';

// Permission-level sample tools for expanded rows (representative examples per connector)
const SAMPLE_TOOLS: Record<string, { name: string; permission: string }[]> = {
  salesforce: [
    { name: 'get_account', permission: 'read' },
    { name: 'list_contacts', permission: 'read' },
    { name: 'create_opportunity', permission: 'write' },
    { name: 'update_lead', permission: 'write' },
    { name: 'delete_record', permission: 'delete' },
    { name: 'run_report', permission: 'read' },
  ],
  hubspot: [
    { name: 'get_contact', permission: 'read' },
    { name: 'list_deals', permission: 'read' },
    { name: 'search_companies', permission: 'read' },
    { name: 'create_contact', permission: 'write' },
    { name: 'update_deal', permission: 'write' },
    { name: 'send_email', permission: 'write' },
    { name: 'create_task', permission: 'write' },
    { name: 'list_pipelines', permission: 'read' },
    { name: 'get_timeline', permission: 'read' },
    { name: 'create_note', permission: 'write' },
    { name: 'update_company', permission: 'write' },
    { name: 'delete_contact', permission: 'delete' },
    { name: 'list_owners', permission: 'read' },
  ],
  stripe: [
    { name: 'get_customer', permission: 'read' },
    { name: 'list_charges', permission: 'read' },
    { name: 'create_payment_intent', permission: 'write' },
    { name: 'update_subscription', permission: 'write' },
    { name: 'list_invoices', permission: 'read' },
    { name: 'create_refund', permission: 'write' },
    { name: 'delete_customer', permission: 'delete' },
    { name: 'run_payment', permission: 'admin' },
  ],
  jira: [
    { name: 'get_issue', permission: 'read' },
    { name: 'list_projects', permission: 'read' },
    { name: 'search_issues', permission: 'read' },
    { name: 'create_issue', permission: 'write' },
    { name: 'update_issue', permission: 'write' },
    { name: 'transition_issue', permission: 'write' },
    { name: 'assign_issue', permission: 'write' },
    { name: 'add_comment', permission: 'write' },
    { name: 'delete_issue', permission: 'delete' },
    { name: 'list_sprints', permission: 'read' },
    { name: 'get_board', permission: 'read' },
  ],
  slack: [
    { name: 'list_channels', permission: 'read' },
    { name: 'get_channel_history', permission: 'read' },
    { name: 'send_message', permission: 'write' },
    { name: 'update_message', permission: 'write' },
    { name: 'delete_message', permission: 'delete' },
    { name: 'upload_file', permission: 'write' },
    { name: 'search_messages', permission: 'read' },
  ],
  github: [
    { name: 'get_repo', permission: 'read' },
    { name: 'list_issues', permission: 'read' },
    { name: 'create_issue', permission: 'write' },
    { name: 'create_pull_request', permission: 'write' },
    { name: 'update_issue', permission: 'write' },
    { name: 'list_commits', permission: 'read' },
    { name: 'search_code', permission: 'read' },
    { name: 'delete_branch', permission: 'delete' },
    { name: 'list_workflows', permission: 'read' },
  ],
  quickbooks: [
    { name: 'get_invoice', permission: 'read' },
    { name: 'list_customers', permission: 'read' },
    { name: 'create_invoice', permission: 'write' },
    { name: 'update_customer', permission: 'write' },
    { name: 'run_report', permission: 'read' },
    { name: 'void_payment', permission: 'delete' },
  ],
  gmail: [
    { name: 'list_messages', permission: 'read' },
    { name: 'get_message', permission: 'read' },
    { name: 'send_message', permission: 'write' },
    { name: 'delete_message', permission: 'delete' },
  ],
};

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger';

function permBadge(permission: string) {
  const map: Record<string, { variant: BadgeVariant; label: string }> = {
    read: { variant: 'success', label: 'READ' },
    write: { variant: 'warning', label: 'WRITE' },
    delete: { variant: 'danger', label: 'DELETE' },
  };

  const entry = map[permission];
  if (entry) return <Badge variant={entry.variant}>{entry.label}</Badge>;

  // admin gets purple — no built-in variant
  if (permission === 'admin') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono bg-purple-500/15 text-purple-400">
        ADMIN
      </span>
    );
  }

  return <Badge>{permission.toUpperCase()}</Badge>;
}

const categoryLabels: Record<string, string> = {
  all: 'All',
  finance: 'Finance',
  hr: 'HR',
  marketing: 'Marketing',
  ops: 'Ops',
  comms: 'Comms',
};

export function ManifestViewer() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = BUNDLED_MANIFESTS;
    if (category !== 'all') {
      result = result.filter((m) => m.category === category);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) =>
          m.connector.includes(q) ||
          m.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [search, category]);

  const totalTools = filtered.reduce((sum, m) => sum + m.tools, 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gx-text">Tool Manifests</h1>
        <p className="text-sm text-gx-muted mt-1">
          Pre-built permission manifests for {BUNDLED_MANIFESTS.length} connectors. Each manifest maps tool names to permission levels used by <code className="text-xs bg-gx-bg px-1 py-0.5 rounded">enforce()</code>.
        </p>
      </div>

      {/* Search + Category filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="sm:w-72">
          <Input
            placeholder="Search connectors or tools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-full font-medium transition-colors border',
                category === cat
                  ? 'bg-gx-accent/15 text-gx-accent border-gx-accent/30'
                  : 'bg-gx-surface text-gx-muted border-gx-border hover:text-gx-text hover:border-gx-accent/30',
              )}
            >
              {categoryLabels[cat]}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
        <Card>
          <p className="text-sm text-gx-muted">Connectors</p>
          <p className="text-2xl font-semibold text-gx-text mt-1">{filtered.length}</p>
        </Card>
        <Card>
          <p className="text-sm text-gx-muted">Total Tools</p>
          <p className="text-2xl font-semibold text-gx-accent mt-1">{totalTools}</p>
        </Card>
        <Card className="hidden sm:block">
          <p className="text-sm text-gx-muted">Categories</p>
          <p className="text-2xl font-semibold text-gx-text mt-1">{category === 'all' ? 5 : 1}</p>
        </Card>
      </div>

      {/* Table */}
      <Card className="p-0">
        {filtered.length === 0 ? (
          <EmptyState title="No manifests found" description="Try adjusting your search or category filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gx-border">
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Connector</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Category</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Tools</th>
                  <th className="text-left py-2.5 px-4 text-xs font-medium text-gx-muted">Description</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <Fragment key={m.connector}>
                    <tr
                      className="border-b border-gx-border/50 last:border-0 cursor-pointer hover:bg-gx-bg/50 transition-colors"
                      onClick={() => setExpanded(expanded === m.connector ? null : m.connector)}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <svg
                            className={cn(
                              'w-3.5 h-3.5 text-gx-muted transition-transform',
                              expanded === m.connector && 'rotate-90',
                            )}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="font-mono text-sm text-gx-text">{m.connector}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs text-gx-muted uppercase tracking-wider">{m.category}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-gx-accent">{m.tools}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-gx-muted">{m.description}</span>
                      </td>
                    </tr>
                    {expanded === m.connector && (
                      <tr className="bg-gx-bg/30">
                        <td colSpan={4} className="px-4 py-3">
                          {SAMPLE_TOOLS[m.connector] ? (
                            <div className="flex flex-wrap gap-2">
                              {SAMPLE_TOOLS[m.connector]!.map((t) => (
                                <div
                                  key={t.name}
                                  className="flex items-center gap-1.5 bg-gx-surface border border-gx-border rounded px-2.5 py-1.5"
                                >
                                  <span className="font-mono text-xs text-gx-text">{t.name}</span>
                                  {permBadge(t.permission)}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-gx-muted">
                              Run <code className="bg-gx-bg px-1 py-0.5 rounded">grantex manifest show {m.connector}</code> to view all {m.tools} tools and permissions.
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
