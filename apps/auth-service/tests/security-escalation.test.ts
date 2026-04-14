/**
 * Authorization escalation prevention tests (PRD §13.3)
 *
 * Verifies that the system prevents unauthorized privilege escalation:
 * - Unauthenticated access to protected endpoints
 * - Sandbox mode restrictions
 * - Developer ownership checks on cross-resource operations
 * - Scope-limited tokens cannot perform elevated actions
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

const ACTIVE_PARENT_ROW = {
  is_revoked: false,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  grant_status: 'active',
};

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Authorization escalation prevention', () => {
  // ── Missing auth on protected endpoints ──────────────────────────────────

  describe('unauthenticated access to protected resources', () => {
    const protectedEndpoints = [
      { method: 'POST' as const, url: '/v1/agents', payload: { name: 'test' } },
      { method: 'GET' as const, url: '/v1/agents' },
      { method: 'GET' as const, url: '/v1/grants' },
      { method: 'POST' as const, url: '/v1/authorize', payload: { agentId: 'a', principalId: 'p', scopes: ['r'] } },
      { method: 'GET' as const, url: '/v1/anomalies' },
      { method: 'POST' as const, url: '/v1/anomalies/detect' },
      { method: 'GET' as const, url: '/v1/compliance/summary' },
      { method: 'GET' as const, url: '/v1/compliance/export/grants' },
      { method: 'GET' as const, url: '/v1/compliance/export/audit' },
      { method: 'POST' as const, url: '/v1/audit/log', payload: { agentId: 'a', agentDid: 'd', grantId: 'g', principalId: 'p', action: 'test' } },
      { method: 'GET' as const, url: '/v1/audit/entries' },
      { method: 'GET' as const, url: '/v1/domains' },
      { method: 'POST' as const, url: '/v1/domains', payload: { domain: 'test.com' } },
      { method: 'GET' as const, url: '/v1/passports' },
      { method: 'POST' as const, url: '/v1/tokens/revoke', payload: { jti: 'tok_x' } },
      { method: 'GET' as const, url: '/v1/vault/credentials' },
      { method: 'GET' as const, url: '/v1/usage' },
    ];

    for (const ep of protectedEndpoints) {
      it(`returns 401 for ${ep.method} ${ep.url} without auth`, async () => {
        const res = await app.inject({
          method: ep.method,
          url: ep.url,
          ...(ep.payload ? { payload: ep.payload } : {}),
        });

        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('UNAUTHORIZED');
      });
    }
  });

  // ── Invalid API key ──────────────────────────────────────────────────────

  it('rejects invalid API key with 401', async () => {
    // Auth lookup returns empty — no matching developer for this key
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer invalid-key-12345' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed Authorization header (no Bearer prefix)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Basic dGVzdDp0ZXN0' },
    });

    expect(res.statusCode).toBe(401);
  });

  // ── Agent ownership checks on authorize ──────────────────────────────────

  it('cannot create auth request for agent not owned by developer', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);    // grant count
    // Agent lookup: developer_id check fails
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: 'ag_NOT_MINE',
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  // ── Delegation scope escalation ──────────────────────────────────────────

  it('rejects delegation that escalates scopes beyond parent', async () => {
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['read'],
      jti: 'tok_PARENT_SCOPE',
      grnt: 'grnt_PARENT_SCOPE',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    seedAuth();
    mockRedis.get.mockResolvedValue(null); // not revoked
    sqlMock.mockResolvedValueOnce([ACTIVE_PARENT_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_SUB',
        scopes: ['read', 'write', 'admin'], // exceeds parent's ['read']
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/exceed parent/);
  });

  it('rejects delegation with revoked parent token', async () => {
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['read', 'write'],
      jti: 'tok_REVOKED_PARENT',
      grnt: 'grnt_REVOKED_PARENT',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    seedAuth();
    // Parent token is revoked in Redis
    mockRedis.get.mockResolvedValueOnce('1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_SUB',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/revoked/);
  });

  // ── Passport issuance for non-owned agent ────────────────────────────────

  it('cannot issue passport for agent not owned by developer', async () => {
    seedAuth();
    // Agent lookup returns empty — agent not found for this developer
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: 'ag_NOT_MINE',
        grantId: 'grnt_X',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_AGENT');
  });

  // ── Passport issuance with revoked grant ─────────────────────────────────

  it('cannot issue passport for revoked grant', async () => {
    seedAuth();
    // Agent found
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant found but revoked
    sqlMock.mockResolvedValueOnce([{
      id: 'grnt_REV',
      scopes: ['payments:mpp:inference'],
      principal_id: 'user_123',
      status: 'revoked',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      delegation_depth: 0,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_REV',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_GRANT');
  });

  // ── Custom domains require enterprise plan ───────────────────────────────

  it('custom domain registration blocked on free plan', async () => {
    seedAuth();
    // Subscription: free plan
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: authHeader(),
      payload: { domain: 'example.com' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('custom domain registration blocked on pro plan', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: authHeader(),
      payload: { domain: 'example.com' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  // ── Plan limit enforcement ───────────────────────────────────────────────

  it('agent creation blocked when plan limit reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription
    sqlMock.mockResolvedValueOnce([{ count: '500' }]); // agent count equals free limit (500)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Over Limit Agent', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('grant creation blocked when plan limit reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription
    sqlMock.mockResolvedValueOnce([{ count: '1000' }]); // grant count equals free limit (1000)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  // ── Vault exchange requires valid grant token ────────────────────────────

  it('vault credential exchange rejects missing bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      payload: { service: 'github' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('vault credential exchange rejects invalid grant token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: 'Bearer invalid.jwt.token' },
      payload: { service: 'github' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});
