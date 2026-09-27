// SPDX-License-Identifier: Apache-2.0
/**
 * enforce() checks the grant token's audience (RFC 7519 section 4.1.3).
 *
 * A token that names an audience is only for that relying party. enforce()
 * denies a token that carries `aud` when the client has no expected audience
 * (`audience_unconfigured`), and a token whose `aud` does not contain the
 * expected audience (`audience_mismatch`). `audienceCheck: 'off'` restores the
 * earlier behaviour, which ignored `aud`.
 *
 * The cases in spec/examples/enforce-audience.json are shared with the Python
 * SDK, @grantex/gateway and @grantex/adapters.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { DenialReason, TokenSubReason } from '../src/denials.js';
import { ToolManifest } from '../src/manifest.js';
import type { GrantexClientOptions, VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn(actual.verifyGrantToken) };
});

const { verifyGrantToken, clearRemoteJwksCache } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

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
)) as { cases: AudienceCase[] }).cases;

const MANIFEST = new ToolManifest({ connector: 'acme_kyb', tools: { get_case: 'read' } });
const MERCHANT = 'https://api.merchant.example';

function grant(aud: string | string[] | null): VerifiedGrant {
  return {
    tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'shopper-01', agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01', scopes: ['tool:acme_kyb:read'], issuedAt: 1709000000, expiresAt: 9999999999,
    ...(aud !== null ? { audience: aud } : {}),
  };
}

function client(options: Partial<GrantexClientOptions> = {}): InstanceType<typeof Grantex> {
  const c = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', ...options });
  c.loadManifest(MANIFEST);
  return c;
}

function withGrant(aud: string | string[] | null): void {
  vi.mocked(verifyGrantToken).mockResolvedValueOnce(grant(aud));
}

function outcome(result: { allowed: boolean; reasonCode?: string; subReason?: string }): string {
  if (result.allowed) return 'allow';
  expect(result.reasonCode).toBe(DenialReason.TOKEN_INVALID);
  return result.subReason ?? '';
}

describe('shared audience cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    withGrant(c.aud);
    const result = await client({
      audienceCheck: c.audience_check,
      ...(c.client_audience !== null ? { audience: c.client_audience } : {}),
    }).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'get_case',
      ...(c.call_audience !== null ? { audience: c.call_audience } : {}),
    });
    expect(outcome(result)).toBe(c.expect);
  });
});

describe('enforce() audience', () => {
  it('denies a token with aud when no audience is configured', async () => {
    withGrant(MERCHANT);
    const result = await client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect([result.allowed, result.reasonCode, result.subReason]).toEqual([
      false, DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_UNCONFIGURED,
    ]);
    expect(result.details).toEqual({ token_audience: [MERCHANT] });
    expect(result.grantId).toBe('grnt_01');
  });

  it('denies an audience mismatch', async () => {
    withGrant(['https://api.provider.example']);
    const result = await client({ audience: MERCHANT }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect([result.allowed, result.reasonCode, result.subReason]).toEqual([
      false, DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_MISMATCH,
    ]);
    expect(result.details).toEqual({ expected_audience: MERCHANT, token_audience: ['https://api.provider.example'] });
  });

  it('denies a token without aud when an audience is expected', async () => {
    withGrant(null);
    const result = await client({ audience: MERCHANT }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect([result.allowed, result.subReason]).toEqual([false, TokenSubReason.AUDIENCE_MISMATCH]);
    expect(result.details).toEqual({ expected_audience: MERCHANT, token_audience: [] });
  });

  it('allows an array aud that contains the audience', async () => {
    withGrant(['https://issuer.example', MERCHANT]);
    const result = await client({ audience: MERCHANT }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(result.subReason).toBeUndefined();
  });

  it('lets the per-call audience override the client', async () => {
    const c = client({ audience: MERCHANT });
    withGrant('https://tools.merchant.example');
    expect((await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' })).subReason)
      .toBe(TokenSubReason.AUDIENCE_MISMATCH);
    withGrant('https://tools.merchant.example');
    expect((await c.enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'get_case', audience: 'https://tools.merchant.example',
    })).allowed).toBe(true);
  });

  it("audienceCheck: 'off' restores the earlier behaviour", async () => {
    for (const aud of [MERCHANT, [MERCHANT, 'https://issuer.example'], [], null]) {
      withGrant(aud);
      const result = await client({ audienceCheck: 'off' }).enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
      expect(result.allowed).toBe(true);
      expect([result.reasonCode, result.subReason, result.details]).toEqual([undefined, undefined, undefined]);
    }
  });

  it('checks the audience before asking the auth service about revocation', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      withGrant('https://api.provider.example');
      const result = await client({ audience: MERCHANT, revocationCheck: 'online' })
        .enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
      expect(result.subReason).toBe(TokenSubReason.AUDIENCE_MISMATCH);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Permissive mode turns a denial into an allow with a warning. An audience
  // denial is a correctly signed token for another relying party (or a client
  // that does not know its own audience), so it stays denied in every mode.
  it.each([
    ['audience_unconfigured', MERCHANT, {}, { token_audience: [MERCHANT] }],
    ['audience_mismatch', 'https://api.provider.example', { audience: MERCHANT },
      { expected_audience: MERCHANT, token_audience: ['https://api.provider.example'] }],
  ] as const)('keeps %s denied in permissive mode', async (subReason, aud, options, details) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withGrant(aud);
      const result = await client({ ...options, enforceMode: 'permissive' } as Partial<GrantexClientOptions>)
        .enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
      expect([result.allowed, result.reasonCode, result.subReason]).toEqual([false, DenialReason.TOKEN_INVALID, subReason]);
      expect(result.details).toEqual(details);
      expect(result.reason).toMatch(/audience/);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still relaxes a scope denial in permissive mode once the audience matches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = new Grantex({ apiKey: 'test-key', audience: MERCHANT, enforceMode: 'permissive', revocationCheck: 'offline' } as GrantexClientOptions);
      c.loadManifest(new ToolManifest({ connector: 'acme_kyb', tools: { get_case: 'write' } }));
      withGrant(MERCHANT);
      const result = await c.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
      expect(result.allowed).toBe(true);
      expect(result.reasonCode).toBe(DenialReason.PERMISSION_INSUFFICIENT);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['', 'ON', 'strict', null, 1, true])('refuses audienceCheck %j at construction', (value) => {
    expect(() => new Grantex({ apiKey: 'test-key', audienceCheck: value as never })).toThrow(/audienceCheck/);
  });

  it.each(['', 1, [MERCHANT]])('refuses the expected audience %j', async (value) => {
    expect(() => new Grantex({ apiKey: 'test-key', audience: value as never })).toThrow(/audience/);
    withGrant(MERCHANT);
    await expect(client().enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case', audience: value as never }))
      .rejects.toThrow(/audience/);
  });

  it("refuses an expected audience with audienceCheck: 'off'", async () => {
    expect(() => new Grantex({ apiKey: 'test-key', audience: MERCHANT, audienceCheck: 'off' })).toThrow(/audienceCheck/);
    withGrant(MERCHANT);
    await expect(client({ audienceCheck: 'off' }).enforce({
      grantToken: 't', connector: 'acme_kyb', tool: 'get_case', audience: MERCHANT,
    })).rejects.toThrow(/audienceCheck/);
  });

  it('adds the two sub-reasons to the vocabulary', () => {
    expect(TokenSubReason.AUDIENCE_UNCONFIGURED).toBe('audience_unconfigured');
    expect(TokenSubReason.AUDIENCE_MISMATCH).toBe('audience_mismatch');
  });
});

describe('signed tokens, verified end to end', () => {
  const ISSUER = 'https://issuer.example';
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'ES256-1', alg: 'ES256', use: 'sig' };
  });

  afterEach(() => {
    clearRemoteJwksCache();
    vi.unstubAllGlobals();
  });

  async function token(aud: string | string[] | null): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: ISSUER, sub: 'shopper-01', iat: now, exp: now + 600, jti: 'tok_01', scope: 'tool:acme_kyb:read',
      'urn:grantex:grant': { grant_id: 'grnt_01', agent_did: 'did:grantex:ag_01', developer_id: 'dev_01' },
      ...(aud !== null ? { aud } : {}),
    };
    return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'ES256-1', typ: 'at+jwt' }).sign(privateKey);
  }

  function signedClient(options: Partial<GrantexClientOptions> = {}): InstanceType<typeof Grantex> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    return client({ baseUrl: ISSUER, legacyClaims: false, ...options });
  }

  it('matches an array aud', async () => {
    const t = await token(['https://issuer.example', MERCHANT]);
    expect((await signedClient({ audience: MERCHANT }).enforce({ grantToken: t, connector: 'acme_kyb', tool: 'get_case' })).allowed)
      .toBe(true);
    const denied = await signedClient({ audience: 'https://tools.merchant.example' })
      .enforce({ grantToken: t, connector: 'acme_kyb', tool: 'get_case' });
    expect([denied.reasonCode, denied.subReason]).toEqual([DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_MISMATCH]);
  });

  it('denies aud without a configured audience unless the check is off', async () => {
    const t = await token(MERCHANT);
    expect((await signedClient().enforce({ grantToken: t, connector: 'acme_kyb', tool: 'get_case' })).subReason)
      .toBe(TokenSubReason.AUDIENCE_UNCONFIGURED);
    expect((await signedClient({ audienceCheck: 'off' }).enforce({ grantToken: t, connector: 'acme_kyb', tool: 'get_case' })).allowed)
      .toBe(true);
  });

  it('leaves a token without aud unaffected', async () => {
    const t = await token(null);
    expect((await signedClient().enforce({ grantToken: t, connector: 'acme_kyb', tool: 'get_case' })).allowed).toBe(true);
  });
});
