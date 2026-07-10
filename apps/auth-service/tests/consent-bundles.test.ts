import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  computeOfflineAuditEntryHash,
  OFFLINE_AUDIT_GENESIS_HASH,
  type SignedOfflineAuditEntry,
} from '../src/lib/offline-audit.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── POST /v1/consent-bundles ────────────────────────────────────────────────

describe('POST /v1/consent-bundles', () => {
  it('creates bundle with valid params', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did, scopes: ['read', 'write'] }]);
    // Grant insert
    sqlMock.mockResolvedValueOnce([]);
    // Grant-token insert
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
    expect(body.data.offlineAuditKey.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(body.data.offlineAuditKey.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(body.data.offlineAuditKey.algorithm).toBe('Ed25519');
    expect(body.data.checkpointAt).toBeTypeOf('number');
    expect(body.data.checkpointAt).toBeGreaterThan(1_000_000_000_000);
    expect(body.data.syncEndpoint).toContain('/v1/audit/offline-sync');
    expect(body.data.offlineExpiresAt).toBeDefined();
    const executedSql = sqlMock.mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(' '))
      .join('\n');
    expect(executedSql).toContain('INSERT INTO grant_tokens');
    expect(body.bundleId).toBe(body.data.bundleId);
    expect(body.grantToken).toBe(body.data.grantToken);
  });

  it('rejects an audit algorithm that does not match the generated Ed25519 key', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['read'],
        offlineAuditKeyAlgorithm: 'RS256',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Ed25519');
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
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did, scopes: ['read'] }]);

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

  it('rejects scopes the agent is not registered to use', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did, scopes: ['read'] }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['write'],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('INVALID_SCOPES');
  });

  it('rejects an offline TTL longer than seven days', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did, scopes: ['read'] }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        userId: 'user_123',
        scopes: ['read'],
        offlineTTL: '8d',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('INVALID_TTL');
  });
});

// ─── POST /v1/audit/offline-sync ─────────────────────────────────────────────

describe('POST /v1/audit/offline-sync', () => {
  const auditKeys = generateKeyPairSync('ed25519');
  const auditPublicJwk = auditKeys.publicKey.export({ format: 'jwk' });

  function signedEntry(
    partial: Omit<SignedOfflineAuditEntry, 'hash' | 'signature'>,
  ): SignedOfflineAuditEntry {
    const hash = computeOfflineAuditEntryHash(partial);
    return {
      ...partial,
      hash,
      signature: sign(null, Buffer.from(hash, 'utf8'), auditKeys.privateKey).toString('hex'),
    };
  }

  const firstEntry = signedEntry({
    seq: 1,
    timestamp: '2026-04-01T10:00:00Z',
    action: 'read',
    agentDID: TEST_AGENT.did,
    grantId: 'grnt_TEST01',
    scopes: ['read'],
    result: 'allow',
    prevHash: OFFLINE_AUDIT_GENESIS_HASH,
  });
  const validEntries = [
    firstEntry,
    signedEntry({
      seq: 2,
      timestamp: '2026-04-01T10:01:00Z',
      action: 'write',
      agentDID: TEST_AGENT.did,
      grantId: 'grnt_TEST01',
      scopes: ['write'],
      result: 'allow',
      metadata: { key: 'value' },
      prevHash: firstEntry.hash,
    }),
  ];

  function syncBundleRow() {
    return {
      id: 'bundle_TEST01',
      grant_id: 'grnt_TEST01',
      scopes: ['read', 'write'],
      status: 'active',
      audit_public_key: JSON.stringify(auditPublicJwk),
      agent_did: TEST_AGENT.did,
    };
  }

  it('accepts valid entries', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([syncBundleRow()]);
    // Lock bundle
    sqlMock.mockResolvedValueOnce([]);
    // Last persisted entry
    sqlMock.mockResolvedValueOnce([]);
    // Existing incoming sequences
    sqlMock.mockResolvedValueOnce([]);
    // tx(entryValues, ...) inner helper call
    sqlMock.mockResolvedValueOnce([]);
    // INSERT tagged template
    sqlMock.mockResolvedValueOnce([]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);
    // Grant status check
    sqlMock.mockResolvedValueOnce([{ status: 'active', revoked_at: null }]);

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
    sqlMock.mockResolvedValueOnce([syncBundleRow()]);
    sqlMock.mockResolvedValueOnce([]); // lock bundle
    sqlMock.mockResolvedValueOnce([]); // last entry
    sqlMock.mockResolvedValueOnce([]); // existing sequences
    // tx(entryValues, ...) inner helper call
    sqlMock.mockResolvedValueOnce([]);
    // INSERT tagged template
    sqlMock.mockResolvedValueOnce([]);
    // Update bundle
    sqlMock.mockResolvedValueOnce([]);
    // Grant status check — revoked
    sqlMock.mockResolvedValueOnce([{ status: 'revoked', revoked_at: '2026-04-01T12:00:00Z' }]);

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

  it('rejects a forged signature without persisting any entry', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([syncBundleRow()]);
    const forged = {
      ...validEntries[0]!,
      signature: '00'.repeat(64),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: { bundleId: 'bundle_TEST01', entries: [forged] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('INVALID_SIGNATURE');
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it('accepts an idempotent retry without inserting duplicate rows', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([syncBundleRow()]);
    sqlMock.mockResolvedValueOnce([]); // lock bundle
    sqlMock.mockResolvedValueOnce([{ seq: 2, hash: validEntries[1]!.hash }]);
    sqlMock.mockResolvedValueOnce([
      { seq: 1, hash: validEntries[0]!.hash },
      { seq: 2, hash: validEntries[1]!.hash },
    ]);
    sqlMock.mockResolvedValueOnce([]); // update last_sync_at, +0 count
    sqlMock.mockResolvedValueOnce([{ status: 'active', revoked_at: null }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/offline-sync',
      headers: authHeader(),
      payload: { bundleId: 'bundle_TEST01', entries: validEntries },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.accepted).toBe(2);
    const allSql = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(allSql).not.toContain('INSERT INTO offline_audit_entries');
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
    expect(body.data.checkpointAt).toBeGreaterThan(1_000_000_000_000);
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
    expect(body.bundles).toHaveLength(2);
    expect(body.bundles[0].id).toBe('bundle_001');
    expect(body.bundles[0].status).toBe('active');
    expect(body.bundles[0].devicePlatform).toBe('raspberry-pi');
    expect(body.bundles[1].id).toBe('bundle_002');
    expect(body.bundles[1].status).toBe('revoked');
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
    expect(res.json().bundles).toEqual([]);
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
    expect(res.json().bundles).toEqual([]);
  });
});

describe('GET /v1/consent-bundles/:bundleId', () => {
  it('returns a developer-owned bundle with the complete detail shape', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_001',
      agent_id: TEST_AGENT.id,
      grant_id: 'grnt_001',
      user_id: 'user_123',
      scopes: ['read'],
      status: 'active',
      device_id: 'dev-001',
      device_platform: 'raspberry-pi',
      offline_ttl: '48h',
      offline_expires_at: new Date('2027-04-06T10:00:00Z'),
      checkpoint_at: new Date('2027-04-04T10:00:00Z'),
      audit_entry_count: 2,
      last_sync_at: null,
      created_at: new Date('2027-04-04T10:00:00Z'),
      revoked_at: null,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_001',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'bundle_001',
      userId: 'user_123',
      offlineTTL: '48h',
      auditEntryCount: 2,
      revokedAt: null,
    });
  });

  it('does not expose another developer bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_other',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/consent-bundles/:bundleId/audit', () => {
  it('returns synced audit entries for an owned bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_001' }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'oae_001',
      seq: 1,
      timestamp: new Date('2027-04-04T10:01:00Z'),
      action: 'read',
      agent_did: TEST_AGENT.did,
      grant_id: 'grnt_001',
      scopes: ['read'],
      result: 'allow',
      metadata: { source: 'offline' },
      prev_hash: '0',
      hash: 'abc',
      signature: 'sig',
      synced_at: new Date('2027-04-04T11:00:00Z'),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent-bundles/bundle_001/audit',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({
      id: 'oae_001',
      seq: 1,
      agentDID: TEST_AGENT.did,
      grantId: 'grnt_001',
    });
  });
});

