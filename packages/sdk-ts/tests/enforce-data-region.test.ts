// SPDX-License-Identifier: Apache-2.0
/**
 * enforce() checks the grant's data region against the relying party's.
 *
 * A `urn:grantex:tools:v1` entry may carry `data_region`: the region the
 * grant's data may be processed in. With `dataRegionCheck: 'on'` enforce()
 * denies a call for a connector whose entry names a region when the client has
 * no expected region (`region_unconfigured`), and when the regions differ
 * (`region_mismatch`). An entry without a region is unrestricted. The check is
 * `off` by default in this release.
 *
 * The cases in spec/examples/enforce-data-region.json are shared with the
 * Python SDK and @grantex/gateway.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DenialReason, RegionSubReason } from '../src/denials.js';
import { ToolManifest } from '../src/manifest.js';
import type { GrantexClientOptions, VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn(actual.verifyGrantToken) };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

interface RegionCase {
  name: string;
  token_region: string | null;
  client_region: string | null;
  call_region: string | null;
  region_check: 'on' | 'off';
  expect: string;
}

const CASES = (JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'enforce-data-region.json'),
  'utf8',
)) as { cases: RegionCase[] }).cases;

const MANIFEST = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: 'read' } });

function grant(region: string | null): VerifiedGrant {
  return {
    tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'shopper-01', agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01', scopes: ['tool:acme_kyb:read'], issuedAt: 1709000000, expiresAt: 9999999999,
    authorizationDetails: [{
      type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding',
      ...(region !== null ? { data_region: region } : {}),
    }],
  };
}

function client(options: Partial<GrantexClientOptions> = {}): InstanceType<typeof Grantex> {
  const c = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', audienceCheck: 'off', ...options });
  c.loadManifest(MANIFEST);
  return c;
}

function withGrant(region: string | null): void {
  vi.mocked(verifyGrantToken).mockResolvedValueOnce(grant(region));
}

function outcome(result: { allowed: boolean; reasonCode?: string; subReason?: string }): string {
  if (result.allowed) return 'allow';
  expect(result.reasonCode).toBe(DenialReason.REGION_MISMATCH);
  return result.subReason ?? '';
}

describe('shared data region cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    withGrant(c.token_region);
    const result = await client({
      dataRegionCheck: c.region_check,
      ...(c.client_region !== null ? { dataRegion: c.client_region } : {}),
    }).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'get_case',
      ...(c.call_region !== null ? { dataRegion: c.call_region } : {}),
    });
    expect(outcome(result)).toBe(c.expect);
  });
});

describe('enforce() data region', () => {
  it('is off by default: a token region is ignored', async () => {
    withGrant('eu');
    const result = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect(result.allowed).toBe(true);
  });

  it('reports the regions in the denial details', async () => {
    withGrant('eu');
    const result = await client({ dataRegionCheck: 'on', dataRegion: 'in' })
      .enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect([result.allowed, result.reasonCode, result.subReason]).toEqual([
      false, DenialReason.REGION_MISMATCH, RegionSubReason.REGION_MISMATCH,
    ]);
    expect(result.details).toEqual({ expected_data_region: 'in', token_data_region: 'eu' });
  });

  it('is not relaxed by permissive mode', async () => {
    withGrant('eu');
    const result = await client({ dataRegionCheck: 'on', dataRegion: 'in', enforceMode: 'permissive' } as Partial<GrantexClientOptions>)
      .enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect(result.allowed).toBe(false);
  });

  it('refuses a region with the check off, and an invalid mode', () => {
    expect(() => new Grantex({ apiKey: 'k', dataRegion: 'in' })).toThrow("dataRegion cannot be set with dataRegionCheck: 'off'");
    expect(() => new Grantex({ apiKey: 'k', dataRegionCheck: 'maybe' as 'on' })).toThrow('dataRegionCheck must be one of on, off');
    expect(() => new Grantex({ apiKey: 'k', dataRegionCheck: 'on', dataRegion: '' })).toThrow('dataRegion must be a non-empty string');
  });

  it('a per-call region cannot be set when the check is off', async () => {
    withGrant('in');
    await expect(client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case', dataRegion: 'in' }))
      .rejects.toThrow("dataRegion cannot be set with dataRegionCheck: 'off'");
  });
});
