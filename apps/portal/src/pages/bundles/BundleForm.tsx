import { useState, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createBundle } from '../../api/bundles';
import { listAgents } from '../../api/agents';
import type { Agent } from '../../api/types';
import type { CreateBundleResponse } from '../../api/bundles';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { CopyButton } from '../../components/ui/CopyButton';
import { ScopePills } from '../../components/ui/ScopePills';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../lib/cn';

const PLATFORMS = ['Android', 'iOS', 'Raspberry Pi', 'Jetson', 'Other'] as const;

const TTL_OPTIONS = [
  { value: '24h', label: '24 hours' },
  { value: '48h', label: '48 hours' },
  { value: '72h', label: '72 hours' },
  { value: '7d', label: '7 days' },
  { value: 'custom', label: 'Custom' },
];

export function BundleForm() {
  const navigate = useNavigate();
  const { show } = useToast();

  // Step tracking
  const [step, setStep] = useState(1);

  // Step 1: Agent & User
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [platform, setPlatform] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true);

  // Step 2: Scopes & TTL
  const [scopes, setScopes] = useState<string[]>([]);
  const [scopeInput, setScopeInput] = useState('');
  const [ttl, setTtl] = useState('24h');
  const [customTtl, setCustomTtl] = useState('');

  // Step 3: Submit & result
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateBundleResponse | null>(null);

  useEffect(() => {
    listAgents()
      .then((a) => {
        setAgents(a);
        if (a.length > 0 && a[0] !== undefined) setAgentId(a[0].agentId);
      })
      .catch(() => show('Failed to load agents', 'error'))
      .finally(() => setLoadingAgents(false));
  }, [show]);

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

  const resolvedTtl = ttl === 'custom' ? customTtl : ttl;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await createBundle({
        agentId,
        userId,
        scopes,
        offlineTTL: resolvedTtl || undefined,
        deviceId: deviceId.trim() || undefined,
        devicePlatform: platform || undefined,
      });
      setResult(res);
      show('Bundle issued successfully', 'success');
    } catch {
      show('Failed to issue bundle', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const canAdvanceStep1 = agentId && userId.trim();
  const canAdvanceStep2 = scopes.length > 0 && (ttl !== 'custom' || customTtl.trim());

  const selectedAgent = agents.find((a) => a.agentId === agentId);

  if (loadingAgents) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  // Success state — show the issued bundle
  if (result) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-gx-text mb-6">Bundle Issued</h1>

        <Card className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-5 h-5 text-gx-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-semibold text-gx-accent">
              Bundle created successfully
            </span>
          </div>

          <dl className="space-y-4">
            <div>
              <dt className="text-xs text-gx-muted">Bundle ID</dt>
              <dd className="flex items-center gap-2 mt-0.5">
                <code className="text-sm font-mono text-gx-accent2">{result.bundle.id}</code>
                <CopyButton text={result.bundle.id} />
              </dd>
            </div>

            <div>
              <dt className="text-xs text-gx-muted">Grant Token</dt>
              <dd className="mt-0.5">
                <div className="flex items-start gap-2">
                  <code className="text-xs font-mono text-gx-text break-all bg-gx-bg border border-gx-border rounded p-2 flex-1 max-h-24 overflow-y-auto">
                    {result.grantToken}
                  </code>
                  <CopyButton text={result.grantToken} />
                </div>
              </dd>
            </div>

            <div>
              <dt className="text-xs text-gx-muted">JWKS</dt>
              <dd className="mt-0.5">
                <div className="flex items-start gap-2">
                  <pre className="text-xs font-mono text-gx-text whitespace-pre-wrap break-all bg-gx-bg border border-gx-border rounded p-2 flex-1 max-h-32 overflow-y-auto">
                    {JSON.stringify(result.jwks, null, 2)}
                  </pre>
                  <CopyButton text={JSON.stringify(result.jwks, null, 2)} />
                </div>
              </dd>
            </div>

            <div>
              <dt className="flex items-center gap-2 text-xs text-gx-muted">
                Audit Signing Key
                <Badge variant="warning">shown once</Badge>
              </dt>
              <dd className="mt-1">
                <div className="border border-gx-warning/30 bg-gx-warning/5 rounded-md p-3">
                  <p className="text-xs text-gx-warning mb-2">
                    This private key is only displayed once. Store it securely on the device.
                  </p>
                  <div className="flex items-start gap-2">
                    <code className="text-xs font-mono text-gx-text break-all bg-gx-bg border border-gx-border rounded p-2 flex-1">
                      {result.auditKey}
                    </code>
                    <CopyButton text={result.auditKey} />
                  </div>
                </div>
              </dd>
            </div>
          </dl>
        </Card>

        <div className="flex gap-3">
          <Button
            size="sm"
            onClick={() => navigate(`/dashboard/bundles/${result.bundle.id}`)}
          >
            View Bundle
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/dashboard/bundles')}
          >
            Back to List
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-gx-text mb-6">
        New Offline Consent Bundle
      </h1>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold',
                s === step
                  ? 'bg-gx-accent text-gx-bg'
                  : s < step
                    ? 'bg-gx-accent/20 text-gx-accent'
                    : 'bg-gx-border text-gx-muted',
              )}
            >
              {s < step ? (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                s
              )}
            </div>
            <span
              className={cn(
                'text-xs font-medium',
                s === step ? 'text-gx-text' : 'text-gx-muted',
              )}
            >
              {s === 1 ? 'Agent & User' : s === 2 ? 'Scopes & TTL' : 'Review & Issue'}
            </span>
            {s < 3 && (
              <div className="w-8 h-px bg-gx-border mx-1" />
            )}
          </div>
        ))}
      </div>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Step 1 — Agent & User */}
          {step === 1 && (
            <>
              <Select
                id="agent"
                label="Agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                options={agents.map((a) => ({ value: a.agentId, label: `${a.name} (${a.agentId.slice(0, 8)}...)` }))}
              />

              <Input
                id="userId"
                label="User ID"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="e.g., user@example.com or user-id"
                autoFocus
              />

              <div>
                <label className="block text-sm font-medium text-gx-text mb-1.5">
                  Platform
                </label>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlatform((prev) => (prev === p ? '' : p))}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
                        platform === p
                          ? 'border-gx-accent bg-gx-accent/10 text-gx-accent'
                          : 'border-gx-border text-gx-muted hover:text-gx-text hover:border-gx-muted',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <Input
                id="deviceId"
                label="Device ID"
                hint="optional"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                placeholder="e.g., device-serial-number"
              />

              <div className="flex justify-end pt-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!canAdvanceStep1}
                  onClick={() => setStep(2)}
                >
                  Next
                </Button>
              </div>
            </>
          )}

          {/* Step 2 — Scopes & TTL */}
          {step === 2 && (
            <>
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

              <Select
                id="ttl"
                label="Offline TTL"
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                options={TTL_OPTIONS}
              />

              {ttl === 'custom' && (
                <Input
                  id="customTtl"
                  label="Custom TTL"
                  value={customTtl}
                  onChange={(e) => setCustomTtl(e.target.value)}
                  placeholder="e.g., 5d, 14d, 30d"
                  autoFocus
                />
              )}

              {(ttl === '7d' || (ttl === 'custom' && customTtl.match(/^(\d+)d$/) && parseInt(customTtl) > 3)) && (
                <div className="flex items-start gap-2 bg-gx-warning/10 border border-gx-warning/30 rounded-md p-3">
                  <svg className="w-4 h-4 text-gx-warning shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <p className="text-xs text-gx-warning">
                    A TTL longer than 72 hours increases the window during which a revocation cannot reach the device. Consider whether this is acceptable for your use case.
                  </p>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setStep(1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canAdvanceStep2}
                  onClick={() => setStep(3)}
                >
                  Next
                </Button>
              </div>
            </>
          )}

          {/* Step 3 — Review & Issue */}
          {step === 3 && (
            <>
              <h2 className="text-sm font-semibold text-gx-text">Review Bundle</h2>

              <dl className="space-y-3 bg-gx-bg border border-gx-border rounded-md p-4">
                <div>
                  <dt className="text-xs text-gx-muted">Agent</dt>
                  <dd className="text-sm text-gx-text mt-0.5">
                    {selectedAgent ? `${selectedAgent.name} (${selectedAgent.agentId.slice(0, 12)}...)` : agentId}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gx-muted">User</dt>
                  <dd className="text-sm text-gx-text mt-0.5">{userId}</dd>
                </div>
                {platform && (
                  <div>
                    <dt className="text-xs text-gx-muted">Platform</dt>
                    <dd className="mt-0.5">
                      <Badge>{platform}</Badge>
                    </dd>
                  </div>
                )}
                {deviceId.trim() && (
                  <div>
                    <dt className="text-xs text-gx-muted">Device ID</dt>
                    <dd className="text-sm font-mono text-gx-text mt-0.5">{deviceId}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-gx-muted">Scopes</dt>
                  <dd className="mt-1">
                    <ScopePills scopes={scopes} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gx-muted">Offline TTL</dt>
                  <dd className="text-sm text-gx-text mt-0.5">{resolvedTtl}</dd>
                </div>
              </dl>

              <div className="flex justify-between pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setStep(2)}
                >
                  Back
                </Button>
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? <Spinner className="h-4 w-4" /> : 'Issue Bundle'}
                </Button>
              </div>
            </>
          )}
        </form>
      </Card>
    </div>
  );
}
