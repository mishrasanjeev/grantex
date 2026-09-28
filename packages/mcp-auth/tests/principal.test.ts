import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import type { McpAuthConfig } from '../src/types.js';
import {
  TEST_CHALLENGE, TEST_CLIENT_ID, TEST_REDIRECT_URI, TEST_RESOURCE,
  TEST_VERIFIER, asGrantex, callbackCookieFrom, clientRecord,
  mockGrantex, seededStorage, submitConsent, upstreamGrantToken,
} from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture(overrides: { [K in keyof McpAuthConfig]?: McpAuthConfig[K] | undefined } = {}, sandbox = false) {
  let human: string | undefined = 'tenant-a:human-1';
  const grantex = mockGrantex(sandbox ? { sandboxCode: 'upstream-code' } : {});
  const storage = await seededStorage(clientRecord({ publicClient: true, grantTypes: ['authorization_code', 'refresh_token'] }));
  const config = {
    grantex: asGrantex(grantex), agentId: 'agent-1', storage,
    issuer: 'https://auth.example.com', resource: TEST_RESOURCE, scopes: ['read'],
    resolvePrincipal: async () => human ? { principalId: human } : undefined,
    grant: { purpose: 'x-acme.review', duration: '8h' },
    sandboxAutoApprove: sandbox,
    ...overrides,
  } as McpAuthConfig;
  const app = await createMcpAuthServer(config);
  apps.push(app);
  const page = (extra: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/authorize', query: {
    response_type: 'code', client_id: TEST_CLIENT_ID, redirect_uri: TEST_REDIRECT_URI,
    code_challenge: TEST_CHALLENGE, code_challenge_method: 'S256', scope: 'read', state: 'client-state', ...extra,
  } });
  const exchange = (code: string) => app.inject({ method: 'POST', url: '/token', payload: {
    grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT_URI,
    client_id: TEST_CLIENT_ID, code_verifier: TEST_VERIFIER,
  } });
  const refresh = (token: string) => app.inject({ method: 'POST', url: '/token', payload: {
    grant_type: 'refresh_token', refresh_token: token, client_id: TEST_CLIENT_ID,
  } });
  return { app, grantex, storage, config, page, exchange, refresh, setHuman: (id?: string) => { human = id; } };
}

