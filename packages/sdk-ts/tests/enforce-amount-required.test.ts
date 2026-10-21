// SPDX-License-Identifier: Apache-2.0
// A `capped:N` scope needs an amount: enforce(), wrapTool() and enforceMiddleware() deny without one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolManifest } from '../src/manifest.js';
import { CapSubReason, DenialReason } from '../src/denials.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', () => ({
  verifyGrantToken: vi.fn(),
  mapOnlineVerifyToVerifiedGrant: vi.fn(),
}));

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

function grant(...scopes: string[]): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_01',
    developerId: 'org_01',
    scopes,
    issuedAt: 1709000000,
    expiresAt: 9999999999,
  };
}

const merchant = ToolManifest.fromJSON({
  connector: 'merchant',
  tools: { get_order: 'read', place_order: 'write' },
});

function client(options: Record<string, unknown> = {}) {
  const c = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', ...options } as ConstructorParameters<typeof Grantex>[0]);
  c.loadManifest(merchant);
  return c;
}

function fakeTool() {
  return { name: 'place_order', description: 'Place an order', invoke: vi.fn().mockResolvedValue('placed') };
}

beforeEach(() => {
  vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:50'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('enforce() with a capped scope and no amount', () => {
  it('test_capped_scope_without_amount_denies_amount_missing', async () => {
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING]);
    expect(r.details).toEqual({ limit: 50 });
    expect(r.reason).toContain('no amount');
  });

  it('applies a capped scope on any permission of the connector', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:read:capped:5', 'tool:merchant:write'));
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.subReason).toBe(CapSubReason.AMOUNT_MISSING);
  });

  it('allows the call with an amount within the cap', async () => {
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order', amount: 50 });
    expect(r.allowed).toBe(true);
  });

  it('allows an uncapped scope without an amount', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write'));
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
    expect('reasonCode' in r).toBe(false);
  });

  it('ignores a capped scope on another connector', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write', 'tool:other:write:capped:5'));
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
  });

  it('applies a capped scope to read tools of the connector', async () => {
    // Connector-wide: a read tool already covered by an uncapped scope still
    // needs an amount (an extractor may report 0).
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:read:*', 'tool:merchant:write:*:capped:50'));
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'get_order' });
    expect([r.allowed, r.subReason]).toEqual([false, CapSubReason.AMOUNT_MISSING]);
    const ok = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'get_order', amount: 0 });
    expect(ok.allowed).toBe(true);
  });

  it('denies a malformed cap without an amount', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:abc'));
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP]);
  });

  it('denies a malformed cap with an amount in every caps mode', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:abc'));
    for (const capsMode of ['enforce', 'warn', 'off'] as const) {
      const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order', amount: 1, capsMode });
      expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP]);
    }
  });
});

