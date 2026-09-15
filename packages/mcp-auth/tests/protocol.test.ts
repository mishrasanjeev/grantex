import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage/memory.js';
import { canonicalResource, protectedResourceMetadataUrl } from '../src/lib/resource.js';
import type { McpAuthConfig } from '../src/types.js';
import {
  TEST_CHALLENGE,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REDIRECT_URI,
  TEST_RESOURCE,
  TEST_VERIFIER,
  asGrantex,
  authorizeWithConsent,
  clientRecord,
  mockGrantex,
  seededStorage,
  upstreamGrantToken,
} from './helpers.js';
import type { MockGrantex } from './helpers.js';

const ISSUER = 'https://auth.example.com';

type Overrides = { [K in keyof McpAuthConfig]?: McpAuthConfig[K] | undefined };

async function build(overrides: Overrides = {}, grantex: MockGrantex = mockGrantex({ sandboxCode: 'UPSTREAM' })) {
  const storage = await seededStorage(clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }));
  const app = await createMcpAuthServer({
    grantex: asGrantex(grantex),
    agentId: 'agent-1',
    scopes: ['read', 'write'],
    issuer: ISSUER,
    resource: TEST_RESOURCE,
    storage,
    sandboxAutoApprove: true,
    ...overrides,
  } as McpAuthConfig);
  return { app, grantex, storage };
}

function authorizeQuery(overrides: Record<string, string | string[] | undefined> = {}) {
  const query: Record<string, string | string[]> = {
    response_type: 'code',
    client_id: TEST_CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    code_challenge: TEST_CHALLENGE,
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete query[key];
    else query[key] = value;
  }
  return query;
}

async function codeFor(app: FastifyInstance, overrides: Record<string, string | string[] | undefined> = {}): Promise<string> {
  const response = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery(overrides) });
  expect(response.statusCode).toBe(303);
  return new URL(response.headers['location'] as string).searchParams.get('code')!;
}

function redeem(app: FastifyInstance, code: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/token',
    payload: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: TEST_REDIRECT_URI,
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
      code_verifier: TEST_VERIFIER,
      ...extra,
    },
  });
}

describe('configuration fails closed', () => {
  const base = {
    grantex: asGrantex(mockGrantex()),
    agentId: 'agent-1',
    scopes: ['read'],
    issuer: ISSUER,
  };

  it('refuses to start without a resource to bind tokens to', async () => {
    await expect(createMcpAuthServer({ ...base, storage: new InMemoryStorage() })).rejects.toThrow(/`resource` is required/);
  });

  it('refuses a resource that is not a canonical URI', async () => {
    for (const resource of ['mcp.example.com', 'https://mcp.example.com#frag', 'http://mcp.example.com/mcp', 'ftp://mcp.example.com']) {
      await expect(createMcpAuthServer({ ...base, resource, storage: new InMemoryStorage() })).rejects.toThrow(/not a valid resource URI/);
    }
  });

  it('refuses an http issuer that is not localhost', async () => {
    await expect(
      createMcpAuthServer({ ...base, issuer: 'http://auth.example.com', resource: TEST_RESOURCE, storage: new InMemoryStorage() }),
    ).rejects.toThrow(/issuer must be an https URL/);
  });

  it('refuses to start with no scopes and no manifests', async () => {
    await expect(
      createMcpAuthServer({ ...base, scopes: [], resource: TEST_RESOURCE, storage: new InMemoryStorage() }),
    ).rejects.toThrow(/configure `scopes` or `manifests`/);
  });
});

describe('canonical resource URIs', () => {
  it('normalises case, default port and a bare trailing slash', () => {
    expect(canonicalResource('HTTPS://MCP.Example.COM:443/')).toBe('https://mcp.example.com');
    expect(canonicalResource('https://mcp.example.com/mcp/')).toBe('https://mcp.example.com/mcp');
    expect(canonicalResource('https://mcp.example.com:8443')).toBe('https://mcp.example.com:8443');
    expect(canonicalResource('http://localhost:3000/mcp')).toBe('http://localhost:3000/mcp');
  });

  it('rejects missing scheme, fragments, credentials and non-https hosts', () => {
    for (const value of ['mcp.example.com', 'https://mcp.example.com#x', 'https://user:pw@mcp.example.com', 'http://mcp.example.com', '', 42]) {
      expect(canonicalResource(value)).toBeUndefined();
    }
  });

  it('derives the RFC 9728 metadata URL by path insertion', () => {
    expect(protectedResourceMetadataUrl('https://mcp.example.com/public/mcp')).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
    );
    expect(protectedResourceMetadataUrl('https://mcp.example.com')).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
  });
});

