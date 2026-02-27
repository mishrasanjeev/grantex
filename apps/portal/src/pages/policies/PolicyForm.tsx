import { useState, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createPolicy, getPolicy, updatePolicy } from '../../api/policies';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';

export function PolicyForm() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const { show } = useToast();

  const [name, setName] = useState('');
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow');
  const [priority, setPriority] = useState('0');
  const [agentId, setAgentId] = useState('');
  const [principalId, setPrincipalId] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [scopeInput, setScopeInput] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    getPolicy(id)
      .then((p) => {
        setName(p.name);
        setEffect(p.effect);
        setPriority(String(p.priority));
        setAgentId(p.agentId ?? '');
        setPrincipalId(p.principalId ?? '');
        setScopes(p.scopes ?? []);
        setTimeStart(p.timeOfDayStart ?? '');
        setTimeEnd(p.timeOfDayEnd ?? '');
      })
      .catch(() => {
        show('Policy not found', 'error');
        navigate('/dashboard/policies');
      })
      .finally(() => setLoading(false));
  }, [id, show, navigate]);

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    const data = {
      name: name.trim(),
      effect,
      priority: parseInt(priority, 10) || 0,
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      ...(principalId.trim() ? { principalId: principalId.trim() } : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(timeStart.trim() ? { timeOfDayStart: timeStart.trim() } : {}),
      ...(timeEnd.trim() ? { timeOfDayEnd: timeEnd.trim() } : {}),
    };

    try {
      if (isEdit) {
        await updatePolicy(id, data);
        show('Policy updated', 'success');
      } else {
        await createPolicy(data);
        show('Policy created', 'success');
      }
      navigate('/dashboard/policies');
    } catch {
      show(isEdit ? 'Failed to update policy' : 'Failed to create policy', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-gx-text mb-6">
        {isEdit ? 'Edit Policy' : 'Create Policy'}
      </h1>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-5">
          <Input
            id="name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Deny off-hours access"
            autoFocus
          />

          <div className="grid grid-cols-2 gap-4">
            <Select
              id="effect"
              label="Effect"
              value={effect}
              onChange={(e) => setEffect(e.target.value as 'allow' | 'deny')}
              options={[
                { value: 'allow', label: 'Allow' },
                { value: 'deny', label: 'Deny' },
              ]}
            />
            <Input
              id="priority"
              label="Priority"
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              id="agentId"
              label="Agent ID"
              hint="optional"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="ag_..."
              className="font-mono"
            />
            <Input
              id="principalId"
              label="Principal ID"
              hint="optional"
              value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
              placeholder="Any principal"
              className="font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gx-text mb-1.5">
              Scopes <span className="text-gx-muted font-normal">(optional)</span>
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
                placeholder={scopes.length === 0 ? 'Applies to all scopes' : ''}
                className="flex-1 min-w-[120px] bg-transparent text-sm text-gx-text placeholder-gx-muted/50 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              id="timeStart"
              label="Time-of-day start"
              hint="optional, HH:MM"
              type="time"
              value={timeStart}
              onChange={(e) => setTimeStart(e.target.value)}
            />
            <Input
              id="timeEnd"
              label="Time-of-day end"
              hint="optional, HH:MM"
              type="time"
              value={timeEnd}
              onChange={(e) => setTimeEnd(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate('/dashboard/policies')}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting || !name.trim()}>
              {submitting ? <Spinner className="h-4 w-4" /> : isEdit ? 'Save Changes' : 'Create Policy'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
