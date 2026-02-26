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

// ─── GET /v1/compliance/evidence-pack ─────────────────────────────────────────

describe('GET /v1/compliance/evidence-pack', () => {
  const MOCK_GRANT_ROW = {
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

  const MOCK_AUDIT_ROW = {
    id: 'alog_01',
    agent_id: 'ag_01',
    agent_did: 'did:grantex:ag_01',
    grant_id: 'grnt_01',
    principal_id: 'user_01',
    developer_id: 'dev_TEST',
    action: 'tool.run',
    metadata: {},
    hash: 'abc123',
    previous_hash: null,
    timestamp: '2026-01-15T12:00:00Z',
    status: 'success',
  };

  const MOCK_POLICY_ROW = {
    id: 'pol_01',
    name: 'allow-all',
    effect: 'allow',
    priority: 0,
    agent_id: null,
    principal_id: null,
    scopes: null,
    time_of_day_start: null,
    time_of_day_end: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  /** Primes 9 mock slots: 1 auth + 8 concurrent SQL calls in Promise.all order. */
  function seedEvidencePack() {
    seedAuth();
    // Promise.all order: agentStats, grantStats, auditStats, policyStats, sub,
    //                    full grants, full audit, full policies
    sqlMock.mockResolvedValueOnce([AGENT_STATS]);
    sqlMock.mockResolvedValueOnce([GRANT_STATS]);
    sqlMock.mockResolvedValueOnce([AUDIT_STATS]);
    sqlMock.mockResolvedValueOnce([POLICY_STATS]);
    sqlMock.mockResolvedValueOnce([SUB]);
    sqlMock.mockResolvedValueOnce([MOCK_GRANT_ROW]);
    sqlMock.mockResolvedValueOnce([MOCK_AUDIT_ROW]);
    sqlMock.mockResolvedValueOnce([MOCK_POLICY_ROW]);
  }

  it('returns a complete evidence pack bundle', async () => {
    seedEvidencePack();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/evidence-pack',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      meta: { schemaVersion: string; framework: string; generatedAt: string };
      summary: { plan: string; agents: { total: number }; grants: { active: number } };
      grants: unknown[];
      auditEntries: unknown[];
      policies: unknown[];
      chainIntegrity: { valid: boolean; checkedEntries: number; firstBrokenAt: string | null };
    }>();

    expect(body.meta.schemaVersion).toBe('1.0');
    expect(body.meta.framework).toBe('all');
    expect(body.meta.generatedAt).toBeDefined();
    expect(body.summary.plan).toBe('pro');
    expect(body.summary.agents.total).toBe(5);
    expect(body.summary.grants.active).toBe(18);
    expect(body.grants).toHaveLength(1);
    expect(body.auditEntries).toHaveLength(1);
    expect(body.policies).toHaveLength(1);
    expect(body.chainIntegrity.valid).toBe(true);
    expect(body.chainIntegrity.checkedEntries).toBe(1);
    expect(body.chainIntegrity.firstBrokenAt).toBeNull();
  });

  it('includes since/until in meta when provided', async () => {
    seedEvidencePack();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/evidence-pack?since=2026-01-01T00:00:00Z&until=2026-12-31T00:00:00Z&framework=soc2',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { since: string; until: string; framework: string } }>();
    expect(body.meta.since).toBe('2026-01-01T00:00:00Z');
    expect(body.meta.until).toBe('2026-12-31T00:00:00Z');
    expect(body.meta.framework).toBe('soc2');
  });

  it('reports chain integrity broken when hash chain is invalid', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([AGENT_STATS]);
    sqlMock.mockResolvedValueOnce([GRANT_STATS]);
    sqlMock.mockResolvedValueOnce([AUDIT_STATS]);
    sqlMock.mockResolvedValueOnce([POLICY_STATS]);
    sqlMock.mockResolvedValueOnce([SUB]);
    sqlMock.mockResolvedValueOnce([]);
    // Two audit entries where second's previous_hash doesn't match first's hash
    sqlMock.mockResolvedValueOnce([
      { ...MOCK_AUDIT_ROW, id: 'alog_01', hash: 'hash_a', previous_hash: null },
      { ...MOCK_AUDIT_ROW, id: 'alog_02', hash: 'hash_b', previous_hash: 'WRONG_HASH' },
    ]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/evidence-pack',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ chainIntegrity: { valid: boolean; firstBrokenAt: string | null } }>();
    expect(body.chainIntegrity.valid).toBe(false);
    expect(body.chainIntegrity.firstBrokenAt).toBe('alog_02');
  });
});
