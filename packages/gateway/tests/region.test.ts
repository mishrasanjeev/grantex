// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway checks the grant's data region with the same semantics as the
 * SDKs' `enforce()`. The cases in spec/examples/enforce-data-region.json are
 * shared with the Python and TypeScript SDKs; a route's `dataRegion` plays the
 * part of the per-call value.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
  GrantexTokenError: class GrantexTokenError extends Error {},
}));

vi.mock('../src/proxy.js', () => ({
  proxyRequest: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { createGatewayServer } from '../src/server.js';
import { validateConfig } from '../src/config.js';
import { GatewayError } from '../src/errors.js';
import { readTokenDataRegions, regionDenial } from '../src/region.js';
import type { GatewayConfig } from '../src/types.js';
import { tokenWith } from './tokens.js';

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

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'shopper-01',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['tool:acme_kyb:read'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const DENIAL_CODES: Record<string, string> = {
  region_unconfigured: 'REGION_UNCONFIGURED',
  region_mismatch: 'REGION_MISMATCH',
};

function config(options: { region?: string | null; routeRegion?: string | null; check?: 'on' | 'off' } = {}): GatewayConfig {
  return {
    upstream: 'https://upstream.merchant.example',
    jwksUri: 'https://issuer.example/.well-known/jwks.json',
    port: 0,
    audienceCheck: 'off',
    ...(options.region != null ? { dataRegion: options.region } : {}),
    ...(options.check !== undefined ? { dataRegionCheck: options.check } : {}),
    routes: [{
      path: '/kyb/**', methods: ['GET'], requiredScopes: ['tool:acme_kyb:read'],
      ...(options.routeRegion != null ? { dataRegion: options.routeRegion } : {}),
    }],
  };
}

function token(region: string | null, extra: Record<string, unknown> = {}): string {
  return tokenWith({
    iss: 'https://issuer.example', sub: 'shopper-01',
    authorization_details: [{
      type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding',
      ...(region !== null ? { data_region: region } : {}),
    }],
    ...extra,
  });
}

async function call(cfg: GatewayConfig, bearer: string): Promise<{ status: number; body: { error?: string; details?: unknown } }> {
  const server = createGatewayServer(cfg);
  try {
    const response = await server.inject({ method: 'GET', url: '/kyb/cases/1', headers: { authorization: `Bearer ${bearer}` } });
    return { status: response.statusCode, body: response.statusCode === 200 ? {} : (response.json() as { error?: string }) };
  } finally {
    await server.close();
  }
}

beforeEach(() => {
  vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  vi.mocked(proxyRequest).mockImplementation(async (_req, reply) => {
    reply.status(200).send('ok');
  });
});

describe('shared data region cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const result = await call(config({ region: c.client_region, routeRegion: c.call_region, check: c.region_check }), token(c.token_region));
    if (c.expect === 'allow') {
      expect(result.status).toBe(200);
    } else {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe(DENIAL_CODES[c.expect]);
    }
  });
});

describe('gateway data region', () => {
  it('is off by default', async () => {
    expect((await call(config(), token('eu'))).status).toBe(200);
  });

  it('refuses a region-bound grant whose entries cannot be read', async () => {
    const result = await call(config({ region: 'in', check: 'on' }), tokenWith({
      iss: 'https://issuer.example', authorization_details: [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', data_region: 7 }],
    }));
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('TOKEN_INVALID');
  });

  it('reports the mismatched connectors', async () => {
    const result = await call(config({ region: 'in', check: 'on' }), token('eu'));
    expect(result.status).toBe(403);
    expect(result.body.details).toEqual({ expected_data_region: 'in', token_data_regions: { acme_kyb: 'eu' } });
  });

  it('validates the configuration', () => {
    expect(() => validateConfig({ ...config(), dataRegionCheck: 'maybe' })).toThrow(GatewayError);
    expect(() => validateConfig({ ...config(), dataRegion: 'in' })).toThrow("dataRegion cannot be set with dataRegionCheck: 'off'");
    expect(() => validateConfig({ ...config({ check: 'on' }), dataRegion: '' })).toThrow('dataRegion must be a non-empty string');
    const parsed = validateConfig({ ...config({ check: 'on' }), dataRegion: ' IN ' });
    expect(parsed.dataRegion).toBe('in');
    expect(() => createGatewayServer({ ...config(), dataRegion: 'in' })).toThrow("dataRegion cannot be set with dataRegionCheck: 'off'");
  });
});

describe('region helpers', () => {
  it('reads tools entries only, leaving other types and entries without a region out', () => {
    const regions = readTokenDataRegions(tokenWith({
      authorization_details: [
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: 'in' },
        { type: 'urn:grantex:tools:v1', connector: 'b' },
        { type: 'urn:grantex:decision:v1', connector: 'c', tools: [] },
      ],
    }));
    expect([...regions.entries()]).toEqual([['a', 'in']]);
    expect(readTokenDataRegions(tokenWith({ sub: 'x' })).size).toBe(0);
    expect(() => readTokenDataRegions(tokenWith({ authorization_details: 'nope' }))).toThrow('authorization_details must be an array');
    expect(() => readTokenDataRegions(tokenWith({
      authorization_details: [
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: 'eu' },
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: 'in' },
      ],
    }))).toThrow('repeats connector "a"');
    // A repeat is refused even when the earlier entry names no region.
    expect(() => readTokenDataRegions(tokenWith({
      authorization_details: [
        { type: 'urn:grantex:tools:v1', connector: 'a' },
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: 'in' },
      ],
    }))).toThrow('repeats connector "a"');
    expect(() => readTokenDataRegions(tokenWith({
      authorization_details: [
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: 'in' },
        { type: 'urn:grantex:tools:v1', connector: 'a', data_region: null },
      ],
    }))).toThrow('repeats connector "a"');
    expect(() => readTokenDataRegions('a.b')).toThrow('grant token payload cannot be read');
  });

  it('denies every entry that names another region', () => {
    const regions = new Map([['a', 'in'], ['b', 'EU '], ['c', 'in']]);
    expect(regionDenial(regions, 'in')?.details).toEqual({ expected_data_region: 'in', token_data_regions: { b: 'eu' } });
    expect(regionDenial(new Map([['a', 'in']]), 'in')).toBeUndefined();
    expect(regionDenial(new Map(), undefined)).toBeUndefined();
    expect(regionDenial(new Map([['a', 'in']]), undefined)?.code).toBe('REGION_UNCONFIGURED');
  });
});
