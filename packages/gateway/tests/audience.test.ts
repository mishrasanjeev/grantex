// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway checks the grant token's audience with the same semantics as
 * the SDKs' `enforce()` (RFC 7519 section 4.1.3). The cases in
 * spec/examples/enforce-audience.json are shared with the Python and
 * TypeScript SDKs; a route's `audience` plays the part of the per-call value.
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

import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { createGatewayServer } from '../src/server.js';
import { validateConfig } from '../src/config.js';
import { GatewayError } from '../src/errors.js';
import type { GatewayConfig } from '../src/types.js';
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
)) as { cases: AudienceCase[] }).cases;

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'shopper-01',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const MERCHANT = 'https://api.merchant.example';

function config(options: {
  audience?: string | null;
  routeAudience?: string | null;
  audienceCheck?: 'on' | 'off';
} = {}): GatewayConfig {
  return {
    upstream: 'https://upstream.merchant.example',
    jwksUri: 'https://issuer.example/.well-known/jwks.json',
    port: 0,
    ...(options.audience != null ? { audience: options.audience } : {}),
    ...(options.audienceCheck !== undefined ? { audienceCheck: options.audienceCheck } : {}),
    routes: [{
      path: '/calendar/**', methods: ['GET'], requiredScopes: ['calendar:read'],
      ...(options.routeAudience != null ? { audience: options.routeAudience } : {}),
    }],
  };
}

function token(aud: string | string[] | null): string {
  return tokenWith({ iss: 'https://issuer.example', sub: 'shopper-01', ...(aud !== null ? { aud } : {}) });
}

async function call(cfg: GatewayConfig, bearer: string): Promise<{ status: number; body: { error?: string } }> {
  const server = createGatewayServer(cfg);
  try {
    const response = await server.inject({
      method: 'GET', url: '/calendar/events', headers: { authorization: `Bearer ${bearer}` },
    });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : {} };
  } finally {
    await server.close();
  }
}

/** The gateway's error codes for the SDKs' `token_invalid` sub-reasons. */
const GATEWAY_CODE: Record<string, string> = {
  audience_unconfigured: 'AUDIENCE_UNCONFIGURED',
  audience_mismatch: 'AUDIENCE_MISMATCH',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  vi.mocked(proxyRequest).mockImplementation(async (_req, reply) => {
    reply.status(200).send({ ok: true });
  });
});

describe('gateway audience parity with enforce()', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { status, body } = await call(
      config({ audience: c.client_audience, routeAudience: c.call_audience, audienceCheck: c.audience_check }),
      token(c.aud),
    );
    if (c.expect === 'allow') {
      expect(status).toBe(200);
      expect(proxyRequest).toHaveBeenCalledTimes(1);
    } else {
      expect(status).toBe(401);
      expect(body.error).toBe(GATEWAY_CODE[c.expect]);
      expect(proxyRequest).not.toHaveBeenCalled();
    }
  });
});

describe('gateway audience', () => {
  it('denies a token with aud when no audience is configured', async () => {
    const { status, body } = await call(config(), token(MERCHANT));
    expect(status).toBe(401);
    expect(body.error).toBe('AUDIENCE_UNCONFIGURED');
  });

  it('denies an audience mismatch', async () => {
    const { status, body } = await call(config({ audience: MERCHANT }), token('https://api.provider.example'));
    expect(status).toBe(401);
    expect(body.error).toBe('AUDIENCE_MISMATCH');
  });

  it('allows an array aud that contains the audience', async () => {
    const { status } = await call(config({ audience: MERCHANT }), token(['https://issuer.example', MERCHANT]));
    expect(status).toBe(200);
  });

  it("audienceCheck: 'off' restores the earlier behaviour, including for a token it cannot read", async () => {
    expect((await call(config({ audienceCheck: 'off' }), token(MERCHANT))).status).toBe(200);
    expect((await call(config({ audienceCheck: 'off' }), 'valid-grant-token')).status).toBe(200);
  });

  it('fails closed when the verified token payload cannot be read', async () => {
    const { status, body } = await call(config(), 'valid-grant-token');
    expect(status).toBe(401);
    expect(body.error).toBe('TOKEN_INVALID');
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('fails closed on an aud claim that is neither a string nor an array of strings', async () => {
    const { status, body } = await call(config({ audience: MERCHANT }), tokenWith({ aud: [MERCHANT, 7] }));
    expect(status).toBe(401);
    expect(body.error).toBe('TOKEN_INVALID');
  });

  it('logs the fail-closed denial for an unreadable payload, like the audience denials', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await call(config(), 'valid-grant-token');
      const lines = write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({
        level: 'info', method: 'GET', path: '/calendar/events', grantId: 'grnt_1', error: 'grant token payload cannot be read',
      }));
    } finally {
      write.mockRestore();
    }
  });

  it('refuses an invalid audienceCheck when the server is created', () => {
    expect(() => createGatewayServer({ ...config(), audienceCheck: 'strict' as never })).toThrow(/audienceCheck/);
  });
});

