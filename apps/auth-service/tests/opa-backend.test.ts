import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpaBackend } from '../src/lib/backends/opa.js';
import type { PolicyEvalContext } from '../src/lib/policy-backend.js';
import { sqlMock } from './setup.js';

const ctx: PolicyEvalContext = {
  agentId: 'ag_1',
  principalId: 'user_1',
  scopes: ['read'],
  developerId: 'dev_1',
};

describe('OpaBackend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct request to OPA', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { allow: true } }),
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    await backend.evaluate(ctx);

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toBe('http://opa:8181/v1/data/grantex/authz');
    const body = JSON.parse(fetchCall[1]!.body as string);
    expect(body.input.agent_id).toBe('ag_1');
    expect(body.input.principal_id).toBe('user_1');
    expect(body.input.scopes).toEqual(['read']);
  });

  it('returns allow when OPA allows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { allow: true } }),
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBe('allow');
  });

  it('returns deny when OPA denies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { allow: false, reason: 'policy xyz denied' } }),
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('policy xyz denied');
  });

  it('returns null when OPA result is undefined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: {} }),
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
  });

  it('returns null when OPA returns no result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
  });

  it('returns null with reason on HTTP error (no fallback)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
    expect(decision.reason).toContain('500');
  });

  it('returns null with reason on network error (no fallback)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const backend = new OpaBackend('http://opa:8181', false);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
    expect(decision.reason).toBe('OPA unavailable');
  });

  it('includes optional context fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { allow: true } }),
    } as Response);

    const fullCtx: PolicyEvalContext = {
      ...ctx,
      time: '14:30',
      grant: { id: 'grnt_1', delegationDepth: 0 },
      request: { ip: '1.2.3.4', userAgent: 'test-agent' },
    };

    const backend = new OpaBackend('http://opa:8181', false);
    await backend.evaluate(fullCtx);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.input.time).toBe('14:30');
    expect(body.input.grant.id).toBe('grnt_1');
    expect(body.input.request.ip).toBe('1.2.3.4');
  });

  it('falls back to builtin on network error when fallbackToBuiltin is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    sqlMock.mockResolvedValueOnce([]); // No policies — BuiltinBackend returns null

    const backend = new OpaBackend('http://opa:8181', true);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull(); // No matching policies
  });

  it('falls back to builtin on HTTP error when fallbackToBuiltin is true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    sqlMock.mockResolvedValueOnce([]); // No policies

    const backend = new OpaBackend('http://opa:8181', true);
    const decision = await backend.evaluate(ctx);
    expect(decision.effect).toBeNull();
  });

  it('strips trailing slash from URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { allow: true } }),
    } as Response);

    const backend = new OpaBackend('http://opa:8181/', false);
    await backend.evaluate(ctx);

    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://opa:8181/v1/data/grantex/authz');
  });
});
