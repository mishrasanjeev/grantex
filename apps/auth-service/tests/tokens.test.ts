import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_GRANT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let validToken: string;

beforeAll(async () => {
  app = await buildTestApp();

  // Generate a real token for introspection tests
  const { signGrantToken } = await import('../src/lib/crypto.js');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  validToken = await signGrantToken({
    sub: 'user_123',
    agt: TEST_GRANT.agent_id,
    dev: TEST_GRANT.developer_id,
    scp: TEST_GRANT.scopes,
    jti: 'tok_INTROSPECT01',
    grnt: TEST_GRANT.id,
    exp,
  });
});

describe('POST /v1/tokens/verify', () => {
  it('returns valid:true for a valid token', async () => {
    seedAuth();
    // Redis: not revoked
    mockRedis.get.mockResolvedValue(null);
    // DB: token exists, not revoked, grant active
    sqlMock.mockResolvedValueOnce([{
      is_revoked: false,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: validToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      valid: boolean;
      principal: string;
      scopes: string[];
      expiresAt: string;
    }>();
    expect(body.valid).toBe(true);
    expect(body.principal).toBe('user_123');
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.expiresAt).toBeDefined();
  });

  it('returns valid:false when token is revoked in Redis', async () => {
    seedAuth();
    // Redis: revoked
    mockRedis.get.mockResolvedValueOnce('1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: validToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean }>();
    expect(body.valid).toBe(false);
  });

  it('returns valid:false when token is revoked in DB', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    sqlMock.mockResolvedValueOnce([{
      is_revoked: true,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: validToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean }>();
    expect(body.valid).toBe(false);
  });

  it('returns valid:false for malformed token', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: 'not.a.jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ valid: boolean }>();
    expect(body.valid).toBe(false);
  });
});

describe('POST /v1/tokens/revoke', () => {
  it('revokes a token and sets Redis key', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      jti: 'tok_INTROSPECT01',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/revoke',
      headers: authHeader(),
      payload: { jti: 'tok_INTROSPECT01' },
    });

    expect(res.statusCode).toBe(204);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'revoked:tok:tok_INTROSPECT01',
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('returns 404 when token not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/revoke',
      headers: authHeader(),
      payload: { jti: 'tok_nonexistent' },
    });

    expect(res.statusCode).toBe(404);
  });
});