describe('authenticated human consent boundary', () => {
  it('calls the issuance hook for exchange and refresh, without failing delivery when logging fails', async () => {
    const hook = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private-hook-detail'));
    const warn = vi.fn();
    const f = await fixture({ hooks: { onTokenIssued: hook }, warn }, true);
    const approved = await submitConsent(f.app, await f.page());
    const response = await f.exchange(new URL(String(approved.headers.location)).searchParams.get('code')!);
    expect(response.statusCode).toBe(200);
    expect((await f.refresh(response.json().refresh_token)).statusCode).toBe(200);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]![0]).toMatchObject({ clientId: TEST_CLIENT_ID, grantId: 'grant-1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onTokenIssued failed'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-hook-detail');
  });
  it('requires a resolver at startup rather than silently using the OAuth client', async () => {
    await expect(fixture({ resolvePrincipal: undefined })).rejects.toThrow(/resolvePrincipal is required/);
  });

  it('allows an explicit evaluation-only opt-out with an operator warning', async () => {
    const warn = vi.fn();
    const f = await fixture({ resolvePrincipal: undefined, allowLegacyClientPrincipal: true, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Evaluation only'));
    expect((await submitConsent(f.app, await f.page())).statusCode).toBe(303);
    expect(f.grantex.authorize.mock.calls[0]![0].userId).toBe(TEST_CLIENT_ID);
  });

  it('uses the resolver even when the legacy opt-out is set', async () => {
    const f = await fixture({ allowLegacyClientPrincipal: true });
    await submitConsent(f.app, await f.page());
    expect(f.grantex.authorize.mock.calls[0]![0].userId).toBe('tenant-a:human-1');
  });

  it.each(['', ' ', ' human ', 'human\n', 'x'.repeat(257)])('rejects malformed resolver identity %j', async (id) => {
    const f = await fixture({ resolvePrincipal: async () => ({ principalId: id }) });
    expect((await f.page()).statusCode).toBe(401);
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });

  it('does not trust principal IDs supplied in query parameters', async () => {
    const f = await fixture();
    f.setHuman();
    expect((await f.page({ principalId: 'victim', userId: 'victim' })).statusCode).toBe(401);
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });

  it('fails closed without revealing resolver failures', async () => {
    const f = await fixture({ resolvePrincipal: async () => { throw new Error('private-session-detail'); } });
    const response = await f.page();
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-session-detail');
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });

  it.each([undefined, 'tenant-a:human-2', 'tenant-b:human-1'])('refuses approval after logout or identity switch to %j', async (id) => {
    const f = await fixture();
    const page = await f.page();
    f.setHuman(id);
    expect((await submitConsent(f.app, page)).statusCode).toBe(403);
    expect(f.grantex.authorize).not.toHaveBeenCalled();
    f.setHuman('tenant-a:human-1');
    expect((await submitConsent(f.app, page)).statusCode).toBe(400);
  });

  it('isolates two humans using the same OAuth client', async () => {
    const f = await fixture();
    const first = await f.page();
    f.setHuman('tenant-a:human-2');
    const second = await f.page();
    expect((await submitConsent(f.app, first)).statusCode).toBe(403);
    expect((await submitConsent(f.app, second)).statusCode).toBe(303);
    expect(f.grantex.authorize.mock.calls[0]![0].userId).toBe('tenant-a:human-2');
  });

  it.each([undefined, 'tenant-a:human-2'])('refuses the upstream callback after identity changes to %j', async (id) => {
    const f = await fixture();
    const approved = await submitConsent(f.app, await f.page());
    const state = f.grantex.authorize.mock.calls[0]![0].state;
    f.setHuman(id);
    const response = await f.app.inject({ method: 'GET', url: '/callback', query: { code: 'upstream-code', state }, headers: { cookie: callbackCookieFrom(approved) } });
    expect(response.statusCode).toBe(403);
    expect(response.headers.location).toBeUndefined();
  });

  it('completes consent, callback, exchange and refresh with immutable upstream subject', async () => {
    const f = await fixture();
    const approved = await submitConsent(f.app, await f.page());
    const state = f.grantex.authorize.mock.calls[0]![0].state;
    const callback = await f.app.inject({ method: 'GET', url: '/callback', query: { code: 'upstream-code', state }, headers: { cookie: callbackCookieFrom(approved) } });
    expect(callback.statusCode).toBe(302);
    const code = new URL(String(callback.headers.location)).searchParams.get('code')!;
    const response = await f.exchange(code);
    expect(response.statusCode).toBe(200);
    const token = response.json().refresh_token;
    const binding = await f.storage.takeRefreshTokenBinding(token, TEST_CLIENT_ID);
    expect(binding).toMatchObject({ grantexPrincipalId: 'principal-1' });
    await f.storage.putRefreshTokenBinding(token, binding!);
    expect((await f.refresh(token)).statusCode).toBe(200);
    expect((await f.refresh(token)).statusCode).toBe(400);
  });

  it.each(['other-human', undefined])('refuses a swapped upstream token subject %j', async (sub) => {
    const f = await fixture({}, true);
    const approved = await submitConsent(f.app, await f.page());
    const code = new URL(String(approved.headers.location)).searchParams.get('code')!;
    f.grantex.tokens.exchange.mockResolvedValueOnce({ grantToken: upstreamGrantToken({ sub, jti: 'swapped' }), refreshToken: 'stolen-refresh', expiresAt: new Date(Date.now() + 3600000).toISOString(), scopes: ['read'], grantId: 'grant-1' });
    const response = await f.exchange(code);
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('stolen-refresh');
    expect(f.grantex.tokens.revoke).toHaveBeenCalledWith('swapped');
    expect(await f.storage.takeRefreshTokenBinding('stolen-refresh', TEST_CLIENT_ID)).toBeUndefined();
  });

  it('refuses a refresh that changes the principal', async () => {
    const f = await fixture({}, true);
    const approved = await submitConsent(f.app, await f.page());
    const response = await f.exchange(new URL(String(approved.headers.location)).searchParams.get('code')!);
    f.grantex.tokens.refresh.mockResolvedValueOnce({ grantToken: upstreamGrantToken({ sub: 'other-human', jti: 'swapped-refresh' }), refreshToken: 'wrong-refresh', expiresAt: new Date(Date.now() + 3600000).toISOString(), scopes: ['read'], grantId: 'grant-1' });
    expect((await f.refresh(response.json().refresh_token)).statusCode).toBe(502);
    expect(await f.storage.takeRefreshTokenBinding('wrong-refresh', TEST_CLIENT_ID)).toBeUndefined();
    expect(f.grantex.tokens.revoke).toHaveBeenCalledWith('swapped-refresh');
  });

  it('requires reauthorization for legacy refresh records without a human binding', async () => {
    const f = await fixture();
    await f.storage.putRefreshTokenBinding('legacy-token', { clientId: TEST_CLIENT_ID, resource: TEST_RESOURCE, expiresAt: Date.now() + 60000 });
    expect((await f.refresh('legacy-token')).statusCode).toBe(400);
    expect(f.grantex.tokens.refresh).not.toHaveBeenCalled();
  });

  it('requires reauthorization for a legacy authorization code without human binding', async () => {
    const f = await fixture();
    await f.storage.putAuthorizationCode('legacy-code', {
      clientId: TEST_CLIENT_ID, redirectUri: TEST_REDIRECT_URI,
      codeChallenge: TEST_CHALLENGE, codeChallengeMethod: 'S256',
      scopes: ['read'], resource: TEST_RESOURCE, grantexAuthRequestId: 'old-request',
      grantexCode: 'old-upstream-code', expiresAt: Date.now() + 60000,
    });
    expect((await f.exchange('legacy-code')).statusCode).toBe(400);
    expect(f.grantex.tokens.exchange).not.toHaveBeenCalled();
  });

  it('refuses upstream authorization without a returned principal ID', async () => {
    const f = await fixture();
    f.grantex.authorize.mockResolvedValueOnce({ consentUrl: 'https://grantex.example.com/consent' });
    expect((await submitConsent(f.app, await f.page())).statusCode).toBe(502);
  });

  it('refuses a principal resolver outage during approval without issuing authority', async () => {
    let unavailable = false;
    const f = await fixture({ resolvePrincipal: async () => {
      if (unavailable) throw new Error('private-session-detail');
      return { principalId: 'human-1' };
    } });
    const page = await f.page();
    unavailable = true;
    const response = await submitConsent(f.app, page);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-session-detail');
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });

  it('refuses approval if the displayed duration changes', async () => {
    const f = await fixture();
    const page = await f.page();
    f.config.grant!.duration = '7d';
    expect((await submitConsent(f.app, page)).statusCode).toBe(400);
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });

  it('refuses a hidden extension that changes the displayed duration', async () => {
    const f = await fixture({ grant: { duration: '8h', authorizeParams: () => ({ expiresIn: '7d' }) } });
    expect((await submitConsent(f.app, await f.page())).statusCode).toBe(500);
    expect(f.grantex.authorize).not.toHaveBeenCalled();
  });
});
