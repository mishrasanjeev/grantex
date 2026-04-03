import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as jose from 'jose';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryClientStore } from '../src/lib/clients.js';
import type { McpAuthConfig } from '../src/types.js';

const TEST_CLIENT_ID = 'test-client-id';
const TEST_CLIENT_SECRET = 'test-secret';

// Generate an RSA key pair for signing test JWTs
let rsaPrivateKey: jose.KeyLike;
let rsaPublicJwk: jose.JWK;
let jwksServer: Server;
let jwksPort: number;

beforeAll(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  rsaPrivateKey = privateKey;
  rsaPublicJwk = await jose.exportJWK(publicKey);
  rsaPublicJwk.kid = 'test-key-1';
  rsaPublicJwk.alg = 'RS256';
  rsaPublicJwk.use = 'sig';

  // Start a local JWKS server
  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [rsaPublicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    jwksServer.listen(0, '127.0.0.1', () => {
      const addr = jwksServer.address();
      if (typeof addr === 'object' && addr) {
        jwksPort = addr.port;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((err) => (err ? reject(err) : resolve()));
  });
});

function createMockGrantex() {
  return {
    authorize: vi.fn().mockResolvedValue({
      authRequestId: 'auth-req-1',
      consentUrl: 'https://example.com/consent',
      agentId: 'agent-1',
      principalId: 'principal-1',
      scopes: ['read', 'write'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }),
    tokens: {
      exchange: vi.fn().mockResolvedValue({
        grantToken: 'gt_test',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test',
        grantId: 'grant-1',
      }),
      refresh: vi.fn().mockResolvedValue({
        grantToken: 'gt_refreshed',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new',
        grantId: 'grant-1',
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function createTestApp() {
  const clientStore = new InMemoryClientStore();
  await clientStore.set(TEST_CLIENT_ID, {
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
    redirectUris: ['https://app.example.com/callback'],
    grantTypes: ['authorization_code'],
    createdAt: new Date().toISOString(),
  });

  const mockGrantex = createMockGrantex();
  const issuer = `http://127.0.0.1:${jwksPort}`;

  const app = await createMcpAuthServer({
    grantex: mockGrantex as unknown as McpAuthConfig['grantex'],
    agentId: 'agent-1',
    scopes: ['read', 'write'],
    issuer,
    clientStore,
  });

  return { app, mockGrantex, clientStore, issuer };
}

async function signTestJwt(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string; algorithm?: string },
): Promise<string> {
  const alg = options?.algorithm ?? 'RS256';
  const builder = new jose.SignJWT(claims)
    .setProtectedHeader({ alg, kid: 'test-key-1' })
    .setIssuedAt()
    .setJti('grnt_01HXYZ');

  if (options?.expiresIn) {
    builder.setExpirationTime(options.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(rsaPrivateKey);
}

describe('introspect endpoint', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
  });

  it('returns active=true with all claims for valid token', async () => {
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['calendar:read', 'email:send'],
      agt: 'did:grantex:ag_01HXYZ',
      dev: 'mcp_client_01HABC',
      grnt: 'grnt_01HXYZ',
      delegationDepth: 0,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(true);
    expect(body.scope).toBe('calendar:read email:send');
    expect(body.sub).toBe('user_abc');
    expect(body.jti).toBe('grnt_01HXYZ');
    expect(body.token_type).toBe('bearer');
    expect(typeof body.exp).toBe('number');
    expect(typeof body.iat).toBe('number');
  });

  it('returns active=false for expired token', async () => {
    const token = await signTestJwt(
      { sub: 'user_abc', scp: ['read'] },
      { expiresIn: '-1h' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(false);
  });

  it('returns active=false for malformed token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token: 'not.a.valid.jwt' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(false);
  });

  it('returns grantex extension claims (agent_did, delegation_depth)', async () => {
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['read'],
      agt: 'did:grantex:ag_01HXYZ',
      delegationDepth: 2,
      parentAgt: 'did:grantex:ag_parent',
      bdg: 5000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token },
    });

    const body = response.json();
    expect(body.active).toBe(true);
    expect(body.grantex_agent_did).toBe('did:grantex:ag_01HXYZ');
    expect(body.grantex_delegation_depth).toBe(2);
    expect(body.grantex_parent_agent).toBe('did:grantex:ag_parent');
    expect(body.grantex_budget_remaining).toBe(5000);
  });

  it('authenticates client via Basic auth', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        authorization: `Basic ${basicCreds}`,
      },
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(true);
  });

  it('rejects invalid Basic auth credentials', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:wrong-secret`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        authorization: `Basic ${basicCreds}`,
      },
      payload: { token },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBe('invalid_client');
  });

  it('returns 400 when token parameter is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
  });

  it('defaults delegation_depth to 0 when not in claims', async () => {
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['read'],
      agt: 'did:grantex:ag_01HXYZ',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token },
    });

    const body = response.json();
    expect(body.active).toBe(true);
    expect(body.grantex_delegation_depth).toBe(0);
  });
});
