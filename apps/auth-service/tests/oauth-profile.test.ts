import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessTokenHash, verifyDpopProof } from '../src/lib/dpop.js';
import { signOAuthAccessToken } from '../src/lib/crypto.js';
import { buildTestApp, mockRedis, sqlMock } from './helpers.js';

interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  thumbprint: string;
}

let app: FastifyInstance;
let dpopKey: DpopKey;

async function createDpopKey(): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, 'sha256'),
  };
}

async function dpopProof(options: {
  method: string;
  uri: string;
  key?: DpopKey;
  accessToken?: string;
  jti?: string;
  issuedAt?: number;
}): Promise<string> {
  const key = options.key ?? dpopKey;
  return new SignJWT({
    htm: options.method.toUpperCase(),
    htu: options.uri,
    jti: options.jti ?? randomUUID(),
    iat: options.issuedAt ?? Math.floor(Date.now() / 1000),
    ...(options.accessToken ? { ath: accessTokenHash(options.accessToken) } : {}),
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    .sign(key.privateKey);
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

beforeAll(async () => {
  dpopKey = await createDpopKey();
  app = await buildTestApp();
});

beforeEach(() => {
  mockRedis.set.mockResolvedValue('OK');
});

describe('DPoP proof verification', () => {
  it('validates method, URI, freshness, signature, and access-token hash', async () => {
    const token = 'header.payload.signature';
    const proof = await dpopProof({
      method: 'GET',
      uri: 'https://grantex.dev/oauth/resource',
      accessToken: token,
    });

    const result = await verifyDpopProof(proof, {
      method: 'GET',
      targetUri: 'https://grantex.dev/oauth/resource',
      accessToken: token,
    });

    expect(result.thumbprint).toBe(dpopKey.thumbprint);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining(`dpop:proof:${dpopKey.thumbprint}:`),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('rejects a replayed proof', async () => {
    const proof = await dpopProof({ method: 'POST', uri: 'https://grantex.dev/oauth/token' });
    mockRedis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await expect(verifyDpopProof(proof, {
      method: 'POST',
      targetUri: 'https://grantex.dev/oauth/token',
    })).resolves.toMatchObject({ thumbprint: dpopKey.thumbprint });
    await expect(verifyDpopProof(proof, {
      method: 'POST',
      targetUri: 'https://grantex.dev/oauth/token',
    })).rejects.toThrow('already been used');
  });

  it('rejects an incorrect access-token hash', async () => {
    const proof = await dpopProof({
      method: 'GET',
      uri: 'https://grantex.dev/oauth/resource',
      accessToken: 'first-token',
    });
    await expect(verifyDpopProof(proof, {
      method: 'GET',
      targetUri: 'https://grantex.dev/oauth/resource',
      accessToken: 'different-token',
    })).rejects.toThrow('access-token hash');
  });
});

describe('OAuth agent-grants profile routes', () => {
  it('marks token responses as non-cacheable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ grant_type: 'unsupported' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('rejects malformed OAuth scope spacing instead of normalizing it', async () => {
    for (const scope of [' grantex.resource.read', 'grantex.resource.read ', 'grantex.resource.read  payments.read']) {
      const res = await app.inject({
        method: 'POST',
        url: '/oauth/par',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({
          client_id: 'ag_oauth',
          response_type: 'code',
          redirect_uri: 'https://client.example/callback',
          scope,
          state: randomBytes(32).toString('base64url'),
          code_challenge: randomBytes(32).toString('base64url'),
          code_challenge_method: 'S256',
          resource: 'https://grantex.dev/oauth/resource',
          dpop_jkt: dpopKey.thumbprint,
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_scope' });
    }
  });

  it('accepts a registered, proof-bound pushed authorization request', async () => {
    sqlMock
      .mockResolvedValueOnce([{
        id: 'ag_oauth',
        developer_id: 'dev_oauth',
        scopes: ['grantex.resource.read', 'payments.read'],
        redirect_uris: ['https://client.example/callback'],
        resource_servers: ['https://grantex.dev/oauth/resource'],
        key_thumbprint: dpopKey.thumbprint,
        key_verified_thumbprint: null,
        status: 'active',
        mode: 'live',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const proof = await dpopProof({ method: 'POST', uri: 'https://grantex.dev/oauth/par' });
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/par',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        dpop: proof,
      },
      payload: form({
        client_id: 'ag_oauth',
        response_type: 'code',
        redirect_uri: 'https://client.example/callback',
        scope: 'grantex.resource.read payments.read',
        state: randomBytes(32).toString('base64url'),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://grantex.dev/oauth/resource',
        login_hint: 'principal_123',
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      request_uri: expect.stringMatching(/^urn:ietf:params:oauth:request_uri:/),
      expires_in: 90,
    });
    expect(sqlMock.mock.calls.map((call) => String(call[0])).join('\n')).toContain('INSERT INTO oauth_par_requests');
    expect(sqlMock.mock.calls.map((call) => String(call[0])).join('\n')).toContain('key_verified_thumbprint');
  });

  it('accepts dpop_jkt without a proof only after possession was verified', async () => {
    sqlMock
      .mockResolvedValueOnce([{
        id: 'ag_oauth',
        developer_id: 'dev_oauth',
        scopes: ['grantex.resource.read'],
        redirect_uris: ['https://client.example/callback'],
        resource_servers: ['https://grantex.dev/oauth/resource'],
        key_thumbprint: dpopKey.thumbprint,
        key_verified_thumbprint: dpopKey.thumbprint,
        status: 'active',
        mode: 'live',
      }])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/par',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        client_id: 'ag_oauth',
        response_type: 'code',
        redirect_uri: 'https://client.example/callback',
        scope: 'grantex.resource.read',
        state: randomBytes(32).toString('base64url'),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://grantex.dev/oauth/resource',
        login_hint: 'principal_123',
        dpop_jkt: dpopKey.thumbprint,
      }),
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects dpop_jkt when the registered key has no proof-of-possession record', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'ag_oauth',
      developer_id: 'dev_oauth',
      scopes: ['grantex.resource.read'],
      redirect_uris: ['https://client.example/callback'],
      resource_servers: ['https://grantex.dev/oauth/resource'],
      key_thumbprint: dpopKey.thumbprint,
      key_verified_thumbprint: null,
      status: 'active',
      mode: 'live',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/par',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        client_id: 'ag_oauth',
        response_type: 'code',
        redirect_uri: 'https://client.example/callback',
        scope: 'grantex.resource.read',
        state: randomBytes(32).toString('base64url'),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://grantex.dev/oauth/resource',
        login_hint: 'principal_123',
        dpop_jkt: dpopKey.thumbprint,
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_dpop_proof' });
  });

  it('rejects a PAR proof whose key is not registered for the client', async () => {
    const otherKey = await createDpopKey();
    sqlMock.mockResolvedValueOnce([{
      id: 'ag_oauth',
      developer_id: 'dev_oauth',
      scopes: ['grantex.resource.read'],
      redirect_uris: ['https://client.example/callback'],
      resource_servers: ['https://grantex.dev/oauth/resource'],
      key_thumbprint: dpopKey.thumbprint,
      status: 'active',
      mode: 'live',
    }]);
    const proof = await dpopProof({ method: 'POST', uri: 'https://grantex.dev/oauth/par', key: otherKey });
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/par',
      headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: proof },
      payload: form({
        client_id: 'ag_oauth',
        response_type: 'code',
        redirect_uri: 'https://client.example/callback',
        scope: 'grantex.resource.read',
        state: randomBytes(32).toString('base64url'),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://grantex.dev/oauth/resource',
        login_hint: 'principal_123',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_dpop_proof' });
  });

  it('rejects bearer presentation of a DPoP-bound token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/oauth/resource',
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('authorizes a resource request only after token, audience, scope, and DPoP validation', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signOAuthAccessToken({
      sub: 'principal_123',
      clientId: 'ag_oauth',
      scopes: ['grantex.resource.read'],
      jti: 'tok_oauth_resource',
      aud: 'https://grantex.dev/oauth/resource',
      cnf: { jkt: dpopKey.thumbprint },
      exp: now + 300,
    });
    sqlMock.mockResolvedValueOnce([{
      is_revoked: false,
      expires_at: new Date((now + 300) * 1000).toISOString(),
      grant_id: 'grnt_oauth_resource',
      grant_status: 'active',
    }]);
    const proof = await dpopProof({
      method: 'GET',
      uri: 'https://grantex.dev/oauth/resource',
      accessToken: token,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/oauth/resource',
      headers: { authorization: `DPoP ${token}`, dpop: proof },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subject: 'principal_123',
      client_id: 'ag_oauth',
      scope: 'grantex.resource.read',
      authorized: true,
    });
    expect(sqlMock.mock.calls.map((call) => String(call[0])).join('\n')).toContain('g.protocol =');
  });
});
