import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── POST /v1/consent-bundles ────────────────────────────────────────────────

describe('POST /v1/consent-bundles', () => {
  it('creates bundle with valid params', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant insert
    sqlMock.mockResolvedValueOnce([]);
    // Bundle insert
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['read', 'write'],
        offlineTTL: '48h',
        deviceId: 'dev-001',
        devicePlatform: 'raspberry-pi',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.bundleId).toMatch(/^bundle_/);
    expect(body.data.grantToken).toBeDefined();
    expect(body.data.jwksSnapshot).toBeDefined();
    expect(body.data.jwksSnapshot.keys).toBeInstanceOf(Array);
    expect(body.data.jwksSnapshot.fetchedAt).toBeDefined();
    expect(body.data.jwksSnapshot.validUntil).toBeDefined();
    expect(body.data.offlineAuditKey).toBeDefined();
    expect(body.data.offlineAuditKey.publicKey).toBeDefined();
    expect(body.data.offlineAuditKey.privateKey).toBeDefined();
    expect(body.data.offlineAuditKey.algorithm).toBe('Ed25519');
    expect(body.data.checkpointAt).toBeTypeOf('number');
    expect(body.data.syncEndpoint).toContain('/v1/audit/offline-sync');
    expect(body.data.offlineExpiresAt).toBeDefined();
  });

  it('rejects missing agentId', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        userId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects missing scopes', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: [],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects agent not owned by developer', async () => {
    seedAuth();
    // Agent lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: 'ag_SOMEONE_ELSES',
        userId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('rejects invalid offlineTTL format', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['read'],
        offlineTTL: 'invalid',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TTL');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── POST /v1/audit/offline-sync ─────────────────────────────────────────────

describe('POST /v1/audit/offline-sync', () => {
  const validEntries = [
    {
      seq: 1,
      timestamp: '2026-04-01T10:00:00Z',
      action: 'read',
      agentDID: 'did:grantex:ag_TEST01',
      grantId: 'grnt_TEST01',
      scopes: ['read'],
      result: 'allow',
      prevHash: '0000000000000000',
      hash: 'abc123def456',
      signature: 'sig_abc123',
    },
    {
      seq: 2,
      timestamp: '2026-04-01T10:01:00Z',
      action: 'write',
      agentDID: 'did:grantex:ag_TEST01',
      grantId: 'grnt_TEST01',
      scopes: ['write'],
      result: 'allow',
      metadata: { key: 'value' },
      prevHash: 'abc123def456',
      hash: 'def456ghi789',
      signature: 'sig_def456',
    },
  ];

  it('accepts valid entries', async () => {
    seedAuth();
    // Bundle lookup
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_TEST01', grant_id: 'grnt_TEST01', status: 'active' }]);
    // sql(entryValues, ...) inner helper call
    sqlMock.mockResolvedValueOnce([]);
    // INSERT tagged template
    sqlMock.mockResolvedValueOnce([]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);
    // Grant status check
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: {
        bundleId: 'bundle_TEST01',
        deviceId: 'dev-001',
        entries: validEntries,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.accepted).toBe(2);
    expect(body.data.rejected).toBe(0);
    expect(body.data.revocationStatus).toBe('valid');
    expect(body.data.newBundle).toBeNull();
  });

  it('rejects unknown bundleId', async () => {
    seedAuth();
    // Bundle lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: {
        bundleId: 'bundle_NONEXISTENT',
        entries: validEntries,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('rejects empty entries array', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: {
        bundleId: 'bundle_TEST01',
        entries: [],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects missing bundleId', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: {
        entries: validEntries,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns revoked status when grant is revoked', async () => {
    seedAuth();
    // Bundle lookup
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_TEST01', grant_id: 'grnt_TEST01', status: 'active' }]);
    // sql(entryValues, ...) inner helper call
    sqlMock.mockResolvedValueOnce([]);
    // INSERT tagged template
    sqlMock.mockResolvedValueOnce([]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);
    // Grant status check — revoked
    sqlMock.mockResolvedValueOnce([{ status: 'revoked' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: {
        bundleId: 'bundle_TEST01',
        entries: [validEntries[0]],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.revocationStatus).toBe('revoked');
  });
});

// ─── GET /v1/consent-bundles/:bundleId/revocation-status ─────────────────────

describe('GET /v1/consent-bundles/:bundleId/revocation-status', () => {
  it('returns valid status', async () => {
    seedAuth();
    // Bundle + grant join
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_TEST01',
      status: 'active',
      revoked_at: null,
      revoked_by: null,
      grant_id: 'grnt_TEST01',
      checkpoint_at: '2026-04-06T10:00:00Z',
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_TEST01/revocation-status',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.bundleId).toBe('bundle_TEST01');
    expect(body.data.status).toBe('active');
    expect(body.data.revokedAt).toBeNull();
    expect(body.data.revokedBy).toBeNull();
    expect(body.data.grantRevoked).toBe(false);
    expect(body.data.checkpointAt).toBeTypeOf('number');
  });

  it('returns revoked status', async () => {
    seedAuth();
    const revokedAt = '2026-04-02T12:00:00Z';
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_TEST01',
      status: 'revoked',
      revoked_at: revokedAt,
      revoked_by: TEST_DEVELOPER.id,
      grant_id: 'grnt_TEST01',
      checkpoint_at: '2026-04-06T10:00:00Z',
      grant_status: 'revoked',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_TEST01/revocation-status',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe('revoked');
    expect(body.data.revokedAt).toBe(revokedAt);
    expect(body.data.revokedBy).toBe(TEST_DEVELOPER.id);
    expect(body.data.grantRevoked).toBe(true);
  });

  it('returns 404 for non-existent bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_NONEXIST/revocation-status',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ─── GET /v1/consent-bundles ─────────────────────────────────────────────────

describe('GET /v1/consent-bundles', () => {
  it('lists bundles for developer', async () => {
    seedAuth();
    // sql`` empty fragments for status, agentId, cursor conditionals
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    // Main query result
    sqlMock.mockResolvedValueOnce([
      {
        id: 'bundle_001',
        agent_id: TEST_AGENT.id,
        grant_id: 'grnt_001',
        principal_id: 'user_123',
        scopes: ['read'],
        status: 'active',
        device_id: 'dev-001',
        device_platform: 'raspberry-pi',
        offline_expires_at: new Date('2026-04-06T10:00:00Z'),
        audit_entry_count: 5,
        last_sync_at: '2026-04-03T10:00:00Z',
        created_at: new Date('2026-04-01T10:00:00Z'),
      },
      {
        id: 'bundle_002',
        agent_id: TEST_AGENT.id,
        grant_id: 'grnt_002',
        principal_id: 'user_456',
        scopes: ['read', 'write'],
        status: 'revoked',
        device_id: null,
        device_platform: null,
        offline_expires_at: new Date('2026-04-05T10:00:00Z'),
        audit_entry_count: 0,
        last_sync_at: null,
        created_at: new Date('2026-03-30T10:00:00Z'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.bundles).toHaveLength(2);
    expect(body.data.bundles[0].bundleId).toBe('bundle_001');
    expect(body.data.bundles[0].status).toBe('active');
    expect(body.data.bundles[0].devicePlatform).toBe('raspberry-pi');
    expect(body.data.bundles[1].bundleId).toBe('bundle_002');
    expect(body.data.bundles[1].status).toBe('revoked');
  });

  it('filters by status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles?status=active',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.bundles).toEqual([]);
  });

  it('filters by agentId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/consent-bundles?agentId=${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.bundles).toEqual([]);
  });
});

// ─── POST /v1/consent-bundles/:bundleId/revoke ───────────────────────────────

describe('POST /v1/consent-bundles/:bundleId/revoke', () => {
  it('revokes a bundle', async () => {
    seedAuth();
    // Bundle lookup
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_TEST01', status: 'active', grant_id: 'grnt_TEST01' }]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_TEST01/revoke',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.bundleId).toBe('bundle_TEST01');
    expect(body.data.status).toBe('revoked');
    expect(body.data.revokedAt).toBeDefined();
  });

  it('revokes bundle and underlying grant', async () => {
    seedAuth();
    // Bundle lookup
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_TEST01', status: 'active', grant_id: 'grnt_TEST01' }]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);
    // Update grant
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_TEST01/revoke',
      headers: authHeader(),
      payload: { revokeGrant: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('revoked');
  });

  it('returns 404 for non-existent bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_NONEXIST/revoke',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('handles already-revoked bundle', async () => {
    seedAuth();
    // Bundle lookup — already revoked
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_TEST01', status: 'revoked', grant_id: 'grnt_TEST01' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_TEST01/revoke',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('revoked');
  });
});
