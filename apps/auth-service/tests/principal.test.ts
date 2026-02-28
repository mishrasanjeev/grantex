import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_DEVELOPER, TEST_GRANT, TEST_AGENT } from './helpers.js';
import { signPrincipalSessionToken } from '../src/lib/crypto.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// Helper to generate a valid session token for tests
async function makeSessionToken(principalId = 'user_123', developerId = TEST_DEVELOPER.id) {
  return signPrincipalSessionToken({ principalId, developerId }, 3600);
}

function sessionHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const GRANT_WITH_AGENT = {
  ...TEST_GRANT,
  delegation_depth: 0,
  agent_name: TEST_AGENT.name,
  agent_description: TEST_AGENT.description,
  agent_did: TEST_AGENT.did,
};

// ─── POST /v1/principal-sessions ─────────────────────────────────────────────

describe('POST /v1/principal-sessions', () => {
  it('returns 201 with sessionToken and dashboardUrl when grants exist', async () => {
    seedAuth();
    // Query for active grants — at least one found
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ sessionToken: string; dashboardUrl: string; expiresAt: string }>();
    expect(body.sessionToken).toBeTruthy();
    expect(body.dashboardUrl).toContain('/permissions?session=');
    expect(body.expiresAt).toBeTruthy();
  });

  it('returns 400 when principalId is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid expiresIn format', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: { principalId: 'user_123', expiresIn: 'invalid' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('BAD_REQUEST');
  });

  it('returns 404 when no active grants exist for the principal', async () => {
    seedAuth();
    // Query for active grants — none found
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: { principalId: 'user_no_grants' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
  });

  it('returns 401 without developer API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('caps expiresIn at 24h', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: { principalId: 'user_123', expiresIn: '48h' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ expiresAt: string }>();
    const expiresAt = new Date(body.expiresAt).getTime();
    const maxExpiry = Date.now() + 86400_000 + 5000; // 24h + 5s buffer
    expect(expiresAt).toBeLessThanOrEqual(maxExpiry);
  });

  it('defaults to 1h when expiresIn is not provided', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/principal-sessions',
      headers: authHeader(),
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ expiresAt: string }>();
    const expiresAt = new Date(body.expiresAt).getTime();
    const expectedMax = Date.now() + 3600_000 + 5000; // 1h + 5s buffer
    const expectedMin = Date.now() + 3600_000 - 5000;
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
  });
});

// ─── GET /v1/principal/grants ────────────────────────────────────────────────

describe('GET /v1/principal/grants', () => {
  it('returns grants for valid session token', async () => {
    const token = await makeSessionToken();
    sqlMock.mockResolvedValueOnce([GRANT_WITH_AGENT]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/grants',
      headers: sessionHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grants: Array<{ grantId: string; agentName: string }>; principalId: string }>();
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]!.grantId).toBe(TEST_GRANT.id);
    expect(body.grants[0]!.agentName).toBe(TEST_AGENT.name);
    expect(body.principalId).toBe('user_123');
  });

  it('returns 401 with missing token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/grants',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with expired token', async () => {
    // Sign a token that's already expired
    const token = await signPrincipalSessionToken(
      { principalId: 'user_123', developerId: TEST_DEVELOPER.id },
      -10, // negative = already expired
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/grants',
      headers: sessionHeader(token),
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/grants',
      headers: sessionHeader('not.a.valid.token'),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── GET /v1/principal/audit ─────────────────────────────────────────────────

describe('GET /v1/principal/audit', () => {
  it('returns entries for valid session', async () => {
    const token = await makeSessionToken();
    const mockEntry = {
      id: 'aud_1',
      agent_id: TEST_AGENT.id,
      agent_did: TEST_AGENT.did,
      grant_id: TEST_GRANT.id,
      principal_id: 'user_123',
      action: 'read.data',
      metadata: {},
      status: 'success',
      timestamp: new Date().toISOString(),
    };
    sqlMock.mockResolvedValueOnce([mockEntry]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/audit',
      headers: sessionHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ entryId: string }> }>();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.entryId).toBe('aud_1');
  });

  it('returns 401 with invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/principal/audit',
      headers: sessionHeader('bad-token'),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── DELETE /v1/principal/grants/:id ─────────────────────────────────────────

describe('DELETE /v1/principal/grants/:id', () => {
  it('returns 204 and revokes grant', async () => {
    const token = await makeSessionToken();
    // Ownership check
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);
    // revokeGrantCascade: UPDATE grants (revoke root)
    sqlMock.mockResolvedValueOnce([TEST_GRANT]);
    // revokeGrantCascade: cascade descendants
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/principal/grants/${TEST_GRANT.id}`,
      headers: sessionHeader(token),
    });

    expect(res.statusCode).toBe(204);
    expect(mockRedis.set).toHaveBeenCalledWith(
      `revoked:grant:${TEST_GRANT.id}`,
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('returns 404 when grant does not belong to this principal', async () => {
    const token = await makeSessionToken('other_user');
    // Ownership check — no rows found
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/principal/grants/${TEST_GRANT.id}`,
      headers: sessionHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 401 with invalid session', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/principal/grants/${TEST_GRANT.id}`,
      headers: sessionHeader('invalid'),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── GET /permissions ────────────────────────────────────────────────────────

describe('GET /permissions', () => {
  it('returns HTML with Manage Permissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/permissions',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Manage Permissions');
  });
});
