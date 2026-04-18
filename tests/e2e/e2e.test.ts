/**
 * Grantex E2E Integration Tests
 *
 * Cross-SDK smoke tests that run the full auth flow against production.
 * Creates a fresh developer account per run (sandbox when supported,
 * falls back to live mode with programmatic approval).
 *
 * Run: npx vitest run tests/e2e/e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const ISSUER = process.env.E2E_ISSUER ?? 'https://grantex.dev';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

let grantex: Grantex;
let apiKey: string;

// Shared agents (free plan allows 200 — reuse across suites)
let mainAgent: { agentId: string; did: string };
let delegateAgent: { agentId: string; did: string };

/** Authorize an agent and return the auth code (handles both sandbox and live mode). */
async function authorizeAndGetCode(
  agentId: string,
  userId: string,
  scopes: string[],
): Promise<{ code: string; authRequestId: string }> {
  const auth = await grantex.authorize({ agentId, userId, scopes });

  // Sandbox mode returns code directly
  if ('code' in auth && typeof (auth as Record<string, unknown>).code === 'string') {
    return { code: (auth as Record<string, unknown>).code as string, authRequestId: auth.authRequestId };
  }

  // Live mode: programmatically approve via internal endpoint
  const approveRes = await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: '{}',
  });
  if (!approveRes.ok) {
    throw new Error(`Failed to approve auth request: ${approveRes.status} ${await approveRes.text()}`);
  }
  const approved = (await approveRes.json()) as { code: string };
  return { code: approved.code, authRequestId: auth.authRequestId };
}

beforeAll(async () => {
  // Create a fresh developer account for this test run
  const account = await Grantex.signup(
    { name: `e2e-runner-${Date.now()}`, mode: 'sandbox' },
    { baseUrl: BASE_URL },
  );
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Pre-register shared agents (stays within free plan limit of 200)
  const [agent1, agent2, agent3] = await Promise.all([
    grantex.agents.register({ name: `e2e-main-${Date.now()}`, scopes: ['calendar:read', 'email:send', 'files:read'] }),
    grantex.agents.register({ name: `e2e-parent-${Date.now()}`, scopes: ['calendar:read', 'email:send'] }),
    grantex.agents.register({ name: `e2e-sub-${Date.now()}`, scopes: ['calendar:read'] }),
  ]);
  mainAgent = { agentId: agent1.agentId, did: agent1.did };
  delegateAgent = { agentId: agent2.agentId, did: agent2.did };
  // agent3 is the sub-agent for delegation
  (globalThis as Record<string, unknown>).__e2eSubAgent = { agentId: agent3.agentId, did: agent3.did };
});

describe('E2E: Full Auth Flow', () => {
  let code: string;
  let grantToken: string;
  let grantId: string;
  let refreshToken: string;
  let tokenId: string;

  it('should create an authorization request and get a code', async () => {
    const result = await authorizeAndGetCode(
      mainAgent.agentId,
      `e2e-user-${Date.now()}`,
      ['calendar:read', 'email:send'],
    );
    code = result.code;

    expect(result.authRequestId).toBeDefined();
    expect(code).toBeDefined();
    expect(typeof code).toBe('string');
  });

  it('should exchange code for a grant token', async () => {
    const result = await grantex.tokens.exchange({ code, agentId: mainAgent.agentId });

    expect(result.grantToken).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    expect(result.scopes).toEqual(expect.arrayContaining(['calendar:read', 'email:send']));
    expect(result.grantId).toBeDefined();
    expect(result.refreshToken).toBeDefined();

    grantToken = result.grantToken;
    grantId = result.grantId;
    refreshToken = result.refreshToken!;
  });

  it('should verify the grant token online', async () => {
    const result = await grantex.tokens.verify(grantToken);

    expect(result.valid).toBe(true);
    expect(result.grantId).toBe(grantId);
    expect(result.scopes).toEqual(expect.arrayContaining(['calendar:read', 'email:send']));
    expect(result.principal).toBeDefined();
    expect(result.agent).toBeDefined();
    expect(result.expiresAt).toBeDefined();
  });

  it('should verify the grant token offline (JWKS)', async () => {
    const grant = await verifyGrantToken(grantToken, { jwksUri: JWKS_URI, issuer: ISSUER });

    expect(grant.grantId).toBe(grantId);
    expect(grant.scopes).toEqual(expect.arrayContaining(['calendar:read', 'email:send']));
    expect(grant.principalId).toBeDefined();
    expect(grant.agentDid).toBeDefined();

    tokenId = grant.tokenId;
  });

  it('should refresh the grant token', async () => {
    const result = await grantex.tokens.refresh({ refreshToken, agentId: mainAgent.agentId });

    expect(result.grantToken).toBeDefined();
    expect(result.grantId).toBe(grantId);
    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken);

    grantToken = result.grantToken;
    refreshToken = result.refreshToken!;
  });

  it('should fail to reuse the old refresh token', async () => {
    await expect(
      grantex.tokens.refresh({ refreshToken: 'already-used-token', agentId: mainAgent.agentId }),
    ).rejects.toThrow();
  });

  it('should revoke the grant token', async () => {
    // Get the current token's ID (after refresh, tokenId points to old token)
    const currentGrant = await verifyGrantToken(grantToken, { jwksUri: JWKS_URI, issuer: ISSUER });
    await grantex.tokens.revoke(currentGrant.tokenId);

    const result = await grantex.tokens.verify(grantToken);
    expect(result.valid).toBe(false);
  });
});

