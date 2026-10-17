import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';
import { proxyRequest } from '../src/proxy.js';
import { assertEgressDestination, validateEgressOptions } from '../src/egress.js';
import { resolveCredentialReference } from '../src/credentials.js';
import { validateConfig } from '../src/config.js';
import { createGatewayServer } from '../src/server.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const grant = {
  principalId: 'synthetic-principal', agentDid: 'did:grantex:agent:synthetic', grantId: 'grnt_synthetic',
} as VerifiedGrant;

describe('restricted gateway egress', () => {
  it('refuses malformed flags, production HTTP fixtures and implicit current-authority destinations', () => {
    for (const options of [{ restrictedEgress: 'true' }, { allowInsecureLoopback: 'false' }]) {
      expect(() => validateEgressOptions(options as never)).toThrow();
    }
    const profile = {
      upstream: 'https://upstream.example', jwksUri: 'https://issuer.example/.well-known/jwks.json', port: 0,
      restrictedEgress: true, egressAllowedOrigins: ['https://upstream.example', 'https://issuer.example'],
      routes: [{ path: '/records/**', methods: ['GET'], requiredScopes: ['records:read'] }],
    };
    expect(validateConfig(profile).restrictedEgress).toBe(true);
    expect(() => createGatewayServer({ ...profile, currentAuthorityCheck: true })).toThrow(/explicit grantexBaseUrl/);
    expect(() => validateConfig({ ...profile, jwksUri: 'https://outside.example/jwks' })).toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => validateEgressOptions({ allowInsecureLoopback: true })).toThrow(/forbidden in production/);
  });

  it.each([301, 302, 303, 307, 308])('never forwards a body or injected headers through an upstream %i redirect', async (status) => {
    let unexpectedCalls = 0;
    const unexpected = await listen(createServer((_req, res) => {
      unexpectedCalls++;
      res.end('unexpected destination');
    }));
    const upstream = await listen(createServer((_req, res) => {
      res.writeHead(status, { Location: `${unexpected}/outside-authority` });
      res.end();
    }));
    const reply = { status() { return this; }, header() { return this; }, send() {} };
    await expect(proxyRequest({
      method: 'POST', url: '/permitted', headers: {}, body: Buffer.from('synthetic-only'),
    } as never, reply as never, grant, {
      upstream, upstreamHeaders: { 'x-fixture-key': 'synthetic-only' },
      restrictedEgress: true, egressAllowedOrigins: [upstream], allowInsecureLoopback: true,
    })).rejects.toThrow();
    expect(unexpectedCalls).toBe(0);
  });

  it('permits the configured origin and refuses a destination outside the allowlist before contacting it', async () => {
    let calls = 0;
    const upstream = await listen(createServer((_req, res) => { calls++; res.end('allowed'); }));
    const reply = { status() { return this; }, header() { return this; }, send() {} };
    await proxyRequest({ method: 'GET', url: '/allowed', headers: {} } as never,
      reply as never, grant, { upstream, restrictedEgress: true, egressAllowedOrigins: [upstream], allowInsecureLoopback: true });
    expect(calls).toBe(1);
    await expect(proxyRequest({ method: 'GET', url: '/', headers: {} } as never,
      reply as never, grant, { upstream, restrictedEgress: true, egressAllowedOrigins: ['https://allowed.invalid'] }))
      .rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('refuses invalid profiles, credentials, paths and mismatched exact origins', () => {
    for (const origin of ['http://remote.invalid', 'https://user:secret@allowed.invalid',
      'https://allowed.invalid/path', 'https://allowed.invalid?key=secret', 'https://*.invalid', 'https://allowed.invalid/#fragment']) {
      expect(() => validateEgressOptions({ restrictedEgress: true, egressAllowedOrigins: [origin] })).toThrow();
    }
    expect(() => validateEgressOptions({ restrictedEgress: true, egressAllowedOrigins: [] })).toThrow();
    const options = { restrictedEgress: true, egressAllowedOrigins: ['https://allowed.invalid'] };
    for (const destination of ['https://allowed.invalid.attacker.invalid', 'https://allowed.invalid:8443', 'https://other.invalid']) {
      expect(() => assertEgressDestination(destination, options)).toThrow();
    }
    expect(() => assertEgressDestination('https://allowed.invalid/path', options)).not.toThrow();
  });

  it('never redirects vault resolution with the gateway credential', async () => {
    let unexpectedCalls = 0;
    const outside = await listen(createServer((_req, res) => { unexpectedCalls++; res.end('{}'); }));
    const authority = await listen(createServer((_req, res) => { res.writeHead(307, { Location: outside }); res.end(); }));
    await expect(resolveCredentialReference('vcr_synthetic', 'grnt_synthetic', {
      grantexBaseUrl: authority, grantexApiKey: 'synthetic-only', rejectRedirects: true,
    })).rejects.toThrow();
    expect(unexpectedCalls).toBe(0);
  });
});
