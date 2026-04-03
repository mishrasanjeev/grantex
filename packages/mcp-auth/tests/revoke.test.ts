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

async function signTestJwt(
  claims: Record<string, unknown>,
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setJti('grnt_revoke_test')
    .setExpirationTime('1h')
    .sign(rsaPrivateKey);
}

describe('revoke endpoint', () => {
  let app: FastifyInstance;
  let mockGrantex: ReturnType<typeof createMockGrantex>;
  let onRevocationHook: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const clientStore = new InMemoryClientStore();
    await clientStore.set(TEST_CLIENT_ID, {
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      redirectUris: ['https://app.example.com/callback'],
      grantTypes: ['authorization_code'],
      createdAt: new Date().toISOString(),
    });

    mockGrantex = createMockGrantex();
    onRevocationHook = vi.fn().mockResolvedValue(undefined);
    const issuer = `http://127.0.0.1:${jwksPort}`;

    app = await createMcpAuthServer({
      grantex: mockGrantex as unknown as McpAuthConfig['grantex'],
      agentId: 'agent-1',
      scopes: ['read', 'write'],
      issuer,
      clientStore,
      hooks: {
        onRevocation: onRevocationHook as (jti: string) => Promise<void>,
      },
    });
  });

  it('revokes a valid token and returns 200', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { authorization: `Basic ${basicCreds}` },
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    expect(mockGrantex.tokens.revoke).toHaveBeenCalledWith('grnt_revoke_test');
  });

  it('returns 200 even when token is already revoked (RFC 7009)', async () => {
    mockGrantex.tokens.revoke.mockRejectedValueOnce(
      new Error('Token already revoked'),
    );

    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { authorization: `Basic ${basicCreds}` },
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
  });

  it('calls hooks.onRevocation with the JTI', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    await app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { authorization: `Basic ${basicCreds}` },
      payload: { token },
    });

    expect(onRevocationHook).toHaveBeenCalledWith('grnt_revoke_test');
  });

  it('rejects unauthenticated request', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: { token },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBe('invalid_client');
  });

  it('authenticates via client_id in body', async () => {
    const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: {
        token,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 400 when token is missing', async () => {
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { authorization: `Basic ${basicCreds}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 200 for non-decodable token (per RFC 7009)', async () => {
    const basicCreds = Buffer.from(
      `${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { authorization: `Basic ${basicCreds}` },
      payload: { token: 'garbage-token-value' },
    });

    expect(response.statusCode).toBe(200);
  });
});