describe('caps mode opt-out', () => {
  it('warn allows the call and reports amount_missing in wouldDeny', async () => {
    const r = await client({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
    expect('reasonCode' in r).toBe(false);
    expect(r.wouldDeny).toEqual({
      reason_code: DenialReason.CAP_EXCEEDED,
      sub_reason: CapSubReason.AMOUNT_MISSING,
      reason: expect.stringContaining('no amount'),
      details: { limit: 50 },
    });
  });

  it('warn per call overrides the client', async () => {
    const r = await client().enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order', capsMode: 'warn' });
    expect(r.allowed).toBe(true);
    expect(r.wouldDeny?.sub_reason).toBe(CapSubReason.AMOUNT_MISSING);
  });

  it('warn still denies an amount above the cap', async () => {
    const r = await client({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order', amount: 51 });
    expect([r.allowed, r.subReason]).toEqual([false, CapSubReason.AMOUNT_CAP]);
  });

  it('warn allows a malformed cap without an amount and reports it', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:abc'));
    const r = await client({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
    expect([r.wouldDeny?.reason_code, r.wouldDeny?.sub_reason]).toEqual([DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP]);
  });

  it('off allows a malformed cap without an amount', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:abc'));
    const r = await client({ capsMode: 'off' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
    expect(r.wouldDeny).toBeUndefined();
  });

  it('off allows the call without reporting', async () => {
    const r = await client({ capsMode: 'off' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.allowed).toBe(true);
    expect(r.wouldDeny).toBeUndefined();
  });
});

const refunds = ToolManifest.fromJSON({
  connector: 'merchant',
  tools: {
    approve_refund: { permission: 'write', requires_decision: true },
    release_refund: { permission: 'write', requires_decision: true, caps: { per_hour: 5 } },
  },
});

function refundsClient(options: Record<string, unknown> = {}) {
  const c = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', ...options } as ConstructorParameters<typeof Grantex>[0]);
  c.loadManifest(refunds);
  return c;
}

function steps(r: { wouldDenyAll?: readonly { reason_code: string; sub_reason: string }[] }) {
  return (r.wouldDenyAll ?? []).map((w) => [w.reason_code, w.sub_reason]);
}

describe('warn mode reports every would-be denial', () => {
  it('reports the decision and amount_missing, in step order', async () => {
    const r = await refundsClient({ decisionsMode: 'warn', capsMode: 'warn' })
      .enforce({ grantToken: 't', connector: 'merchant', tool: 'approve_refund' });
    expect(r.allowed).toBe(true);
    expect(steps(r)).toEqual([
      [DenialReason.DECISION_REQUIRED, ''],
      [DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING],
    ]);
    expect(r.wouldDenyAll?.[1]?.details).toEqual({ limit: 50 });
    // The first would-be denial is still reported in wouldDeny.
    expect(r.wouldDeny?.reason_code).toBe(DenialReason.DECISION_REQUIRED);
    expect(r.wouldDeny).toEqual(r.wouldDenyAll?.[0]);
  });

  it('reports the decision, a malformed cap and the meter, in step order', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write:*:capped:abc'));
    const r = await refundsClient({ decisionsMode: 'warn', capsMode: 'warn' })
      .enforce({ grantToken: 't', connector: 'merchant', tool: 'release_refund', reserve: false });
    expect(r.allowed).toBe(true);
    expect(steps(r)).toEqual([
      [DenialReason.DECISION_REQUIRED, ''],
      [DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP],
      [DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE],
    ]);
    expect(r.wouldDeny).toEqual(r.wouldDenyAll?.[0]);
  });

  it('reports amount_missing and the meter after the decision', async () => {
    const r = await refundsClient({ decisionsMode: 'warn', capsMode: 'warn' })
      .enforce({ grantToken: 't', connector: 'merchant', tool: 'release_refund', reserve: false });
    expect(steps(r)).toEqual([
      [DenialReason.DECISION_REQUIRED, ''],
      [DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_MISSING],
      [DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE],
    ]);
  });

  it('lists a single warning as the only entry', async () => {
    const r = await client({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order' });
    expect(r.wouldDeny?.sub_reason).toBe(CapSubReason.AMOUNT_MISSING);
    expect(r.wouldDenyAll).toEqual([r.wouldDeny]);
  });

  it('leaves both absent without a warning', async () => {
    const r = await client({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'place_order', amount: 10 });
    expect(r.allowed).toBe(true);
    expect('wouldDeny' in r).toBe(false);
    expect('wouldDenyAll' in r).toBe(false);
  });

  it('still denies at the decision step when decisions enforce', async () => {
    const r = await refundsClient({ capsMode: 'warn' }).enforce({ grantToken: 't', connector: 'merchant', tool: 'approve_refund' });
    expect([r.allowed, r.reasonCode]).toEqual([false, DenialReason.DECISION_REQUIRED]);
    expect(r.wouldDeny).toBeUndefined();
    expect(r.wouldDenyAll).toBeUndefined();
  });
});

describe('wrapTool() amount extractor', () => {
  it('test_wrap_tool_passes_extracted_amount', async () => {
    const gx = client();
    const spy = vi.spyOn(gx, 'enforce');
    const original = fakeTool();
    const seen: unknown[] = [];
    const wrapped = gx.wrapTool(original, {
      connector: 'merchant',
      tool: 'place_order',
      grantToken: 'token',
      extractAmount: (input) => {
        seen.push(input);
        return (input as { total: number }).total;
      },
    });
    await expect(wrapped.invoke({ total: 20, sku: 'nimbus-01' })).resolves.toBe('placed');
    expect(spy.mock.calls[0]![0].amount).toBe(20);
    expect(seen).toEqual([{ total: 20, sku: 'nimbus-01' }]);

    await expect(wrapped.invoke({ total: 51, sku: 'nimbus-01' })).rejects.toThrow('exceeds budget cap of 50');
    expect(original.invoke).toHaveBeenCalledTimes(1);
  });

  it('awaits an async extractor', async () => {
    const original = fakeTool();
    const wrapped = client().wrapTool(original, {
      connector: 'merchant',
      tool: 'place_order',
      grantToken: 'token',
      extractAmount: async (input) => (input as { total: number }).total,
    });
    await expect(wrapped.invoke({ total: 10 })).resolves.toBe('placed');
  });

  it('denies amount_missing without an extractor', async () => {
    const original = fakeTool();
    const wrapped = client().wrapTool(original, { connector: 'merchant', tool: 'place_order', grantToken: 'token' });
    await expect(wrapped.invoke({ total: 20 })).rejects.toThrow('no amount');
    expect(original.invoke).not.toHaveBeenCalled();
  });

  it('denies amount_missing when the extractor returns undefined or null', async () => {
    for (const value of [undefined, null]) {
      const original = fakeTool();
      const wrapped = client().wrapTool(original, {
        connector: 'merchant',
        tool: 'place_order',
        grantToken: 'token',
        extractAmount: () => value as unknown as number,
      });
      await expect(wrapped.invoke({ sku: 'nimbus-01' })).rejects.toThrow('no amount');
      expect(original.invoke).not.toHaveBeenCalled();
    }
  });

  it('is unchanged for an uncapped scope without an extractor', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:merchant:write'));
    const wrapped = client().wrapTool(fakeTool(), { connector: 'merchant', tool: 'place_order', grantToken: 'token' });
    await expect(wrapped.invoke({ total: 20 })).resolves.toBe('placed');
  });

  it('fails closed when the extractor throws, whatever the grant says', async () => {
    for (const scope of ['tool:merchant:write:*:capped:50', 'tool:merchant:write']) {
      vi.mocked(verifyGrantToken).mockResolvedValue(grant(scope));
      const gx = client();
      const spy = vi.spyOn(gx, 'enforce');
      const original = fakeTool();
      const wrapped = gx.wrapTool(original, {
        connector: 'merchant',
        tool: 'place_order',
        grantToken: 'token',
        extractAmount: () => {
          throw new TypeError('total is missing');
        },
      });
      const err = await wrapped.invoke({ sku: 'nimbus-01' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/amount extractor .* threw TypeError/);
      expect((err as Error).cause).toBeInstanceOf(TypeError);
      expect(original.invoke).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the extractor returns something that is not a finite number', async () => {
    for (const value of ['20', true, Number.NaN, Number.POSITIVE_INFINITY, [20]]) {
      const original = fakeTool();
      const wrapped = client().wrapTool(original, {
        connector: 'merchant',
        tool: 'place_order',
        grantToken: 'token',
        extractAmount: () => value as unknown as number,
      });
      await expect(wrapped.invoke({ total: value })).rejects.toThrow('finite number');
      expect(original.invoke).not.toHaveBeenCalled();
    }
  });
});

describe('enforceMiddleware() amount extractor', () => {
  function run(mw: ReturnType<InstanceType<typeof Grantex>['enforceMiddleware']>, req: Record<string, unknown>) {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) };
    return new Promise<{ status?: number; body?: unknown; next: boolean; err?: unknown }>((resolve) => {
      json.mockImplementation((body: unknown) => resolve({ status: res.status.mock.calls[0]![0] as number, body, next: false }));
      mw(req, res, (err?: unknown) => resolve({ next: true, err }));
    });
  }

  function middleware(gx: InstanceType<typeof Grantex>, extractAmount?: (req: Record<string, unknown>) => unknown) {
    return gx.enforceMiddleware({
      extractToken: () => 'jwt',
      extractConnector: () => 'merchant',
      extractTool: () => 'place_order',
      ...(extractAmount !== undefined ? { extractAmount: extractAmount as (req: Record<string, unknown>) => number } : {}),
    });
  }

  it('passes the extracted amount to enforce', async () => {
    const gx = client();
    const spy = vi.spyOn(gx, 'enforce');
    const req = { body: { total: 20 } };
    const out = await run(middleware(gx, (r) => (r['body'] as { total: number }).total), req);
    expect(out).toEqual({ next: true, err: undefined });
    expect(spy.mock.calls[0]![0].amount).toBe(20);

    const over = await run(middleware(gx, () => 51), { body: {} });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ error: { code: 'SCOPE_DENIED', reason: 'cap_exceeded', subReason: 'amount_cap' } });
  });

  it('denies amount_missing without an extractor', async () => {
    const out = await run(middleware(client()), { body: { total: 20 } });
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ error: { reason: 'cap_exceeded', subReason: 'amount_missing' } });
  });

  it('fails closed with a 403 when the extractor throws', async () => {
    const gx = client();
    const spy = vi.spyOn(gx, 'enforce');
    const out = await run(middleware(gx, () => {
      throw new Error('no body');
    }), {});
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({
      error: { code: 'SCOPE_DENIED', reason: 'cap_exceeded', subReason: 'invalid_amount', message: expect.stringContaining('amount extractor') },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when the extractor returns a non-number', async () => {
    const out = await run(middleware(client(), () => '20'), {});
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ error: { reason: 'cap_exceeded', subReason: 'invalid_amount' } });
  });
});
