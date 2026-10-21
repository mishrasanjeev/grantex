// SPDX-License-Identifier: Apache-2.0
/**
 * Adapters check the grant token's audience with the same semantics as the
 * SDKs' `enforce()` (RFC 7519 section 4.1.3). The cases in
 * spec/examples/enforce-audience.json are shared with the Python and
 * TypeScript SDKs and the gateway. An adapter serves one relying party, so it
 * takes the audience from its config only: the cases with a per-call audience
 * do not apply.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { BaseAdapter } from '../src/base-adapter.js';
import { GitHubAdapter } from '../src/adapters/github.js';
import { GrantexAdapterError } from '../src/errors.js';
import type { AdapterConfig } from '../src/types.js';
import { tokenWith } from './tokens.js';

interface AudienceCase {
  name: string;
  aud: string | string[] | null;
  client_audience: string | null;
  call_audience: string | null;
  audience_check: 'on' | 'off';
  expect: string;
}

const CASES = (JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'enforce-audience.json'),
  'utf8',
)) as { cases: AudienceCase[] }).cases.filter((c) => c.call_audience === null);

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'shopper-01',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read', 'repos:read'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const MERCHANT = 'https://api.merchant.example';

class TestAdapter extends BaseAdapter {
  async check(token: string) {
    return this.verifyAndCheckScope(token, 'calendar:read');
  }
}

function adapter(options: Partial<AdapterConfig> = {}): TestAdapter {
  return new TestAdapter({ jwksUri: 'https://issuer.example/.well-known/jwks.json', credentials: 'placeholder', ...options });
}

function token(aud: string | string[] | null): string {
  return tokenWith({ iss: 'https://issuer.example', sub: 'shopper-01', ...(aud !== null ? { aud } : {}) });
}

async function outcome(a: TestAdapter, t: string): Promise<string> {
  try {
    await a.check(t);
    return 'allow';
  } catch (err) {
    if (!(err instanceof GrantexAdapterError)) throw err;
    return err.code;
  }
}

/** The adapters' error codes for the SDKs' `token_invalid` sub-reasons. */
const ADAPTER_CODE: Record<string, string> = {
  allow: 'allow',
  audience_unconfigured: 'AUDIENCE_UNCONFIGURED',
  audience_mismatch: 'AUDIENCE_MISMATCH',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
});

describe('adapter audience parity with enforce()', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const a = adapter({
      audienceCheck: c.audience_check,
      ...(c.client_audience !== null ? { audience: c.client_audience } : {}),
    });
    expect(await outcome(a, token(c.aud))).toBe(ADAPTER_CODE[c.expect]);
  });
});

describe('adapter audience', () => {
  it('denies a token with aud when no audience is configured', async () => {
    expect(await outcome(adapter(), token(MERCHANT))).toBe('AUDIENCE_UNCONFIGURED');
  });

  it('denies an audience mismatch', async () => {
    expect(await outcome(adapter({ audience: MERCHANT }), token('https://api.provider.example'))).toBe('AUDIENCE_MISMATCH');
  });

  it('allows an array aud that contains the audience', async () => {
    expect(await outcome(adapter({ audience: MERCHANT }), token(['https://issuer.example', MERCHANT]))).toBe('allow');
  });

  it("audienceCheck: 'off' restores the earlier behaviour, including for a token it cannot read", async () => {
    expect(await outcome(adapter({ audienceCheck: 'off' }), token(MERCHANT))).toBe('allow');
    expect(await outcome(adapter({ audienceCheck: 'off' }), 'grant-token')).toBe('allow');
  });

  it('fails closed when the verified token payload cannot be read', async () => {
    expect(await outcome(adapter(), 'grant-token')).toBe('TOKEN_INVALID');
    expect(await outcome(adapter({ audience: MERCHANT }), tokenWith({ aud: { value: MERCHANT } }))).toBe('TOKEN_INVALID');
  });

  it('checks the audience before calling the upstream service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const github = new GitHubAdapter({
        jwksUri: 'https://issuer.example/.well-known/jwks.json', credentials: 'placeholder', audience: MERCHANT,
      });
      await expect(github.listRepositories(token('https://api.provider.example'))).rejects.toMatchObject({
        code: 'AUDIENCE_MISMATCH',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['', 'ON', 'strict', 1, true, null])('refuses audienceCheck %j at construction', (value) => {
    expect(() => adapter({ audienceCheck: value as never })).toThrow(/audienceCheck/);
  });

  it.each(['', 1, [MERCHANT]])('refuses the audience %j at construction', (value) => {
    expect(() => adapter({ audience: value as never })).toThrow(/audience/);
  });

  it("refuses an audience together with audienceCheck: 'off'", () => {
    expect(() => adapter({ audience: MERCHANT, audienceCheck: 'off' })).toThrow(/audienceCheck/);
  });
});
