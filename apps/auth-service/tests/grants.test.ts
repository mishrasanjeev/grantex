import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_GRANT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /v1/grants', () => {
  it('returns list of grants', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grants: Array<{ grantId: string }> }>();
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]!.grantId).toBe(TEST_GRANT.id);
  });

  it('returns empty list when no grants', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grants: unknown[] }>();
    expect(body.grants).toHaveLength(0);
  });
});

describe('GET /v1/grants/:id', () => {
  it('returns grant by id', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/grants/${TEST_GRANT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grantId: string; status: string }>();
    expect(body.grantId).toBe(TEST_GRANT.id);
    expect(body.status).toBe('active');
  });

  it('returns 404 for unknown grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants/nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/grants/:id (revoke)', () => {
  it('revokes grant and sets Redis key', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);
    // Cascade revocation — no descendants
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/grants/${TEST_GRANT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
    expect(mockRedis.set).toHaveBeenCalledWith(
      `revoked:grant:${TEST_GRANT.id}`,
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('returns 404 when grant not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/grants/nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/grants/verify', () => {
  it('returns active:false for revoked token (Redis hit)', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValueOnce('1'); // token revoked in Redis

    // Mock jwt decode — need a valid JWT format (3 base64 parts)
    // Use a real token for this test
    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_revoked',
      grnt: TEST_GRANT.id,
      exp,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; reason?: string }>();
    expect(body.active).toBe(false);
  });

  it('returns active:true for valid token', async () => {
    seedAuth();
    // Redis returns null (not revoked)
    mockRedis.get.mockResolvedValue(null);

    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_valid',
      grnt: TEST_GRANT.id,
      exp,
    });

    // DB check: token exists, not revoked, grant active
    sqlMock.mockResolvedValueOnce([{
      is_revoked: false,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean }>();
    expect(body.active).toBe(true);
  });
});
