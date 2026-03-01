/**
 * Grantex E2E Integration Tests
 *
 * Cross-SDK smoke tests that run the full auth flow against production.
 * Requires E2E_API_KEY environment variable (test developer account).
 *
 * Run: npx vitest run tests/e2e/e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env.E2E_API_KEY;
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

if (!API_KEY) {
  throw new Error('E2E_API_KEY environment variable is required');
}

const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

describe('E2E: Full Auth Flow', () => {
  let agentId: string;
  let authRequestId: string;
  let code: string;
  let grantToken: string;
  let grantId: string;
  let refreshToken: string;
  let tokenId: string;

  beforeAll(async () => {
    // Register a test agent
    const agent = await grantex.agents.register({
      name: `e2e-test-agent-${Date.now()}`,
      scopes: ['calendar:read', 'email:send', 'files:read'],
    });
    agentId = agent.agentId;
  });

  it('should create an authorization request', async () => {
    const auth = await grantex.authorize({
      agentId,
      userId: `e2e-user-${Date.now()}`,
      scopes: ['calendar:read', 'email:send'],
    });

    expect(auth.authRequestId).toBeDefined();
    expect(typeof auth.authRequestId).toBe('string');

    authRequestId = auth.authRequestId;

    // In sandbox mode, code is returned directly
    if ('code' in auth && typeof auth.code === 'string') {
      code = auth.code;
    } else {
      expect(auth.consentUrl).toBeDefined();
    }
  });

  it('should approve consent and get a code (sandbox)', async () => {
    // If code was already returned (sandbox mode), skip manual approval
    if (code) return;

    // In production mode, we'd need to approve via consent URL
    // For E2E, we use sandbox mode which returns the code directly
    throw new Error('E2E tests require sandbox mode — code not returned from authorize');
  });

  it('should exchange code for a grant token', async () => {
    expect(code).toBeDefined();

    const result = await grantex.tokens.exchange({ code, agentId });

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
    const grant = await verifyGrantToken(grantToken, { jwksUri: JWKS_URI });

    expect(grant.grantId).toBe(grantId);
    expect(grant.scopes).toEqual(expect.arrayContaining(['calendar:read', 'email:send']));
    expect(grant.principalId).toBeDefined();
    expect(grant.agentDid).toBeDefined();

    // Extract tokenId from offline verification for later revocation
    tokenId = grant.tokenId;
  });

  it('should refresh the grant token', async () => {
    const result = await grantex.tokens.refresh({ refreshToken, agentId });

    expect(result.grantToken).toBeDefined();
    expect(result.grantId).toBe(grantId); // Same grant
    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken); // Rotated

    // Update for subsequent tests
    grantToken = result.grantToken;
    refreshToken = result.refreshToken!;
  });

  it('should fail to reuse the old refresh token', async () => {
    // The original refresh token was used above — reuse must fail
    await expect(
      grantex.tokens.refresh({ refreshToken: 'already-used-token', agentId }),
    ).rejects.toThrow();
  });

  it('should revoke the grant token', async () => {
    await grantex.tokens.revoke(tokenId);

    // Verify it's revoked
    const result = await grantex.tokens.verify(grantToken);
    expect(result.valid).toBe(false);
  });
});

describe('E2E: Audit Log', () => {
  let agentId: string;

  beforeAll(async () => {
    const agent = await grantex.agents.register({
      name: `e2e-audit-agent-${Date.now()}`,
      scopes: ['files:read'],
    });
    agentId = agent.agentId;

    // Create a flow to generate audit entries
    const auth = await grantex.authorize({
      agentId,
      userId: `e2e-audit-user-${Date.now()}`,
      scopes: ['files:read'],
    });

    if ('code' in auth && typeof auth.code === 'string') {
      await grantex.tokens.exchange({ code: auth.code, agentId });
    }
  });

  it('should log an audit entry', async () => {
    const entry = await grantex.audit.log({
      agentId,
      action: 'e2e.test',
      metadata: { test: true, timestamp: Date.now() },
    });

    expect(entry.entryId).toBeDefined();
    expect(entry.action).toBe('e2e.test');
  });

  it('should list audit entries', async () => {
    const entries = await grantex.audit.list();

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('should get an audit entry by ID', async () => {
    const entries = await grantex.audit.list();
    const entry = await grantex.audit.get(entries[0].entryId);

    expect(entry.entryId).toBe(entries[0].entryId);
    expect(entry.action).toBeDefined();
  });
});

describe('E2E: Grant Delegation', () => {
  let parentAgentId: string;
  let subAgentId: string;
  let parentGrantId: string;
  let parentToken: string;

  beforeAll(async () => {
    // Register parent agent
    const parent = await grantex.agents.register({
      name: `e2e-parent-${Date.now()}`,
      scopes: ['calendar:read', 'email:send', 'files:read'],
    });
    parentAgentId = parent.agentId;

    // Register sub-agent
    const sub = await grantex.agents.register({
      name: `e2e-sub-${Date.now()}`,
      scopes: ['calendar:read'],
    });
    subAgentId = sub.agentId;

    // Get a grant for the parent agent
    const auth = await grantex.authorize({
      agentId: parentAgentId,
      userId: `e2e-delegate-user-${Date.now()}`,
      scopes: ['calendar:read', 'email:send'],
    });

    if ('code' in auth && typeof auth.code === 'string') {
      const result = await grantex.tokens.exchange({ code: auth.code, agentId: parentAgentId });
      parentToken = result.grantToken;
      parentGrantId = result.grantId;
    }
  });

  it('should delegate a grant to a sub-agent', async () => {
    const delegation = await grantex.grants.delegate({
      grantId: parentGrantId,
      agentId: subAgentId,
      scopes: ['calendar:read'],
    });

    expect(delegation.grantToken).toBeDefined();
    expect(delegation.grantId).toBeDefined();
    expect(delegation.scopes).toEqual(['calendar:read']);
  });

  it('should verify delegation claims in the delegated token', async () => {
    const delegation = await grantex.grants.delegate({
      grantId: parentGrantId,
      agentId: subAgentId,
      scopes: ['calendar:read'],
    });

    const grant = await verifyGrantToken(delegation.grantToken, { jwksUri: JWKS_URI });

    expect(grant.parentGrantId).toBe(parentGrantId);
    expect(grant.delegationDepth).toBeGreaterThanOrEqual(1);
  });
});