describe('resource indicators (RFC 8707) and audience binding', () => {
  it('binds the upstream grant to the requested resource as its audience', async () => {
    const { app, grantex } = await build();
    await codeFor(app, { resource: 'HTTPS://MCP.EXAMPLE.COM/mcp' });
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({ audience: TEST_RESOURCE });
  });

  it('defaults an omitted resource to the only accepted resource', async () => {
    const { app, grantex } = await build();
    await codeFor(app);
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({ audience: TEST_RESOURCE });
  });

  it('refuses a resource that is not accepted, has a fragment or is repeated', async () => {
    const { app, grantex } = await build();
    for (const resource of ['https://other.example.com/mcp', 'https://mcp.example.com/mcp#x', [TEST_RESOURCE, TEST_RESOURCE]]) {
      const response = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ resource }) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_target');
    }
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('requires the resource parameter when several resources are accepted', async () => {
    const { app } = await build({ allowedResources: ['https://mcp.example.com/other'] });
    const response = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery() });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_target' });
    expect(await codeFor(app, { resource: 'https://mcp.example.com/other' })).toBeTruthy();
  });

  it('refuses a token request whose resource differs from the code', async () => {
    const { app, grantex } = await build();
    const code = await codeFor(app);
    const response = await redeem(app, code, { resource: 'https://other.example.com/mcp' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_target');
    expect(grantex.tokens.exchange).not.toHaveBeenCalled();
    // The code was spent by the failed attempt.
    expect((await redeem(app, code)).statusCode).toBe(400);
  });

  it('accepts a token request naming the bound resource in any canonical spelling', async () => {
    const { app } = await build();
    const response = await redeem(app, await codeFor(app), { resource: 'https://MCP.example.com/mcp/' });
    expect(response.statusCode).toBe(200);
  });

  it('never returns an upstream token that is not audience-bound to the resource', async () => {
    for (const grantToken of [
      upstreamGrantToken({ aud: 'https://other.example.com/mcp', jti: 'grnt_wrong_aud' }),
      upstreamGrantToken({ aud: undefined, jti: 'grnt_no_aud' }),
      'not-a-jwt',
    ]) {
      const grantex = mockGrantex({ sandboxCode: 'UPSTREAM' });
      grantex.tokens.exchange.mockResolvedValueOnce({
        grantToken,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read'],
        refreshToken: 'rt_unbound',
        grantId: 'grant-1',
      });
      const { app } = await build({}, grantex);
      const response = await redeem(app, await codeFor(app));
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain(grantToken);
      expect(response.body).not.toContain('rt_unbound');
      if (grantToken.includes('.')) {
        expect(grantex.tokens.revoke).toHaveBeenCalled();
      }
    }
  });

  it('refuses a refresh whose resource differs, without spending the refresh token', async () => {
    const { app, grantex } = await build();
    expect((await redeem(app, await codeFor(app))).statusCode).toBe(200);
    const refresh = (resource?: string) => app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: 'rt_test_refresh',
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        ...(resource !== undefined ? { resource } : {}),
      },
    });
    const wrong = await refresh('https://other.example.com/mcp');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('invalid_target');
    expect(grantex.tokens.refresh).not.toHaveBeenCalled();
    expect((await refresh(TEST_RESOURCE)).statusCode).toBe(200);
  });

  it('exchanges the upstream code with the callback redirect URI Grantex requires', async () => {
    const { app, grantex } = await build();
    expect((await redeem(app, await codeFor(app))).statusCode).toBe(200);
    expect(grantex.tokens.exchange).toHaveBeenCalledWith({
      code: 'UPSTREAM',
      agentId: 'agent-1',
      redirectUri: `${ISSUER}/callback`,
    });
  });
});

describe('PKCE: S256 only', () => {
  it('refuses plain, an omitted method and a malformed challenge', async () => {
    const { app, grantex } = await build();
    const plain = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ code_challenge_method: 'plain', code_challenge: TEST_VERIFIER }) });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error_description).toMatch(/"plain" is not supported/);

    const omitted = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ code_challenge_method: undefined }) });
    expect(omitted.statusCode).toBe(400);

    const malformed = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ code_challenge: 'too-short' }) });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error_description).toMatch(/43 characters/);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });
});

describe('scopes', () => {
  it('refuses a scope the server does not support', async () => {
    const { app, grantex } = await build();
    const response = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ scope: 'read admin:everything' }) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_scope', error_description: 'Unsupported scope: admin:everything' });
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('derives scopes from manifests and accepts them', async () => {
    const { app, grantex } = await build({
      scopes: undefined,
      manifests: [{ connector: 'acme_kyb', tools: { resolve_business: 'read', monitor_enroll: { permission: 'write' } } }],
    });
    const metadata = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(metadata.scopes_supported).toEqual(['tool:acme_kyb:read', 'tool:acme_kyb:write']);
    await codeFor(app, { scope: 'tool:acme_kyb:read' });
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({ scopes: ['tool:acme_kyb:read'] });
  });
});

