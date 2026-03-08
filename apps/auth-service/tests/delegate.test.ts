import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { signGrantToken, initKeys } from '../src/lib/crypto.js';
import { decodeJwt } from 'jose';

let app: FastifyInstance;
let parentToken: string;

const SUB_AGENT = {
  id: 'ag_SUBAGENT01',
  did: 'did:grantex:ag_SUBAGENT01',
  developer_id: TEST_DEVELOPER.id,
  name: 'Sub Agent',
  description: 'A sub agent',
  scopes: ['read'],
  status: 'active',
};

beforeAll(async () => {
  app = await buildTestApp();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  parentToken = await signGrantToken({
    sub: 'user_123',
    agt: TEST_AGENT.did,
    dev: TEST_DEVELOPER.id,
    scp: ['read', 'write'],
    jti: 'tok_PARENT01',
    grnt: 'grnt_PARENT01',
    exp,
  });
});

describe('POST /v1/grants/delegate', () => {
  it('creates a delegated grant token for a sub-agent', async () => {
    seedAuth();
    // Redis: parent token not revoked
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
        expiresIn: '1h',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      grantId: string;
    }>();
    expect(typeof body.grantToken).toBe('string');
    expect(body.scopes).toEqual(['read']);
    expect(typeof body.grantId).toBe('string');

    // Verify delegation claims
    const claims = decodeJwt(body.grantToken);
    expect(claims['agt']).toBe(SUB_AGENT.did);
    expect(claims['parentAgt']).toBe(TEST_AGENT.did);
    expect(claims['parentGrnt']).toBe('grnt_PARENT01');
    expect(claims['delegationDepth']).toBe(1);
  });

  it('returns 400 when requested scopes exceed parent scopes', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['admin'],  // not in parent's scp
        expiresIn: '1h',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string }>();
    expect(body.message).toMatch(/exceed parent/);
  });

  it('returns 400 when parent grant is revoked in Redis', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValueOnce('1'); // parent token revoked

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string }>();
    expect(body.message).toMatch(/revoked/);
  });

  it('returns 404 when sub-agent is not found', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_NONEXISTENT',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when parentGrantToken is not a valid JWT', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: 'not-a-valid-jwt',
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string; code: string }>();
    expect(body.message).toBe('Invalid parentGrantToken');
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when parentGrantToken is missing required claims (jti)', async () => {
    seedAuth();

    // Create a JWT without jti (and without grnt, scp, exp)
    const { SignJWT: JoseSignJWT } = await import('jose');
    const { getKeyPair } = await import('../src/lib/crypto.js');
    const { privateKey } = getKeyPair();
    const invalidToken = await new JoseSignJWT({ sub: 'user_123', agt: 'did:test:agent' })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(privateKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: invalidToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string; code: string }>();
    expect(body.message).toBe('Invalid parentGrantToken claims');
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: { subAgentId: SUB_AGENT.id }, // missing parentGrantToken + scopes
    });

    expect(res.statusCode).toBe(400);
  });

  it('includes verifiableCredential when credentialFormat is vc-jwt', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);
    // VC issuance: SELECT vc_status_lists (existing list)
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_TEST', next_index: 0 }]);
    // VC issuance: UPDATE vc_status_lists next_index
    sqlMock.mockResolvedValueOnce([]);
    // VC issuance: INSERT verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
        expiresIn: '1h',
        credentialFormat: 'vc-jwt',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      grantId: string;
      verifiableCredential: string;
    }>();
    expect(typeof body.grantToken).toBe('string');
    expect(body.scopes).toEqual(['read']);
    expect(typeof body.grantId).toBe('string');
    expect(typeof body.verifiableCredential).toBe('string');

    // Verify the VC-JWT is a valid JWT with vc claim
    const vcClaims = decodeJwt(body.verifiableCredential);
    expect(vcClaims['vc']).toBeDefined();
    const vc = vcClaims['vc'] as Record<string, unknown>;
    expect((vc['type'] as string[])).toContain('AgentGrantCredential');
    const subject = vc['credentialSubject'] as Record<string, unknown>;
    expect(subject['id']).toBe(SUB_AGENT.did);
    expect(subject['scopes']).toEqual(['read']);
  });

  it('includes verifiableCredential when credentialFormat is both', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);
    // VC issuance: SELECT vc_status_lists (existing list)
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_TEST', next_index: 0 }]);
    // VC issuance: UPDATE vc_status_lists next_index
    sqlMock.mockResolvedValueOnce([]);
    // VC issuance: INSERT verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
        expiresIn: '1h',
        credentialFormat: 'both',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      grantId: string;
      verifiableCredential: string;
    }>();
    expect(typeof body.grantToken).toBe('string');
    expect(typeof body.verifiableCredential).toBe('string');

    // Both the grant JWT and the VC-JWT should be present and different
    expect(body.grantToken).not.toBe(body.verifiableCredential);

    // Verify grant JWT has delegation claims
    const grantClaims = decodeJwt(body.grantToken);
    expect(grantClaims['delegationDepth']).toBe(1);

    // Verify VC-JWT has vc claim
    const vcClaims = decodeJwt(body.verifiableCredential);
    expect(vcClaims['vc']).toBeDefined();
  });

  it('succeeds without verifiableCredential when VC issuance fails (best-effort)', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);
    // VC issuance: SELECT vc_status_lists — reject to simulate DB failure
    sqlMock.mockRejectedValueOnce(new Error('status list query failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
        expiresIn: '1h',
        credentialFormat: 'vc-jwt',
      },
    });

    // Delegation should still succeed
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      grantId: string;
      verifiableCredential?: string;
    }>();
    expect(typeof body.grantToken).toBe('string');
    expect(body.scopes).toEqual(['read']);
    expect(typeof body.grantId).toBe('string');
    // verifiableCredential should NOT be present since VC issuance failed
    expect(body.verifiableCredential).toBeUndefined();
  });
});
