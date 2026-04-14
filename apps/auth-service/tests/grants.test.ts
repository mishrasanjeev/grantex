import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_GRANT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('auth plugin — invalid API key', () => {
  it('returns 401 with UNAUTHORIZED when API key is not found in DB', async () => {
    // Do NOT seed auth — sqlMock returns empty array (no matching developer)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants',
      headers: { authorization: 'Bearer invalid-api-key-that-does-not-exist' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
    expect(res.json().message).toBe('Invalid API key');
  });
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

  it('includes parentGrantId when present', async () => {
    seedAuth();
    const delegatedGrant = {
      ...TEST_GRANT,
      id: 'grnt_CHILD',
      parent_grant_id: 'grnt_PARENT',
      delegation_depth: 1,
    };
    sqlMock.mockResolvedValueOnce([delegatedGrant]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants/grnt_CHILD',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.parentGrantId).toBe('grnt_PARENT');
    expect(body.delegationDepth).toBe(1);
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

  it('cascade-revokes descendants and sets Redis keys for each', async () => {
    seedAuth();
    // Parent grant revoked
    sqlMock.mockResolvedValueOnce([{
      ...TEST_GRANT,
      id: 'grnt_PARENT',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    }]);
    // Descendant grants returned by recursive CTE
    sqlMock.mockResolvedValueOnce([
      { id: 'grnt_CHILD1', expires_at: new Date(Date.now() + 86400_000).toISOString() },
      { id: 'grnt_CHILD2', expires_at: new Date(Date.now() + 86400_000).toISOString() },
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/grants/grnt_PARENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);

    // Parent grant Redis key
    expect(mockRedis.set).toHaveBeenCalledWith(
      'revoked:grant:grnt_PARENT',
      '1',
      'EX',
      expect.any(Number),
    );
    // Descendant Redis keys
    expect(mockRedis.set).toHaveBeenCalledWith(
      'revoked:grant:grnt_CHILD1',
      '1',
      'EX',
      expect.any(Number),
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      'revoked:grant:grnt_CHILD2',
      '1',
      'EX',
      expect.any(Number),
    );
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
    const body = res.json<{ active: boolean; claims?: { iat?: number; jti?: string } }>();
    expect(body.active).toBe(true);
    expect(typeof body.claims?.iat).toBe('number');
    expect(body.claims?.jti).toBe('tok_valid');
  });

  it('returns active:false when the token belongs to a different developer', async () => {
    seedAuth();
    const { signGrantToken } = await import('../src/lib/crypto.js');
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: 'dev_OTHER',
      scp: TEST_GRANT.scopes,
      jti: 'tok_other_dev',
      grnt: TEST_GRANT.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
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
    expect(body.reason).toBe('wrong_developer');
  });

  it('returns active:false reason not_found when token not in DB', async () => {
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
      jti: 'tok_missing',
      grnt: TEST_GRANT.id,
      exp,
    });

    // DB check: no row found
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; reason: string }>();
    expect(body.active).toBe(false);
    expect(body.reason).toBe('not_found');
  });

  it('returns active:false reason revoked when DB shows token revoked', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_db_revoked',
      grnt: TEST_GRANT.id,
      exp,
    });

    // DB shows token is revoked
    sqlMock.mockResolvedValueOnce([{
      is_revoked: true,
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
    const body = res.json<{ active: boolean; reason: string }>();
    expect(body.active).toBe(false);
    expect(body.reason).toBe('revoked');
  });

  it('returns active:false reason revoked when grant is not active in DB', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_inactive_grant',
      grnt: TEST_GRANT.id,
      exp,
    });

    // DB shows grant status is revoked
    sqlMock.mockResolvedValueOnce([{
      is_revoked: false,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      grant_status: 'revoked',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; reason: string }>();
    expect(body.active).toBe(false);
    expect(body.reason).toBe('revoked');
  });

  it('returns active:false reason expired when token has expired in DB', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_expired_db',
      grnt: TEST_GRANT.id,
      exp,
    });

    // DB shows token is expired (past date)
    sqlMock.mockResolvedValueOnce([{
      is_revoked: false,
      expires_at: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; reason: string }>();
    expect(body.active).toBe(false);
    expect(body.reason).toBe('expired');
  });

  it('returns 400 for missing token', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid JWT format', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token: 'not-a-valid-jwt' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns active:false for grant-revoked Redis hit', async () => {
    seedAuth();
    // Token not revoked, but grant is revoked in Redis
    mockRedis.get.mockResolvedValueOnce(null);   // token not revoked
    mockRedis.get.mockResolvedValueOnce('1');     // grant revoked

    const { signGrantToken } = await import('../src/lib/crypto.js');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signGrantToken({
      sub: 'user_123',
      agt: TEST_GRANT.agent_id,
      dev: TEST_GRANT.developer_id,
      scp: TEST_GRANT.scopes,
      jti: 'tok_grant_redis',
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
    const body = res.json<{ active: boolean; reason: string }>();
    expect(body.active).toBe(false);
    expect(body.reason).toBe('revoked');
  });
});

describe('GET /v1/grants/:id (toGrantResponse edge cases)', () => {
  it('includes revokedAt when revoked_at is set', async () => {
    seedAuth();
    const revokedGrant = {
      ...TEST_GRANT,
      status: 'revoked',
      revoked_at: '2026-03-01T00:00:00Z',
    };
    sqlMock.mockResolvedValueOnce([revokedGrant]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/grants/${TEST_GRANT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revokedAt).toBe('2026-03-01T00:00:00Z');
  });

  it('omits revokedAt when revoked_at is null', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]); // revoked_at: null

    const res = await app.inject({
      method: 'GET',
      url: `/v1/grants/${TEST_GRANT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('revokedAt');
  });
});
