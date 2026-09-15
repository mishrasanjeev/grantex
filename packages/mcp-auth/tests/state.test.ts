import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as jose from 'jose';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage/memory.js';
import type { McpAuthStorage } from '../src/storage/types.js';
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
} from './helpers.js';

let privateKey: jose.CryptoKey;
let jwksServer: Server;
let grantexIssuer: string;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  grantexIssuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

async function grantToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new jose.SignJWT({ scp: ['read'], aud: TEST_RESOURCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(grantexIssuer)
    .setSubject(TEST_CLIENT_ID)
    .setIssuedAt()
    .setJti(`grnt_${Math.random().toString(36).slice(2)}`)
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function serverWith(storage: McpAuthStorage, grantex = mockGrantex({ sandboxCode: 'UPSTREAM_CODE' })) {
  const app = await createMcpAuthServer({
    grantex: asGrantex(grantex),
    agentId: 'agent-1',
    scopes: ['read', 'write'],
    issuer: 'https://auth.example.com',
    resource: TEST_RESOURCE,
    grantexIssuer,
    storage,
    sandboxAutoApprove: true,
  });
  return { app, grantex };
}

async function issueCode(app: Awaited<ReturnType<typeof serverWith>>['app']): Promise<string> {
  const response = await authorizeWithConsent(app, {
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
  expect(response.statusCode).toBe(303);
  return new URL(response.headers['location'] as string).searchParams.get('code')!;
}

function redeem(app: Awaited<ReturnType<typeof serverWith>>['app'], code: string) {
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
    },
  });
}

describe('state goes through the configured storage', () => {
  it('registration stores only a hash of the client secret', async () => {
    const storage = new InMemoryStorage();
    const { app } = await serverWith(storage);
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { redirect_uris: [TEST_REDIRECT_URI] },
    });
    expect(response.statusCode).toBe(201);
    const { client_id, client_secret } = response.json() as { client_id: string; client_secret: string };
    const stored = await storage.getClient(client_id);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(client_secret);
    expect(stored?.clientSecretHash).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it('a code issued by one server instance is redeemed by another sharing the storage', async () => {
    const storage = await seededStorage(clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }));
    const first = await serverWith(storage);
    const code = await issueCode(first.app);
    await first.app.close();

    const second = await serverWith(storage);
    const token = await redeem(second.app, code);
    expect(token.statusCode).toBe(200);
    expect(second.grantex.tokens.exchange).toHaveBeenCalledTimes(1);
  });

  it('single use at the HTTP layer: 20 concurrent redemptions of one code, exactly one token', async () => {
    const storage = await seededStorage(clientRecord());
    const { app, grantex } = await serverWith(storage);
    const code = await issueCode(app);
    const responses = await Promise.all(Array.from({ length: 20 }, () => redeem(app, code)));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(19);
    expect(grantex.tokens.exchange).toHaveBeenCalledTimes(1);
  });

  it('two concurrent refreshes of one token: exactly one reaches Grantex', async () => {
    const storage = await seededStorage(clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }));
    const { app, grantex } = await serverWith(storage);
    expect((await redeem(app, await issueCode(app))).statusCode).toBe(200);

    const refresh = () => app.inject({
      method: 'POST',
      url: '/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: 'rt_test_refresh',
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      },
    });
    const responses = await Promise.all([refresh(), refresh(), refresh()]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(grantex.tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it('an upstream refresh failure keeps the refresh token usable', async () => {
    const storage = await seededStorage(clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }));
    const { app, grantex } = await serverWith(storage);
    expect((await redeem(app, await issueCode(app))).statusCode).toBe(200);
    grantex.tokens.refresh.mockRejectedValueOnce(new Error('upstream unavailable'));

    const payload = {
      grant_type: 'refresh_token',
      refresh_token: 'rt_test_refresh',
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
    };
    expect((await app.inject({ method: 'POST', url: '/token', payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/token', payload })).statusCode).toBe(200);
  });

  it('a storage failure refuses the request instead of issuing a token', async () => {
    const storage = await seededStorage(clientRecord());
    const { app, grantex } = await serverWith(storage);
    const code = await issueCode(app);
    storage.consumeAuthorizationCode = async () => {
      throw new Error('storage unavailable');
    };
    const response = await redeem(app, code);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('gt_test_token');
    expect(grantex.tokens.exchange).not.toHaveBeenCalled();
  });

  it('a revoked token is inactive at /introspect even though its signature is valid', async () => {
    const storage = await seededStorage(clientRecord());
    const { app } = await serverWith(storage);
    const token = await grantToken();

    const before = await app.inject({ method: 'POST', url: '/introspect', payload: { token } });
    expect(before.json()).toMatchObject({ active: true });

    const revoke = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: { token, client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET },
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({ method: 'POST', url: '/introspect', payload: { token } });
    expect(after.json()).toEqual({ active: false });
  });

  it('a revocation is recorded even when the upstream revoke call fails', async () => {
    const storage = await seededStorage(clientRecord());
    const grantex = mockGrantex();
    grantex.tokens.revoke.mockRejectedValueOnce(new Error('upstream unavailable'));
    const { app } = await serverWith(storage, grantex);
    const token = await grantToken();
    const { jti } = jose.decodeJwt(token);

    const revoke = await app.inject({
      method: 'POST',
      url: '/revoke',
      payload: { token, client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET },
    });
    expect(revoke.statusCode).toBe(200);
    expect(await storage.isTokenRevoked(jti!)).toBe(true);
  });

  it('a token without a jti is never reported active (it could not be revoked)', async () => {
    const storage = await seededStorage(clientRecord());
    const { app } = await serverWith(storage);
    const token = await new jose.SignJWT({ scp: ['read'], aud: TEST_RESOURCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(grantexIssuer)
      .setSubject(TEST_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const response = await app.inject({ method: 'POST', url: '/introspect', payload: { token } });
    expect(response.json()).toEqual({ active: false });
  });

  it('a confidential client record without a secret hash fails closed', async () => {
    const { clientSecretHash: _dropped, ...broken } = clientRecord();
    const storage = await seededStorage(broken);
    const { app } = await serverWith(storage);
    const code = await issueCode(app);
    const response = await app.inject({
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
    expect(response.statusCode).toBe(401);
  });
});
