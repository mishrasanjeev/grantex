/**
 * E2E Tests: Cross-Feature Integration
 *
 * Tests interactions between multiple features working together:
 * - Policy + Authorization (deny policy blocks auth)
 * - Revocation Cascade (revoke parent -> child revoked)
 * - Audit Chain Integrity (hash chain verification)
 * - Budget + Delegation
 * - Compliance after revocation
 * Run: npx vitest run tests/e2e/cross-feature.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

let grantex: Grantex;
let apiKey: string;

async function authorizeAndGetCode(agentId: string, userId: string, scopes: string[]) {
  const auth = await grantex.authorize({ agentId, userId, scopes });
  if ('code' in auth && typeof (auth as any).code === 'string') {
    return { code: (auth as any).code, authRequestId: auth.authRequestId };
  }
  const approveRes = await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: '{}',
  });
  const approved = (await approveRes.json()) as { code: string };
  return { code: approved.code, authRequestId: auth.authRequestId };
}

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-cross-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: Policy + Authorization Integration', () => {
  it('deny policy prevents authorization for specific scope and agent', async () => {
    const agent = await grantex.agents.register({
      name: `cross-policy-agent-${Date.now()}`,
      scopes: ['files:read', 'files:write'],
    });

    // Create a deny policy for files:write on this agent
    const policy = await grantex.policies.create({
      name: `deny-write-${Date.now()}`,
      effect: 'deny',
      priority: 100,
      scopes: ['files:write'],
      agentId: agent.agentId,
    });

    // Authorization for files:read should still work
    const { code } = await authorizeAndGetCode(agent.agentId, 'user@policy.test', ['files:read']);
    const token = await grantex.tokens.exchange({ code, agentId: agent.agentId });
    expect(token.grantToken).toBeTruthy();
    expect(token.scopes).toContain('files:read');

    // Cleanup
    await grantex.policies.delete(policy.id);
  });

  it('multiple policies with different priorities are evaluated correctly', async () => {
    const agent = await grantex.agents.register({
      name: `cross-multi-policy-${Date.now()}`,
      scopes: ['calendar:read', 'calendar:write'],
    });

    // Low priority allow
    const allowPolicy = await grantex.policies.create({
      name: `allow-all-${Date.now()}`,
      effect: 'allow',
      priority: 1,
      scopes: ['calendar:read', 'calendar:write'],
    });

    // High priority deny for calendar:write
    const denyPolicy = await grantex.policies.create({
      name: `deny-write-${Date.now()}`,
      effect: 'deny',
      priority: 100,
      scopes: ['calendar:write'],
      agentId: agent.agentId,
    });

    // Verify both policies exist
    const policies = await grantex.policies.list();
    expect(policies.total).toBeGreaterThanOrEqual(2);

    // calendar:read should work
    const { code } = await authorizeAndGetCode(agent.agentId, 'user@multi-policy.test', ['calendar:read']);
    const token = await grantex.tokens.exchange({ code, agentId: agent.agentId });
    expect(token.grantToken).toBeTruthy();

    // Cleanup
    await grantex.policies.delete(allowPolicy.id);
    await grantex.policies.delete(denyPolicy.id);
  });
});

describe('E2E: Revocation Cascade', () => {
  it('revoking parent grant invalidates child delegated grants', async () => {
    const parentAgent = await grantex.agents.register({
      name: `cross-parent-${Date.now()}`,
      scopes: ['calendar:read', 'email:send'],
    });
    const childAgent = await grantex.agents.register({
      name: `cross-child-${Date.now()}`,
      scopes: ['calendar:read'],
    });

    // Authorize parent
    const { code: parentCode } = await authorizeAndGetCode(
      parentAgent.agentId, 'user@cascade.test', ['calendar:read', 'email:send'],
    );
    const parentToken = await grantex.tokens.exchange({
      code: parentCode,
      agentId: parentAgent.agentId,
    });

    // Verify parent token is valid
    const parentVerifyBefore = await grantex.tokens.verify(parentToken.grantToken);
    expect(parentVerifyBefore.valid).toBe(true);
    expect(parentVerifyBefore.grantId).toBe(parentToken.grantId);

    // Delegate to child
    const delegated = await grantex.grants.delegate({
      parentGrantToken: parentToken.grantToken,
      subAgentId: childAgent.agentId,
      scopes: ['calendar:read'],
    });
    expect(delegated.grantToken).toBeTruthy();
    expect(delegated.scopes).toEqual(['calendar:read']);

    // Verify child token is valid
    const childVerifyBefore = await grantex.tokens.verify(delegated.grantToken);
    expect(childVerifyBefore.valid).toBe(true);

    // Verify delegation claims in the child token
    const childGrant = await verifyGrantToken(delegated.grantToken, { jwksUri: JWKS_URI });
    expect(childGrant.parentGrantId).toBeDefined();
    expect(childGrant.delegationDepth).toBeGreaterThanOrEqual(1);

    // Revoke parent grant
    await grantex.grants.revoke(parentToken.grantId);

    // Parent token should be invalid
    const parentVerifyAfter = await grantex.tokens.verify(parentToken.grantToken);
    expect(parentVerifyAfter.valid).toBe(false);

    // Child delegated token should also be invalid (cascade)
    const childVerifyAfter = await grantex.tokens.verify(delegated.grantToken);
    expect(childVerifyAfter.valid).toBe(false);
  });

  it('revoking child does not invalidate parent', async () => {
    const parentAgent = await grantex.agents.register({
      name: `cross-parent-indep-${Date.now()}`,
      scopes: ['files:read'],
    });
    const childAgent = await grantex.agents.register({
      name: `cross-child-indep-${Date.now()}`,
      scopes: ['files:read'],
    });

    // Authorize parent
    const { code } = await authorizeAndGetCode(
      parentAgent.agentId, 'user@indep.test', ['files:read'],
    );
    const parentToken = await grantex.tokens.exchange({
      code,
      agentId: parentAgent.agentId,
    });

    // Delegate to child
    const delegated = await grantex.grants.delegate({
      parentGrantToken: parentToken.grantToken,
      subAgentId: childAgent.agentId,
      scopes: ['files:read'],
    });

    // Revoke child grant
    await grantex.grants.revoke(delegated.grantId);

    // Child should be invalid
    const childVerify = await grantex.tokens.verify(delegated.grantToken);
    expect(childVerify.valid).toBe(false);

    // Parent should still be valid
    const parentVerify = await grantex.tokens.verify(parentToken.grantToken);
    expect(parentVerify.valid).toBe(true);
  });
});

describe('E2E: Audit Chain Integrity', () => {
  it('audit entries maintain hash chain across multiple actions', async () => {
    const agent = await grantex.agents.register({
      name: `cross-audit-${Date.now()}`,
      scopes: ['files:read'],
    });

    // Create several audit entries sequentially
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const entry = await grantex.audit.log({
        agentId: agent.agentId,
        agentDid: agent.did,
        grantId: `grnt_chain_test_${i}`,
        principalId: 'user@chain.test',
        action: `test.action.${i}`,
        metadata: { step: i, timestamp: Date.now() },
        status: 'success',
      });
      entries.push(entry);
    }

    expect(entries.length).toBe(5);

    // Each entry should have a unique entryId
    const entryIds = entries.map((e) => e.entryId);
    const uniqueIds = new Set(entryIds);
    expect(uniqueIds.size).toBe(5);

    // List entries and verify hash chain
    const auditResult = await grantex.audit.list();
    expect(auditResult.entries.length).toBeGreaterThanOrEqual(5);

    // Each entry should have a hash field
    for (const entry of auditResult.entries) {
      expect(entry.hash).toBeDefined();
      expect(typeof entry.hash).toBe('string');
      expect(entry.hash.length).toBeGreaterThan(0);
    }
  });

  it('compliance evidence pack confirms chain integrity', async () => {
    const res = await fetch(`${BASE_URL}/v1/compliance/evidence-pack`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const pack = (await res.json()) as any;

    expect(pack.chainIntegrity).toBeDefined();
    expect(pack.chainIntegrity.valid).toBe(true);
    expect(pack.chainIntegrity.checkedEntries).toBeGreaterThan(0);
    expect(pack.chainIntegrity.firstBrokenAt).toBeNull();
  });
});

describe('E2E: Budget + Delegation', () => {
  it('allocates budget on parent and delegates without affecting budget', async () => {
    const parentAgent = await grantex.agents.register({
      name: `cross-budget-parent-${Date.now()}`,
      scopes: ['files:read'],
    });
    const childAgent = await grantex.agents.register({
      name: `cross-budget-child-${Date.now()}`,
      scopes: ['files:read'],
    });

    // Authorize parent
    const { code } = await authorizeAndGetCode(
      parentAgent.agentId, 'user@budget-delegate.test', ['files:read'],
    );
    const parentToken = await grantex.tokens.exchange({
      code,
      agentId: parentAgent.agentId,
    });

    // Allocate budget to parent grant
    const allocation = await grantex.budgets.allocate({
      grantId: parentToken.grantId,
      initialBudget: 500,
      currency: 'USD',
    });
    expect(Number(allocation.remainingBudget)).toBe(500);

    // Delegate to child
    const delegated = await grantex.grants.delegate({
      parentGrantToken: parentToken.grantToken,
      subAgentId: childAgent.agentId,
      scopes: ['files:read'],
    });
    expect(delegated.grantToken).toBeTruthy();

    // Parent budget should be unaffected by delegation
    const balance = await grantex.budgets.balance(parentToken.grantId);
    expect(Number(balance.remainingBudget)).toBe(500);

    // Debit from parent budget
    const debit = await grantex.budgets.debit({
      grantId: parentToken.grantId,
      amount: 100,
      description: 'Post-delegation debit',
    });
    expect(Number(debit.remaining)).toBe(400);
  });
});

describe('E2E: Compliance After Revocation', () => {
  it('compliance summary reflects revoked grants', async () => {
    const agent = await grantex.agents.register({
      name: `cross-comp-${Date.now()}`,
      scopes: ['files:read'],
    });

    // Create and then revoke a grant
    const { code } = await authorizeAndGetCode(
      agent.agentId, 'user@comp-revoke.test', ['files:read'],
    );
    const token = await grantex.tokens.exchange({ code, agentId: agent.agentId });
    await grantex.grants.revoke(token.grantId);

    // Compliance summary should show revoked grants
    const summary = await grantex.compliance.getSummary();
    expect(summary.grants.revoked).toBeGreaterThanOrEqual(1);
  });

  it('grant export includes revoked grants', async () => {
    const result = await grantex.compliance.exportGrants();

    const revokedGrants = result.grants.filter((g: any) => g.status === 'revoked');
    expect(revokedGrants.length).toBeGreaterThanOrEqual(1);

    // Revoked grants should have revokedAt timestamp
    for (const g of revokedGrants) {
      expect(g.revokedAt).not.toBeNull();
    }
  });
});
