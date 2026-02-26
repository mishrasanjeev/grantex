import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── summary mock data ────────────────────────────────────────────────────────

const AGENT_STATS = { total: '5', active: '4', suspended: '1', revoked: '0' };
const GRANT_STATS = { total: '23', active: '18', revoked: '3', expired: '2' };
const AUDIT_STATS = { total: '412', success: '400', failure: '10', blocked: '2' };
const POLICY_STATS = { total: '2' };
const SUB = { plan: 'pro' };

function seedSummary() {
  seedAuth();
  // Promise.all fires these in declaration order
  sqlMock.mockResolvedValueOnce([AGENT_STATS]);
  sqlMock.mockResolvedValueOnce([GRANT_STATS]);
  sqlMock.mockResolvedValueOnce([AUDIT_STATS]);
  sqlMock.mockResolvedValueOnce([POLICY_STATS]);
  sqlMock.mockResolvedValueOnce([SUB]);
}

// ─── GET /v1/compliance/summary ───────────────────────────────────────────────

describe('GET /v1/compliance/summary', () => {
  it('returns org-wide aggregate stats', async () => {
    seedSummary();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/summary',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      agents: { total: number; active: number };
      grants: { total: number; active: number };
      auditEntries: { total: number; failure: number };
      policies: { total: number };
      plan: string;
      generatedAt: string;
    }>();
    expect(body.agents.total).toBe(5);
    expect(body.agents.active).toBe(4);
    expect(body.grants.total).toBe(23);
    expect(body.grants.active).toBe(18);
    expect(body.auditEntries.total).toBe(412);
    expect(body.auditEntries.failure).toBe(10);
    expect(body.policies.total).toBe(2);
    expect(body.plan).toBe('pro');
    expect(body.generatedAt).toBeDefined();
  });

  it('defaults plan to free when no subscription exists', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([AGENT_STATS]);
    sqlMock.mockResolvedValueOnce([GRANT_STATS]);
    sqlMock.mockResolvedValueOnce([AUDIT_STATS]);
    sqlMock.mockResolvedValueOnce([POLICY_STATS]);
    sqlMock.mockResolvedValueOnce([]); // no subscription row

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/summary',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ plan: string }>().plan).toBe('free');
  });

  it('includes since/until in response when provided', async () => {
    seedSummary();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/summary?since=2026-01-01T00:00:00Z&until=2026-12-31T00:00:00Z',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ since: string; until: string }>();
    expect(body.since).toBe('2026-01-01T00:00:00Z');
    expect(body.until).toBe('2026-12-31T00:00:00Z');
  });
});

// ─── GET /v1/compliance/export/grants ─────────────────────────────────────────

describe('GET /v1/compliance/export/grants', () => {
  const MOCK_GRANT = {
    id: 'grnt_01',
    agent_id: 'ag_01',
    principal_id: 'user_01',
    developer_id: 'dev_TEST',
    scopes: ['read'],
    status: 'active',
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
    revoked_at: null,
    delegation_depth: 0,
  };

  it('returns grants export with total and generatedAt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([MOCK_GRANT]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/export/grants',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ grants: unknown[]; total: number; generatedAt: string }>();
    expect(body.total).toBe(1);
    expect(body.grants).toHaveLength(1);
    expect(body.generatedAt).toBeDefined();
  });

  it('returns empty grants array when none exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/export/grants',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});

// ─── GET /v1/compliance/export/audit ──────────────────────────────────────────

describe('GET /v1/compliance/export/audit', () => {
  const MOCK_ENTRY = {
    id: 'alog_01',
    agent_id: 'ag_01',
    agent_did: 'did:grantex:ag_01',
    grant_id: 'grnt_01',
    principal_id: 'user_01',
    developer_id: 'dev_TEST',
    action: 'tool.run:fetch',
    metadata: {},
    hash: 'abc123',
    previous_hash: null,
    timestamp: '2026-01-15T12:00:00Z',
    status: 'success',
  };

  it('returns audit export with total and generatedAt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([MOCK_ENTRY]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/export/audit',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: unknown[]; total: number; generatedAt: string }>();
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.generatedAt).toBeDefined();
  });

  it('returns empty entries array when none exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/export/audit',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});
