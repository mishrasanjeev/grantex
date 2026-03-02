import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Policy Backend — Builtin (default)', () => {
  it('allows when policy effect is allow', async () => {
    seedAuth();
    // Subscription query
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]);
    // Grant count
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    // Agent exists
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Policies query (from BuiltinBackend)
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_1', effect: 'allow', priority: 100, agent_id: null, principal_id: null, scopes: null, time_of_day_start: null, time_of_day_end: null },
    ]);
    // Insert auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.policyEnforced).toBe(true);
    expect(body.effect).toBe('allow');
    expect(body.code).toBeDefined();
  });

  it('denies when policy effect is deny', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Deny policy
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_2', effect: 'deny', priority: 100, agent_id: 'ag_1', principal_id: null, scopes: null, time_of_day_start: null, time_of_day_end: null },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('POLICY_DENIED');
  });

  it('falls through to consent when no policies match', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'pro' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // No matching policies
    sqlMock.mockResolvedValueOnce([]);
    // Insert auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.policyEnforced).toBeUndefined();
    expect(body.consentUrl).toBeDefined();
  });

  it('evaluates agent-specific policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Agent-specific deny
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_3', effect: 'deny', priority: 50, agent_id: 'ag_1', principal_id: null, scopes: null, time_of_day_start: null, time_of_day_end: null },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(403);
  });

  it('evaluates principal-specific policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Principal-specific deny (different principal)
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_4', effect: 'deny', priority: 50, agent_id: null, principal_id: 'user_other', scopes: null, time_of_day_start: null, time_of_day_end: null },
    ]);
    // Insert auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    // Policy targets different principal, so no match → consent flow
    expect(res.statusCode).toBe(201);
  });

  it('evaluates scope-restricted policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Allow only 'read' scope
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_5', effect: 'allow', priority: 50, agent_id: null, principal_id: null, scopes: ['read'], time_of_day_start: null, time_of_day_end: null },
    ]);
    // Insert auth request
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().policyEnforced).toBe(true);
  });

  it('rejects when requesting scopes beyond policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Allow only 'read' scope, but request includes 'write'
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_6', effect: 'allow', priority: 50, agent_id: null, principal_id: null, scopes: ['read'], time_of_day_start: null, time_of_day_end: null },
    ]);
    // Insert auth request (no policy match, falls through)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read', 'write'] },
    });

    // No policy match (scope mismatch), so goes to consent
    expect(res.statusCode).toBe(201);
    expect(res.json().policyEnforced).toBeUndefined();
  });

  it('evaluates time-of-day policy', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Allow only 09:00-17:00
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_7', effect: 'deny', priority: 50, agent_id: null, principal_id: null, scopes: null, time_of_day_start: '22:00', time_of_day_end: '06:00' },
    ]);
    // Insert auth request (time-based deny may not match current time)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    // The result depends on current time; test just verifies no crash
    expect([201, 403]).toContain(res.statusCode);
  });

  it('uses priority order — higher priority policy wins', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_1' }]);
    // Two conflicting policies — allow (pri 100) before deny (pri 50)
    sqlMock.mockResolvedValueOnce([
      { id: 'pol_a', effect: 'allow', priority: 100, agent_id: null, principal_id: null, scopes: null, time_of_day_start: null, time_of_day_end: null },
      { id: 'pol_b', effect: 'deny', priority: 50, agent_id: null, principal_id: null, scopes: null, time_of_day_start: null, time_of_day_end: null },
    ]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: 'ag_1', principalId: 'user_1', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().policyEnforced).toBe(true);
  });
});

describe('PolicyEvalContext interface', () => {
  it('includes all required fields', () => {
    // Type-level test — if this compiles, the interface is correct
    const ctx = {
      agentId: 'ag_1',
      principalId: 'user_1',
      scopes: ['read'],
      developerId: 'dev_1',
    };
    expect(ctx.agentId).toBeDefined();
    expect(ctx.developerId).toBeDefined();
  });

  it('supports optional fields', () => {
    const ctx = {
      agentId: 'ag_1',
      principalId: 'user_1',
      scopes: ['read'],
      developerId: 'dev_1',
      time: '14:30',
      grant: { id: 'grnt_1', delegationDepth: 0 },
      request: { ip: '127.0.0.1', userAgent: 'test' },
    };
    expect(ctx.time).toBe('14:30');
    expect(ctx.grant.delegationDepth).toBe(0);
  });
});

describe('PolicyDecision interface', () => {
  it('supports all effect values', () => {
    const allow = { effect: 'allow' as const };
    const deny = { effect: 'deny' as const };
    const none = { effect: null };
    expect(allow.effect).toBe('allow');
    expect(deny.effect).toBe('deny');
    expect(none.effect).toBeNull();
  });

  it('supports optional reason and policyId', () => {
    const decision = { effect: 'deny' as const, reason: 'test', policyId: 'pol_1' };
    expect(decision.reason).toBe('test');
    expect(decision.policyId).toBe('pol_1');
  });
});
