import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolManifest, Permission } from '../src/manifest.js';
import { CapSubReason, DenialReason, ManifestSubReason, PurposeSubReason } from '../src/denials.js';
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

const acmeKyb = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: {
    get_case: 'read',
    add_case_note: 'write',
    verify_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'] },
    resolve_business: { permission: 'read', caps: { per_hour: 200 } },
    price_check: { permission: 'read', cost_units: { base: 1 } },
    case_decision: { permission: 'write', requires_decision: true },
  },
});

function client(enforceMode: 'strict' | 'permissive' = 'strict') {
  const c = new Grantex({ apiKey: 'test-key', enforceMode } as ConstructorParameters<typeof Grantex>[0]);
  c.loadManifest(acmeKyb);
  return c;
}

async function codes(connector: string, tool: string, amount?: number, c = client()) {
  const r = await c.enforce({ grantToken: 't', connector, tool, ...(amount !== undefined ? { amount } : {}) });
  return [r.allowed, r.reasonCode, r.subReason] as const;
}

beforeEach(() => {
  vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:acme_kyb:write'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('existing denials carry codes', () => {
  it('token failure is token_invalid', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));
    expect(await codes('acme_kyb', 'get_case')).toEqual([false, DenialReason.TOKEN_INVALID, undefined]);
  });

  it('unknown connector', async () => {
    expect(await codes('other', 'get_case')).toEqual([
      false,
      DenialReason.MANIFEST_UNKNOWN_TOOL,
      ManifestSubReason.UNKNOWN_CONNECTOR,
    ]);
  });

  it('unknown tool', async () => {
    expect(await codes('acme_kyb', 'nope')).toEqual([
      false,
      DenialReason.MANIFEST_UNKNOWN_TOOL,
      ManifestSubReason.UNKNOWN_TOOL,
    ]);
  });

  it('no scope for the connector is tool_not_granted', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:other:admin'));
    expect(await codes('acme_kyb', 'get_case')).toEqual([false, DenialReason.TOOL_NOT_GRANTED, undefined]);
  });

  it('a lower scope is permission_insufficient', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:acme_kyb:read'));
    expect(await codes('acme_kyb', 'add_case_note')).toEqual([
      false,
      DenialReason.PERMISSION_INSUFFICIENT,
      undefined,
    ]);
  });

  it('amount above the cap', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:acme_kyb:write:*:capped:10'));
    const r = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'add_case_note', amount: 11 });
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_CAP]);
    expect(r.details).toEqual({ limit: 10, amount: 11 });
  });

  it('non-finite amount', async () => {
    expect(await codes('acme_kyb', 'add_case_note', Number.NaN)).toEqual([
      false,
      DenialReason.CAP_EXCEEDED,
      CapSubReason.INVALID_AMOUNT,
    ]);
  });

  it('malformed amount cap', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:acme_kyb:write:*:capped:abc'));
    expect(await codes('acme_kyb', 'add_case_note', 1)).toEqual([
      false,
      DenialReason.CAP_EXCEEDED,
      CapSubReason.MALFORMED_CAP,
    ]);
  });

  it('allowed results carry no code', async () => {
    const r = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'add_case_note' });
    expect(r.allowed).toBe(true);
    expect('reasonCode' in r).toBe(false);
    expect('details' in r).toBe(false);
  });
});

describe('declared constraints fail closed', () => {
  it('tools without constraints behave as before', async () => {
    expect((await codes('acme_kyb', 'get_case'))[0]).toBe(true);
    expect((await codes('acme_kyb', 'add_case_note'))[0]).toBe(true);
  });

  it('a tool with allowed_purposes is denied for a grant without purpose', async () => {
    const r = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'verify_business' });
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([
      false,
      DenialReason.PURPOSE_NOT_ALLOWED,
      PurposeSubReason.MISSING,
    ]);
    expect(r.details).toEqual({ allowed_purposes: ['aml.cdd.*'] });
    expect(r.reason).toContain('purpose');
  });

  it('a tool requiring a decision returns decision_required', async () => {
    expect(await codes('acme_kyb', 'case_decision')).toEqual([false, DenialReason.DECISION_REQUIRED, undefined]);
  });

  it('a tool with caps is denied without a meter', async () => {
    expect(await codes('acme_kyb', 'resolve_business')).toEqual([
      false,
      DenialReason.CAP_EXCEEDED,
      CapSubReason.METER_UNAVAILABLE,
    ]);
  });

  it('a tool with cost units is denied without a meter', async () => {
    expect(await codes('acme_kyb', 'price_check')).toEqual([
      false,
      DenialReason.CAP_EXCEEDED,
      CapSubReason.METER_UNAVAILABLE,
    ]);
  });

  it('permission is checked before declared constraints', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant('tool:acme_kyb:read'));
    expect(await codes('acme_kyb', 'case_decision')).toEqual([
      false,
      DenialReason.PERMISSION_INSUFFICIENT,
      undefined,
    ]);
  });

  it('a declaration edited into an invalid state is denied', async () => {
    const manifest = new ToolManifest({
      connector: 'acme_kyb',
      tools: { case_decision: { permission: 'write', requires_decision: true } },
    });
    (manifest.tools as Record<string, Permission>)['case_decision'] = Permission.READ;
    const c = new Grantex({ apiKey: 'test-key' });
    c.loadManifest(manifest);
    expect(await codes('acme_kyb', 'case_decision', undefined, c)).toEqual([
      false,
      DenialReason.MANIFEST_UNKNOWN_TOOL,
      ManifestSubReason.INVALID_DECLARATION,
    ]);
  });

  it('permissive mode keeps the denial code', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await client('permissive').enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'case_decision' });
    expect(r.allowed).toBe(true);
    expect(r.reasonCode).toBe(DenialReason.DECISION_REQUIRED);
  });
});

it('the taxonomy lists every Appendix B reason', () => {
  expect(Object.values(DenialReason)).toEqual(
    expect.arrayContaining([
      'purpose_not_allowed',
      'tool_not_granted',
      'permission_insufficient',
      'cap_exceeded',
      'decision_required',
      'decision_invalid',
      'grant_revoked',
      'region_mismatch',
      'manifest_unknown_tool',
    ]),
  );
});
