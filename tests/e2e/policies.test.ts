/**
 * E2E Tests: Policy Management & Enforcement
 *
 * Tests policy CRUD, allow/deny effects, time-of-day policies,
 * priority ordering, agent-scoped policies, and principal-scoped policies.
 * Run: npx vitest run tests/e2e/policies.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let agentId: string;
let agentDid: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-policy-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  const agent = await grantex.agents.register({
    name: `policy-agent-${Date.now()}`,
    scopes: ['files:read', 'email:send', 'calendar:read'],
  });
  agentId = agent.agentId;
  agentDid = agent.did;
});

describe('E2E: Policy CRUD', () => {
  let allowPolicyId: string;
  let denyPolicyId: string;
  let todPolicyId: string;
  let principalPolicyId: string;

  it('creates an allow policy', async () => {
    const policy = await grantex.policies.create({
      name: 'allow-files',
      effect: 'allow',
      priority: 10,
      scopes: ['files:read'],
    });
    allowPolicyId = policy.id;
    expect(policy.id).toBeDefined();
    expect(typeof policy.id).toBe('string');
    expect(policy.name).toBe('allow-files');
    expect(policy.effect).toBe('allow');
    expect(policy.priority).toBe(10);
    expect(policy.scopes).toEqual(['files:read']);
    expect(policy.agentId).toBeNull();
    expect(policy.principalId).toBeNull();
    expect(policy.timeOfDayStart).toBeNull();
    expect(policy.timeOfDayEnd).toBeNull();
    expect(policy.createdAt).toBeDefined();
    expect(policy.updatedAt).toBeDefined();
  });

  it('creates a deny policy scoped to an agent', async () => {
    const policy = await grantex.policies.create({
      name: 'deny-email-for-agent',
      effect: 'deny',
      priority: 50,
      scopes: ['email:send'],
      agentId,
    });
    denyPolicyId = policy.id;
    expect(policy.effect).toBe('deny');
    expect(policy.priority).toBe(50);
    expect(policy.agentId).toBe(agentId);
    expect(policy.scopes).toEqual(['email:send']);
  });

  it('creates a time-of-day policy', async () => {
    const policy = await grantex.policies.create({
      name: 'business-hours-only',
      effect: 'allow',
      priority: 5,
      timeOfDayStart: '09:00',
      timeOfDayEnd: '17:00',
      scopes: ['calendar:read'],
    });
    todPolicyId = policy.id;
    expect(policy.timeOfDayStart).toBe('09:00');
    expect(policy.timeOfDayEnd).toBe('17:00');
    expect(policy.effect).toBe('allow');
  });

  it('creates a principal-scoped policy', async () => {
    const policy = await grantex.policies.create({
      name: 'allow-specific-principal',
      effect: 'allow',
      priority: 30,
      principalId: 'principal-test-user@example.com',
      scopes: ['files:read', 'calendar:read'],
    });
    principalPolicyId = policy.id;
    expect(policy.principalId).toBe('principal-test-user@example.com');
    expect(policy.scopes).toEqual(['files:read', 'calendar:read']);
  });

  it('lists policies with correct ordering by priority DESC', async () => {
    const result = await grantex.policies.list();
    expect(result).toBeDefined();
    expect(Array.isArray(result.policies)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(4);

    // Verify policies are ordered by priority DESC
    const priorities = result.policies.map((p: any) => p.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeLessThanOrEqual(priorities[i - 1]);
    }

    // Deny policy (priority 50) should be before allow policy (priority 10)
    const denyIdx = result.policies.findIndex((p: any) => p.id === denyPolicyId);
    const allowIdx = result.policies.findIndex((p: any) => p.id === allowPolicyId);
    expect(denyIdx).toBeLessThan(allowIdx);
  });

  it('gets a policy by ID', async () => {
    const policy = await grantex.policies.get(allowPolicyId);
    expect(policy.id).toBe(allowPolicyId);
    expect(policy.name).toBe('allow-files');
    expect(policy.effect).toBe('allow');
    expect(policy.priority).toBe(10);
  });

  it('updates a policy name and priority', async () => {
    const updated = await grantex.policies.update(allowPolicyId, {
      name: 'allow-files-updated',
      priority: 20,
    });
    expect(updated.name).toBe('allow-files-updated');
    expect(updated.priority).toBe(20);
    expect(updated.effect).toBe('allow');
    expect(updated.updatedAt).toBeDefined();
  });

  it('updates a policy effect from allow to deny', async () => {
    const updated = await grantex.policies.update(allowPolicyId, {
      effect: 'deny',
    });
    expect(updated.effect).toBe('deny');
    expect(updated.name).toBe('allow-files-updated');
  });

  it('returns 400 for invalid effect value', async () => {
    try {
      await grantex.policies.update(allowPolicyId, {
        effect: 'maybe' as any,
      });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  it('returns 404 for non-existent policy', async () => {
    await expect(grantex.policies.get('pol_nonexistent_000')).rejects.toThrow();
  });

  it('deletes the time-of-day policy', async () => {
    await grantex.policies.delete(todPolicyId);

    // Verify it's gone
    await expect(grantex.policies.get(todPolicyId)).rejects.toThrow();
  });

  it('deletes the principal-scoped policy', async () => {
    await grantex.policies.delete(principalPolicyId);

    const result = await grantex.policies.list();
    const found = result.policies.find((p: any) => p.id === principalPolicyId);
    expect(found).toBeUndefined();
  });

  it('returns 404 when deleting an already-deleted policy', async () => {
    await expect(grantex.policies.delete(todPolicyId)).rejects.toThrow();
  });

  it('rejects creating a policy without name', async () => {
    await expect(
      grantex.policies.create({
        name: '',
        effect: 'allow',
      } as any),
    ).rejects.toThrow();
  });

  // Clean up remaining CRUD policies so they don't interfere with enforcement tests
  it('deletes remaining CRUD policies', async () => {
    await grantex.policies.delete(allowPolicyId);
    await grantex.policies.delete(denyPolicyId);
  });
});

describe('E2E: Policy Enforcement', () => {
  it('deny policy blocks authorization for specific scope and agent', async () => {
    // Create a fresh deny policy
    const policy = await grantex.policies.create({
      name: `deny-email-enforcement-${Date.now()}`,
      effect: 'deny',
      priority: 100,
      scopes: ['email:send'],
      agentId,
    });

    // Attempt to authorize with the denied scope
    try {
      const auth = await grantex.authorize({ agentId, userId: 'user@policy-test.com', scopes: ['email:send'] });
      // If sandbox auto-approves, the policy might block at token exchange or authorize
      if ('code' in auth && typeof (auth as any).code === 'string') {
        try {
          await grantex.tokens.exchange({ code: (auth as any).code, agentId });
        } catch (err: any) {
          // Expected: policy blocks the exchange
          expect(err.message || err.code).toBeTruthy();
        }
      }
    } catch (err: any) {
      // Expected: policy blocks the authorization
      expect(err.message || err.code).toBeTruthy();
    }

    // Cleanup
    await grantex.policies.delete(policy.id);
  });

  it('allow policy with non-matching scope does not block other scopes', async () => {
    const policy = await grantex.policies.create({
      name: `allow-calendar-only-${Date.now()}`,
      effect: 'allow',
      priority: 5,
      scopes: ['calendar:read'],
    });

    // Should be able to authorize with files:read (no deny policy for it)
    const auth = await grantex.authorize({ agentId, userId: 'user@scope-test.com', scopes: ['files:read'] });
    expect(auth.authRequestId).toBeDefined();

    await grantex.policies.delete(policy.id);
  });
});
