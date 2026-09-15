/**
 * Spend caps (PRD G-4): caps meter, limit derivation and enforce() integration.
 * Backend-independent behaviour runs against the in-memory backend with a frozen
 * clock; tests/caps-backends.integration.test.ts covers real Redis and Postgres.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolManifest, type ToolSpec } from '../src/manifest.js';
import { CapSubReason, DenialReason } from '../src/denials.js';
import {
  CAP_ERROR_CODE,
  CapExceededError,
  CapsConfigurationError,
  CapsMeter,
  InMemoryCapsBackend,
  MeterUnavailableError,
  buildCapLimits,
  counterId,
  counterKey,
  tenantHash,
  type CapLimit,
  type CapsBackend,
} from '../src/caps/index.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', () => ({
  verifyGrantToken: vi.fn(),
  mapOnlineVerifyToVerifiedGrant: vi.fn(),
}));

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_760_000_000_000;

function clock(start = T0) {
  const c = { now: start, fn: () => c.now };
  return c;
}

const limit = (max: number, window: CapLimit['window'] = 'per_hour', units = 1, counter = 'c1'): CapLimit => ({
  counter,
  limit: max,
  window,
  units,
});

async function rejects(p: Promise<unknown>): Promise<CapExceededError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CapExceededError) return err;
    throw err;
  }
  throw new Error('expected CapExceededError');
}

function failingBackend(error: Error): CapsBackend & { reserve: ReturnType<typeof vi.fn> } {
  return {
    reserve: vi.fn().mockRejectedValue(error),
    refund: vi.fn().mockRejectedValue(error),
    usage: vi.fn().mockRejectedValue(error),
  };
}

describe('CapsMeter', () => {
  it('reserves up to the limit, then throws E1008 with the limit and window', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    for (let i = 0; i < 3; i += 1) await meter.reserve('dev_01', [limit(3)]);
    const err = await rejects(meter.reserve('dev_01', [limit(3)]));
    expect([err.code, err.reason, err.limit, err.window, err.used, err.requested]).toEqual([
      'E1008', 'cap_exceeded', 3, 'per_hour', 3, 1,
    ]);
    expect(CAP_ERROR_CODE).toBe('E1008');
    expect(err.message).toContain('E1008');
  });

  it('frees units as they age out of the rolling hour', async () => {
    const c = clock();
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: c.fn });
    await meter.reserve('dev_01', [limit(2)]);
    c.now += HOUR / 2;
    await meter.reserve('dev_01', [limit(2)]);
    await rejects(meter.reserve('dev_01', [limit(2)]));
    c.now += HOUR / 2 - 1;
    await rejects(meter.reserve('dev_01', [limit(2)]));
    c.now += 1;
    await meter.reserve('dev_01', [limit(2)]);
  });

  it('rolls the day window', async () => {
    const c = clock();
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: c.fn });
    await meter.reserve('dev_01', [limit(1, 'per_day')]);
    c.now += DAY - 1;
    await rejects(meter.reserve('dev_01', [limit(1, 'per_day')]));
    c.now += 1;
    await meter.reserve('dev_01', [limit(1, 'per_day')]);
  });

  it('never ages out per-case counters', async () => {
    const c = clock();
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: c.fn });
    await meter.reserve('dev_01', [limit(1, 'per_case')]);
    c.now += 365 * DAY;
    expect((await rejects(meter.reserve('dev_01', [limit(1, 'per_case')]))).window).toBe('per_case');
  });

  it('a cap of zero disables the tool without asking the backend', async () => {
    const backend = failingBackend(new Error('should not be called'));
    const err = await rejects(new CapsMeter(backend).reserve('dev_01', [limit(0)]));
    expect(err.limit).toBe(0);
    expect(backend.reserve).not.toHaveBeenCalled();
  });

  it('is all or nothing across limits', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    await meter.reserve('dev_01', [limit(1, 'per_hour', 1, 'b')]);
    expect((await rejects(meter.reserve('dev_01', [limit(5, 'per_hour', 1, 'a'), limit(1, 'per_hour', 1, 'b')]))).limit).toBe(1);
    expect((await meter.usage('dev_01', [limit(5, 'per_hour', 1, 'a')]))[0]?.used).toBe(0);
  });

  it('counts weighted units', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    await meter.reserve('dev_01', [limit(10, 'per_hour', 7)]);
    const err = await rejects(meter.reserve('dev_01', [limit(10, 'per_hour', 4)]));
    expect([err.used, err.requested]).toEqual([7, 4]);
    await meter.reserve('dev_01', [limit(10, 'per_hour', 3)]);
    expect(await meter.usage('dev_01', [limit(10)])).toMatchObject([{ used: 10, remaining: 0 }]);
  });

  it('reports the real usage when a single call exceeds the cap', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    await meter.reserve('dev_01', [limit(10, 'per_hour', 4)]);
    const err = await rejects(meter.reserve('dev_01', [limit(10, 'per_hour', 11)]));
    expect([err.used, err.requested, err.limit]).toEqual([4, 11, 10]);
  });

  it('refundUnsent releases units and is idempotent', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    const reservation = await meter.reserve('dev_01', [limit(1)]);
    await meter.refundUnsent(reservation);
    await meter.refundUnsent(reservation);
    await meter.reserve('dev_01', [limit(1)]);
    await rejects(meter.reserve('dev_01', [limit(1)]));
  });

  it('scopes counters to the tenant', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend(), { clock: clock().fn });
    await meter.reserve('dev_01', [limit(1)]);
    await meter.reserve('dev_02', [limit(1)]);
    await rejects(meter.reserve('dev_01', [limit(1)]));
  });

  it('turns a backend failure into MeterUnavailableError', async () => {
    const meter = new CapsMeter(failingBackend(new Error('down')));
    await expect(meter.reserve('dev_01', [limit(5)])).rejects.toBeInstanceOf(MeterUnavailableError);
    await expect(meter.usage('dev_01', [limit(5)])).rejects.toBeInstanceOf(MeterUnavailableError);
  });

  const invalid: Array<[string, CapLimit[]]> = [
    ['', [limit(1)]],
    ['dev_01', [{ counter: 'c', limit: 1, window: 'per_week' as 'per_hour' }]],
    ['dev_01', [{ counter: '', limit: 1, window: 'per_hour' }]],
    ['dev_01', [{ counter: 'c', limit: -1, window: 'per_hour' }]],
    ['dev_01', [{ counter: 'c', limit: 1.5, window: 'per_hour' }]],
    ['dev_01', [{ counter: 'c', limit: 1, window: 'per_hour', units: -2 }]],
    ['dev_01', [limit(1), limit(1)]],
  ];
  invalid.forEach(([tenant, limits], i) => {
    it(`rejects invalid arguments (${i})`, async () => {
      await expect(new CapsMeter(new InMemoryCapsBackend()).reserve(tenant, limits)).rejects.toBeInstanceOf(CapsConfigurationError);
    });
  });

  it('fifty parallel reservations against a cap of ten', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => meter.reserve('dev_01', [limit(10)])));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });
});

describe('buildCapLimits', () => {
  const spec: ToolSpec = {
    permission: 'read' as ToolSpec['permission'],
    caps: { perHour: 50, perCase: 3 },
    costUnits: { base: 5, ownership: 10, web_insights: 3 },
    requiresDecision: false,
    fourEyesOn: [],
  };

  it('keeps manifest and grant caps as separate counters', () => {
    const limits = buildCapLimits({
      connector: 'acme_kyb',
      tool: 'verify_business',
      spec,
      grantId: 'grnt_01',
      grantCaps: { verify_business: { per_hour: 20 }, cost_units: { per_day: 5000 } },
      caseId: 'case_01',
    });
    expect(limits.map((l) => [l.scope, l.kind, l.window, l.limit, l.units])).toEqual([
      ['manifest', 'calls', 'per_hour', 50, 1],
      ['manifest', 'calls', 'per_case', 3, 1],
      ['grant', 'calls', 'per_hour', 20, 1],
      ['grant', 'cost_units', 'per_day', 5000, 18],
    ]);
    expect(limits[1]?.counter).toBe(counterId('manifest', 'acme_kyb', 'verify_business', 'calls', 'per_case', 'case_01'));
  });

  it('selects cost components', () => {
    const limits = buildCapLimits({
      connector: 'acme_kyb',
      tool: 'verify_business',
      spec: { ...spec, caps: undefined } as unknown as ToolSpec,
      grantId: 'grnt_01',
      grantCaps: { cost_units: { per_hour: 100 } },
      costComponents: ['base'],
    });
    expect(limits.map((l) => [l.kind, l.units])).toEqual([['cost_units', 5]]);
  });

  it('rejects unknown cost components and missing cases', () => {
    const run = (extra: object) => {
      try {
        buildCapLimits({ connector: 'acme_kyb', tool: 'verify_business', spec, grantId: 'grnt_01', ...extra });
      } catch (err) {
        return (err as CapsConfigurationError).subReason;
      }
      return 'no error';
    };
    expect(run({ caseId: 'c1', costComponents: ['base', 'screening'] })).toBe('invalid_cost_component');
    expect(run({ caseId: 'c1', costComponents: [], grantCaps: { cost_units: { per_day: 100 } } })).toBe('invalid_cost_component');
    expect(run({})).toBe('case_required');
    expect(
      buildCapLimits({
        connector: 'acme_kyb',
        tool: 'get_case',
        spec: { permission: 'read' as ToolSpec['permission'], requiresDecision: false, fourEyesOn: [] },
        grantId: 'grnt_01',
        costComponents: [],
      }),
    ).toEqual([]);
    try {
      buildCapLimits({
        connector: 'acme_kyb',
        tool: 'verify_business',
        spec: { ...spec, caps: undefined, costUnits: { base: 2147483647, ownership: 1 } } as unknown as ToolSpec,
        grantId: 'grnt_01',
      });
      throw new Error('expected an error');
    } catch (err) {
      expect((err as CapsConfigurationError).subReason).toBe('invalid_cost_component');
    }
  });

  const malformed: unknown[] = [
    [],
    { verify_business: 5 },
    { verify_business: {} },
    { verify_business: { per_week: 5 } },
    { verify_business: { per_hour: -1 } },
    { cost_units: { per_day: '5000' } },
  ];
  malformed.forEach((grantCaps, i) => {
    it(`rejects malformed grant caps (${i})`, () => {
      expect(() =>
        buildCapLimits({
          connector: 'acme_kyb',
          tool: 'verify_business',
          spec: { permission: 'read' as ToolSpec['permission'], requiresDecision: false, fourEyesOn: [] },
          grantId: 'grnt_01',
          grantCaps,
        }),
      ).toThrow(expect.objectContaining({ subReason: 'malformed_grant_caps' }));
    });
  });
});

it('counter keys match the shared fixture', async () => {
  const fixture = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'caps-counters.json'), 'utf-8'),
  ) as { cases: Array<{ tenant_id: string; parts: string[]; window: 'per_hour'; counter_id: string; counter_hash: string; tenant_hash: string }> };
  for (const c of fixture.cases) {
    expect(counterId(...c.parts)).toBe(c.counter_id);
    expect(await counterKey(c.window, c.counter_id)).toBe(c.counter_hash);
    expect(await tenantHash(c.tenant_id)).toBe(c.tenant_hash);
  }
});

// ── enforce() ──────────────────────────────────────────────────────────────

function grant(details?: unknown, developerId = 'dev_01', scopes = ['tool:acme_kyb:write']): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_01',
    developerId,
    scopes,
    issuedAt: 1709000000,
    expiresAt: 9999999999,
    ...(details !== undefined ? { authorizationDetails: details } : {}),
  };
}

const acmeKyb = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: {
    get_case: 'read',
    resolve_business: { permission: 'read', caps: { per_hour: 2 } },
    verify_business: { permission: 'read', caps: { per_case: 3 }, cost_units: { base: 5, ownership: 10 } },
    screen_person: { permission: 'read', caps: { per_hour: 0 } },
    price_check: { permission: 'read', cost_units: { base: 1 } },
    monitor_enroll: { permission: 'write', caps: { per_hour: 5 } },
  },
});

function client(meter: CapsMeter | undefined = new CapsMeter(new InMemoryCapsBackend())) {
  const c = new Grantex({ apiKey: 'test-key', ...(meter !== undefined ? { capsMeter: meter } : {}) });
  c.loadManifest(acmeKyb);
  return c;
}

const enforce = (c: InstanceType<typeof Grantex>, tool: string, extra: object = {}) =>
  c.enforce({ grantToken: 't', connector: 'acme_kyb', tool, ...extra });

beforeEach(() => {
  vi.mocked(verifyGrantToken).mockResolvedValue(grant());
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('spend caps acceptance criteria', () => {
  it('exceeding a per-hour cap returns E1008 cap_exceeded with the limit and the window', async () => {
    const c = client();
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
    const r = await enforce(c, 'resolve_business');
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, DenialReason.CAP_EXCEEDED, CapSubReason.LIMIT_REACHED]);
    expect(r.details).toMatchObject({ code: 'E1008', limit: 2, window: 'per_hour' });
    expect(r.reason).toContain('E1008 cap_exceeded');
  });

  it('exceeding a per-case cap returns E1008 cap_exceeded with the limit and the window', async () => {
    const c = client();
    for (let i = 0; i < 3; i += 1) expect((await enforce(c, 'verify_business', { caseId: 'case_01' })).allowed).toBe(true);
    const r = await enforce(c, 'verify_business', { caseId: 'case_01' });
    expect(r.reasonCode).toBe('cap_exceeded');
    expect(r.details).toMatchObject({ code: 'E1008', limit: 3, window: 'per_case' });
    expect((await enforce(c, 'verify_business', { caseId: 'case_02' })).allowed).toBe(true);
  });

  it('a cap of zero disables a tool', async () => {
    const r = await enforce(client(), 'screen_person');
    expect([r.allowed, r.reasonCode, r.details?.['limit']]).toEqual([false, 'cap_exceeded', 0]);
  });

  it('concurrent calls cannot exceed a cap', async () => {
    const manifest = ToolManifest.fromJSON({
      connector: 'acme_kyb',
      tools: { resolve_business: { permission: 'read', caps: { per_hour: 10 } } },
    });
    const c = new Grantex({ apiKey: 'test-key', capsMeter: new CapsMeter(new InMemoryCapsBackend()) });
    c.loadManifest(manifest);
    const results = await Promise.all(Array.from({ length: 50 }, () => enforce(c, 'resolve_business')));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});

describe('enforce() metering', () => {
  it('an allowed call carries its reservation', async () => {
    const r = await enforce(client(), 'resolve_business');
    expect(r.reservation?.tenantId).toBe('dev_01');
    expect(r.reservation?.limits.map((l) => l.window)).toEqual(['per_hour']);
  });

  it('tools without caps are not metered', async () => {
    const backend = failingBackend(new Error('unused'));
    const r = await enforce(client(new CapsMeter(backend)), 'get_case');
    expect(r.allowed).toBe(true);
    expect(r).not.toHaveProperty('reservation');
    expect(backend.reserve).not.toHaveBeenCalled();
  });

  it('denied calls do not consume caps', async () => {
    const c = client();
    vi.mocked(verifyGrantToken).mockResolvedValue(grant(undefined, 'dev_01', ['tool:acme_kyb:read']));
    for (let i = 0; i < 10; i += 1) {
      expect((await enforce(c, 'monitor_enroll')).reasonCode).toBe(DenialReason.PERMISSION_INSUFFICIENT);
    }
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    expect((await enforce(c, 'monitor_enroll')).allowed).toBe(true);
  });

  it('charges cost units against the grant budget', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { cost_units: { per_day: 30 } } }]),
    );
    const c = client();
    expect((await enforce(c, 'verify_business', { caseId: 'c1' })).allowed).toBe(true);
    expect((await enforce(c, 'verify_business', { caseId: 'c2', costComponents: ['base'] })).allowed).toBe(true);
    const r = await enforce(c, 'verify_business', { caseId: 'c3' });
    expect(r.details).toMatchObject({ kind: 'cost_units', used: 20, requested: 15 });
  });

  it('allows cost units without a budget when a meter is configured', async () => {
    const r = await enforce(client(), 'price_check');
    expect(r.allowed).toBe(true);
    expect(r.reservation?.limits).toEqual([]);
  });

  it('applies grant caps per grant', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { get_case: { per_hour: 1 } } }]),
    );
    const c = client();
    expect((await enforce(c, 'get_case')).allowed).toBe(true);
    expect((await enforce(c, 'get_case')).details).toMatchObject({ scope: 'grant' });
  });

  it('requires a case for per-case caps', async () => {
    const r = await enforce(client(), 'verify_business');
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, 'cap_exceeded', CapSubReason.CASE_REQUIRED]);
  });

  it('rejects an invalid cost component', async () => {
    const r = await enforce(client(), 'verify_business', { caseId: 'c1', costComponents: ['screening'] });
    expect(r.subReason).toBe(CapSubReason.INVALID_COST_COMPONENT);
  });

  it('denies malformed grant caps as malformed authorization_details', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { resolve_business: { per_week: 1 } } }]),
    );
    const r = await enforce(client(), 'resolve_business');
    expect([r.reasonCode, r.subReason]).toEqual(['token_invalid', 'malformed_authorization_details']);
  });

  it('fails closed when the backend is unavailable', async () => {
    const r = await enforce(client(new CapsMeter(failingBackend(new Error('redis timeout')))), 'resolve_business');
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, 'cap_exceeded', 'meter_unavailable']);
  });

  it('fails closed without a meter', async () => {
    const c = new Grantex({ apiKey: 'test-key' });
    c.loadManifest(acmeKyb);
    expect((await enforce(c, 'resolve_business')).subReason).toBe('meter_unavailable');
  });

  it('does not share counters between tenants', async () => {
    const c = client();
    for (let i = 0; i < 2; i += 1) expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
    vi.mocked(verifyGrantToken).mockResolvedValue(grant(undefined, 'dev_02'));
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
  });

  it('refundUnsent restores the call', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const c = client(meter);
    const first = await enforce(c, 'resolve_business');
    await enforce(c, 'resolve_business');
    expect((await enforce(c, 'resolve_business')).allowed).toBe(false);
    await meter.refundUnsent(first.reservation!);
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
  });
});

describe('check-only and caps modes', () => {
  it('reserve: false checks without consuming', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const c = client(meter);
    let check;
    for (let i = 0; i < 5; i += 1) {
      check = await enforce(c, 'resolve_business', { reserve: false });
      expect(check.allowed).toBe(true);
      expect(check).not.toHaveProperty('reservation');
    }
    expect(check?.capsTenantId).toBe('dev_01');
    expect((await meter.usage('dev_01', check!.capLimits!))[0]?.used).toBe(0);
  });

  it('check early, then reserve at the gateway, uses one unit', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const c = client(meter);
    const check = await enforce(c, 'resolve_business', { reserve: false });
    await meter.reserve(check.capsTenantId!, check.capLimits!);
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
    const denied = await enforce(c, 'resolve_business', { reserve: false });
    expect([denied.allowed, denied.subReason, denied.details?.['used'], denied.details?.['limit']]).toEqual([false, 'limit_reached', 2, 2]);
  });

  it('reserve: false still denies a disabled tool', async () => {
    const r = await enforce(client(), 'screen_person', { reserve: false });
    expect([r.allowed, r.details?.['limit']]).toEqual([false, 0]);
  });

  it('warn mode allows and reports what it would deny', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const c = new Grantex({ apiKey: 'test-key', capsMeter: meter, capsMode: 'warn' });
    c.loadManifest(acmeKyb);
    for (let i = 0; i < 2; i += 1) {
      const r = await enforce(c, 'resolve_business');
      expect([r.allowed, r.wouldDeny, r.reservation !== undefined]).toEqual([true, undefined, true]);
    }
    const over = await enforce(c, 'resolve_business');
    expect([over.allowed, over.reservation, over.reasonCode]).toEqual([true, undefined, undefined]);
    expect(over.wouldDeny).toMatchObject({ reason_code: 'cap_exceeded', sub_reason: 'limit_reached', details: { code: 'E1008' } });
    expect((await meter.usage('dev_01', over.capLimits!))[0]?.used).toBe(2);
  });

  it('warn mode reports a missing meter', async () => {
    const c = new Grantex({ apiKey: 'test-key', capsMode: 'warn' });
    c.loadManifest(acmeKyb);
    const r = await enforce(c, 'resolve_business');
    expect([r.allowed, r.wouldDeny?.sub_reason]).toEqual([true, 'meter_unavailable']);
  });

  it('warn mode still denies malformed grant caps', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { resolve_business: { per_week: 1 } } }]),
    );
    const c = new Grantex({ apiKey: 'test-key', capsMeter: new CapsMeter(new InMemoryCapsBackend()), capsMode: 'warn' });
    c.loadManifest(acmeKyb);
    expect((await enforce(c, 'resolve_business')).reasonCode).toBe('token_invalid');
  });

  it('off mode skips caps and the meter', async () => {
    const backend = failingBackend(new Error('unused'));
    const c = new Grantex({ apiKey: 'test-key', capsMeter: new CapsMeter(backend), capsMode: 'off' });
    c.loadManifest(acmeKyb);
    for (let i = 0; i < 3; i += 1) {
      const r = await enforce(c, 'screen_person');
      expect([r.allowed, r.reservation, r.wouldDeny]).toEqual([true, undefined, undefined]);
    }
    expect(backend.reserve).not.toHaveBeenCalled();
  });

  it('a per-call mode overrides the client', async () => {
    const c = client();
    expect((await enforce(c, 'screen_person', { capsMode: 'off' })).allowed).toBe(true);
    expect((await enforce(c, 'screen_person')).allowed).toBe(false);
  });

  it('rejects an invalid mode', async () => {
    expect(() => new Grantex({ apiKey: 'test-key', capsMode: 'audit' as 'warn' })).toThrow();
    await expect(enforce(client(), 'resolve_business', { capsMode: 'audit' })).rejects.toThrow();
  });

  it('a tenant override scopes the counters', async () => {
    const c = client();
    for (let i = 0; i < 2; i += 1) expect((await enforce(c, 'resolve_business', { capsTenantId: 'tenant_a' })).allowed).toBe(true);
    expect((await enforce(c, 'resolve_business', { capsTenantId: 'tenant_a' })).allowed).toBe(false);
    const r = await enforce(c, 'resolve_business', { capsTenantId: 'tenant_b' });
    expect([r.allowed, r.capsTenantId]).toEqual([true, 'tenant_b']);
    expect((await enforce(c, 'resolve_business')).allowed).toBe(true);
  });

  it('permissive mode turns cap denials into allows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = new Grantex({ apiKey: 'test-key', enforceMode: 'permissive' } as ConstructorParameters<typeof Grantex>[0]);
    c.loadManifest(acmeKyb);
    const r = await enforce(c, 'resolve_business');
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([true, 'cap_exceeded', 'meter_unavailable']);
  });
});

describe('wrappers pass case and cost components', () => {
  it('wrapTool', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { cost_units: { per_day: 12 } } }]),
    );
    const c = client();
    let n = 0;
    const invoke = vi.fn().mockResolvedValue('ok');
    const wrapped = c.wrapTool(
      { name: 'verify_business', description: 'verify', invoke },
      { connector: 'acme_kyb', tool: 'verify_business', grantToken: 't', caseId: () => `case_0${(n += 1)}`, costComponents: ['base'] },
    );
    expect(await wrapped.invoke()).toBe('ok');
    expect(await wrapped.invoke()).toBe('ok');
    await expect(wrapped.invoke()).rejects.toThrow('E1008');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('enforceMiddleware', async () => {
    const c = client();
    const middleware = c.enforceMiddleware({
      extractToken: () => 't',
      extractConnector: () => 'acme_kyb',
      extractTool: () => 'verify_business',
      extractCaseId: (req) => req['caseId'] as string | undefined,
      extractCostComponents: () => ['base'],
    });
    const run = (req: Record<string, unknown>) =>
      new Promise<{ status?: number; next: boolean }>((resolve) => {
        const res = {
          status: (code: number) => ({ json: () => resolve({ status: code, next: false }) }),
        };
        middleware(req, res, () => resolve({ next: true }));
      });
    for (let i = 0; i < 3; i += 1) expect(await run({ caseId: 'case_01' })).toEqual({ next: true });
    expect(await run({ caseId: 'case_01' })).toEqual({ status: 403, next: false });
    expect(await run({})).toEqual({ status: 403, next: false });
  });
});

