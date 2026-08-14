import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_GRANT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import {
  auditMetadataForResponse,
  computeAuditHash,
  matchStoredAuditHash,
} from '../src/lib/hash.js';
import { createHash } from 'node:crypto';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const auditEntry = {
  id: 'alog_TEST01',
  agent_id: TEST_AGENT.id,
  agent_did: TEST_AGENT.did,
  grant_id: TEST_GRANT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  action: 'invoke',
  metadata: { tool: 'search' },
  hash: 'abc123hash',
  previous_hash: null,
  timestamp: new Date().toISOString(),
  status: 'success',
};

describe('POST /v1/audit/log', () => {
  it('creates an audit entry with hash', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                  // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([]);                  // advisory chain lock
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // audit entry count → 0
    // Previous hash query
    sqlMock.mockResolvedValueOnce([]); // no previous entry
    // INSERT
    sqlMock.mockResolvedValueOnce([auditEntry]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/log',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        agentDid: TEST_AGENT.did,
        grantId: TEST_GRANT.id,
        principalId: 'user_123',
        action: 'invoke',
        metadata: { tool: 'search' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      entryId: string;
      agentId: string;
      action: string;
      hash: string;
      status: string;
    }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
    expect(body.action).toBe('invoke');
    expect(typeof body.hash).toBe('string');
    expect(body.status).toBe('success');
    expect(body.entryId).toBe(auditEntry.id);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(sqlMock.json).toHaveBeenCalledWith({ tool: 'search' });
    const allSql = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join('\n');
    expect(allSql).toContain('pg_advisory_xact_lock');
  });

  it('returns 402 when plan audit entry limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);   // subscription → free plan
    sqlMock.mockResolvedValueOnce([]);                    // advisory chain lock
    sqlMock.mockResolvedValueOnce([{ count: '20000' }]); // audit count → at limit

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/log',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        agentDid: TEST_AGENT.did,
        grantId: TEST_GRANT.id,
        principalId: 'user_123',
        action: 'invoke',
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('includes previousHash in chain when prior entry exists', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                    // subscription lookup
    sqlMock.mockResolvedValueOnce([]);                    // advisory chain lock
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);      // audit count
    // Previous hash query returns an entry
    sqlMock.mockResolvedValueOnce([{ hash: 'previous_hash_value' }]);
    // INSERT
    sqlMock.mockResolvedValueOnce([{ ...auditEntry, previous_hash: 'previous_hash_value' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/log',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        agentDid: TEST_AGENT.did,
        grantId: TEST_GRANT.id,
        principalId: 'user_123',
        action: 'invoke',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ prevHash: string | null }>();
    expect(body.prevHash).toBe('previous_hash_value');
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/log',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id }, // missing other required fields
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/audit/entries', () => {
  it('returns audit entries', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([auditEntry]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/entries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ entryId: string }> }>();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.entryId).toBe(auditEntry.id);
  });

  it('decodes legacy string-encoded metadata in responses', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...auditEntry,
      metadata: JSON.stringify({ zebra: 1, alpha: { bravo: true } }),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/entries',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: Array<{ metadata: unknown }> }>().entries[0]!.metadata)
      .toEqual({ zebra: 1, alpha: { bravo: true } });
  });

  it('accepts filter query params', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit/entries?agentId=${TEST_AGENT.id}&action=invoke`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('GET /v1/audit/:id', () => {
  it('returns audit entry by id', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([auditEntry]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit/${auditEntry.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entryId: string; hash: string }>();
    expect(body.entryId).toBe(auditEntry.id);
  });

  it('returns 404 for unknown entry', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('computeAuditHash', () => {
  it('produces a deterministic sha256 hash', () => {
    const fields = {
      id: 'alog_001',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata: {},
      timestamp: '2026-01-01T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };
    const hash1 = computeAuditHash(fields);
    const hash2 = computeAuditHash(fields);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // metadata lives in a JSONB column and Postgres normalizes JSONB key order,
  // so a hash that depends on insertion order cannot be recomputed from the
  // stored row — which is the only thing that makes the chain verifiable.
  it('is independent of metadata key order', () => {
    const base = {
      id: 'alog_001',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      timestamp: '2026-01-01T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };

    const written = computeAuditHash({
      ...base,
      metadata: { zebra: 1, alpha: { yankee: true, bravo: [3, 2] }, mike: 'x' },
    });
    const readBack = computeAuditHash({
      ...base,
      metadata: { alpha: { bravo: [3, 2], yankee: true }, mike: 'x', zebra: 1 },
    });

    expect(readBack).toBe(written);
  });

  it('still reflects a change in metadata values', () => {
    const base = {
      id: 'alog_001',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      timestamp: '2026-01-01T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };

    expect(computeAuditHash({ ...base, metadata: { amount: 10 } }))
      .not.toBe(computeAuditHash({ ...base, metadata: { amount: 1000 } }));
    // Array order is meaningful and must not be sorted away.
    expect(computeAuditHash({ ...base, metadata: { items: [1, 2] } }))
      .not.toBe(computeAuditHash({ ...base, metadata: { items: [2, 1] } }));
  });

  it('is unchanged for empty and single-key metadata', () => {
    // Entries written before canonicalization must keep verifying.
    expect(computeAuditHash({
      id: 'alog_001',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata: {},
      timestamp: '2026-01-01T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    })).toBe(
      // sha256 of the exact serialization the previous implementation produced.
      createHash('sha256').update(JSON.stringify({
        id: 'alog_001',
        agentId: 'ag_001',
        agentDid: 'did:grantex:ag_001',
        grantId: 'grnt_001',
        principalId: 'user_001',
        developerId: 'dev_001',
        action: 'invoke',
        metadata: {},
        timestamp: '2026-01-01T00:00:00.000Z',
        prevHash: null,
        status: 'success',
      })).digest('hex'),
    );
  });

  it('matches current hashes after decoding legacy string storage', () => {
    const fields = {
      id: 'alog_C',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata: { zebra: 1, alpha: { yankee: true, bravo: [3, 2] } },
      timestamp: '2026-08-13T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };
    const storedHash = computeAuditHash(fields);

    expect(matchStoredAuditHash({
      ...fields,
      metadata: JSON.stringify(fields.metadata),
    }, storedHash)).toBe('C');
  });

  it('matches exact Era A and Era B hashes without rewriting metadata', () => {
    const metadata = { zebra: 1, alpha: { yankee: true, bravo: [3, 2] } };
    const base = {
      id: 'alog_legacy',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata,
      timestamp: '2026-03-01T00:00:00.000Z',
      prevHash: 'previous',
      status: 'success',
    };
    const eraAHash = createHash('sha256').update(JSON.stringify({
      id: base.id,
      agentId: base.agentId,
      agentDid: base.agentDid,
      grantId: base.grantId,
      principalId: base.principalId,
      developerId: base.developerId,
      action: base.action,
      metadata,
      timestamp: base.timestamp,
      previousHash: base.prevHash,
    })).digest('hex');
    const eraBHash = createHash('sha256').update(JSON.stringify({
      id: base.id,
      agentId: base.agentId,
      agentDid: base.agentDid,
      grantId: base.grantId,
      principalId: base.principalId,
      developerId: base.developerId,
      action: base.action,
      metadata,
      timestamp: base.timestamp,
      prevHash: base.prevHash,
      status: base.status,
    })).digest('hex');
    const stored = { ...base, metadata: JSON.stringify(metadata) };

    expect(matchStoredAuditHash(stored, eraAHash)).toBe('A');
    expect(matchStoredAuditHash(stored, eraBHash)).toBe('B');
  });

  it('reports B/C when insertion-order and canonical bytes are identical', () => {
    const fields = {
      id: 'alog_ambiguous',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata: { alpha: 1, zebra: 2 },
      timestamp: '2026-08-13T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };

    expect(matchStoredAuditHash(
      { ...fields, metadata: JSON.stringify(fields.metadata) },
      computeAuditHash(fields),
    )).toBe('B/C');
  });

  it('does not normalize malformed legacy metadata into a valid hash', () => {
    const fields = {
      id: 'alog_bad',
      agentId: 'ag_001',
      agentDid: 'did:grantex:ag_001',
      grantId: 'grnt_001',
      principalId: 'user_001',
      developerId: 'dev_001',
      action: 'invoke',
      metadata: 'customer-secret-value',
      timestamp: '2026-08-13T00:00:00.000Z',
      prevHash: null,
      status: 'success',
    };

    expect(matchStoredAuditHash(fields, '0'.repeat(64))).toBeNull();
    expect(auditMetadataForResponse(fields.metadata)).toBe(fields.metadata);
  });
});
