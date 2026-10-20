/**
 * G24 / G36: UCP identity-linking scope registry and Grantex ACP extension
 * scopes on the OAuth 2.1 authorization server, and the identity link a
 * merchant records from an issued token.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import type { McpAuthConfig } from '../src/types.js';
import {
  ACP_DELEGATED_AUTHENTICATION_SCOPES,
  UCP_IDENTITY_LINKING_SCOPES,
  UCP_IDENTITY_LINKING_VERSIONS,
  UCP_SCOPE_TOKEN_PATTERNS,
  commerceScopeDefinition,
  ucpIdentityLinkingScopePolicies,
} from '../src/index.js';
import {
  TEST_CHALLENGE, TEST_CLIENT_ID, TEST_REDIRECT_URI, TEST_RESOURCE, TEST_VERIFIER,
  asGrantex, clientRecord, mockGrantex, seededStorage, submitConsent,
} from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const UCP_SCOPES = Object.keys(UCP_IDENTITY_LINKING_SCOPES);
const ACP_SCOPES = Object.keys(ACP_DELEGATED_AUTHENTICATION_SCOPES);

function savedScopeSchema(version: string): { pattern: RegExp; policy: Record<string, unknown> } {
  const schema = JSON.parse(readFileSync(join(FIXTURES, `ucp-${version}`, 'identity_linking.json'), 'utf8')) as {
    $defs: { scope_token: { pattern: string }; scope_policy: Record<string, unknown> };
  };
  return { pattern: new RegExp(schema.$defs.scope_token.pattern), policy: schema.$defs.scope_policy };
}

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function server(overrides: { [K in keyof McpAuthConfig]?: McpAuthConfig[K] | undefined } = {}, sandbox = true) {
  const grantex = mockGrantex(sandbox ? { sandboxCode: 'upstream-code' } : {});
  const storage = await seededStorage(clientRecord({ publicClient: true, grantTypes: ['authorization_code', 'refresh_token'] }));
  const app = await createMcpAuthServer({
    grantex: asGrantex(grantex), agentId: 'agent-1', storage,
    issuer: 'https://auth.merchant.example', resource: TEST_RESOURCE,
    resolvePrincipal: async () => ({ principalId: 'merchant-account-42' }),
    sandboxAutoApprove: sandbox,
    commerce: { ucpIdentityLinking: { version: '2026-04-08' }, acpDelegatedAuthentication: {} },
    ...overrides,
  } as McpAuthConfig);
  apps.push(app);
  return { app, grantex };
}

describe('commerce scope registries', () => {
  it.each(UCP_IDENTITY_LINKING_VERSIONS)('every UCP scope is a %s scope token per the saved schema', (version) => {
    const { pattern } = savedScopeSchema(version);
    expect(UCP_SCOPE_TOKEN_PATTERNS[version].source).toBe(pattern.source);
    for (const scope of UCP_SCOPES) expect(pattern.test(scope), scope).toBe(true);
    // The Grantex ACP extension scopes are valid scope tokens too, under Grantex's own namespace.
    for (const scope of ACP_SCOPES) expect(pattern.test(scope), scope).toBe(true);
  });

  it('lists exactly the six well-known UCP scopes, each naming its capability', () => {
    expect([...UCP_SCOPES].sort()).toEqual([
      'dev.ucp.shopping.cart:manage',
      'dev.ucp.shopping.catalog.lookup:read',
      'dev.ucp.shopping.catalog.search:read',
      'dev.ucp.shopping.checkout:manage',
      'dev.ucp.shopping.order:manage',
      'dev.ucp.shopping.order:read',
    ]);
    for (const scope of UCP_SCOPES) {
      expect(scope.split(':')[0]).toBe(UCP_IDENTITY_LINKING_SCOPES[scope]!.capability);
      expect(UCP_IDENTITY_LINKING_SCOPES[scope]!.defined_by).toBe('ucp');
    }
  });

  it('keeps every non-UCP commerce scope in the Grantex namespace and marked as a Grantex extension', () => {
    for (const scope of ACP_SCOPES) {
      expect(scope.startsWith('dev.grantex.acp.')).toBe(true);
      expect(commerceScopeDefinition(scope)!.defined_by).toBe('grantex');
    }
    expect(commerceScopeDefinition('dev.ucp.shopping.order:read')!.defined_by).toBe('ucp');
    expect(commerceScopeDefinition('dev.grantex.commerce.discovery.preview:read')).toBeUndefined();
  });

  it('builds identity-linking scope policies for UCP scopes only', () => {
    const policies = ucpIdentityLinkingScopePolicies([...ACP_SCOPES, 'dev.ucp.shopping.order:read', 'toString']);
    expect(policies).toEqual({ 'dev.ucp.shopping.order:read': { description: { plain: 'Read the buyer\'s orders.' } } });
  });
});

describe('authorization server with commerce scopes', () => {
  it('publishes the scopes in RFC 8414 and RFC 9728 metadata with the commerce extension', async () => {
    const { app } = await server();
    const as = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(as.scopes_supported).toEqual([...UCP_SCOPES, ...ACP_SCOPES]);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.grantex_extensions.commerce).toEqual({
      ucp_identity_linking: { version: '2026-04-08', scopes: UCP_SCOPES },
      acp_delegated_authentication: { scopes: ACP_SCOPES, defined_by: 'grantex' },
    });
    const pr = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json();
    expect(pr.authorization_servers).toEqual(['https://auth.merchant.example']);
    expect(pr.scopes_supported).toEqual(as.scopes_supported);
  });

  it('offers a chosen subset and keeps configured non-commerce scopes', async () => {
    const { app } = await server({
      scopes: ['tool:loyalty:read'],
      commerce: { ucpIdentityLinking: { version: '2026-08-25', scopes: ['dev.ucp.shopping.order:read'] } },
    });
    const as = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(as.scopes_supported).toEqual(['tool:loyalty:read', 'dev.ucp.shopping.order:read']);
    expect(as.grantex_extensions.commerce).toEqual({ ucp_identity_linking: { version: '2026-08-25', scopes: ['dev.ucp.shopping.order:read'] } });
  });

  it('refuses invented dev.ucp.* and dev.grantex.acp.* scopes, unknown releases and empty selections at start-up', async () => {
    await expect(server({ scopes: ['dev.ucp.shopping.checkout:admin'] })).rejects.toThrow(/not a defined UCP or Grantex ACP scope/);
    await expect(server({ scopes: ['dev.grantex.acp.refund:manage'] })).rejects.toThrow(/not a defined UCP or Grantex ACP scope/);
    await expect(server({ commerce: { ucpIdentityLinking: { version: '2026-01-11' as never } } })).rejects.toThrow(/version must be one of/);
    await expect(server({ commerce: { ucpIdentityLinking: { version: '2026-04-08', scopes: ['dev.ucp.shopping.cart:read'] } } }))
      .rejects.toThrow(/may list only/);
    await expect(server({ commerce: { acpDelegatedAuthentication: { scopes: [] } } })).rejects.toThrow(/at least one scope/);
  });

  it('leaves servers without commerce configuration unchanged', async () => {
    const { app } = await server({ commerce: undefined, scopes: ['dev.ucp.anything:goes'] });
    const as = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(as.scopes_supported).toEqual(['dev.ucp.anything:goes']);
    expect(as.grantex_extensions).toBeUndefined();
  });

  it('runs Authorization Code + PKCE for UCP scopes and reports the identity link at issuance', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const { app, grantex } = await server({ hooks: { onTokenIssued: hook } });
    const scope = 'dev.ucp.shopping.order:read dev.grantex.acp.checkout:manage';
    const page = await app.inject({ method: 'GET', url: '/authorize', query: {
      response_type: 'code', client_id: TEST_CLIENT_ID, redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE, code_challenge_method: 'S256', scope, state: 'platform-state',
    } });
    expect(page.statusCode, page.body).toBe(200);
    const approved = await submitConsent(app, page, 'approve', 'https://auth.merchant.example');
    expect(approved.statusCode, approved.body).toBe(303);
    const location = new URL(String(approved.headers.location));
    expect(location.searchParams.get('state')).toBe('platform-state');
    expect(location.searchParams.get('iss')).toBe('https://auth.merchant.example');
    expect(grantex.authorize.mock.calls[0]![0].scopes).toEqual(scope.split(' '));
    expect(grantex.authorize.mock.calls[0]![0].userId).toBe('merchant-account-42');
    const token = await app.inject({ method: 'POST', url: '/token', payload: {
      grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: TEST_REDIRECT_URI,
      client_id: TEST_CLIENT_ID, code_verifier: TEST_VERIFIER,
    } });
    expect(token.statusCode).toBe(200);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ subject: 'principal-1', principalId: 'merchant-account-42' }));
    // Refresh keeps the subject; the host principal is only known at code exchange.
    const refreshed = await app.inject({ method: 'POST', url: '/token', payload: {
      grant_type: 'refresh_token', refresh_token: token.json().refresh_token, client_id: TEST_CLIENT_ID,
    } });
    expect(refreshed.statusCode).toBe(200);
    expect(hook.mock.calls[1]![0]).toMatchObject({ subject: 'principal-1' });
    expect(hook.mock.calls[1]![0].principalId).toBeUndefined();
  });

  it('refuses a scope outside the registry at /authorize with invalid_scope', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'GET', url: '/authorize', query: {
      response_type: 'code', client_id: TEST_CLIENT_ID, redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE, code_challenge_method: 'S256', scope: 'dev.ucp.shopping.checkout:admin', state: 's',
    } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
  });
});
