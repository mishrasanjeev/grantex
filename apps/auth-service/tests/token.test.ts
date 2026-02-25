import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const validAuthRequest = {
  id: 'areq_TEST',
  agent_id: TEST_AGENT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read', 'write'],
  expires_in: '24h',
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  status: 'approved',
  agent_did: TEST_AGENT.did,
};

describe('POST /v1/token', () => {
  it('exchanges a valid code for a signed JWT', async () => {
    seedAuth();
    // Auth request lookup
    sqlMock.mockResolvedValueOnce([validAuthRequest]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE auth_requests status=consumed
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'valid-code-123', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      refreshToken: string;
      grantId: string;
    }>();

    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(86400);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(typeof body.grantId).toBe('string');

    // Verify JWT structure
    const claims = decodeJwt(body.accessToken);
    expect(claims.sub).toBe('user_123');
    expect(claims['agt']).toBe(TEST_AGENT.did);
    expect(claims['dev']).toBe(TEST_DEVELOPER.id);
    expect(claims['scp']).toEqual(['read', 'write']);
    expect(claims['gid']).toBeDefined();
  });

  it('returns 400 for invalid (not found) code', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'bad-code', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when auth request not approved', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validAuthRequest, status: 'pending' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when auth request is expired', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validAuthRequest,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required fields missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123' }, // missing agentId
    });

    expect(res.statusCode).toBe(400);
  });
});
