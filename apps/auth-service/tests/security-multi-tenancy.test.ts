/**
 * Multi-tenancy isolation tests (PRD §13.2)
 *
 * Verifies that resources are scoped to the developer (org) and that
 * one org cannot access, modify, or list resources belonging to another org.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTestApp,
  seedAuth,
  authHeader,
  sqlMock,
  mockRedis,
  TEST_DEVELOPER,
  TEST_AGENT,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { signGrantToken } from '../src/lib/crypto.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// A second developer to test cross-org isolation
const TEST_DEVELOPER_B = { id: 'dev_other_org', name: 'Other Org', mode: 'live' };

describe('Multi-tenancy isolation', () => {
  // ── Agents ──────────────────────────────────────────────────────────────

  it('org A cannot read org B agent by ID (returns 404)', async () => {
    // Developer B created an agent, but developer A tries to GET it.
    // Auth as developer A
    seedAuth();
    // The SQL query includes `AND developer_id = ${developerId}` so it returns empty for A
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('org A list agents returns only its own agents', async () => {
    seedAuth();
    // SQL returns only agents for developer A — no cross-org leakage
    const devAAgent = { ...TEST_AGENT, developer_id: TEST_DEVELOPER.id };
    sqlMock.mockResolvedValueOnce([devAAgent]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: Array<{ developerId: string }> }>();
    for (const agent of body.agents) {
      expect(agent.developerId).toBe(TEST_DEVELOPER.id);
    }
  });

  it('org A cannot delete org B agent (returns 404)', async () => {
    seedAuth();
    // Ownership check returns empty because agent belongs to a different developer
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/agents/ag_OTHER_ORG_AGENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  // ── Grants ──────────────────────────────────────────────────────────────

  it('org A cannot view org B grant by ID (returns 404)', async () => {
    seedAuth();
    // SQL query has `AND developer_id = ${developerId}`, returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/grants/grnt_OTHER_ORG',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('org A cannot revoke org B grant (returns 404)', async () => {
    seedAuth();
    // revokeGrantCascade checks developer_id; grant not found for developer A
    sqlMock.mockResolvedValueOnce([]); // grant lookup
    sqlMock.mockResolvedValueOnce([]); // child grants

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/grants/grnt_OTHER_ORG',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  // ── Anomalies ───────────────────────────────────────────────────────────

  it('org A cannot view org B anomaly alerts', async () => {
    seedAuth();
    // The SQL query uses `WHERE developer_id = ${developerId}`, so developer A
    // only gets their own anomalies (empty in this case).
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomalies',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ anomalies: unknown[]; total: number }>();
    expect(body.anomalies).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('org A cannot acknowledge org B anomaly (returns 404)', async () => {
    seedAuth();
    // UPDATE ... WHERE id = :id AND developer_id = :developerId returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/anomalies/anm_OTHER_ORG/acknowledge',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // ── Token verification scoping ──────────────────────────────────────────

  it('org A token revocation does not affect org B tokens', async () => {
    seedAuth();
    // Revoke a token that belongs to a different developer → SQL UPDATE returns empty
    // because `AND g.developer_id = ${request.developer.id}` excludes it
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/revoke',
      headers: authHeader(),
      payload: { jti: 'tok_OTHER_DEV_TOKEN' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('grants/verify scoped by developer_id', async () => {
    seedAuth();
    // Fake a token that has a different dev claim
    const token = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_OTHER',
      dev: TEST_DEVELOPER_B.id,
      scp: ['read'],
      jti: 'tok_CROSS_ORG',
      grnt: 'grnt_CROSS_ORG',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/verify',
      headers: authHeader(),
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
    expect(res.json().reason).toBe('wrong_developer');
  });

  // ── Vault credentials ──────────────────────────────────────────────────

  it('org A cannot read org B vault credentials', async () => {
    seedAuth();
    // SQL: WHERE developer_id = ${developerId} AND id = ... → empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials/vc_OTHER_ORG',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('org A cannot delete org B vault credentials', async () => {
    seedAuth();
    // DELETE ... WHERE id = :id AND developer_id = :developerId → empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/vault/credentials/vc_OTHER_ORG',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // ── Domains ─────────────────────────────────────────────────────────────

  it('org A cannot verify org B domain', async () => {
    seedAuth();
    // Domain lookup with developer_id check returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains/dom_OTHER_ORG/verify',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('org A cannot delete org B domain', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/domains/dom_OTHER_ORG',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // ── Passports ───────────────────────────────────────────────────────────

  it('org A cannot retrieve org B passport (returns 404)', async () => {
    seedAuth();
    // SQL: WHERE id = :id AND developer_id = :developerId → empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passport/urn:grantex:passport:OTHER',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('org A cannot revoke org B passport (returns 404)', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/urn:grantex:passport:OTHER/revoke',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // ── Compliance ──────────────────────────────────────────────────────────

  it('org A compliance summary returns only org A data', async () => {
    seedAuth();
    // All 5 queries scoped to developer A
    sqlMock.mockResolvedValueOnce([{ total: '3', active: '2', suspended: '1', revoked: '0' }]); // agents
    sqlMock.mockResolvedValueOnce([{ total: '5', active: '4', revoked: '1', expired: '0' }]); // grants
    sqlMock.mockResolvedValueOnce([{ total: '10', success: '8', failure: '1', blocked: '1' }]); // audit
    sqlMock.mockResolvedValueOnce([{ total: '2' }]); // policies
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]); // subscription

    const res = await app.inject({
      method: 'GET',
      url: '/v1/compliance/summary',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The data returned is only for developer A — no cross-org data
    expect(body.agents.total).toBe(3);
    expect(body.plan).toBe('pro');
  });

  // ── Authorize scoping ──────────────────────────────────────────────────

  it('org A cannot create auth request for org B agent', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]); // subscription
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);   // grant count
    // Agent lookup: WHERE id = :agentId AND developer_id = :developerId → empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: 'ag_BELONGS_TO_ORG_B',
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
