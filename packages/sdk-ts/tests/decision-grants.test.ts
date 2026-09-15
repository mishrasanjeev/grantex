/**
 * Decision grants in the TypeScript SDK (PRD G-3): offline verification, four
 * eyes, atomic consumption at the issuer and enforce() integration. Cases in
 * spec/examples/decision-grant/verification.json are shared with the Python SDK.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, generateKeyPair, type JWTPayload } from 'jose';
import { DenialReason, DecisionSubReason } from '../src/denials.js';
import { computeActionHash, type DecisionAction } from '../src/decisions/action.js';
import type { VerifiedGrant } from '../src/types.js';
import { InMemoryCapsBackend } from '../src/caps/memory.js';
import { CapsMeter } from '../src/caps/meter.js';
import type { ConsumedDecision, DecisionConsumer } from '../src/resources/decisions.js';

interface GrantSpec {
  claims?: Record<string, unknown>;
  remove?: string[];
  header?: Record<string, unknown>;
  tamper?: Record<string, unknown>;
}
interface Fixture {
  issuer: string;
  developer_id: string;
  connector: string;
  now: number;
  action: DecisionAction;
  base_claims: Record<string, unknown>;
  cases: {
    name: string;
    grants: GrantSpec[];
    expected_action?: Partial<DecisionAction>;
    case_version?: string;
    approvals_required?: 1 | 2;
    now?: number;
    expect: string;
  }[];
}

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'decision-grant', 'verification.json'), 'utf-8'),
) as Fixture;

const keys = vi.hoisted(() => ({ publicKey: undefined as unknown, now: 0 }));

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn() };
});
vi.mock('../src/decisions/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/decisions/verify.js')>();
  return {
    ...actual,
    verifyDecisionGrants: (tokens: string[], action: DecisionAction, caseVersion: string, options: Parameters<typeof actual.verifyDecisionGrants>[3]) =>
      actual.verifyDecisionGrants(tokens, action, caseVersion, { ...options, key: keys.publicKey as CryptoKey, now: keys.now }),
  };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { verifyDecisionGrant, DecisionGrantError } = await import('../src/decisions/verify.js');
const actualVerify = await vi.importActual<typeof import('../src/decisions/verify.js')>('../src/decisions/verify.js');
const { Grantex } = await import('../src/client.js');
const { ToolManifest } = await import('../src/manifest.js');

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys.publicKey = pair.publicKey;
  keys.now = FIXTURE.now;
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
});

async function sign(claims: Record<string, unknown>, header?: Record<string, unknown>, key: CryptoKey = privateKey): Promise<string> {
  const token = await new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', typ: 'decision+jwt', kid: 'test-key' })
    .sign(key);
  if (header === undefined) return token;
  // Replace the protected header as written; the signature no longer matches.
  const written: Record<string, unknown> = { alg: 'RS256', typ: 'decision+jwt', kid: 'test-key', ...header };
  for (const [name, value] of Object.entries(written)) if (value === null) delete written[name];
  const [, payload, signature] = token.split('.');
  return [Buffer.from(JSON.stringify(written)).toString('base64url'), payload, signature].join('.');
}

async function buildGrant(spec: GrantSpec): Promise<string> {
  const claims: Record<string, unknown> = { ...structuredClone(FIXTURE.base_claims), ...structuredClone(spec.claims ?? {}) };
  for (const key of spec.remove ?? []) delete claims[key];
  let token = await sign(claims, spec.header);
  if (spec.tamper) {
    const [head, , signature] = token.split('.');
    token = [head, Buffer.from(JSON.stringify({ ...claims, ...spec.tamper })).toString('base64url'), signature].join('.');
  }
  return token;
}

describe('shared verification cases', () => {
  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const tokens = await Promise.all(c.grants.map(buildGrant));
    const expected = { ...FIXTURE.action, ...(c.expected_action ?? {}) } as DecisionAction;
    try {
      const result = await actualVerify.verifyDecisionGrants(tokens, expected, c.case_version ?? String(FIXTURE.base_claims['case_version']), {
        issuer: FIXTURE.issuer,
        key: keys.publicKey as CryptoKey,
        developerId: FIXTURE.developer_id,
        connector: FIXTURE.connector,
        approvalsRequired: c.approvals_required ?? 1,
        now: c.now ?? FIXTURE.now,
      });
      expect(c.expect).toBe('valid');
      expect(result.grants).toHaveLength(tokens.length);
      expect(result.actionHash).toBe(computeActionHash(expected));
      if (result.grants.length === 2) expect(result.grants.map((g) => g.fourEyes?.position)).toEqual([1, 2]);
    } catch (err) {
      if (!(err instanceof actualVerify.DecisionGrantError)) throw err;
      expect(err.subReason, err.message).toBe(c.expect);
    }
  });

  it('refuses a signature by another key, and alg none', async () => {
    const other = await sign(FIXTURE.base_claims, {}, otherPrivateKey);
    await expect(verifyDecisionGrant(other, FIXTURE.action, 'v7', { issuer: FIXTURE.issuer, key: keys.publicKey as CryptoKey, now: FIXTURE.now }))
      .rejects.toMatchObject({ subReason: 'malformed' });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'decision+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify(FIXTURE.base_claims)).toString('base64url')}.`;
    await expect(verifyDecisionGrant(unsigned, FIXTURE.action, 'v7', { issuer: FIXTURE.issuer, key: keys.publicKey as CryptoKey, now: FIXTURE.now }))
      .rejects.toBeInstanceOf(DecisionGrantError);
  });
});

// ── enforce() ────────────────────────────────────────────────────────────

const MANIFEST = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: {
    case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] },
    payout_release: { permission: 'write', requires_decision: true, caps: { per_hour: 5 } },
    payout_currency: { permission: 'write', requires_decision: true, decision_fields: ['currency'] },
    get_case: 'read',
  },
});

class FakeIssuer implements DecisionConsumer {
  readonly consumed = new Set<string>();
  calls = 0;
  constructor(private readonly failWith?: DecisionSubReason) {}
  async consume(grants: Parameters<DecisionConsumer['consume']>[0]): Promise<ConsumedDecision> {
    this.calls++;
    if (this.failWith) throw new DecisionGrantError(this.failWith, 'refused by the issuer');
    const jtis = grants.grants.map((g) => g.jti);
    if (jtis.some((j) => this.consumed.has(j))) throw new DecisionGrantError('consumed', 'already used');
    for (const j of jtis) this.consumed.add(j);
    return { requestId: grants.grants[0]!.decisionRequest, jtis, actionHash: grants.actionHash, approvers: [] };
  }
}

function grantFor(): VerifiedGrant {
  return {
    tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'user_01', agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01', scopes: ['tool:acme_kyb:write'], issuedAt: 1, expiresAt: 9_999_999_999,
  } as VerifiedGrant;
}

function client(issuer: DecisionConsumer = new FakeIssuer(), options: Record<string, unknown> = {}) {
  vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
  const c = new Grantex({ apiKey: 'test-key', decisionConsumer: issuer, ...options });
  c.loadManifest(MANIFEST);
  return c;
}

const args = (overrides: Record<string, unknown> = {}) => ({ case_id: 'case_8841', decision: 'approve', subject: 'gb:00000001', note: 're-planned', ...overrides });
const caseByName = (name: string) => FIXTURE.cases.find((c) => c.name === name)!;

afterEach(() => {
  vi.mocked(verifyGrantToken).mockReset();
});

describe('enforce() and decision grants', () => {
  it('returns decision_required without a decision grant', async () => {
    const result = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', arguments: args(), caseVersion: 'v7' });
    expect(result).toMatchObject({ allowed: false, reasonCode: DenialReason.DECISION_REQUIRED, details: { decision_required: 'acme_kyb:case_decision' } });
    expect(result.subReason).toBeUndefined();
  });

  it('consumes a valid decision grant and allows the call', async () => {
    const issuer = new FakeIssuer();
    const result = await client(issuer).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'case_decision',
      decisionGrants: [await buildGrant({})], arguments: args({ requested_at: '2026-09-15T10:04:31Z' }), caseVersion: 'v7',
    });
    expect(result.allowed, result.reason).toBe(true);
    expect(result.decision?.jtis).toEqual([FIXTURE.base_claims['jti']]);
    expect(issuer.calls).toBe(1);
  });

  it('denies replay of a consumed jti', async () => {
    const c = client(new FakeIssuer());
    const token = await buildGrant({});
    const call = () => c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], arguments: args(), caseVersion: 'v7' });
    expect((await call()).allowed).toBe(true);
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    expect(await call()).toMatchObject({ allowed: false, reasonCode: DenialReason.DECISION_INVALID, subReason: 'consumed' });
  });

  it('never allows a call on offline verification alone', async () => {
    const result = await client(new FakeIssuer('consume_unavailable')).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [await buildGrant({})], arguments: args(), caseVersion: 'v7',
    });
    expect(result).toMatchObject({ allowed: false, subReason: 'consume_unavailable' });
  });

  it.each([
    [args({ decision: 'decline' }), 'v7', 'action_mismatch'],
    [args({ subject: 'gb:00000002' }), 'v7', 'action_mismatch'],
    [args({ case_id: 'case_8842' }), 'v7', 'wrong_case'],
    [args(), 'v8', 'case_changed'],
    [args({ amount: 10 }), 'v7', 'action_mismatch'],
  ])('returns decision_invalid for %o at %s (%s)', async (callArgs, caseVersion, subReason) => {
    const issuer = new FakeIssuer();
    const result = await client(issuer).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [await buildGrant({})], arguments: callArgs, caseVersion });
    expect(result).toMatchObject({ allowed: false, reasonCode: DenialReason.DECISION_INVALID, subReason });
    expect(issuer.calls).toBe(0);
  });

  it('needs the action and the case version', async () => {
    const c = client();
    const token = await buildGrant({});
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], caseVersion: 'v7' })).subReason).toBe('malformed');
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], arguments: args() })).subReason).toBe('malformed');
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], decisionAction: { ...FIXTURE.action, action: 'monitor_delete' }, caseVersion: 'v7' })).subReason).toBe('action_mismatch');
  });

  it('four eyes: same approver twice denied, one grant incomplete, two approvers allowed', async () => {
    const decline = args({ decision: 'decline' });
    const same = await Promise.all(caseByName('four eyes with the same approver twice').grants.map(buildGrant));
    expect(await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: same, arguments: decline, caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'same_approver' });
    const one = await Promise.all(caseByName('four eyes with one grant').grants.map(buildGrant));
    expect(await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: one, arguments: decline, caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'four_eyes_incomplete' });
    const issuer = new FakeIssuer();
    const both = await Promise.all(caseByName('four eyes with two approvers').grants.map(buildGrant));
    const ok = await client(issuer).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: both, arguments: decline, caseVersion: 'v7' });
    expect(ok.allowed, ok.reason).toBe(true);
    expect(issuer.consumed.size).toBe(2);
  });

  it('warn mode allows and reports, and still consumes valid grants', async () => {
    const absent = await client(new FakeIssuer(), { decisionsMode: 'warn' }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', arguments: args(), caseVersion: 'v7' });
    expect(absent.allowed).toBe(true);
    expect(absent.wouldDeny?.reason_code).toBe(DenialReason.DECISION_REQUIRED);
    const c = client(new FakeIssuer());
    const token = await buildGrant({});
    const first = await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], arguments: args(), caseVersion: 'v7', decisionsMode: 'warn' });
    expect(first.allowed && first.wouldDeny === undefined && first.decision !== undefined).toBe(true);
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    const second = await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], arguments: args(), caseVersion: 'v7', decisionsMode: 'warn' });
    expect(second.allowed).toBe(true);
    expect(second.wouldDeny?.sub_reason).toBe('consumed');
    expect(() => new Grantex({ apiKey: 'k', decisionsMode: 'off' as 'warn' })).toThrow(/decisionsMode/);
  });

  it('releases the caps reservation when consumption fails', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const payout = { ...FIXTURE.action, action: 'payout_release' };
    const token = await buildGrant({ claims: { action: payout, action_hash: computeActionHash(payout) } });
    const denied = await client(new FakeIssuer('consumed'), { capsMeter: meter }).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'payout_release', decisionGrants: [token], decisionAction: payout, caseVersion: 'v7',
    });
    expect(denied).toMatchObject({ allowed: false, subReason: 'consumed' });
    const probe = await client(new FakeIssuer(), { capsMeter: meter }).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'payout_release', decisionAction: payout, caseVersion: 'v7', reserve: false, decisionsMode: 'warn',
    });
    const usage = await meter.usage('dev_01', probe.capLimits ?? []);
    expect(usage.every((u) => u.used === 0)).toBe(true);
  });

  it('does not apply to tools without requires_decision', async () => {
    const issuer = new FakeIssuer();
    const result = await client(issuer).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case', decisionGrants: [await buildGrant({})] });
    expect(result.allowed).toBe(true);
    expect(result.decision).toBeUndefined();
    expect(issuer.calls).toBe(0);
  });
});

// ── DecisionsClient over HTTP ────────────────────────────────────────────

describe('grantex.decisions', () => {
  const fetchMock = vi.fn();
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  async function verifiedSet() {
    return actualVerify.verifyDecisionGrants([await buildGrant({})], FIXTURE.action, 'v7', { issuer: FIXTURE.issuer, key: keys.publicKey as CryptoKey, now: FIXTURE.now });
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('consume posts the tokens, action and case version once', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(json(200, { consumed: true, requestId: 'dreq_1', jtis: [FIXTURE.base_claims['jti']], actionHash: 'sha256:x', approvers: [{ sub: 'user:approver-a' }] }));
    const set = await verifiedSet();
    const receipt = await new Grantex({ apiKey: 'test-key' }).decisions.consume(set, { grantId: 'grnt_01' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.grantex.dev/v1/decisions/consume');
    expect(JSON.parse(String(init.body))).toEqual({ decisionGrants: set.grants.map((g) => g.token), action: FIXTURE.action, caseVersion: 'v7', grantId: 'grnt_01' });
    expect(receipt.jtis).toEqual([FIXTURE.base_claims['jti']]);
  });

  it.each([
    [json(409, { code: 'DECISION_INVALID', subReason: 'consumed', message: 'used' }), 'consumed'],
    [json(409, { code: 'DECISION_INVALID', subReason: 'case_changed', message: 'changed' }), 'case_changed'],
    [json(409, { code: 'DECISION_INVALID', subReason: 'made_up' }), 'consume_unavailable'],
    [json(503, { message: 'down' }), 'consume_unavailable'],
    [json(404, { code: 'DECISION_GRANTS_DISABLED' }), 'consume_unavailable'],
    [json(200, { consumed: true, jtis: ['dgnt_other'] }), 'consume_unavailable'],
    [json(200, { consumed: false }), 'consume_unavailable'],
  ])('maps refusals and never assumes success (%#)', async (response, subReason) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(response);
    await expect(new Grantex({ apiKey: 'test-key' }).decisions.consume(await verifiedSet())).rejects.toMatchObject({ subReason });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the documented platform request bodies', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => json(201, {}));
    const d = new Grantex({ apiKey: 'test-key' }).decisions;
    await d.createRequest({
      action: FIXTURE.action, connector: 'acme_kyb', caseVersion: 'v7', fourEyesOn: ['decline'],
      memo: { content: 'Registry active.', ref: 'memo:1' }, policyScore: { content: { tier: 'low' } },
    });
    await d.setCaseVersion('case_8841', 'v8');
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      action: FIXTURE.action, connector: 'acme_kyb', caseVersion: 'v7', fourEyesOn: ['decline'],
      memo: { content: 'Registry active.', ref: 'memo:1' }, policyScore: { content: { tier: 'low' } },
    });
    expect(calls[1]![0]).toBe('https://api.grantex.dev/v1/decisions/cases/case_8841');
  });

  it('cannot approve', () => {
    const d = new Grantex({ apiKey: 'test-key' }).decisions as unknown as Record<string, unknown>;
    for (const name of ['approve', 'createApproverSession', 'createPageTicket']) expect(d[name]).toBeUndefined();
  });
});

describe('review follow-ups', () => {
  it('requires decisionAction and arguments to describe the same action', async () => {
    const issuer = new FakeIssuer();
    const token = await buildGrant({});
    expect(await client(issuer).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], decisionAction: FIXTURE.action, arguments: args({ decision: 'decline' }), caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'action_mismatch' });
    expect(issuer.calls).toBe(0);
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    const same = await client(issuer).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision', decisionGrants: [token], decisionAction: FIXTURE.action, arguments: args(), caseVersion: 'v7' });
    expect(same.allowed, same.reason).toBe(true);
  });

  it('denies and refunds caps when the consumer throws anything', async () => {
    const meter = new CapsMeter(new InMemoryCapsBackend());
    const payout = { ...FIXTURE.action, action: 'payout_release' };
    const token = await buildGrant({ claims: { action: payout, action_hash: computeActionHash(payout) } });
    const exploding: DecisionConsumer = { consume: async () => { throw new TypeError('socket closed'); } };
    expect(await client(exploding, { capsMeter: meter }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_release', decisionGrants: [token], decisionAction: payout, caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, reasonCode: DenialReason.DECISION_INVALID, subReason: 'consume_unavailable' });
    const probe = await client(new FakeIssuer(), { capsMeter: meter }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_release', decisionAction: payout, caseVersion: 'v7', reserve: false, decisionsMode: 'warn' });
    expect((await meter.usage('dev_01', probe.capLimits ?? [])).every((u) => u.used === 0)).toBe(true);
  });

  it('binds declared decision fields', async () => {
    const payout = { ...FIXTURE.action, action: 'payout_currency', extra: { currency: 'GBP' } };
    const token = await buildGrant({ claims: { action: payout, action_hash: computeActionHash(payout) } });
    const ok = await client(new FakeIssuer()).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_currency', decisionGrants: [token], arguments: args({ currency: 'GBP' }), caseVersion: 'v7' });
    expect(ok.allowed, ok.reason).toBe(true);
    expect(await client(new FakeIssuer()).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_currency', decisionGrants: [token], arguments: args({ currency: 'EUR' }), caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'action_mismatch' });
    expect(await client(new FakeIssuer()).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_currency', decisionGrants: [token], arguments: args(), caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'malformed' });
    expect(await client(new FakeIssuer()).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'payout_currency', decisionGrants: [token], decisionAction: { ...FIXTURE.action, action: 'payout_currency' }, caseVersion: 'v7' }))
      .toMatchObject({ allowed: false, subReason: 'malformed' });
  });

  it('wrapTool and enforceMiddleware carry decision grants', async () => {
    const issuer = new FakeIssuer();
    const c = client(issuer);
    const token = await buildGrant({});
    const invoked: unknown[] = [];
    const tool = { name: 'case_decision', description: 'd', invoke: async (input: unknown) => { invoked.push(input); return 'done'; } };
    const wrapped = c.wrapTool(tool, { connector: 'acme_kyb', tool: 'case_decision', grantToken: 't', decisionGrants: () => [token], caseVersion: 'v7' });
    expect(await wrapped.invoke(args())).toBe('done');
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    await expect(wrapped.invoke(args())).rejects.toThrow(/consumed/);
    expect(invoked).toHaveLength(1);

    const second = await buildGrant({ claims: { jti: 'dgnt_01K8Z000000000000000000QB9' } });
    vi.mocked(verifyGrantToken).mockResolvedValue(grantFor());
    const middleware = c.enforceMiddleware({
      extractToken: () => 't', extractConnector: () => 'acme_kyb', extractTool: () => 'case_decision',
      extractDecisionGrants: () => [second], extractArguments: () => args(), extractCaseVersion: () => 'v7',
    });
    const next = vi.fn();
    await new Promise<void>((resolve) => middleware({}, { status: () => ({ json: () => resolve() }) }, (err?: unknown) => { next(err); resolve(); }));
    expect(next).toHaveBeenCalledWith(undefined);
  });

  it('accepts ES256 decision grants and refuses algorithms outside the allowlist', async () => {
    const pair = await generateKeyPair('ES256');
    const token = await new SignJWT(FIXTURE.base_claims as JWTPayload).setProtectedHeader({ alg: 'ES256', typ: 'decision+jwt', kid: 'ec-1' }).sign(pair.privateKey);
    await expect(actualVerify.verifyDecisionGrant(token, FIXTURE.action, 'v7', { issuer: FIXTURE.issuer, key: pair.publicKey, now: FIXTURE.now })).resolves.toMatchObject({ dwellSource: 'server' });
    await expect(actualVerify.verifyDecisionGrant(token, FIXTURE.action, 'v7', { issuer: FIXTURE.issuer, key: pair.publicKey, now: FIXTURE.now, algorithms: ['RS256'] }))
      .rejects.toMatchObject({ subReason: 'malformed' });
    expect(() => new Grantex({ apiKey: 'k', decisionAlgorithms: [] })).toThrow(/decisionAlgorithms/);
  });
});
