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
  used_at: null,
  rotated_to_token_id: null,
  replay_expires_at: null,
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
    // INSERT refresh_tokens (new)
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE refresh_tokens SET is_used = true + rotation replay metadata
    sqlMock.mockResolvedValueOnce([{ id: 'ref_EXISTING' }]);
    // INSERT grant_tokens
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

    const consumeCall = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(' ').includes('replay_expires_at = LEAST')
    );
    expect(consumeCall).toContain(300);

    // Verify JWT claims
    const claims = decodeJwt(body.grantToken);
    expect(claims.sub).toBe('user_123');
    expect(claims['agt']).toBe(TEST_AGENT.did);
    expect(claims['dev']).toBe(TEST_DEVELOPER.id);
    expect(claims['scp']).toEqual(['read', 'write']);
    expect(claims['grnt']).toBe('grnt_EXISTING');
  });

  it('preserves audience, budget, and delegation constraints on refresh', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      audience: 'https://resource.example',
      remaining_budget: '42.50',
      parent_grant_id: 'grnt_PARENT',
      parent_agent_did: 'did:grantex:ag_PARENT',
      delegation_depth: 2,
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'ref_EXISTING' }]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
    const claims = decodeJwt(res.json<{ grantToken: string }>().grantToken);
    expect(claims.aud).toBe('https://resource.example');
    expect(claims['bdg']).toBe(42.5);
    expect(claims['parentGrnt']).toBe('grnt_PARENT');
    expect(claims['parentAgt']).toBe('did:grantex:ag_PARENT');
    expect(claims['delegationDepth']).toBe(2);
  });

  it('returns 400 when the refresh token was consumed concurrently', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validRefreshRow]);
    // INSERT refresh_tokens (new) succeeds inside the transaction but rolls
    // back when the guarded consume UPDATE below observes concurrent use.
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE refresh_tokens SET is_used = true ... RETURNING id
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Refresh token already used');
  });

  it('recovers a lost refresh response by replaying the already-rotated refresh token inside the replay window', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      is_used: true,
      used_at: new Date(Date.now() - 5_000).toISOString(),
      rotated_to_token_id: 'ref_ROTATED',
      replay_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);
    // SELECT rotated child refresh token
    sqlMock.mockResolvedValueOnce([{
      id: 'ref_ROTATED',
      grant_id: 'grnt_EXISTING',
      is_used: false,
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    }]);
    // INSERT grant_tokens for the fresh replayed access JWT
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

    expect(body.refreshToken).toBe('ref_ROTATED');
    expect(body.grantId).toBe('grnt_EXISTING');
    expect(body.scopes).toEqual(['read', 'write']);
    const claims = decodeJwt(body.grantToken);
    expect(claims['grnt']).toBe('grnt_EXISTING');

    const sqlText = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(sqlText).toContain('FROM refresh_tokens');
    expect(sqlText).toContain('WHERE id = ');
    expect(sqlText).not.toContain('rotated_to_token_id =');
  });

  it('rejects a used refresh token after the replay window expires', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      is_used: true,
      used_at: new Date(Date.now() - 180_000).toISOString(),
      rotated_to_token_id: 'ref_ROTATED',
      replay_expires_at: new Date(Date.now() - 1_000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Refresh token already used');
  });

  it('rejects replay recovery once the rotated child refresh token was used', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      is_used: true,
      used_at: new Date(Date.now() - 5_000).toISOString(),
      rotated_to_token_id: 'ref_ROTATED',
      replay_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'ref_ROTATED',
      grant_id: 'grnt_EXISTING',
      is_used: true,
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Refresh token already used');
  });

  it('does not recover a used refresh token if the grant was revoked after rotation', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      is_used: true,
      grant_status: 'revoked',
      used_at: new Date(Date.now() - 5_000).toISOString(),
      rotated_to_token_id: 'ref_ROTATED',
      replay_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Grant has been revoked');
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

  it('returns 400 when the underlying grant has expired', async () => {
    seedAuth();
    // Refresh token itself is fresh, but grant_expires_at is in the past
    sqlMock.mockResolvedValueOnce([{
      ...validRefreshRow,
      grant_expires_at: new Date(Date.now() - 1000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_GRANTEXPIRED', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Grant has expired');
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