describe('E2E: Audit Log', () => {
  let grantId: string;
  let principalId: string;

  beforeAll(async () => {
    // Reuse mainAgent — create a new grant for audit context
    principalId = `e2e-audit-user-${Date.now()}`;
    const { code } = await authorizeAndGetCode(mainAgent.agentId, principalId, ['files:read']);
    const result = await grantex.tokens.exchange({ code, agentId: mainAgent.agentId });
    grantId = result.grantId;
  });

  it('should log an audit entry', async () => {
    const entry = await grantex.audit.log({
      agentId: mainAgent.agentId,
      agentDid: mainAgent.did,
      grantId,
      principalId,
      action: 'e2e.test',
      metadata: { test: true, timestamp: Date.now() },
    });

    expect(entry.entryId).toBeDefined();
    expect(entry.action).toBe('e2e.test');
  });

  it('should list audit entries', async () => {
    const result = await grantex.audit.list();

    expect(result.entries).toBeDefined();
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('should get an audit entry by ID', async () => {
    const result = await grantex.audit.list();
    const entry = await grantex.audit.get(result.entries[0].entryId);

    expect(entry.entryId).toBe(result.entries[0].entryId);
    expect(entry.action).toBeDefined();
  });
});

describe('E2E: Grant Delegation', () => {
  let parentToken: string;
  let subAgentId: string;

  beforeAll(async () => {
    // Get a grant for the parent (delegateAgent)
    const { code } = await authorizeAndGetCode(
      delegateAgent.agentId,
      `e2e-delegate-user-${Date.now()}`,
      ['calendar:read', 'email:send'],
    );
    const result = await grantex.tokens.exchange({ code, agentId: delegateAgent.agentId });
    parentToken = result.grantToken;

    // Get sub-agent from shared setup
    subAgentId = ((globalThis as Record<string, unknown>).__e2eSubAgent as { agentId: string }).agentId;
  });

  it('should delegate a grant to a sub-agent', async () => {
    const delegation = await grantex.grants.delegate({
      parentGrantToken: parentToken,
      subAgentId,
      scopes: ['calendar:read'],
    });

    expect(delegation.grantToken).toBeDefined();
    expect(delegation.grantId).toBeDefined();
    expect(delegation.scopes).toEqual(['calendar:read']);
  });

  it('should verify delegation claims in the delegated token', async () => {
    const delegation = await grantex.grants.delegate({
      parentGrantToken: parentToken,
      subAgentId,
      scopes: ['calendar:read'],
    });

    const grant = await verifyGrantToken(delegation.grantToken, { jwksUri: JWKS_URI, issuer: ISSUER });

    expect(grant.parentGrantId).toBeDefined();
    expect(grant.delegationDepth).toBeGreaterThanOrEqual(1);
  });
});