describe('authorization responses carry iss (RFC 9207)', () => {
  it('on success and on an upstream denial, and never reflects upstream error text', async () => {
    const { app } = await build();
    const success = await authorizeWithConsent(app, { method: 'GET', url: '/authorize', query: authorizeQuery({ state: 's1' }) });
    expect(new URL(success.headers['location'] as string).searchParams.get('iss')).toBe(ISSUER);

    const live = await build({ sandboxAutoApprove: false }, mockGrantex());
    await authorizeWithConsent(live.app, { method: 'GET', url: '/authorize', query: authorizeQuery({ state: 's2' }) });
    const grantexState = (live.grantex.authorize.mock.calls[0]![0] as { state: string }).state;
    const denied = await live.app.inject({
      method: 'GET',
      url: '/callback',
      query: { error: '<script>alert(1)</script>', state: grantexState },
    });
    const location = new URL(denied.headers['location'] as string);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(location.searchParams.get('state')).toBe('s2');
  });
});

describe('authorization server metadata (RFC 8414)', () => {
  it('advertises S256, iss responses, metadata-document clients and only routes that exist', async () => {
    const { app } = await build();
    const body = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(body).toMatchObject({
      issuer: ISSUER,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      response_types_supported: ['code'],
    });
    expect(JSON.stringify(body)).not.toContain('events/stream');
    for (const url of [body.authorization_endpoint, body.token_endpoint, body.registration_endpoint, body.introspection_endpoint, body.revocation_endpoint]) {
      const path = new URL(url as string).pathname;
      const probe = await app.inject({ method: path === '/authorize' ? 'GET' : 'POST', url: path });
      expect(probe.statusCode).not.toBe(404);
    }
  });

  it('is also served at the path-inserted location for an issuer with a path', async () => {
    const { app } = await build({ issuer: 'https://auth.example.com/tenant-a' });
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server/tenant-a' });
    expect(response.statusCode).toBe(200);
    expect(response.json().issuer).toBe('https://auth.example.com/tenant-a');
  });
});

describe('protected resource metadata (RFC 9728)', () => {
  it('is served at the path-inserted and root locations with the authorization server listed', async () => {
    const { app } = await build({ scopes: ['read', 'offline_access'], resourceName: 'Acme KYB tools' });
    for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        resource: TEST_RESOURCE,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
        scopes_supported: ['read'],
        resource_name: 'Acme KYB tools',
      });
    }
  });
});

describe('revoking refresh tokens (RFC 7009) and upstream error text', () => {
  it('revokes a refresh token bound to the client, and only for that client', async () => {
    const storage = await seededStorage(
      clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }),
      clientRecord({ clientId: 'other-client', clientSecret: 'other-secret' }),
    );
    const grantex = mockGrantex({ sandboxCode: 'UPSTREAM' });
    const { app } = await build({ storage }, grantex);
    const issued = await redeem(app, await codeFor(app));
    const refreshToken = issued.json().refresh_token as string;

    const byOther = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: { token: refreshToken, token_type_hint: 'refresh_token', client_id: 'other-client', client_secret: 'other-secret' },
    });
    expect(byOther.statusCode).toBe(503); // not bound to other-client; not a JWT either, and no grantexIssuer here
    const refresh = () => app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET },
    });

    const revoked = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: { token: refreshToken, token_type_hint: 'refresh_token', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET },
    });
    expect(revoked.statusCode).toBe(200);
    expect((await refresh()).statusCode).toBe(400);
    expect(grantex.tokens.refresh).not.toHaveBeenCalled();
  });

  it('does not relay upstream error text from the token exchange, refresh or authorization', async () => {
    const secretText = 'upstream internal detail 10.0.0.12 api key prefix';
    const grantex = mockGrantex({ sandboxCode: 'UPSTREAM' });
    grantex.tokens.exchange.mockRejectedValueOnce(new Error(secretText));
    const { app } = await build({}, grantex);
    const exchange = await redeem(app, await codeFor(app));
    expect(exchange.statusCode).toBe(502);
    expect(exchange.body).not.toContain(secretText);

    const refreshing = mockGrantex({ sandboxCode: 'UPSTREAM' });
    refreshing.tokens.refresh.mockRejectedValueOnce(new Error(secretText));
    const second = await build({}, refreshing);
    expect((await redeem(second.app, await codeFor(second.app))).statusCode).toBe(200);
    const refreshed = await second.app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'refresh_token', refresh_token: 'rt_test_refresh', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET },
    });
    expect(refreshed.statusCode).toBe(400);
    expect(refreshed.body).not.toContain(secretText);

    const failing = mockGrantex();
    failing.authorize.mockRejectedValueOnce(new Error(secretText));
    const third = await build({}, failing);
    const authorizeResponse = await third.app.inject({ method: 'GET', url: '/authorize', query: authorizeQuery() });
    expect(authorizeResponse.body).not.toContain(secretText);
  });
});
