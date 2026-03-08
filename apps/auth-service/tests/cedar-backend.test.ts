import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CedarBackend } from '../src/lib/backends/cedar.js';
import type { PolicyEvalContext } from '../src/lib/policy-backend.js';
import { sqlMock } from './setup.js';

const ctx: PolicyEvalContext = {
  agentId: 'ag_1',
  principalId: 'user_1',
  scopes: ['read'],
  developerId: 'dev_1',
};

describe('CedarBackend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct request to Cedar', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Allow' }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    await backend.evaluate(ctx);

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toBe('http://cedar:8180/v1/is_authorized');
    const body = JSON.parse(fetchCall[1]!.body as string);
    expect(body.principal.type).toBe('Grantex::Agent');
    expect(body.principal.id).toBe('ag_1');
    expect(body.action.type).toBe('Grantex::Action');
    expect(body.action.id).toBe('authorize');
    expect(body.context.principalId).toBe('user_1');
  });

  it('returns allow when Cedar allows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Allow' }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBe('allow');
  });

  it('returns deny when Cedar denies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        decision: 'Deny',
        diagnostics: { reason: ['policy0 denied'] },
      }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('policy0 denied');
  });

  it('returns deny with multiple reasons', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        decision: 'Deny',
        diagnostics: { reason: ['policy0', 'policy1'] },
      }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.reason).toBe('policy0; policy1');
  });

  it('returns null with reason on HTTP error (no fallback)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
    expect(decision.reason).toContain('503');
  });

  it('returns null with reason on network error (no fallback)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
    expect(decision.reason).toBe('Cedar unavailable');
  });

  it('includes grant and delegation context', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Allow' }),
    } as Response);

    const fullCtx: PolicyEvalContext = {
      ...ctx,
      grant: { id: 'grnt_1', delegationDepth: 2 },
    };

    const backend = new CedarBackend('http://cedar:8180', false);
    await backend.evaluate(fullCtx);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.resource.id).toBe('grnt_1');
    expect(body.context.delegationDepth).toBe(2);
  });

  it('uses "pending" as resource id when no grant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Allow' }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    await backend.evaluate(ctx);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.resource.id).toBe('pending');
  });

  it('falls back to builtin on network error when fallbackToBuiltin is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    sqlMock.mockResolvedValueOnce([]); // No policies — BuiltinBackend returns null

    const backend = new CedarBackend('http://cedar:8180', true);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
  });

  it('falls back to builtin on HTTP error when fallbackToBuiltin is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);
    sqlMock.mockResolvedValueOnce([]); // No policies

    const backend = new CedarBackend('http://cedar:8180', true);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
  });

  it('strips trailing slash from URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Allow' }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180/', false);
    await backend.evaluate(ctx);

    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://cedar:8180/v1/is_authorized');
  });

  it('handles empty diagnostics', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'Deny', diagnostics: {} }),
    } as Response);

    const backend = new CedarBackend('http://cedar:8180', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBeUndefined();
  });
});
