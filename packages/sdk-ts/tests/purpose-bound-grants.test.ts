/**
 * Purpose-bound grants (PRD G-2): vocabulary, matching and enforce().
 *
 * Acceptance-criteria tests are named after the criteria. Matching cases in
 * spec/examples/purpose-matching.json are shared with the Python SDK.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolManifest, isValidPurposePattern } from '../src/manifest.js';
import { DenialReason, PurposeSubReason, TokenSubReason, ToolSubReason } from '../src/denials.js';
import {
  PURPOSE_VOCABULARY,
  isKnownPurpose,
  isValidPurpose,
  matchPurpose,
  purposeMatches,
} from '../src/purpose.js';
import {
  AuthorizationDetailsError,
  parseToolsAuthorization,
  toolsAuthorizationAllows,
} from '../src/authorization-details.js';
import { claimsToVerifiedGrant } from '../src/verify.js';
import type { GrantTokenPayload, VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn() };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

interface Fixtures {
  vocabulary: string[];
  match_cases: { pattern: string; purpose: string; matches: boolean }[];
  known_cases: { purpose: string; known: boolean }[];
}
const FIXTURES = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'purpose-matching.json'),
    'utf-8',
  ),
) as Fixtures;

const UNSET = Symbol('unset');

function grant(
  purpose?: string,
  { details = UNSET, scopes = ['tool:acme_kyb:write'] }: { details?: unknown; scopes?: string[] } = {},
): VerifiedGrant {
  const authorizationDetails =
    details === UNSET
      ? purpose === undefined
        ? undefined
        : [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose }]
      : details;
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_01',
    developerId: 'org_01',
    scopes,
    issuedAt: 1709000000,
    expiresAt: 9999999999,
    ...(authorizationDetails !== undefined ? { authorizationDetails } : {}),
  };
}

const acmeKyb = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: {
    get_case: 'read',
    add_case_note: 'write',
    resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'] },
    screen_person: { permission: 'read', allowed_purposes: ['aml.*'] },
    monitor_enroll: { permission: 'write', allowed_purposes: ['aml.cdd.ongoing'] },
    private_lookup: { permission: 'read', allowed_purposes: ['x-acme-bank.*'] },
    open_tool: { permission: 'read', requires_decision: false },
  },
});

async function enforce(g: VerifiedGrant, tool: string, connector = 'acme_kyb') {
  vi.mocked(verifyGrantToken).mockResolvedValue(g);
  const client = new Grantex({ apiKey: 'test-key' });
  client.loadManifest(acmeKyb);
  return client.enforce({ grantToken: 't', connector, tool });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('purpose-bound grants acceptance criteria', () => {
  it('a grant with purpose marketing.enrichment cannot call a tool restricted to aml.cdd.* and the denial names purpose', async () => {
    const r = await enforce(grant('marketing.enrichment'), 'resolve_business');
    expect(r.allowed).toBe(false);
    expect(r.reasonCode).toBe('purpose_not_allowed');
    expect(r.reason).toContain('purpose');
  });

  it('wildcard matching is prefix-segment based', () => {
    expect(purposeMatches('aml.cdd.*', 'aml.cdd.onboarding')).toBe(true);
    expect(purposeMatches('aml.cdd.*', 'aml.cddx')).toBe(false);
  });

  it('a grant with no purpose is denied for any tool that declares allowed_purposes', async () => {
    for (const tool of ['resolve_business', 'screen_person', 'monitor_enroll', 'private_lookup']) {
      const r = await enforce(grant(), tool);
      expect([r.allowed, r.reasonCode, r.subReason], tool).toEqual([
        false,
        DenialReason.PURPOSE_NOT_ALLOWED,
        PurposeSubReason.MISSING,
      ]);
    }
  });

  it('a prefix wildcard does not match the prefix itself', () => {
    expect(purposeMatches('aml.*', 'aml')).toBe(false);
    expect(purposeMatches('aml.cdd.*', 'aml.cdd')).toBe(false);
  });
});

describe('enforce() purpose', () => {
  it('allows and reports a matching purpose', async () => {
    const r = await enforce(grant('aml.cdd.onboarding'), 'resolve_business');
    expect(r.allowed).toBe(true);
    expect(r.purpose).toBe('aml.cdd.onboarding');
  });

  it('an exact pattern requires the exact purpose', async () => {
    expect((await enforce(grant('aml.cdd.ongoing'), 'monitor_enroll')).allowed).toBe(true);
    const r = await enforce(grant('aml.cdd.onboarding'), 'monitor_enroll');
    expect([r.reasonCode, r.subReason]).toEqual([DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.NOT_MATCHED]);
    expect(r.details).toEqual({ allowed_purposes: ['aml.cdd.ongoing'], purpose: 'aml.cdd.onboarding' });
  });

  it('a private purpose matches a private pattern', async () => {
    expect((await enforce(grant('x-acme-bank.kyb_refresh'), 'private_lookup')).allowed).toBe(true);
    expect((await enforce(grant('x-other.kyb_refresh'), 'private_lookup')).allowed).toBe(false);
  });

  it('a purpose outside the vocabulary is denied even if a pattern would match', async () => {
    const r = await enforce(grant('aml.cdd'), 'screen_person');
    expect([r.allowed, r.reasonCode, r.subReason]).toEqual([
      false,
      DenialReason.PURPOSE_NOT_ALLOWED,
      PurposeSubReason.UNKNOWN_PURPOSE,
    ]);
  });

  it('a malformed purpose is denied', async () => {
    const r = await enforce(grant('AML.cdd.onboarding'), 'resolve_business');
    expect([r.reasonCode, r.subReason]).toEqual([DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.UNKNOWN_PURPOSE]);
  });

  it('a purpose for another connector does not apply', async () => {
    const details = [{ type: 'urn:grantex:tools:v1', connector: 'other_kyb', purpose: 'aml.cdd.onboarding' }];
    const r = await enforce(grant(undefined, { details }), 'resolve_business');
    expect([r.reasonCode, r.subReason]).toEqual([DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.MISSING]);
  });

  it('the purpose check follows the permission check', async () => {
    const r = await enforce(grant('marketing.enrichment', { scopes: ['tool:acme_kyb:read'] }), 'monitor_enroll');
    expect(r.reasonCode).toBe(DenialReason.PERMISSION_INSUFFICIENT);
  });
});

describe('tools without allowed_purposes behave as before', () => {
  for (const purpose of [undefined, 'aml.cdd.onboarding', 'marketing.enrichment', 'AML']) {
    it(`ignore the grant purpose (${String(purpose)})`, async () => {
      for (const tool of ['get_case', 'add_case_note', 'open_tool']) {
        expect((await enforce(grant(purpose), tool)).allowed).toBe(true);
      }
    });
  }

  it('permission denials are unchanged', async () => {
    const r = await enforce(grant('aml.screening', { scopes: ['tool:acme_kyb:read'] }), 'add_case_note');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('read scope does not permit write operations on acme_kyb.');
  });
});

describe('authorization_details in enforce()', () => {
  it('ignores other detail types', async () => {
    const details = [
      { type: 'urn:grantex:params:oauth:authorization-details:budget', amount: '10', currency: 'USD' },
      { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
    ];
    expect((await enforce(grant(undefined, { details }), 'screen_person')).allowed).toBe(true);
  });

  const malformed: unknown[] = [
    { type: 'urn:grantex:tools:v1' },
    ['not-an-object'],
    [{ connector: 'acme_kyb' }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 7 }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', scope: 'all' }],
    [
      { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
      { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'payments.payout' },
    ],
  ];
  malformed.forEach((details, index) => {
    it(`malformed authorization_details deny every call (${index})`, async () => {
      for (const tool of ['get_case', 'resolve_business']) {
        const r = await enforce(grant(undefined, { details }), tool);
        expect([r.allowed, r.reasonCode, r.subReason]).toEqual([
          false,
          DenialReason.TOKEN_INVALID,
          TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
        ]);
      }
    });
  });

  it('a tools list restricts tools', async () => {
    const details = [
      {
        type: 'urn:grantex:tools:v1',
        connector: 'acme_kyb',
        purpose: 'aml.cdd.onboarding',
        tools: ['resolve_business', 'screen_*'],
      },
    ];
    expect((await enforce(grant(undefined, { details }), 'resolve_business')).allowed).toBe(true);
    expect((await enforce(grant(undefined, { details }), 'screen_person')).allowed).toBe(true);
    const r = await enforce(grant(undefined, { details }), 'get_case');
    expect([r.reasonCode, r.subReason]).toEqual([DenialReason.TOOL_NOT_GRANTED, ToolSubReason.NOT_IN_AUTHORIZATION_DETAILS]);
  });

  it('grant caps for the tool fail closed without a meter', async () => {
    const details = [
      {
        type: 'urn:grantex:tools:v1',
        connector: 'acme_kyb',
        purpose: 'aml.cdd.onboarding',
        caps: { resolve_business: { per_hour: 5 } },
      },
    ];
    const r = await enforce(grant(undefined, { details }), 'resolve_business');
    expect([r.reasonCode, r.subReason]).toEqual([DenialReason.CAP_EXCEEDED, 'meter_unavailable']);
    expect((await enforce(grant(undefined, { details }), 'get_case')).allowed).toBe(true);
  });

  it('the verified grant carries the claim', () => {
    const details = [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' }];
    const payload: GrantTokenPayload = {
      iss: 'https://issuer.example.com',
      jti: 'tok_01',
      sub: 'user_01',
      agt: 'did:grantex:ag_01',
      dev: 'org_01',
      scp: ['tool:acme_kyb:read'],
      iat: 1,
      exp: 2,
      authorization_details: details,
    };
    expect(claimsToVerifiedGrant(payload).authorizationDetails).toEqual(details);
  });
});

describe('parseToolsAuthorization', () => {
  it('an absent claim is empty', () => {
    expect(parseToolsAuthorization(undefined).size).toBe(0);
  });

  it('reads a full entry', () => {
    const entry = parseToolsAuthorization([
      {
        type: 'urn:grantex:tools:v1',
        connector: 'acme_kyb',
        purpose: 'aml.cdd.onboarding',
        data_region: 'eu',
        tools: ['resolve_business', 'screen_*'],
        caps: { verify_business: { per_hour: 50 } },
      },
    ]).get('acme_kyb');
    expect(entry).toEqual({
      connector: 'acme_kyb',
      purpose: 'aml.cdd.onboarding',
      dataRegion: 'eu',
      tools: ['resolve_business', 'screen_*'],
      caps: { verify_business: { per_hour: 50 } },
    });
    expect(toolsAuthorizationAllows(entry!, 'screen_business')).toBe(true);
    expect(toolsAuthorizationAllows(entry!, 'verify_business')).toBe(false);
  });

  const bad: unknown[] = [
    'x',
    [{ type: '' }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme kyb' }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', tools: 'resolve_business' }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', tools: ['*'] }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: [] }],
    [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', data_region: 1 }],
  ];
  bad.forEach((claim, index) => {
    it(`malformed claim throws (${index})`, () => {
      expect(() => parseToolsAuthorization(claim)).toThrow(AuthorizationDetailsError);
    });
  });
});

describe('shared fixtures', () => {
  it('the vocabulary matches', () => {
    expect([...PURPOSE_VOCABULARY].sort()).toEqual([...FIXTURES.vocabulary].sort());
  });

  for (const c of FIXTURES.match_cases) {
    it(`${JSON.stringify(c.pattern)} ~ ${JSON.stringify(c.purpose)} is ${c.matches}`, () => {
      expect(purposeMatches(c.pattern, c.purpose)).toBe(c.matches);
    });
  }

  for (const c of FIXTURES.known_cases) {
    it(`${JSON.stringify(c.purpose)} known is ${c.known}`, () => {
      expect(isKnownPurpose(c.purpose)).toBe(c.known);
    });
  }
});

// ── Property tests (seeded, deterministic) ─────────────────────────────────

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SEED = 20260915;
const ITERATIONS = 2000;

function pick(r: () => number, chars: string): string {
  return chars[Math.floor(r() * chars.length)] as string;
}
function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}
function segment(r: () => number): string {
  let s = pick(r, LOWER);
  for (let i = int(r, 0, 6); i > 0; i -= 1) s += pick(r, LOWER + DIGITS + '_');
  return s;
}
function randomPurpose(r: () => number, segments?: number): string {
  const count = segments ?? int(r, 1, 5);
  const parts = Array.from({ length: count }, () => segment(r));
  if (r() < 0.2) {
    const orgParts = Array.from({ length: int(r, 1, 2) }, () =>
      Array.from({ length: int(r, 1, 4) }, () => pick(r, LOWER + DIGITS)).join(''),
    );
    return ['x-' + orgParts.join('-'), ...parts].join('.');
  }
  return parts.join('.');
}
function referenceMatch(pattern: string, purpose: string): boolean {
  const p = pattern.split('.');
  const q = purpose.split('.');
  if (p[p.length - 1] === '*') {
    const prefix = p.slice(0, -1);
    return q.length > prefix.length && prefix.every((seg, i) => q[i] === seg);
  }
  return p.length === q.length && p.every((seg, i) => q[i] === seg);
}

describe('purpose matcher properties', () => {
  it('an exact pattern matches only itself', () => {
    const r = rng(SEED);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const p = randomPurpose(r);
      const q = randomPurpose(r);
      expect(purposeMatches(p, p)).toBe(true);
      expect(purposeMatches(p, q)).toBe(p === q);
    }
  });

  it('every proper prefix wildcard matches, and never matches the prefix', () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const p = randomPurpose(r, int(r, 2, 5));
      const parts = p.split('.');
      for (let k = 1; k < parts.length; k += 1) {
        const prefix = parts.slice(0, k).join('.');
        if (!isValidPurpose(prefix)) continue;
        expect(purposeMatches(`${prefix}.*`, p)).toBe(true);
        expect(purposeMatches(`${prefix}.*`, prefix)).toBe(false);
      }
    }
  });

  it('extending the last prefix segment never matches', () => {
    const r = rng(SEED + 2);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const parts = randomPurpose(r, int(r, 2, 5)).split('.');
      const k = int(r, 1, parts.length - 1);
      const prefix = parts.slice(0, k).join('.');
      const extended = prefix + pick(r, LOWER + DIGITS + '_');
      const tail = parts.slice(k).join('.');
      expect(purposeMatches(`${prefix}.*`, extended)).toBe(false);
      expect(purposeMatches(`${prefix}.*`, `${extended}.${tail}`)).toBe(false);
    }
  });

  it('agrees with the segment reference model', () => {
    const r = rng(SEED + 3);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const q = randomPurpose(r);
      let pattern: string;
      if (r() < 0.5) {
        const parts = q.split('.');
        const base = parts.slice(0, int(r, 1, parts.length)).join('.');
        pattern = r() < 0.7 ? `${base}.*` : base;
      } else {
        pattern = randomPurpose(r) + (r() < 0.5 ? '.*' : '');
      }
      if (!isValidPurposePattern(pattern)) {
        expect(purposeMatches(pattern, q)).toBe(false);
        continue;
      }
      expect(purposeMatches(pattern, q), `${pattern} ~ ${q}`).toBe(referenceMatch(pattern, q));
    }
  });

  it('malformed inputs never match', () => {
    const r = rng(SEED + 4);
    const alphabet = LOWER + LOWER.toUpperCase() + DIGITS + '._-* \n';
    for (let i = 0; i < ITERATIONS; i += 1) {
      const junk = Array.from({ length: int(r, 0, 12) }, () => pick(r, alphabet)).join('');
      const good = randomPurpose(r);
      if (!isValidPurpose(junk)) {
        expect(purposeMatches(`${good}.*`, junk)).toBe(false);
        expect(purposeMatches(junk, junk)).toBe(false);
      }
      expect(purposeMatches(null, good)).toBe(false);
      expect(purposeMatches(good, null)).toBe(false);
    }
  });

  it('matchPurpose returns the first matching pattern', () => {
    expect(matchPurpose(['payments.*', 'aml.*', 'aml.cdd.*'], 'aml.cdd.onboarding')).toBe('aml.*');
    expect(matchPurpose([], 'aml.screening')).toBeUndefined();
    expect(matchPurpose(undefined, 'aml.screening')).toBeUndefined();
  });
});

it('authorize() sends purpose', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    headers: { get: () => null },
    json: () => Promise.resolve({ authRequestId: 'areq_01', consentUrl: 'https://auth.example.com/consent' }),
    text: () => Promise.resolve('{}'),
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const client = new Grantex({ apiKey: 'test-key' });
    await client.authorize({ agentId: 'ag_01', userId: 'user_01', scopes: ['tool:acme_kyb:read'], purpose: 'aml.screening' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)) as Record<string, unknown>;
    expect(body['purpose']).toBe('aml.screening');
  } finally {
    vi.unstubAllGlobals();
  }
});
