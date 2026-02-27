import { useState, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createAgent, getAgent, updateAgent } from '../../api/agents';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Spinner } from '../../components/ui/Spinner';

export function AgentForm() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const { show } = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [scopeInput, setScopeInput] = useState('');
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    getAgent(id)
      .then((agent) => {
        setName(agent.name);
        setDescription(agent.description ?? '');
        setScopes(agent.scopes);
      })
      .catch(() => {
        show('Agent not found', 'error');
        navigate('/dashboard/agents');
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
    try {
      if (isEdit) {
        await updateAgent(id, {
          name: name.trim(),
          description: description.trim() || undefined,
          scopes,
        });
        show('Agent updated', 'success');
        navigate(`/dashboard/agents/${id}`);
      } else {
        const agent = await createAgent({
          name: name.trim(),
          description: description.trim() || undefined,
          scopes,
        });
        show('Agent created', 'success');
        navigate(`/dashboard/agents/${agent.agentId}`);
      }
    } catch {
      show(isEdit ? 'Failed to update agent' : 'Failed to create agent', 'error');
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
        {isEdit ? 'Edit Agent' : 'Create Agent'}
      </h1>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-5">
          <Input
            id="name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent"
            autoFocus
          />

          <Input
            id="description"
            label="Description"
            hint="optional"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A brief description of what this agent does"
          />

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

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate(-1)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting || !name.trim()}>
              {submitting ? <Spinner className="h-4 w-4" /> : isEdit ? 'Save Changes' : 'Create Agent'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
