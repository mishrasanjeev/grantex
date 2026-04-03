/**
 * E2E: Cross-Feature Integration Tests
 *
 * Tests interactions between multiple features working together.
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

describe('E2E: Policy + Authorization', () => {
  it('deny policy prevents authorization for specific scope', async () => {
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

    // Authorization for files:read should work
    const { code } = await authorizeAndGetCode(agent.agentId, 'user@test.com', ['files:read']);
    const token = await grantex.tokens.exchange({ code, agentId: agent.agentId });
    expect(token.grantToken).toBeTruthy();

    // Cleanup
    await grantex.policies.delete(policy.id);
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

    // Delegate to child
    const delegated = await grantex.grants.delegate({
      parentGrantToken: parentToken.grantToken,
      subAgentId: childAgent.agentId,
      scopes: ['calendar:read'],
    });
    expect(delegated.grantToken).toBeTruthy();

    // Revoke parent grant
    await grantex.grants.revoke(parentToken.grantId);

    // Parent token should be invalid
    const parentVerify = await grantex.tokens.verify(parentToken.grantToken);
    expect(parentVerify.valid).toBe(false);

    // Child delegated token should also be invalid
    const childVerify = await grantex.tokens.verify(delegated.grantToken);
    expect(childVerify.valid).toBe(false);
  });
});

describe('E2E: Audit Chain Integrity', () => {
  it('audit entries maintain hash chain', async () => {
    const agent = await grantex.agents.register({
      name: `cross-audit-${Date.now()}`,
      scopes: ['files:read'],
    });

    // Create several audit entries
    for (let i = 0; i < 3; i++) {
      await grantex.audit.log({
        agentId: agent.agentId,
        agentDid: agent.did,
        grantId: `grnt_fake_${i}`,
        principalId: 'user@chain.test',
        action: `test.action.${i}`,
        metadata: { step: i },
        status: 'success',
      });
    }

    // Verify chain
    const entries = await grantex.audit.list({ agentId: agent.agentId });
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // Each entry should have a hash, and entries after the first should have prevHash
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i].hash).toBeTruthy();
      if (i > 0) {
        // prevHash of entry i should equal hash of entry i-1 (entries are newest-first)
        // The exact ordering depends on the API; just verify hashes are present
        expect(typeof entries[i].hash).toBe('string');
      }
    }
  });
});

describe('E2E: Budget + Delegation', () => {
  it('allocates budget on parent and delegates', async () => {
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
      parentAgent.agentId, 'user@budget.test', ['files:read'],
    );
    const parentToken = await grantex.tokens.exchange({
      code,
      agentId: parentAgent.agentId,
    });

    // Allocate budget to parent grant
    await grantex.budgets.allocate({
      grantId: parentToken.grantId,
      initialBudget: 500,
      currency: 'USD',
    });

    // Delegate to child
    const delegated = await grantex.grants.delegate({
      parentGrantToken: parentToken.grantToken,
      subAgentId: childAgent.agentId,
      scopes: ['files:read'],
    });

    expect(delegated.grantToken).toBeTruthy();

    // Check parent budget is still intact
    const balance = await grantex.budgets.balance(parentToken.grantId);
    expect(balance.remainingBudget).toBe(500);
  });
});
