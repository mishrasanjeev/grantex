import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import * as jose from 'jose';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryClientStore } from '../src/lib/clients.js';
import type { McpAuthConfig } from '../src/types.js';

const TEST_CLIENT_ID = 'test-client-id';
const TEST_CLIENT_SECRET = 'test-secret';
const TEST_REDIRECT_URI = 'https://app.example.com/callback';
const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const TEST_CHALLENGE = createHash('sha256').update(TEST_VERIFIER).digest('base64url');

let rsaPrivateKey: jose.KeyLike;
let rsaPublicJwk: jose.JWK;
let hmacSecret: Uint8Array;
let jwksServer: Server;
let jwksPort: number;

beforeAll(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  rsaPrivateKey = privateKey;
  rsaPublicJwk = await jose.exportJWK(publicKey);
  rsaPublicJwk.kid = 'test-key-1';
  rsaPublicJwk.alg = 'RS256';
  rsaPublicJwk.use = 'sig';

  hmacSecret = new TextEncoder().encode(
    'super-secret-key-for-hs256-testing-that-is-long-enough',
  );

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
    redirectUris: [TEST_REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
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

  return { app, mockGrantex, clientStore };
}

describe('OAuth 2.1 security', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
  });

  it('rejects implicit grant flow (response_type=token)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'token',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('unsupported_response_type');
  });

  it('rejects password grant flow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'password',
        username: 'user',
        password: 'pass',
        client_id: TEST_CLIENT_ID,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('rejects client_credentials without explicit allowance', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('HS256 token rejected in introspect (only RS256 accepted)', async () => {
    // Sign a token with HS256
    const hs256Token = await new jose.SignJWT({
      sub: 'user_abc',
      scp: ['read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setJti('grnt_hs256')
      .setExpirationTime('1h')
      .sign(hmacSecret);

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token: hs256Token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(false);
  });

  it('PKCE is required (no code_challenge => 400)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('PKCE');
  });

  it('state parameter is passed through when present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
        state: 'csrf-protection-state',
      },
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    const url = new URL(location);
    expect(url.searchParams.get('state')).toBe('csrf-protection-state');
  });

  it('only S256 code_challenge_method accepted (not plain)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'plain',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('S256');
  });

  it('RS256 token is accepted in introspect', async () => {
    const token = await new jose.SignJWT({
      sub: 'user_abc',
      scp: ['read'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setJti('grnt_rs256')
      .setExpirationTime('1h')
      .sign(rsaPrivateKey);

    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active).toBe(true);
  });

  it('authorization code is single-use (replayed code rejected)', async () => {
    // First, get an authorization code
    const authResponse = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });

    const location = authResponse.headers['location'] as string;
    const code = new URL(location).searchParams.get('code')!;

    // Exchange the code
    const firstExchange = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: TEST_VERIFIER,
      },
    });

    expect(firstExchange.statusCode).toBe(200);

    // Try to use the same code again
    const secondExchange = await app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: TEST_VERIFIER,
      },
    });

    expect(secondExchange.statusCode).toBe(400);
    const body = secondExchange.json();
    expect(body.error).toBe('invalid_grant');
  });
});
