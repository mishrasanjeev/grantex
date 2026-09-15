/**
 * Every code example in docs/mcp-auth.md is a file under tests/docs/examples
 * that is type-checked with the package and exercised here, and the
 * documentation must contain it verbatim, so the examples cannot drift.
 * The Postgres and Redis examples run in the integration suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as jose from 'jose';
import { InMemoryStorage } from '../src/storage/memory.js';
import { createMcpAuthServer } from '../src/server.js';
import type { LoadedManifest } from '../src/resource/tool-policy.js';
import { startAuthServer } from './docs/examples/auth-server.js';
import { createMcpApp } from './docs/examples/mcp-server.js';
import { decisionVerifier } from './docs/examples/decision-verifier.js';
import { consentPage } from './docs/examples/consent-details.js';
import { TEST_CHALLENGE, TEST_CLIENT_ID, TEST_REDIRECT_URI, asGrantex, clientRecord, mockGrantex } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const examplesDir = fileURLToPath(new URL('./docs/examples/', import.meta.url));

const MANIFEST: LoadedManifest = {
  connector: 'acme_kyb',
  version: '1.0.0',
  tools: {
    resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'], caps: { per_hour: 200 } },
    verify_business: { permission: 'read', caps: { per_hour: 50, per_case: 3 } },
    monitor_enroll: { permission: 'write', allowed_purposes: ['aml.cdd.ongoing'] },
    case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] },
  },
};

describe('docs/mcp-auth.md examples', () => {
  // Compare with LF line endings whatever the checkout's autocrlf setting.
  const read = (path: string) => readFileSync(path, 'utf8').split(String.fromCharCode(13)).join('');
  const doc = read(`${repoRoot}docs/mcp-auth.md`);
  const snippets = [...doc.matchAll(/<!-- snippet: (\S+) -->\n```typescript\n([\s\S]*?)\n```/g)];

  it('embeds every example file verbatim', () => {
    const files = readdirSync(examplesDir).filter((f) => f.endsWith('.ts')).sort();
    const referenced = snippets.map((m) => m[1]!.replace('packages/mcp-auth/tests/docs/examples/', '')).sort();
    expect(referenced).toEqual(files);
    for (const [, path, code] of snippets) {
      expect(code, path).toBe(read(`${repoRoot}${path}`).replace(/\n+$/, ''));
    }
  });

  it('has no untested typescript blocks', () => {
    const blocks = doc.match(/```typescript\n/g) ?? [];
    expect(blocks.length).toBe(snippets.length);
  });

  it('auth-server: starts and renders the consent page with purpose, region, duration and tools', async () => {
    const storage = new InMemoryStorage();
    await storage.putClient(clientRecord());
    const grantex = mockGrantex();
    const app = await startAuthServer({ grantex: asGrantex(grantex), storage, manifest: MANIFEST });
    const page = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        resource: 'https://mcp.acme.example.com/mcp',
        scope: 'tool:acme_kyb:read',
      },
    });
    expect(page.statusCode).toBe(200);
    for (const text of ['Allow case tools?', 'aml.cdd.onboarding', '<dd>eu</dd>', '8 hours', 'verify_business', 'per case: at most 3 calls']) {
      expect(page.body).toContain(text);
    }
    expect(grantex.authorize).not.toHaveBeenCalled();
    const metadata = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(metadata.scopes_supported).toEqual(['tool:acme_kyb:read', 'tool:acme_kyb:write']);
  });

  it('consent-details: the customised page renders its own details section', async () => {
    const storage = new InMemoryStorage();
    await storage.putClient(clientRecord());
    const app = await createMcpAuthServer({
      grantex: asGrantex(mockGrantex()),
      agentId: 'agent-1',
      issuer: 'https://auth.acme.example.com',
      resource: 'https://mcp.acme.example.com/mcp',
      manifests: [MANIFEST],
      grant: { purpose: 'aml.cdd.onboarding', dataRegion: 'eu', duration: '8h' },
      consentPage,
      storage,
    });
    const page = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        scope: 'tool:acme_kyb:write',
      },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Case tools for aml.cdd.onboarding');
    expect(page.body).toContain('<li>case_decision (needs approval per action)</li>');
    expect(page.body).toContain('Data stays in eu for 8 hours.');
    expect(page.body).toContain('<html lang="en-GB">');
    expect(page.body).toContain('>Not now</button>');
  });

  describe('mcp-server and decision-verifier', () => {
    let privateKey: jose.CryptoKey;
    let jwks: Server;
    let issuer: string;
    let mcp: Server;
    let base: string;

    beforeAll(async () => {
      const pair = await jose.generateKeyPair('ES256');
      privateKey = pair.privateKey;
      const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'docs', alg: 'ES256', use: 'sig' };
      jwks = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      });
      await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
      const jwksAddress = jwks.address();
      issuer = `http://127.0.0.1:${typeof jwksAddress === 'object' && jwksAddress ? jwksAddress.port : 0}`;

      const storage = new InMemoryStorage();
      await storage.revokeToken('grnt_revoked', { revokedAt: Date.now(), expiresAt: Date.now() + 3600_000 });
      const app = createMcpApp({ manifest: MANIFEST, revocations: storage, decisions: decisionVerifier, grantexIssuer: issuer });
      mcp = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => mcp.once('listening', () => resolve()));
      const address = mcp.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });

    afterAll(async () => {
      mcp.closeAllConnections();
      await new Promise<void>((resolve) => mcp.close(() => resolve()));
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    });

    const token = (scp: string[], jti = 'grnt_docs') => new jose.SignJWT({ scp, aud: 'https://mcp.acme.example.com/mcp', sub: 'client-a' })
      .setProtectedHeader({ alg: 'ES256', kid: 'docs' })
      .setIssuer(issuer)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const call = async (name: string, authorization?: string) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } }),
      });
      return { status: response.status, challenge: response.headers.get('www-authenticate'), body: await response.json() as Record<string, unknown> };
    };

    it('serves protected-resource metadata', async () => {
      const body = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(body).toMatchObject({ resource: 'https://mcp.acme.example.com/mcp', authorization_servers: ['https://auth.acme.example.com'] });
    });

    it('lets a granted tool through and refuses the rest at the server', async () => {
      const read = `Bearer ${await token(['tool:acme_kyb:read'])}`;
      expect((await call('verify_business', read)).status).toBe(200);
      const refused = await call('monitor_enroll', read);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ reason: 'tool_not_granted' });
      expect((await call('verify_business')).status).toBe(401);
      expect((await call('verify_business', `Bearer ${await token(['tool:acme_kyb:read'], 'grnt_revoked')}`)).status).toBe(401);
    });

    it('refuses a requires_decision tool with the decision_required challenge', async () => {
      const outcome = await call('case_decision', `Bearer ${await token(['tool:acme_kyb:write'])}`);
      expect(outcome.status).toBe(403);
      expect(outcome.challenge).toContain('decision_required="acme_kyb:case_decision"');
    });
  });
});
