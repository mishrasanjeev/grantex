import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateOAuthAgentKey, OAuthAgentClient } from '../src/oauth-agent.js';

const issuer = 'https://issuer.example';
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
  require_pushed_authorization_requests: true as const,
  response_types_supported: ['code'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:token-exchange',
  ],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true as const,
  dpop_signing_alg_values_supported: ['ES256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('OAuthAgentClient', () => {
  it('runs PAR, verifies state and issuer, and exchanges the code with DPoP', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({
        request_uri: 'urn:ietf:params:oauth:request_uri:test',
        expires_in: 90,
      }, 201))
      .mockResolvedValueOnce(json({
        access_token: 'access-token',
        token_type: 'DPoP',
        expires_in: 300,
        refresh_token: 'refresh-token',
        scope: 'grantex.resource.read',
      }));
    vi.stubGlobal('fetch', mockFetch);

    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    const pending = await client.beginAuthorization({
      scopes: ['grantex.resource.read'],
      principalHint: 'principal_123',
    });

    const authorizationUrl = new URL(pending.authorizationUrl);
    expect(authorizationUrl.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:test');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('ag_test');

    const [, parInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const parBody = new URLSearchParams(parInit.body as string);
    expect(parBody.get('state')).toBe(pending.state);
    expect(parBody.get('code_challenge_method')).toBe('S256');
    expect(parBody.get('dpop_jkt')).toBe(client.keyThumbprint);
    expect(decodeProtectedHeader((parInit.headers as Record<string, string>).DPoP!).typ).toBe('dpop+jwt');

    const callback = new URL('https://client.example/callback');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', pending.state);
    callback.searchParams.set('iss', issuer);
    const token = await client.completeAuthorization(callback.toString());
    expect(token.access_token).toBe('access-token');

    const [, tokenInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    const tokenBody = new URLSearchParams(tokenInit.body as string);
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code_verifier')).toHaveLength(43);
    const proofClaims = decodeJwt((tokenInit.headers as Record<string, string>).DPoP!);
    expect(proofClaims.htu).toBe(`${issuer}/oauth/token`);
    expect(proofClaims.htm).toBe('POST');
  });

  it('rejects an authorization response from a different issuer and consumes its state', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({ request_uri: 'urn:ietf:params:oauth:request_uri:test', expires_in: 90 }, 201));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    const pending = await client.beginAuthorization({ scopes: ['read'], principalHint: 'principal_123' });
    const callback = `https://client.example/callback?code=abc&state=${pending.state}&iss=${encodeURIComponent('https://attacker.example')}`;
    await expect(client.completeAuthorization(callback)).rejects.toThrow('issuer');
    await expect(client.completeAuthorization(callback)).rejects.toThrow('already consumed');
  });

  it('rejects duplicate security parameters in an authorization response', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({ request_uri: 'urn:ietf:params:oauth:request_uri:test', expires_in: 90 }, 201));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    const pending = await client.beginAuthorization({ scopes: ['read'], principalHint: 'principal_123' });
    const callback = `https://client.example/callback?code=abc&state=${pending.state}&state=second&iss=${encodeURIComponent(issuer)}`;
    await expect(client.completeAuthorization(callback)).rejects.toThrow('state must occur at most once');
  });

  it('creates an ath-bound proof for protected-resource requests', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    await client.fetch('https://resource.example/api?item=1', 'access-token', { method: 'GET' });

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('DPoP access-token');
    const claims = decodeJwt(headers.get('dpop')!);
    expect(claims.htu).toBe('https://resource.example/api');
    expect(claims.ath).toBeTypeOf('string');
  });

  it('reuses a stable refresh idempotency key and creates a fresh DPoP proof', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({
        access_token: 'access-token', token_type: 'DPoP', expires_in: 300,
        refresh_token: 'rotated-token', scope: 'read',
      }))
      .mockResolvedValueOnce(json({
        access_token: 'access-token', token_type: 'DPoP', expires_in: 250,
        refresh_token: 'rotated-token', scope: 'read', refresh_replay: true,
      }));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });

    await client.refresh('old-refresh-token');
    const replay = await client.refresh('old-refresh-token');

    const firstHeaders = new Headers((mockFetch.mock.calls[1]?.[1] as RequestInit).headers);
    const retryHeaders = new Headers((mockFetch.mock.calls[2]?.[1] as RequestInit).headers);
    expect(firstHeaders.get('idempotency-key')).toHaveLength(36);
    expect(retryHeaders.get('idempotency-key')).toBe(firstHeaders.get('idempotency-key'));
    expect(retryHeaders.get('dpop')).not.toBe(firstHeaders.get('dpop'));
    expect(replay.refresh_replay).toBe(true);
  });

  it('accepts a caller-persisted OAuth refresh recovery key and rejects weak keys', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({
        access_token: 'access-token', token_type: 'DPoP', expires_in: 300,
        refresh_token: 'rotated-token', scope: 'read',
      }));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });

    await client.refresh('old-refresh-token', { idempotencyKey: 'persisted-refresh-attempt-0001' });
    const headers = new Headers((mockFetch.mock.calls[1]?.[1] as RequestInit).headers);
    expect(headers.get('idempotency-key')).toBe('persisted-refresh-attempt-0001');
    expect(() => client.refresh('old-refresh-token', { idempotencyKey: 'short' }))
      .toThrow('16 to 256');
  });

  it('rejects callbacks delivered to a different redirect URI', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({
        request_uri: 'urn:ietf:params:oauth:request_uri:redirect-test',
        expires_in: 90,
      }, 201));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    const pending = await client.beginAuthorization({ scopes: ['read'], principalHint: 'principal_123' });
    const callback = `https://attacker.example/callback?code=abc&state=${pending.state}&iss=${encodeURIComponent(issuer)}`;
    await expect(client.completeAuthorization(callback)).rejects.toThrow('redirect URI');
  });

  it('refuses to send a resource token to another origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(metadata)));
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    await expect(client.fetch('https://attacker.example/collect', 'access-token'))
      .rejects.toThrow('origin');
  });

  it('rejects private or mismatched public JWK input', async () => {
    const first = await generateOAuthAgentKey();
    const second = await generateOAuthAgentKey();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json(metadata)));

    await expect(OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
      privateKey: first.privateKey,
      publicJwk: { ...first.publicJwk, d: 'private-material' },
    })).rejects.toThrow('private key material');

    await expect(OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
      privateKey: first.privateKey,
      publicJwk: second.publicJwk,
    })).rejects.toThrow('does not match');
  });

  it('rejects insecure non-loopback issuer metadata', async () => {
    await expect(OAuthAgentClient.create({
      issuer: 'http://issuer.example',
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
      allowInsecureLoopback: true,
    })).rejects.toThrow('HTTPS');
  });

  it('uses the RFC 8414 well-known location for an issuer with a path', async () => {
    const pathIssuer = 'https://issuer.example/tenant';
    const pathMetadata = {
      ...metadata,
      issuer: pathIssuer,
      authorization_endpoint: `${pathIssuer}/oauth/authorize`,
      token_endpoint: `${pathIssuer}/oauth/token`,
      jwks_uri: `${pathIssuer}/jwks`,
      revocation_endpoint: `${pathIssuer}/oauth/revoke`,
      pushed_authorization_request_endpoint: `${pathIssuer}/oauth/par`,
    };
    const mockFetch = vi.fn().mockResolvedValueOnce(json(pathMetadata));
    vi.stubGlobal('fetch', mockFetch);

    await OAuthAgentClient.create({
      issuer: pathIssuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://issuer.example/.well-known/oauth-authorization-server/tenant',
    );
  });

  it('rejects a malformed token response', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(json({ request_uri: 'urn:ietf:params:oauth:request_uri:test', expires_in: 90 }, 201))
      .mockResolvedValueOnce(json({ access_token: '', token_type: 'Bearer', expires_in: 0, scope: '' }));
    vi.stubGlobal('fetch', mockFetch);
    const client = await OAuthAgentClient.create({
      issuer,
      clientId: 'ag_test',
      redirectUri: 'https://client.example/callback',
      resource: 'https://resource.example/api',
    });
    const pending = await client.beginAuthorization({ scopes: ['read'], principalHint: 'principal_123' });
    const callback = `https://client.example/callback?code=abc&state=${pending.state}&iss=${encodeURIComponent(issuer)}`;
    await expect(client.completeAuthorization(callback)).rejects.toThrow('invalid DPoP token response');
  });
});