describe('POST /v1/consent-bundles/:bundleId/refresh', () => {
  it('rotates keys and returns a persisted, usable grant token', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_001',
      agent_id: TEST_AGENT.id,
      grant_id: 'grnt_001',
      user_id: 'user_123',
      scopes: ['read'],
      offline_ttl: '48h',
      offline_expires_at: new Date(Date.now() + 3_600_000),
      status: 'active',
      agent_did: TEST_AGENT.did,
      grant_status: 'active',
    }]);
    sqlMock.mockResolvedValueOnce([]); // commerce Passport keys for JWKS snapshot
    sqlMock.mockResolvedValueOnce([{ id: 'bundle_001' }]); // guarded bundle update
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_001' }]); // guarded grant update
    sqlMock.mockResolvedValueOnce([]); // insert grant token

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_001/refresh',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().grantToken).toBeTypeOf('string');
    expect(res.json().offlineAuditKey.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(res.json().checkpointAt).toBeGreaterThan(1_000_000_000_000);
    expect(res.json().jwksSnapshot.validUntil).toBe(res.json().offlineExpiresAt);
    const allSql = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(allSql).toContain('INSERT INTO grant_tokens');
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
  });

  it('refuses to revive an expired bundle', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_001',
      offline_ttl: '48h',
      offline_expires_at: new Date(Date.now() - 1),
      status: 'active',
      grant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_001/refresh',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('BUNDLE_EXPIRED');
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it('rolls back when the bundle is revoked during refresh', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'bundle_001',
      agent_id: TEST_AGENT.id,
      grant_id: 'grnt_001',
      user_id: 'user_123',
      scopes: ['read'],
      offline_ttl: '48h',
      offline_expires_at: new Date(Date.now() + 3_600_000),
      status: 'active',
      agent_did: TEST_AGENT.did,
      grant_status: 'active',
    }]);
    sqlMock.mockResolvedValueOnce([]); // commerce Passport keys for JWKS snapshot
    sqlMock.mockResolvedValueOnce([]); // guarded update loses the revoke race

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent-bundles/bundle_001/refresh',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('BUNDLE_INACTIVE');
    const allSql = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(allSql).not.toContain('INSERT INTO grant_tokens');
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
