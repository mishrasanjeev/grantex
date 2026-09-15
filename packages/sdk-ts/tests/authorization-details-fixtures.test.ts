/**
 * authorization_details parsing against the fixtures shared with the Python SDK,
 * and the enforce() consequences of grant caps that cannot be read unambiguously.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolManifest, ManifestValidationError } from '../src/manifest.js';
import { AuthorizationDetailsError, parseToolsAuthorization, type ToolsAuthorization } from '../src/authorization-details.js';
import { CapsMeter, InMemoryCapsBackend } from '../src/caps/index.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', () => ({
  verifyGrantToken: vi.fn(),
  mapOnlineVerifyToVerifiedGrant: vi.fn(),
}));

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

interface Fixtures {
  valid: Array<{ name: string; claim: unknown; entries: Record<string, Record<string, unknown>> }>;
  invalid: Array<{ name: string; claim: unknown }>;
}
const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'authorization-details.json'), 'utf-8'),
) as Fixtures;

function asFixture(entry: ToolsAuthorization): Record<string, unknown> {
  return {
    ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
    ...(entry.dataRegion !== undefined ? { data_region: entry.dataRegion } : {}),
    ...(entry.tools !== undefined ? { tools: [...entry.tools] } : {}),
    ...(entry.caps !== undefined ? { caps: JSON.parse(JSON.stringify(entry.caps)) as unknown } : {}),
  };
}

describe('shared authorization_details fixtures', () => {
  for (const c of FIXTURES.valid) {
    it(`valid: ${c.name}`, () => {
      const entries = Object.fromEntries([...parseToolsAuthorization(c.claim)].map(([k, v]) => [k, asFixture(v)]));
      expect(entries).toEqual(c.entries);
    });
  }
  for (const c of FIXTURES.invalid) {
    it(`invalid: ${c.name}`, () => {
      expect(() => parseToolsAuthorization(c.claim)).toThrow(AuthorizationDetailsError);
    });
  }
});

const manifest = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: { get_case: 'read', screen_person: 'read', screen_business: 'read' },
});

function grant(details: unknown): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01',
    scopes: ['tool:acme_kyb:read'],
    issuedAt: 1709000000,
    expiresAt: 9999999999,
    authorizationDetails: details,
  };
}

function client() {
  const c = new Grantex({ apiKey: 'test-key', capsMeter: new CapsMeter(new InMemoryCapsBackend()) });
  c.loadManifest(manifest);
  return c;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('grant caps in enforce()', () => {
  it('wildcard cap keys deny instead of being ignored', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', tools: ['screen_*'], caps: { 'screen_*': { per_hour: 1 } } }]),
    );
    const c = client();
    for (let i = 0; i < 3; i += 1) {
      const r = await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'screen_person' });
      expect([r.allowed, r.reasonCode, r.subReason]).toEqual([false, 'token_invalid', 'malformed_authorization_details']);
    }
  });

  it('malformed caps for another tool deny every call on the connector', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { screen_business: { per_hour: 'x' } } }]),
    );
    const r = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect([r.allowed, r.subReason]).toEqual([false, 'malformed_authorization_details']);
  });

  it('exact grant caps apply', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      grant([{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', caps: { screen_person: { per_hour: 1 } } }]),
    );
    const c = client();
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'screen_person' })).allowed).toBe(true);
    const denied = await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'screen_person' });
    expect([denied.reasonCode, denied.details?.['limit'], denied.details?.['scope']]).toEqual(['cap_exceeded', 1, 'grant']);
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'screen_business' })).allowed).toBe(true);
  });
});

describe('cost_units is not a tool name', () => {
  for (const tools of [{ cost_units: { permission: 'read' } }, { get_case: 'read', cost_units: 'read' }]) {
    it(JSON.stringify(tools), () => {
      expect(() => ToolManifest.fromJSON({ connector: 'acme_kyb', tools })).toThrow('tool name "cost_units" is reserved');
    });
  }
  it('addTool', () => {
    const m = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: 'read' } });
    expect(() => m.addTool('cost_units', 'read')).toThrow(ManifestValidationError);
  });
});
