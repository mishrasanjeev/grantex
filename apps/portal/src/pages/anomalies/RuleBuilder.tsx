import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  listRules,
  createRule,
  toggleRule,
  deleteRule,
  listChannels,
  type AnomalyRule,
  type AnomalyChannel,
} from '../../api/anomalies';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

const severityVariant: Record<string, 'danger' | 'warning' | 'default'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'warning',
  low: 'default',
};

export function RuleBuilder() {
  const [rules, setRules] = useState<AnomalyRule[]>([]);
  const [channels, setChannels] = useState<AnomalyChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AnomalyRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const { show } = useToast();

  // Create form state
  const [formRuleId, setFormRuleId] = useState('');
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formSeverity, setFormSeverity] = useState('medium');
  const [formAgentIds, setFormAgentIds] = useState('');
  const [formScopes, setFormScopes] = useState('');
  const [formTimeWindow, setFormTimeWindow] = useState('1h');
  const [formThreshold, setFormThreshold] = useState('10');
  const [formChannels, setFormChannels] = useState<string[]>([]);

  useEffect(() => {
    Promise.all([listRules(), listChannels()])
      .then(([r, c]) => {
        setRules(r);
        setChannels(c);
      })
      .catch(() => show('Failed to load rules', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleToggle(rule: AnomalyRule) {
    try {
      const updated = await toggleRule(rule.ruleId, !rule.enabled);
      setRules((prev) =>
        prev.map((r) => (r.ruleId === rule.ruleId ? updated : r)),
      );
      show(`Rule ${updated.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch {
      show('Failed to update rule', 'error');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteRule(deleteTarget.ruleId);
      setRules((prev) => prev.filter((r) => r.ruleId !== deleteTarget.ruleId));
      show('Rule deleted', 'success');
      setDeleteTarget(null);
    } catch {
      show('Failed to delete rule', 'error');
    } finally {
      setDeleting(false);
    }
  }

  function resetForm() {
    setFormRuleId('');
    setFormName('');
    setFormDescription('');
    setFormSeverity('medium');
    setFormAgentIds('');
    setFormScopes('');
    setFormTimeWindow('1h');
    setFormThreshold('10');
    setFormChannels([]);
  }

  async function handleCreate() {
    if (!formRuleId.trim() || !formName.trim()) {
      show('Rule ID and Name are required', 'error');
      return;
    }
    setCreating(true);
    try {
      const newRule = await createRule({
        ruleId: formRuleId.trim(),
        name: formName.trim(),
        description: formDescription.trim(),
        severity: formSeverity,
        condition: {
          ...(formAgentIds.trim()
            ? { agentIds: formAgentIds.split(',').map((s) => s.trim()).filter(Boolean) }
            : {}),
          ...(formScopes.trim()
            ? { scopes: formScopes.split(',').map((s) => s.trim()).filter(Boolean) }
            : {}),
          ...(formTimeWindow ? { timeWindow: formTimeWindow } : {}),
          ...(formThreshold ? { threshold: parseInt(formThreshold, 10) } : {}),
        },
        ...(formChannels.length > 0 ? { channels: formChannels } : {}),
      });
      setRules((prev) => [...prev, newRule]);
      show('Rule created', 'success');
      setShowCreate(false);
      resetForm();
    } catch {
      show('Failed to create rule', 'error');
    } finally {
      setCreating(false);
    }
  }

  function handleChannelToggle(channelId: string) {
    setFormChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((c) => c !== channelId)
        : [...prev, channelId],
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const builtinRules = rules.filter((r) => r.builtin);
  const customRules = rules.filter((r) => !r.builtin);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Link
          to="/dashboard/anomalies"
          className="text-gx-muted hover:text-gx-text transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 19.5L8.25 12l7.5-7.5"
            />
          </svg>
        </Link>
        <h1 className="text-xl font-semibold text-gx-text flex-1">Anomaly Rules</h1>
        <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
          + Create Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card>
          <EmptyState
            title="No rules configured"
            description="Create your first anomaly detection rule."
            action={
              <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
                + Create Rule
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Built-in rules */}
          {builtinRules.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-medium text-gx-muted mb-3">
                Built-in Rules ({builtinRules.length})
              </h2>
              <div className="space-y-2">
                {builtinRules.map((rule) => (
                  <RuleCard
                    key={rule.ruleId}
                    rule={rule}
                    onToggle={() => handleToggle(rule)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Custom rules */}
          <div>
            <h2 className="text-sm font-medium text-gx-muted mb-3">
              Custom Rules ({customRules.length})
            </h2>
            {customRules.length === 0 ? (
              <Card>
                <p className="text-sm text-gx-muted text-center py-4">
                  No custom rules yet. Click "+ Create Rule" to add one.
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {customRules.map((rule) => (
                  <RuleCard
                    key={rule.ruleId}
                    rule={rule}
                    onToggle={() => handleToggle(rule)}
                    onDelete={() => setDeleteTarget(rule)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Create rule modal */}
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          resetForm();
        }}
        title="Create Detection Rule"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gx-muted mb-1 block">Rule ID *</label>
              <input
                value={formRuleId}
                onChange={(e) => setFormRuleId(e.target.value)}
                placeholder="custom_velocity_check"
                className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gx-muted mb-1 block">Name *</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Custom Velocity Check"
                className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gx-muted mb-1 block">Description</label>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Describe what this rule detects..."
              rows={2}
              className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent resize-y"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gx-muted mb-1 block">Severity</label>
            <select
              value={formSeverity}
              onChange={(e) => setFormSeverity(e.target.value)}
              className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text focus:outline-none focus:border-gx-accent"
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className="border-t border-gx-border pt-4">
            <h4 className="text-xs font-medium text-gx-text mb-3">Condition</h4>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gx-muted mb-1 block">
                  Agent IDs (comma-separated)
                </label>
                <input
                  value={formAgentIds}
                  onChange={(e) => setFormAgentIds(e.target.value)}
                  placeholder="ag_01abc, ag_02def"
                  className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gx-muted mb-1 block">
                  Scope filter (comma-separated)
                </label>
                <input
                  value={formScopes}
                  onChange={(e) => setFormScopes(e.target.value)}
                  placeholder="calendar:write, email:send"
                  className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gx-muted mb-1 block">Time Window</label>
                  <select
                    value={formTimeWindow}
                    onChange={(e) => setFormTimeWindow(e.target.value)}
                    className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text focus:outline-none focus:border-gx-accent"
                  >
                    <option value="5m">5 minutes</option>
                    <option value="15m">15 minutes</option>
                    <option value="1h">1 hour</option>
                    <option value="6h">6 hours</option>
                    <option value="24h">24 hours</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gx-muted mb-1 block">Threshold</label>
                  <input
                    type="number"
                    value={formThreshold}
                    onChange={(e) => setFormThreshold(e.target.value)}
                    min={1}
                    className="w-full bg-gx-bg border border-gx-border rounded-md px-3 py-2 text-sm text-gx-text focus:outline-none focus:border-gx-accent"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Channel selection */}
          {channels.length > 0 && (
            <div className="border-t border-gx-border pt-4">
              <h4 className="text-xs font-medium text-gx-text mb-3">Alert Channels</h4>
              <div className="space-y-2">
                {channels.map((ch) => (
                  <label
                    key={ch.id}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={formChannels.includes(ch.id)}
                      onChange={() => handleChannelToggle(ch.id)}
                      className="rounded border-gx-border text-gx-accent focus:ring-gx-accent"
                    />
                    <span className="text-sm text-gx-text">{ch.name}</span>
                    <span className="text-xs text-gx-muted font-mono">({ch.type})</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowCreate(false);
                resetForm();
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? <Spinner className="h-4 w-4" /> : 'Create Rule'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Rule"
        message={`Are you sure you want to delete the rule "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete Rule"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}

// ── Rule card sub-component ────────────────────────────────────────────────

function RuleCard({
  rule,
  onToggle,
  onDelete,
}: {
  rule: AnomalyRule;
  onToggle: () => void;
  onDelete?: () => void;
}) {
  return (
    <Card className={!rule.enabled ? 'opacity-60' : ''}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-medium text-gx-text">{rule.name}</span>
            <Badge variant={severityVariant[rule.severity] ?? 'default'}>
              {rule.severity}
            </Badge>
            {rule.builtin && <Badge>Built-in</Badge>}
          </div>
          <p className="text-xs text-gx-muted">{rule.description}</p>
          <p className="text-xs text-gx-muted font-mono mt-1">{rule.ruleId}</p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Toggle */}
          <button
            onClick={onToggle}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              rule.enabled ? 'bg-gx-accent' : 'bg-gx-border'
            }`}
            title={rule.enabled ? 'Disable rule' : 'Enable rule'}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                rule.enabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>

          {/* Delete (custom only) */}
          {onDelete && (
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
