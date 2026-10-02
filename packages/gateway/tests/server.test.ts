import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
  GrantexTokenError: class GrantexTokenError extends Error {
    constructor(message: string) {
      super(message);
      Object.setPrototypeOf(this, GrantexTokenError.prototype);
    }
  },
}));

// Mock proxy to avoid actual HTTP calls
vi.mock('../src/proxy.js', () => ({
  proxyRequest: vi.fn(),
}));

import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { createGatewayServer } from '../src/server.js';
import type { GatewayConfig } from '../src/types.js';
import { GRANT_TOKEN } from './tokens.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read', 'calendar:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const CONFIG: GatewayConfig = {
  upstream: 'https://api.internal.example.com',
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  port: 0,
  routes: [
    { path: '/calendar/**', methods: ['GET'], requiredScopes: ['calendar:read'] },
    { path: '/calendar/**', methods: ['POST'], requiredScopes: ['calendar:write'] },
    { path: '/payments/**', methods: ['POST'], requiredScopes: ['payments:initiate'] },
  ],
};

describe('createGatewayServer', () => {
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    server = createGatewayServer(CONFIG);
    vi.mocked(proxyRequest).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 404 for unmatched route', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/unknown/path',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('ROUTE_NOT_FOUND');
  });

  it('returns 401 when no Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_MISSING');
  });

  it('returns 401 when Authorization is not Bearer', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_MISSING');
  });

  it('returns 401 for invalid token', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Invalid signature'),
    );

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_INVALID');
  });

  it('returns 401 for expired token', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Token exp claim is in the past'),
    );

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: 'Bearer expired-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_EXPIRED');
  });

  it('does not mislabel an expected-agent mismatch as token expiry', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new GrantexTokenError('Grant token does not belong to the expected agent'));
    const response = await server.inject({ method: 'GET', url: '/calendar/events', headers: { authorization: 'Bearer invalid-token' } });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('TOKEN_INVALID');
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('returns 403 for insufficient scopes', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Missing required scope: payments:initiate'),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('SCOPE_INSUFFICIENT');
  });

  it('proxies request on valid token', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);

    await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });

    expect(verifyGrantToken).toHaveBeenCalledWith(GRANT_TOKEN, {
      jwksUri: CONFIG.jwksUri,
      requiredScopes: ['calendar:read'],
    });
    expect(proxyRequest).toHaveBeenCalled();
  });

  it('passes correct requiredScopes for POST', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);

    await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: {
        authorization: `Bearer ${GRANT_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { summary: 'Meeting' },
    });

    expect(verifyGrantToken).toHaveBeenCalledWith(GRANT_TOKEN, {
      jwksUri: CONFIG.jwksUri,
      requiredScopes: ['calendar:write'],
    });
  });

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('DB connection lost'));

    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('INTERNAL_ERROR');
  });

  it('handles DELETE method against unmatched route', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/calendar/events/123',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });

    // No DELETE route configured for /calendar/**
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Traversal rejection is asserted at the unit level in matcher.test.ts rather
 * than here: `inject` resolves `..` and `.` in the URL before the handler runs
 * (verified — `/calendar/../payments/transfer` arrives as `/payments/transfer`),
 * whereas a real Node HTTP server passes the raw request-target through
 * untouched. Driving this path through `inject` would assert on a normalized
 * URL that production never produces, which is why the gap went unnoticed.
 */
describe('path handling', () => {
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    server = createGatewayServer(CONFIG);
    vi.mocked(proxyRequest).mockResolvedValue(undefined);
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  afterEach(async () => {
    await server.close();
  });

  it('still allows dots inside a path segment', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events/report.v2.json',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });

    expect(response.statusCode).not.toBe(400);
    expect(proxyRequest).toHaveBeenCalled();
  });
});

describe('request body handling', () => {
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    server = createGatewayServer(CONFIG);
    vi.mocked(proxyRequest).mockResolvedValue(undefined);
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  afterEach(async () => {
    await server.close();
  });

  function bodyGivenToProxy(): unknown {
    return (vi.mocked(proxyRequest).mock.calls[0]![0] as { body: unknown }).body;
  }

  // The content-type parser used to decode every body as UTF-8. Bytes that are
  // not valid UTF-8 became U+FFFD and were unrecoverable by the time the proxy
  // saw them, so the upstream received mojibake.
  it('preserves a non-UTF-8 body through the parser', async () => {
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);

    const response = await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: {
        authorization: `Bearer ${GRANT_TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      payload: binary,
    });

    expect(response.statusCode).not.toBe(400);
    const received = bodyGivenToProxy();
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(Buffer.compare(received as Buffer, binary)).toBe(0);
  });

  it('preserves a JSON body exactly as sent, without reformatting', async () => {
    // Key order and whitespace survive, so a body the client signed still
    // hashes to the same value downstream.
    const raw = '{"b":2,  "a":1}';

    await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'content-type': 'application/json' },
      payload: raw,
    });

    const received = bodyGivenToProxy();
    expect(Buffer.isBuffer(received)).toBe(true);
    expect((received as Buffer).toString('utf-8')).toBe(raw);
  });

  it('preserves a form-encoded body', async () => {
    const raw = 'summary=Meeting&when=today';

    await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: {
        authorization: `Bearer ${GRANT_TOKEN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: raw,
    });

    expect((bodyGivenToProxy() as Buffer).toString('utf-8')).toBe(raw);
  });

  it('still accepts a malformed JSON body rather than rejecting it', async () => {
    // A proxy has no business validating the payload; that is the upstream's call.
    const response = await server.inject({
      method: 'POST',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'content-type': 'application/json' },
      payload: '{not valid json',
    });

    expect(response.statusCode).not.toBe(400);
    expect((bodyGivenToProxy() as Buffer).toString('utf-8')).toBe('{not valid json');
  });
});

describe('credentials by reference', () => {
  const REFERENCE = 'vcr_01J9ZK3X6Q0Z6W7F0X2Y1V8K3M';
  const REF_CONFIG: GatewayConfig = {
    ...CONFIG,
    credentialReference: 'on',
    grantexApiKey: 'gx_key_1',
    grantexBaseUrl: 'https://auth.example.com',
    upstreamHeaders: { 'X-Internal': 'yes' },
  };
  let server: ReturnType<typeof createGatewayServer>;

  function resolver(status: number, body: unknown) {
    const fetchImpl = vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    vi.mocked(proxyRequest).mockResolvedValue(undefined);
    server = createGatewayServer(REF_CONFIG);
  });

  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals();
  });

  it('redeems a presented reference for the grant and injects the credential upstream', async () => {
    const fetchImpl = resolver(200, { accessToken: 'ya29.token', service: 'google', credentialType: 'oauth2' });
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'grantex-credential-ref': REFERENCE },
    });
    expect(response.statusCode).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example.com/v1/vault/credentials/resolve');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gx_key_1');
    expect(JSON.parse(init.body as string)).toEqual({ credentialRef: REFERENCE, grantId: 'grnt_1' });
    const options = vi.mocked(proxyRequest).mock.calls[0]![3];
    expect(options.upstreamHeaders).toEqual({ 'X-Internal': 'yes', Authorization: 'Bearer ya29.token' });
  });

  it('proxies a request that presents no reference without asking the auth service', async () => {
    const fetchImpl = resolver(200, {});
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.mocked(proxyRequest).mock.calls[0]![3].upstreamHeaders).toEqual({ 'X-Internal': 'yes' });
  });

  it('denies the request when the auth service refuses the reference, and never proxies it', async () => {
    resolver(403, { code: 'GRANT_INACTIVE' });
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'grantex-credential-ref': REFERENCE },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('CREDENTIAL_REF_INVALID');
    expect(JSON.parse(response.body).message).toContain('GRANT_INACTIVE');
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('answers 502 when the auth service cannot be reached, and never proxies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'grantex-credential-ref': REFERENCE },
    });
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toBe('CREDENTIAL_RESOLVE_FAILED');
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('refuses a malformed reference with 400', async () => {
    const fetchImpl = resolver(200, {});
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'grantex-credential-ref': 'not-a-reference' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('CREDENTIAL_REF_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('ignores the header while the check is off', async () => {
    await server.close();
    server = createGatewayServer(CONFIG);
    const fetchImpl = resolver(200, {});
    const response = await server.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${GRANT_TOKEN}`, 'grantex-credential-ref': REFERENCE },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(proxyRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with the check on but no key or auth service', () => {
    expect(() => createGatewayServer({ ...CONFIG, credentialReference: 'on', grantexApiKey: 'gx_key_1' }))
      .toThrow('credentialReference: on needs grantexApiKey and grantexBaseUrl');
    expect(() => createGatewayServer({ ...CONFIG, credentialReference: 'maybe' as never })).toThrow();
  });
});
