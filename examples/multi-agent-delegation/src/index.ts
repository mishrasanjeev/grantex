/**
 * Grantex Multi-Agent Delegation Example
 *
 * Demonstrates the delegation chain pattern (SPEC §9):
 *   1. Register a parent agent and a child agent
 *   2. Parent agent gets a grant token with broad scopes
 *   3. Parent delegates a subset of scopes to the child agent
 *   4. Child agent's token is verified with delegation metadata
 *   5. Revoking the parent grant cascade-revokes the child
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/multi-agent-delegation
 *   npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register parent and child agents ────────────────────────────
  const parentAgent = await grantex.agents.register({
    name: 'orchestrator-agent',
    description: 'Parent agent that coordinates tasks across sub-agents',
    scopes: ['calendar:read', 'calendar:write', 'email:read', 'email:send'],
  });
  console.log('Parent agent registered:', parentAgent.id);

  const childAgent = await grantex.agents.register({
    name: 'calendar-worker',
    description: 'Specialized agent for calendar operations only',
    scopes: ['calendar:read', 'calendar:write'],
  });
  console.log('Child agent registered:', childAgent.id);

  // ── 2. Parent agent gets a grant token ─────────────────────────────
  const parentAuth = await grantex.authorize({
    agentId: parentAgent.id,
    userId: 'user-alice',
    scopes: ['calendar:read', 'calendar:write', 'email:read', 'email:send'],
  });

  const parentCode = (parentAuth as unknown as Record<string, unknown>)['code'] as string;
  if (!parentCode) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }

  const parentToken = await grantex.tokens.exchange({
    code: parentCode,
    agentId: parentAgent.id,
  });
  console.log('\nParent grant token:');
  console.log('  grantId:', parentToken.grantId);
  console.log('  scopes:', parentToken.scopes.join(', '));

  // ── 3. Parent delegates to child with subset of scopes ────────────
  console.log('\nDelegating calendar scopes to child agent...');
  const delegatedToken = await grantex.grants.delegate({
    grantToken: parentToken.grantToken,
    agentId: childAgent.id,
    scopes: ['calendar:read'],  // Only a subset of parent's scopes
  });
  console.log('Child grant token:');
  console.log('  grantId:', delegatedToken.grantId);
  console.log('  scopes:', delegatedToken.scopes.join(', '));

  // ── 4. Verify the child token — shows delegation metadata ─────────
  console.log('\nVerifying child token offline...');
  const childVerified = await verifyGrantToken(delegatedToken.grantToken, {
    jwksUri: JWKS_URI,
  });
  console.log('Child token claims:');
  console.log('  principalId:', childVerified.principalId);
  console.log('  agentDid:', childVerified.agentDid);
  console.log('  scopes:', childVerified.scopes.join(', '));
  console.log('  delegationDepth:', childVerified.delegationDepth);
  if (childVerified.parentAgentDid) {
    console.log('  parentAgentDid:', childVerified.parentAgentDid);
  }
  if (childVerified.parentGrantId) {
    console.log('  parentGrantId:', childVerified.parentGrantId);
  }

  // ── 5. Both tokens are valid ───────────────────────────────────────
  const parentCheck = await grantex.tokens.verify(parentToken.grantToken);
  const childCheck = await grantex.tokens.verify(delegatedToken.grantToken);
  console.log('\nBefore revocation:');
  console.log('  Parent token valid:', parentCheck.valid);
  console.log('  Child token valid:', childCheck.valid);

  // ── 6. Revoke parent → cascades to child ──────────────────────────
  console.log('\nRevoking parent grant (cascade)...');
  await grantex.grants.revoke(parentToken.grantId);

  const parentCheckAfter = await grantex.tokens.verify(parentToken.grantToken);
  const childCheckAfter = await grantex.tokens.verify(delegatedToken.grantToken);
  console.log('After parent revocation:');
  console.log('  Parent token valid:', parentCheckAfter.valid, '(expected: false)');
  console.log('  Child token valid:', childCheckAfter.valid, '(expected: false — cascade revoked)');

  console.log('\nDone! Multi-agent delegation lifecycle complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
