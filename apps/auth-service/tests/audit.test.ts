import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_GRANT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { computeAuditHash } from '../src/lib/hash.js';

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
};

describe('POST /v1/audit', () => {
  it('creates an audit entry with hash', async () => {
    seedAuth();
    // Previous hash query
    sqlMock.mockResolvedValueOnce([]); // no previous entry
    // INSERT
    sqlMock.mockResolvedValueOnce([auditEntry]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
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
      id: string;
      agentId: string;
      action: string;
      hash: string;
    }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
    expect(body.action).toBe('invoke');
    expect(typeof body.hash).toBe('string');
  });

  it('includes previousHash in chain when prior entry exists', async () => {
    seedAuth();
    // Previous hash query returns an entry
    sqlMock.mockResolvedValueOnce([{ hash: 'previous_hash_value' }]);
    // INSERT
    sqlMock.mockResolvedValueOnce([{ ...auditEntry, previous_hash: 'previous_hash_value' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
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
    const body = res.json<{ previousHash: string | null }>();
    expect(body.previousHash).toBe('previous_hash_value');
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id }, // missing other required fields
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/audit', () => {
  it('returns audit entries', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([auditEntry]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ id: string }> }>();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.id).toBe(auditEntry.id);
  });

  it('accepts filter query params', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit?agentId=${TEST_AGENT.id}&action=invoke`,
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
    const body = res.json<{ id: string; hash: string }>();
    expect(body.id).toBe(auditEntry.id);
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
      previousHash: null,
    };
    const hash1 = computeAuditHash(fields);
    const hash2 = computeAuditHash(fields);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});
