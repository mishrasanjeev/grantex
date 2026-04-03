import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { listMcpServers } from '../../api/mcp';
import type { McpServer } from '../../api/mcp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDate } from '../../lib/format';

const CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'data', label: 'Data' },
  { value: 'compute', label: 'Compute' },
  { value: 'payments', label: 'Payments' },
  { value: 'communication', label: 'Communication' },
  { value: 'other', label: 'Other' },
];

function certBadge(level: string | null) {
  if (!level) return <Badge>none</Badge>;
  const colors: Record<string, string> = {
    gold: 'bg-yellow-500/15 text-yellow-500',
    silver: 'bg-gray-400/15 text-gray-400',
    bronze: 'bg-orange-400/15 text-orange-400',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono ${colors[level] ?? 'bg-gx-border/50 text-gx-muted'}`}
    >
      {level}
    </span>
  );
}

export function McpServerList() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [certifiedOnly, setCertifiedOnly] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  useEffect(() => {
    setLoading(true);
    listMcpServers({
      ...(category ? { category } : {}),
      ...(certifiedOnly ? { certified: true } : {}),
    })
      .then(setServers)
      .catch(() => show('Failed to load MCP servers', 'error'))
      .finally(() => setLoading(false));
  }, [category, certifiedOnly, show]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gx-text">MCP Servers</h1>
        <Link to="/dashboard/mcp/new">
          <Button size="sm">+ Register Server</Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent transition-colors"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gx-muted cursor-pointer">
          <input
            type="checkbox"
            checked={certifiedOnly}
            onChange={(e) => setCertifiedOnly(e.target.checked)}
            className="rounded border-gx-border text-gx-accent focus:ring-gx-accent"
          />
          Certified only
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <Card className="p-0">
          {servers.length === 0 ? (
            <EmptyState
              title="No MCP servers found"
              description="Register your first MCP server to get started."
              action={
                <Link to="/dashboard/mcp/new">
                  <Button size="sm">+ Register Server</Button>
                </Link>
              }
            />
          ) : (
            <div className="p-4">
              <Table
                data={servers}
                rowKey={(s) => s.id}
                onRowClick={(s) => navigate(`/dashboard/mcp/${s.id}`)}
                columns={[
                  {
                    key: 'name',
                    header: 'Name',
                    render: (s) => (
                      <span className="font-medium text-gx-text">{s.name}</span>
                    ),
                  },
                  {
                    key: 'category',
                    header: 'Category',
                    render: (s) => (
                      <Badge variant="default">{s.category}</Badge>
                    ),
                  },
                  {
                    key: 'certified',
                    header: 'Certified',
                    render: (s) => certBadge(s.certificationLevel),
                  },
                  {
                    key: 'weeklyAgents',
                    header: 'Weekly Agents',
                    render: (s) => (
                      <span className="text-gx-text text-sm">{s.weeklyActiveAgents.toLocaleString()}</span>
                    ),
                  },
                  {
                    key: 'stars',
                    header: 'Stars',
                    render: (s) => (
                      <span className="text-gx-text text-sm">{s.stars.toLocaleString()}</span>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (s) => (
                      <Badge variant={s.status === 'active' ? 'success' : s.status === 'pending' ? 'warning' : 'default'}>
                        {s.status}
                      </Badge>
                    ),
                  },
                  {
                    key: 'created',
                    header: 'Created',
                    render: (s) => (
                      <span className="text-gx-muted text-xs">{formatDate(s.createdAt)}</span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right',
                    render: (s) => (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/dashboard/mcp/${s.id}`);
                          }}
                        >
                          View
                        </Button>
                        {!s.certified && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/dashboard/mcp/${s.id}`);
                            }}
                          >
                            Certify
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