describe('validateConfig audience options', () => {
  const base = {
    upstream: 'https://upstream.merchant.example',
    jwksUri: 'https://issuer.example/.well-known/jwks.json',
    routes: [{ path: '/calendar/**', methods: ['GET'], requiredScopes: ['calendar:read'] }],
  };

  it('reads audience, audienceCheck and a route audience', () => {
    const cfg = validateConfig({
      ...base, audience: MERCHANT, audienceCheck: 'on',
      routes: [{ ...base.routes[0], audience: 'https://tools.merchant.example' }],
    });
    expect(cfg.audience).toBe(MERCHANT);
    expect(cfg.audienceCheck).toBe('on');
    expect(cfg.routes[0]!.audience).toBe('https://tools.merchant.example');
  });

  it('leaves the audience options out when they are not set', () => {
    const cfg = validateConfig(base);
    expect('audience' in cfg).toBe(false);
    expect('audienceCheck' in cfg).toBe(false);
    expect('audience' in cfg.routes[0]!).toBe(false);
  });

  it.each(['', 'ON', 'strict', 1, true, null])('refuses audienceCheck %j', (value) => {
    expect(() => validateConfig({ ...base, audienceCheck: value })).toThrow(GatewayError);
    expect(() => validateConfig({ ...base, audienceCheck: value })).toThrow(/audienceCheck/);
  });

  it.each(['', 1, [MERCHANT], null])('refuses the audience %j', (value) => {
    expect(() => validateConfig({ ...base, audience: value })).toThrow(/audience/);
    expect(() => validateConfig({ ...base, routes: [{ ...base.routes[0], audience: value }] })).toThrow(/audience/);
  });

  it("refuses an audience together with audienceCheck: 'off'", () => {
    expect(() => validateConfig({ ...base, audience: MERCHANT, audienceCheck: 'off' })).toThrow(/audienceCheck/);
    expect(() => validateConfig({
      ...base, audienceCheck: 'off', routes: [{ ...base.routes[0], audience: MERCHANT }],
    })).toThrow(/audienceCheck/);
  });
});

describe('gateway audience is checked before scopes, as in enforce()', () => {
  const scopeError = () => new GrantexTokenError('Grant token is missing required scopes: calendar:read');

  it('denies a token for another relying party that also lacks the scopes as an audience mismatch', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(scopeError());
    const { status, body } = await call(config({ audience: MERCHANT }), token('https://api.provider.example'));
    expect(status).toBe(401);
    expect(body.error).toBe('AUDIENCE_MISMATCH');
  });

  it('denies a token with aud and no configured audience that also lacks the scopes as unconfigured', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(scopeError());
    const { status, body } = await call(config(), token(MERCHANT));
    expect(status).toBe(401);
    expect(body.error).toBe('AUDIENCE_UNCONFIGURED');
  });

  it('still reports SCOPE_INSUFFICIENT when the audience matches', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(scopeError());
    const { status, body } = await call(config({ audience: MERCHANT }), token(MERCHANT));
    expect(status).toBe(403);
    expect(body.error).toBe('SCOPE_INSUFFICIENT');
  });

  it("reports SCOPE_INSUFFICIENT with audienceCheck: 'off', as before", async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(scopeError());
    const { status, body } = await call(config({ audienceCheck: 'off' }), token(MERCHANT));
    expect(status).toBe(403);
    expect(body.error).toBe('SCOPE_INSUFFICIENT');
  });
});
