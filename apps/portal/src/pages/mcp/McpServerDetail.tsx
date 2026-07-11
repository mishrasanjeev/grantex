import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getMcpServer, applyForCertification } from '../../api/mcp';
import type { McpCertification, McpServer } from '../../api/mcp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { formatDateTime } from '../../lib/format';

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

interface StatCardProps {
  label: string;
  value: string | number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <Card>
      <div className="text-xs text-gx-muted mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gx-text">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </Card>
  );
}

export function McpServerDetail() {
  const { serverId } = useParams<{ serverId: string }>();
  const { show } = useToast();

  const [server, setServer] = useState<McpServer | null>(null);
  const [certification, setCertification] = useState<McpCertification | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!serverId) return;
    getMcpServer(serverId)
      .then(setServer)
      .catch(() => show('Failed to load MCP server', 'error'))
      .finally(() => setLoading(false));
  }, [serverId, show]);

  async function handleApplyCertification(level: string) {
    if (!serverId) return;
    setApplying(true);
    try {
      const application = await applyForCertification(serverId, level);
      setCertification(application);
      show(`Applied for ${level} certification`, 'success');
    } catch {
      show('Failed to apply for certification', 'error');
    } finally {
      setApplying(false);
    }
  }

  if (loading || !server) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  // Determine which cert levels can be applied for
  const currentLevel = server.certificationLevel;
  const certOptions: string[] = [];
  if (!currentLevel) {
    certOptions.push('bronze', 'silver', 'gold');
  } else if (currentLevel === 'bronze') {
    certOptions.push('silver', 'gold');
  } else if (currentLevel === 'silver') {
    certOptions.push('gold');
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/dashboard/mcp" className="text-xs text-gx-muted hover:text-gx-text transition-colors">
            &larr; MCP Servers
          </Link>
          <h1 className="text-xl font-semibold text-gx-text mt-1">{server.name}</h1>
        </div>
      </div>

      {/* Server metadata card */}
      <Card className="mb-6">
        <h2 className="text-xs font-medium text-gx-muted mb-4">Server Details</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-gx-muted">Server ID</dt>
            <dd className="flex items-center gap-2 mt-0.5">
              <code className="text-sm font-mono text-gx-accent2">{server.id}</code>
              <CopyButton text={server.id} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gx-muted">Category</dt>
            <dd className="mt-0.5">
              <Badge variant="default">{server.category}</Badge>
            </dd>
          </div>
          {server.authEndpoint && (
            <div>
              <dt className="text-xs text-gx-muted">Auth Endpoint</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text truncate">{server.authEndpoint}</code>
                <CopyButton text={server.authEndpoint} />
              </dd>
            </div>
          )}
          {server.serverUrl && (
            <div>
              <dt className="text-xs text-gx-muted">Server URL</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-text truncate">{server.serverUrl}</code>
                <CopyButton text={server.serverUrl} />
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-gx-muted">Status</dt>
            <dd className="mt-0.5">
              <Badge variant={server.status === 'active' ? 'success' : server.status === 'pending' ? 'warning' : 'default'}>
                {server.status}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gx-muted">Created</dt>
            <dd className="text-sm text-gx-text mt-0.5">{formatDateTime(server.createdAt)}</dd>
          </div>
          {server.scopes.length > 0 && (
            <div className="md:col-span-2">
              <dt className="text-xs text-gx-muted">Scopes</dt>
              <dd className="mt-1">
                <ScopePills scopes={server.scopes} />
              </dd>
            </div>
          )}
          {server.description && (
            <div className="md:col-span-2">
              <dt className="text-xs text-gx-muted">Description</dt>
              <dd className="text-sm text-gx-text mt-0.5">{server.description}</dd>
            </div>
          )}
        </dl>
      </Card>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Weekly Agents" value={server.weeklyActiveAgents} />
        <StatCard label="Stars" value={server.stars} />
      </div>

      {/* Certification section */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gx-text">Certification</h2>
          {certOptions.length > 0 && !certification && !server.certificationPending && (
            <div className="flex items-center gap-2">
              {certOptions.map((level) => (
                <Button
                  key={level}
                  variant="secondary"
                  size="sm"
                  disabled={applying}
                  onClick={() => handleApplyCertification(level)}
                >
                  {applying ? <Spinner className="h-3 w-3" /> : `Apply for ${level.charAt(0).toUpperCase() + level.slice(1)}`}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="text-xs text-gx-muted mb-1">Current Level</div>
            {certBadge(currentLevel)}
          </div>
          {server.certificationPending && !certification && (
            <div>
              <div className="text-xs text-gx-muted mb-1">Application Status</div>
              <span className="text-sm text-gx-text">pending</span>
            </div>
          )}
          {certification && (
            <>
              <div>
                <div className="text-xs text-gx-muted mb-1">Application Status</div>
                <span className="text-sm text-gx-text">
                  {certification.status.replace(/_/g, ' ')}
                </span>
              </div>
              <div>
                <div className="text-xs text-gx-muted mb-1">Requested Level</div>
                {certBadge(certification.requestedLevel)}
              </div>
              <div>
                <div className="text-xs text-gx-muted mb-1">Conformance Results</div>
                <span className="text-sm font-mono text-gx-text">
                  {certification.conformancePassed} / {certification.conformanceTotal}
                </span>
              </div>
            </>
          )}
          {server.certifiedAt && (
            <div>
              <div className="text-xs text-gx-muted mb-1">Certified At</div>
              <span className="text-sm text-gx-text">{formatDateTime(server.certifiedAt)}</span>
            </div>
          )}
        </div>
        {!certification && !server.certificationPending && !server.certified && (
          <p className="text-xs text-gx-muted mt-4">
            Conformance results appear after the certification service processes an application.
          </p>
        )}
      </Card>
    </div>
  );
}
