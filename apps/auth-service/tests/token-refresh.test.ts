import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const validRefreshRow = {
  refresh_id: 'ref_EXISTING',
  grant_id: 'grnt_EXISTING',
  is_used: false,
  refresh_expires_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
  agent_id: TEST_AGENT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read', 'write'],
  grant_status: 'active',
  grant_expires_at: new Date(Date.now() + 86400_000).toISOString(),
  agent_did: TEST_AGENT.did,
};

describe('POST /v1/token/refresh', () => {
  it('refreshes a valid token and returns new grant token with same grantId', async () => {
    seedAuth();
    // Refresh token lookup (JOIN grants + agents)
    sqlMock.mockResolvedValueOnce([validRefreshRow]);
    // UPDATE refresh_tokens SET is_used = true
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens (new)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      refreshToken: string;
      grantId: string;
    }>();

    expect(typeof body.grantToken).toBe('string');
    expect(body.grantId).toBe('grnt_EXISTING');
    expect(body.scopes).toEqual(['read', 'write']);
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken).not.toBe('ref_EXISTING'); // rotated

    // Verify JWT claims
    const claims = decodeJwt(body.grantToken);
    expect(claims.sub).toBe('user_123');
    expect(claims['agt']).toBe(TEST_AGENT.did);
    expect(claims['dev']).toBe(TEST_DEVELOPER.id);
    expect(claims['scp']).toEqual(['read', 'write']);
    expect(claims['grnt']).toBe('grnt_EXISTING');
  });

  it('returns 400 for already-used refresh token', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validRefreshRow, is_used: true }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_USED', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Refresh token already used');
  });

  it('returns 400 for expired refresh token', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      refresh_expires_at: new Date(Date.now() - 1000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXPIRED', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Refresh token expired');
  });

  it('returns 400 when grant has been revoked', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validRefreshRow, grant_status: 'revoked' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_REVOKED', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Grant has been revoked');
  });

  it('returns 400 when agent does not match', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validRefreshRow, agent_id: 'ag_DIFFERENT' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_MISMATCH', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Agent mismatch');
  });

  it('returns 400 for invalid (not found) refresh token', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_NONEXISTENT', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Invalid refresh token');
  });

  it('returns 400 when required fields missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_123' }, // missing agentId
    });

    expect(res.statusCode).toBe(400);
  });
});
