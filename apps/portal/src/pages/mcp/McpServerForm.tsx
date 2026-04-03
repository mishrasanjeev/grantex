import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createMcpServer } from '../../api/mcp';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';

const CATEGORIES = [
  { value: 'productivity', label: 'Productivity' },
  { value: 'data', label: 'Data' },
  { value: 'compute', label: 'Compute' },
  { value: 'payments', label: 'Payments' },
  { value: 'communication', label: 'Communication' },
  { value: 'other', label: 'Other' },
];

const DOCKER_COMPOSE_SNIPPET = `version: "3.8"
services:
  mcp-server:
    image: ghcr.io/grantex/mcp-server:latest
    ports:
      - "3100:3100"
    environment:
      - GRANTEX_PROJECT_ID=\${GRANTEX_PROJECT_ID}
      - GRANTEX_API_KEY=\${GRANTEX_API_KEY}
      - GRANTEX_MCP_SERVER_ID=\${GRANTEX_MCP_SERVER_ID}
    restart: unless-stopped`;

export function McpServerForm() {
  const navigate = useNavigate();
  const { show } = useToast();

  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  // Step 1 — Server Details
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [category, setCategory] = useState('productivity');

  // Step 2 — Scopes
  const [scopes, setScopes] = useState<string[]>([]);
  const [scopeInput, setScopeInput] = useState('');
  const [npmPackage, setNpmPackage] = useState('');

  // Step 3 — Deployment
  const [deploymentMode, setDeploymentMode] = useState<'managed' | 'self-hosted'>('managed');

  function addScope() {
    const trimmed = scopeInput.trim();
    if (trimmed && !scopes.includes(trimmed)) {
      setScopes((prev) => [...prev, trimmed]);
    }
    setScopeInput('');
  }

  function removeScope(scope: string) {
    setScopes((prev) => prev.filter((s) => s !== scope));
  }

  function handleScopeKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addScope();
    }
    if (e.key === 'Backspace' && !scopeInput && scopes.length > 0) {
      setScopes((prev) => prev.slice(0, -1));
    }
  }

  function canAdvance(): boolean {
    switch (step) {
      case 1: return !!name.trim();
      case 2: return true;
      case 3: return true;
      case 4: return !!name.trim();
      default: return false;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    try {
      const server = await createMcpServer({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(serverUrl.trim() ? { serverUrl: serverUrl.trim() } : {}),
        ...(npmPackage.trim() ? { npmPackage: npmPackage.trim() } : {}),
        category,
        scopes,
      });
      show('MCP server registered', 'success');
      navigate(`/dashboard/mcp/${server.id}`);
    } catch {
      show('Failed to register MCP server', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const envVars = [
    { key: 'GRANTEX_PROJECT_ID', value: 'your-project-id' },
    { key: 'GRANTEX_API_KEY', value: 'gx_key_...' },
    { key: 'GRANTEX_MCP_SERVER_ID', value: 'auto-generated-on-create' },
  ];

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-gx-text mb-6">Register MCP Server</h1>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                s === step
                  ? 'bg-gx-accent text-gx-bg'
                  : s < step
                    ? 'bg-gx-accent/20 text-gx-accent'
                    : 'bg-gx-border/50 text-gx-muted'
              }`}
            >
              {s}
            </div>
            {s < 4 && (
              <div className={`w-8 h-px ${s < step ? 'bg-gx-accent' : 'bg-gx-border'}`} />
            )}
          </div>
        ))}
      </div>

      <Card>
        <form onSubmit={handleSubmit}>
          {/* Step 1 — Server Details */}
          {step === 1 && (
            <div className="space-y-5">
              <h2 className="text-sm font-semibold text-gx-text mb-4">Server Details</h2>
              <Input
                id="name"
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My MCP Server"
                autoFocus
              />
              <Input
                id="description"
                label="Description"
                hint="optional"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of what this server provides"
              />
              <Input
                id="serverUrl"
                label="Server URL"
                hint="optional"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://mcp.example.com"
              />
              <div>
                <label htmlFor="category" className="block text-sm font-medium text-gx-text mb-1.5">
                  Category
                </label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent transition-colors"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Step 2 — Scope Definition */}
          {step === 2 && (
            <div className="space-y-5">
              <h2 className="text-sm font-semibold text-gx-text mb-4">Scope Definition</h2>
              <div>
                <label className="block text-sm font-medium text-gx-text mb-1.5">
                  Scopes
                </label>
                <div className="flex flex-wrap gap-1.5 p-2 bg-gx-bg border border-gx-border rounded-md min-h-[42px] focus-within:border-gx-accent transition-colors">
                  {scopes.map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-gx-accent2/10 text-gx-accent2"
                    >
                      {scope}
                      <button
                        type="button"
                        onClick={() => removeScope(scope)}
                        className="hover:text-gx-text transition-colors"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                  <input
                    value={scopeInput}
                    onChange={(e) => setScopeInput(e.target.value)}
                    onKeyDown={handleScopeKeyDown}
                    onBlur={addScope}
                    placeholder={scopes.length === 0 ? 'Type a scope and press Enter' : ''}
                    className="flex-1 min-w-[120px] bg-transparent text-sm text-gx-text placeholder-gx-muted/50 outline-none"
                  />
                </div>
                <p className="mt-1 text-xs text-gx-muted">
                  Press Enter or comma to add a scope
                </p>
              </div>
              <Input
                id="npmPackage"
                label="npm Package"
                hint="optional"
                value={npmPackage}
                onChange={(e) => setNpmPackage(e.target.value)}
                placeholder="@org/mcp-server"
              />
            </div>
          )}

          {/* Step 3 — Deployment Mode */}
          {step === 3 && (
            <div className="space-y-5">
              <h2 className="text-sm font-semibold text-gx-text mb-4">Deployment Mode</h2>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDeploymentMode('managed')}
                  className={`flex-1 p-4 rounded-lg border text-left transition-colors ${
                    deploymentMode === 'managed'
                      ? 'border-gx-accent bg-gx-accent/5'
                      : 'border-gx-border bg-gx-bg hover:border-gx-muted'
                  }`}
                >
                  <div className="text-sm font-semibold text-gx-text mb-1">Managed</div>
                  <div className="text-xs text-gx-muted">Grantex hosts and manages the auth layer for your server.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setDeploymentMode('self-hosted')}
                  className={`flex-1 p-4 rounded-lg border text-left transition-colors ${
                    deploymentMode === 'self-hosted'
                      ? 'border-gx-accent bg-gx-accent/5'
                      : 'border-gx-border bg-gx-bg hover:border-gx-muted'
                  }`}
                >
                  <div className="text-sm font-semibold text-gx-text mb-1">Self-hosted</div>
                  <div className="text-xs text-gx-muted">Run the MCP auth proxy in your own infrastructure.</div>
                </button>
              </div>

              {deploymentMode === 'managed' && (
                <div>
                  <p className="text-xs text-gx-muted mb-3">
                    Set these environment variables in your MCP server:
                  </p>
                  <div className="space-y-2">
                    {envVars.map((v) => (
                      <div key={v.key} className="flex items-center justify-between gap-2 p-3 bg-gx-bg border border-gx-border rounded-md">
                        <div>
                          <code className="text-xs font-mono text-gx-accent2">{v.key}</code>
                          <span className="text-xs text-gx-muted ml-2">=</span>
                          <code className="text-xs font-mono text-gx-muted ml-1">{v.value}</code>
                        </div>
                        <CopyButton text={`${v.key}=${v.value}`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {deploymentMode === 'self-hosted' && (
                <div>
                  <p className="text-xs text-gx-muted mb-3">
                    Use this Docker Compose configuration to run the MCP auth proxy:
                  </p>
                  <div className="relative">
                    <pre className="p-4 bg-gx-bg border border-gx-border rounded-md text-xs font-mono text-gx-text overflow-x-auto">
                      {DOCKER_COMPOSE_SNIPPET}
                    </pre>
                    <div className="absolute top-2 right-2">
                      <CopyButton text={DOCKER_COMPOSE_SNIPPET} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 4 — Review & Create */}
          {step === 4 && (
            <div className="space-y-5">
              <h2 className="text-sm font-semibold text-gx-text mb-4">Review & Create</h2>
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-gx-muted">Name</dt>
                  <dd className="text-sm text-gx-text mt-0.5">{name}</dd>
                </div>
                {description && (
                  <div>
                    <dt className="text-xs text-gx-muted">Description</dt>
                    <dd className="text-sm text-gx-text mt-0.5">{description}</dd>
                  </div>
                )}
                {serverUrl && (
                  <div>
                    <dt className="text-xs text-gx-muted">Server URL</dt>
                    <dd className="text-sm font-mono text-gx-text mt-0.5">{serverUrl}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-gx-muted">Category</dt>
                  <dd className="mt-0.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono bg-gx-border/50 text-gx-muted">
                      {category}
                    </span>
                  </dd>
                </div>
                {scopes.length > 0 && (
                  <div>
                    <dt className="text-xs text-gx-muted">Scopes</dt>
                    <dd className="flex flex-wrap gap-1.5 mt-1">
                      {scopes.map((scope) => (
                        <span
                          key={scope}
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-gx-accent2/10 text-gx-accent2"
                        >
                          {scope}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {npmPackage && (
                  <div>
                    <dt className="text-xs text-gx-muted">npm Package</dt>
                    <dd className="text-sm font-mono text-gx-text mt-0.5">{npmPackage}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-gx-muted">Deployment Mode</dt>
                  <dd className="text-sm text-gx-text mt-0.5 capitalize">{deploymentMode}</dd>
                </div>
              </dl>
            </div>
          )}

          {/* Navigation buttons */}
          <div className="flex justify-between gap-3 pt-6 mt-6 border-t border-gx-border">
            <div>
              {step > 1 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setStep((s) => s - 1)}
                >
                  Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => navigate('/dashboard/mcp')}
              >
                Cancel
              </Button>
              {step < 4 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={!canAdvance()}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Next
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={submitting || !name.trim()}>
                  {submitting ? <Spinner className="h-4 w-4" /> : 'Register Server'}
                </Button>
              )}
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
