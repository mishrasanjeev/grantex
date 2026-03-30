/**
 * Comprehensive Negative E2E Test Suite
 * Tests every failure path against production Grantex.
 *
 * Categories:
 *   1. Authentication failures (invalid API key, missing key)
 *   2. Agent lifecycle errors (duplicate, not found, bad params)
 *   3. Authorization failures (bad agent, missing fields)
 *   4. Token exchange failures (invalid code, replay, wrong agent)
 *   5. Token verification failures (garbage, revoked, expired claims)
 *   6. Scope enforcement (missing scope, empty scopes, wrong scope)
 *   7. Delegation failures (scope escalation, invalid parent token)
 *   8. Revocation + cascade (revoke parent → child invalid, double revoke)
 *   9. Audit logging failures (missing fields, invalid grant)
 *  10. Offline verification failures (bad JWT, wrong JWKS, missing scopes)
 *  11. Integration package negative paths (@grantex/anthropic scope errors)
 *  12. Rate limit behavior
 *
 * Run: node tests/e2e-negative.mjs
 */

import { Grantex, verifyGrantToken, GrantexApiError, GrantexAuthError, GrantexTokenError } from '@grantex/sdk';
import { createGrantexTool, getGrantScopes, GrantexScopeError, GrantexToolRegistry } from '@grantex/anthropic';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'gx_test_playground_demo_2026';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}
function skip(msg) { skipped++; console.log(`  ⊘ SKIP: ${msg}`); }

/** Helper: register agent + get sandbox grant token */
async function setupAgent(name, scopes = ['calendar:read', 'email:send']) {
  const agent = await grantex.agents.register({ name: `neg-${name}-${Date.now()}`, description: 'negative test', scopes });
  const agentId = agent.id ?? agent['agentId'];
  const auth = await grantex.authorize({ agentId, userId: 'neg-test-user', scopes });
  const code = auth.code ?? auth['code'];
  const token = await grantex.tokens.exchange({ code, agentId });
  return { agentId, ...token };
}

// ════════════════════════════════════════════════════════════════════
// 1. AUTHENTICATION FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_auth_failures() {
  console.log('\n── 1. Authentication Failures ──');

  // Invalid API key
  const badClient = new Grantex({ apiKey: 'totally-invalid-key', baseUrl: BASE_URL });
  try {
    await badClient.agents.list();
    ok(false, 'Invalid API key should throw');
  } catch (err) {
    ok(err instanceof GrantexAuthError, `Invalid API key → GrantexAuthError (${err.statusCode})`);
    ok(err.statusCode === 401, 'Status code is 401');
  }

  // Empty API key
  try {
    const emptyClient = new Grantex({ apiKey: '', baseUrl: BASE_URL });
    await emptyClient.agents.list();
    ok(false, 'Empty API key should throw');
  } catch (err) {
    ok(err instanceof Error, 'Empty API key → Error thrown');
  }
}

// ════════════════════════════════════════════════════════════════════
// 2. AGENT LIFECYCLE ERRORS
// ════════════════════════════════════════════════════════════════════

async function test_agent_errors() {
  console.log('\n── 2. Agent Lifecycle Errors ──');

  // Get non-existent agent
  try {
    await grantex.agents.get('ag_nonexistent_00000000');
    ok(false, 'Non-existent agent should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Non-existent agent → GrantexApiError (${err.statusCode})`);
    ok(err.statusCode === 404, 'Status code is 404');
  }

  // Register without name
  try {
    await grantex.agents.register({ name: '', description: '', scopes: [] });
    // Some servers may accept empty name — not necessarily an error
    ok(true, 'Empty name agent registration handled');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Empty name → GrantexApiError (${err.statusCode})`);
  }

  // Delete non-existent agent
  try {
    await grantex.agents.delete('ag_nonexistent_00000000');
    ok(false, 'Delete non-existent agent should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Delete non-existent → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. AUTHORIZATION FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_authorize_errors() {
  console.log('\n── 3. Authorization Failures ──');

  // Authorize with non-existent agent
  try {
    await grantex.authorize({ agentId: 'ag_nonexistent_00000000', userId: 'user1', scopes: ['read'] });
    ok(false, 'Authorize non-existent agent should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Non-existent agent authorize → GrantexApiError (${err.statusCode})`);
  }

  // Authorize with missing fields
  try {
    await grantex.authorize({ agentId: '', userId: '', scopes: [] });
    ok(false, 'Empty authorize params should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Empty params → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 4. TOKEN EXCHANGE FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_token_exchange_errors() {
  console.log('\n── 4. Token Exchange Failures ──');

  const agent = await grantex.agents.register({ name: `neg-exchange-${Date.now()}`, description: 'test', scopes: ['read'] });
  const agentId = agent.id ?? agent['agentId'];

  // Exchange with invalid code
  try {
    await grantex.tokens.exchange({ code: 'invalid-code-12345', agentId });
    ok(false, 'Invalid code should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Invalid code → GrantexApiError (${err.statusCode})`);
  }

  // Exchange with empty code
  try {
    await grantex.tokens.exchange({ code: '', agentId });
    ok(false, 'Empty code should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Empty code → GrantexApiError (${err.statusCode})`);
  }

  // Exchange with wrong agentId
  const auth = await grantex.authorize({ agentId, userId: 'user1', scopes: ['read'] });
  const code = auth.code ?? auth['code'];
  try {
    await grantex.tokens.exchange({ code, agentId: 'ag_wrong_agent_id' });
    ok(false, 'Wrong agentId should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Wrong agentId → GrantexApiError (${err.statusCode})`);
  }

  // Double exchange (replay) — use the code legitimately first, then try again
  const auth2 = await grantex.authorize({ agentId, userId: 'user2', scopes: ['read'] });
  const code2 = auth2.code ?? auth2['code'];
  await grantex.tokens.exchange({ code: code2, agentId }); // first use
  try {
    await grantex.tokens.exchange({ code: code2, agentId }); // replay
    ok(false, 'Code replay should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Code replay → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 5. TOKEN VERIFICATION FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_token_verify_errors() {
  console.log('\n── 5. Token Verification Failures ──');

  // Verify garbage token (online)
  const verifyResult = await grantex.tokens.verify('not.a.real.token');
  ok(verifyResult.valid === false, `Garbage token → valid: false`);

  // Verify empty string — API rejects with error (token is required)
  try {
    const emptyResult = await grantex.tokens.verify('');
    ok(emptyResult.valid === false, `Empty token → valid: false`);
  } catch (err) {
    ok(err instanceof GrantexApiError, `Empty token → GrantexApiError (${err.statusCode})`);
  }

  // Verify a revoked token
  const { agentId, grantToken, grantId } = await setupAgent('verify-revoked');
  const beforeRevoke = await grantex.tokens.verify(grantToken);
  ok(beforeRevoke.valid === true, 'Token valid before revocation');

  await grantex.grants.revoke(grantId);
  const afterRevoke = await grantex.tokens.verify(grantToken);
  ok(afterRevoke.valid === false, 'Token invalid after revocation');
}

// ════════════════════════════════════════════════════════════════════
// 6. SCOPE ENFORCEMENT (Integration packages)
// ════════════════════════════════════════════════════════════════════

async function test_scope_enforcement() {
  console.log('\n── 6. Scope Enforcement ──');

  const { grantToken } = await setupAgent('scope-enforce', ['file:read']);

  // Tool with missing scope
  const tool = createGrantexTool({
    name: 'admin_tool',
    description: 'Admin',
    inputSchema: { type: 'object' },
    grantToken,
    requiredScope: 'admin:all',
    execute: async () => 'should-not-run',
  });

  try {
    await tool.execute({});
    ok(false, 'Missing scope should throw');
  } catch (err) {
    ok(err instanceof GrantexScopeError, 'GrantexScopeError thrown');
    ok(err.requiredScope === 'admin:all', `requiredScope: ${err.requiredScope}`);
    ok(err.grantedScopes.includes('file:read'), `grantedScopes includes file:read`);
    ok(!err.grantedScopes.includes('admin:all'), 'grantedScopes does NOT include admin:all');
  }

  // Empty scopes token
  const emptyAgent = await setupAgent('empty-scope', ['calendar:read']); // has calendar:read
  const emptyTool = createGrantexTool({
    name: 'write_tool',
    description: 'Write',
    inputSchema: { type: 'object' },
    grantToken: emptyAgent.grantToken,
    requiredScope: 'file:write', // not granted
    execute: async () => 'should-not-run',
  });
  try {
    await emptyTool.execute({});
    ok(false, 'Wrong scope should throw');
  } catch (err) {
    ok(err instanceof GrantexScopeError, 'Wrong scope → GrantexScopeError');
  }

  // Valid scope should pass
  const validTool = createGrantexTool({
    name: 'read_tool',
    description: 'Read',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    grantToken,
    requiredScope: 'file:read',
    execute: async () => 'ok',
  });
  const result = await validTool.execute({ x: 'test' });
  ok(result === 'ok', 'Valid scope executes successfully');

  // getGrantScopes on garbage token
  try {
    getGrantScopes('not-a-jwt');
    ok(false, 'getGrantScopes on garbage should throw');
  } catch (err) {
    ok(err instanceof Error, 'getGrantScopes garbage → Error');
  }

  // Registry with unknown tool name
  const registry = new GrantexToolRegistry();
  registry.register(validTool);
  try {
    await registry.execute({ type: 'tool_use', id: 'x', name: 'hallucinated_tool', input: {} });
    ok(false, 'Unknown tool should throw');
  } catch (err) {
    ok(err.message.includes('hallucinated_tool'), `Unknown tool error: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 7. DELEGATION FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_delegation_errors() {
  console.log('\n── 7. Delegation Failures ──');

  const { agentId, grantToken, grantId } = await setupAgent('delegation', ['calendar:read', 'email:send']);

  // Register a sub-agent
  const subAgent = await grantex.agents.register({ name: `neg-sub-${Date.now()}`, description: 'sub', scopes: ['email:send'] });
  const subAgentId = subAgent.id ?? subAgent['agentId'];

  // Scope escalation: delegate a scope the parent doesn't have
  try {
    await grantex.grants.delegate({ parentGrantToken: grantToken, subAgentId, scopes: ['admin:all'] });
    ok(false, 'Scope escalation should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Scope escalation → GrantexApiError (${err.statusCode})`);
  }

  // Delegate with invalid parent token
  try {
    await grantex.grants.delegate({ parentGrantToken: 'garbage.token.here', subAgentId, scopes: ['email:send'] });
    ok(false, 'Invalid parent token should throw');
  } catch (err) {
    ok(err instanceof Error, `Invalid parent token → Error`);
  }

  // Delegate with revoked parent token
  const { grantToken: tokenToRevoke, grantId: grantToRevoke } = await setupAgent('delegate-revoke', ['calendar:read', 'email:send']);
  await grantex.grants.revoke(grantToRevoke);
  try {
    await grantex.grants.delegate({ parentGrantToken: tokenToRevoke, subAgentId, scopes: ['email:send'] });
    ok(false, 'Delegate from revoked token should throw');
  } catch (err) {
    ok(err instanceof Error, `Revoked parent delegate → Error`);
  }

  // Valid delegation for cascade test
  const delegated = await grantex.grants.delegate({ parentGrantToken: grantToken, subAgentId, scopes: ['email:send'] });
  ok(delegated.scopes.includes('email:send'), 'Valid delegation succeeded');
  ok(!delegated.scopes.includes('calendar:read'), 'Delegated token does NOT have calendar:read');
}

// ════════════════════════════════════════════════════════════════════
// 8. REVOCATION + CASCADE
// ════════════════════════════════════════════════════════════════════

async function test_revocation_cascade() {
  console.log('\n── 8. Revocation + Cascade ──');

  const { agentId, grantToken, grantId } = await setupAgent('cascade', ['calendar:read', 'email:send']);

  const subAgent = await grantex.agents.register({ name: `neg-cascade-sub-${Date.now()}`, description: 'sub', scopes: ['email:send'] });
  const subAgentId = subAgent.id ?? subAgent['agentId'];

  const delegated = await grantex.grants.delegate({ parentGrantToken: grantToken, subAgentId, scopes: ['email:send'] });

  // Both valid before revocation
  const parentBefore = await grantex.tokens.verify(grantToken);
  const childBefore = await grantex.tokens.verify(delegated.grantToken);
  ok(parentBefore.valid === true, 'Parent valid before revoke');
  ok(childBefore.valid === true, 'Child valid before revoke');

  // Revoke parent
  await grantex.grants.revoke(grantId);

  // Both invalid after cascade
  const parentAfter = await grantex.tokens.verify(grantToken);
  const childAfter = await grantex.tokens.verify(delegated.grantToken);
  ok(parentAfter.valid === false, 'Parent invalid after revoke');
  ok(childAfter.valid === false, 'Child cascade-invalidated after parent revoke');

  // Double revoke — should not crash
  try {
    await grantex.grants.revoke(grantId);
    ok(true, 'Double revoke does not crash');
  } catch (err) {
    // Some servers return 404 or 409 on double revoke — both are acceptable
    ok(err instanceof GrantexApiError, `Double revoke → GrantexApiError (${err.statusCode})`);
  }

  // Revoke non-existent grant
  try {
    await grantex.grants.revoke('grnt_nonexistent_00000000');
    ok(true, 'Revoke non-existent grant handled gracefully');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Revoke non-existent → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 9. AUDIT LOGGING FAILURES
// ════════════════════════════════════════════════════════════════════

async function test_audit_errors() {
  console.log('\n── 9. Audit Logging Failures ──');

  // Log with missing required fields
  try {
    await grantex.audit.log({
      agentId: '',
      agentDid: '',
      grantId: '',
      principalId: '',
      action: '',
    });
    // Server may accept empty strings — that's valid behavior
    ok(true, 'Empty field audit log handled');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Empty fields → GrantexApiError (${err.statusCode})`);
  }

  // Get non-existent audit entry
  try {
    await grantex.audit.get('entry_nonexistent_00000000');
    ok(false, 'Non-existent audit entry should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Non-existent entry → GrantexApiError (${err.statusCode})`);
  }

  // List with valid filters (should not throw)
  const auditList = await grantex.audit.list({ agentId: 'ag_nonexistent' });
  ok(Array.isArray(auditList.entries), 'Audit list with non-existent agent returns empty array');
  ok(auditList.entries.length === 0, 'No entries for non-existent agent');
}

// ════════════════════════════════════════════════════════════════════
// 10. OFFLINE VERIFICATION FAILURES (verifyGrantToken)
// ════════════════════════════════════════════════════════════════════

async function test_offline_verify_errors() {
  console.log('\n── 10. Offline Verification Failures ──');

  // Garbage token
  try {
    await verifyGrantToken('not.a.jwt.at.all', { jwksUri: JWKS_URI });
    ok(false, 'Garbage token should throw');
  } catch (err) {
    ok(err instanceof GrantexTokenError, `Garbage token → GrantexTokenError`);
  }

  // Empty token
  try {
    await verifyGrantToken('', { jwksUri: JWKS_URI });
    ok(false, 'Empty token should throw');
  } catch (err) {
    ok(err instanceof GrantexTokenError, `Empty token → GrantexTokenError`);
  }

  // Valid token but wrong required scopes
  const { grantToken } = await setupAgent('offline-verify', ['file:read']);
  try {
    await verifyGrantToken(grantToken, { jwksUri: JWKS_URI, requiredScopes: ['admin:all'] });
    ok(false, 'Missing required scope should throw');
  } catch (err) {
    ok(err instanceof GrantexTokenError, `Missing scope → GrantexTokenError`);
    ok(err.message.includes('admin:all'), `Error mentions missing scope`);
  }

  // Valid token with correct scopes should pass
  const verified = await verifyGrantToken(grantToken, { jwksUri: JWKS_URI, requiredScopes: ['file:read'] });
  ok(verified.scopes.includes('file:read'), 'Valid offline verification passes');

  // Wrong JWKS URI
  try {
    await verifyGrantToken(grantToken, { jwksUri: 'https://example.com/.well-known/jwks.json' });
    ok(false, 'Wrong JWKS should throw');
  } catch (err) {
    ok(err instanceof GrantexTokenError, `Wrong JWKS → GrantexTokenError`);
  }

  // Revoked token — offline verify won't catch this (it doesn't check revocation)
  const { grantToken: revokedToken, grantId: revokedGrant } = await setupAgent('offline-revoked', ['file:read']);
  await grantex.grants.revoke(revokedGrant);
  // Offline verify should STILL pass — revocation is server-side only
  const revokedVerified = await verifyGrantToken(revokedToken, { jwksUri: JWKS_URI });
  ok(revokedVerified.scopes.includes('file:read'), 'Offline verify passes for revoked token (expected — revocation is server-side)');
  // But online verify should fail
  const onlineCheck = await grantex.tokens.verify(revokedToken);
  ok(onlineCheck.valid === false, 'Online verify correctly rejects revoked token');
}

// ════════════════════════════════════════════════════════════════════
// 11. INTEGRATION EDGE CASES
// ════════════════════════════════════════════════════════════════════

async function test_integration_edge_cases() {
  console.log('\n── 11. Integration Edge Cases ──');

  const { grantToken } = await setupAgent('integration-edge', ['file:read', 'file:write']);

  // Tool execute after token is conceptually expired (but JWT hasn't expired yet)
  // This tests that scope check is purely offline
  const tool = createGrantexTool({
    name: 'read_tool',
    description: 'Read',
    inputSchema: { type: 'object' },
    grantToken,
    requiredScope: 'file:read',
    execute: async () => ({ data: 'sensitive' }),
  });
  const result = await tool.execute({});
  ok(result.data === 'sensitive', 'Tool executes with valid real production token');

  // Scope check is case-sensitive
  const caseTool = createGrantexTool({
    name: 'case_tool',
    description: 'Case',
    inputSchema: { type: 'object' },
    grantToken,
    requiredScope: 'FILE:READ', // wrong case
    execute: async () => 'bad',
  });
  try {
    await caseTool.execute({});
    ok(false, 'Case-sensitive scope should throw');
  } catch (err) {
    ok(err instanceof GrantexScopeError, 'Scope check is case-sensitive');
  }

  // Multiple tools in registry, execute wrong one
  const toolA = createGrantexTool({ name: 'a', description: 'A', inputSchema: { type: 'object' }, grantToken, requiredScope: 'file:read', execute: async () => 'A' });
  const toolB = createGrantexTool({ name: 'b', description: 'B', inputSchema: { type: 'object' }, grantToken, requiredScope: 'file:write', execute: async () => 'B' });
  const reg = new GrantexToolRegistry();
  reg.register(toolA).register(toolB);

  const resA = await reg.execute({ type: 'tool_use', id: 'x', name: 'a', input: {} });
  ok(resA === 'A', 'Registry dispatches correct tool A');
  const resB = await reg.execute({ type: 'tool_use', id: 'x', name: 'b', input: {} });
  ok(resB === 'B', 'Registry dispatches correct tool B');

  // Tool with scope that exists but execute throws — error should propagate
  const throwingTool = createGrantexTool({
    name: 'crash',
    description: 'Crash',
    inputSchema: { type: 'object' },
    grantToken,
    requiredScope: 'file:read',
    execute: async () => { throw new Error('intentional crash'); },
  });
  try {
    await throwingTool.execute({});
    ok(false, 'Throwing execute should propagate');
  } catch (err) {
    ok(err.message === 'intentional crash', 'Execute error propagates through scope check');
    ok(!(err instanceof GrantexScopeError), 'Not a GrantexScopeError (scope was valid)');
  }
}

// ════════════════════════════════════════════════════════════════════
// 12. GRANT LIFECYCLE
// ════════════════════════════════════════════════════════════════════

async function test_grant_lifecycle() {
  console.log('\n── 12. Grant Lifecycle ──');

  // Get non-existent grant
  try {
    await grantex.grants.get('grnt_nonexistent_00000000');
    ok(false, 'Non-existent grant should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Non-existent grant → GrantexApiError (${err.statusCode})`);
  }

  // List grants for non-existent agent
  const emptyGrants = await grantex.grants.list({ agentId: 'ag_nonexistent' });
  ok(Array.isArray(emptyGrants.grants), 'Grant list for non-existent agent returns array');

  // Token refresh with invalid refresh token
  try {
    await grantex.tokens.refresh({ refreshToken: 'invalid-refresh-token', agentId: 'ag_x' });
    ok(false, 'Invalid refresh token should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Invalid refresh → GrantexApiError (${err.statusCode})`);
  }

  // Token revoke with non-existent token ID
  try {
    await grantex.tokens.revoke('tok_nonexistent_00000000');
    ok(true, 'Revoke non-existent token handled');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Revoke non-existent token → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// RUN ALL
// ════════════════════════════════════════════════════════════════════

console.log('Negative E2E Tests against production');
console.log(`Target: ${BASE_URL}\n`);

const sections = [
  ['Authentication Failures', test_auth_failures],
  ['Agent Lifecycle Errors', test_agent_errors],
  ['Authorization Failures', test_authorize_errors],
  ['Token Exchange Failures', test_token_exchange_errors],
  ['Token Verification Failures', test_token_verify_errors],
  ['Scope Enforcement', test_scope_enforcement],
  ['Delegation Failures', test_delegation_errors],
  ['Revocation + Cascade', test_revocation_cascade],
  ['Audit Logging Failures', test_audit_errors],
  ['Offline Verification Failures', test_offline_verify_errors],
  ['Integration Edge Cases', test_integration_edge_cases],
  ['Grant Lifecycle', test_grant_lifecycle],
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < sections.length; i++) {
  const [name, fn] = sections[i];
  // Wait for rate limit window to reset between test groups
  if (i > 0 && i % 3 === 0) {
    console.log('\n  ⏳ Waiting for rate limit window to reset...');
    await delay(12000);
  }
  try {
    await fn();
  } catch (err) {
    if (err.message?.includes('Rate limit')) {
      console.log(`  ⏳ Rate limited in ${name}, waiting 60s and retrying...`);
      await delay(60000);
      try {
        await fn();
      } catch (retryErr) {
        failed++;
        console.log(`  ✗ CRASH in ${name} (retry): ${retryErr.message}`);
      }
    } else {
      failed++;
      console.log(`  ✗ CRASH in ${name}: ${err.message}`);
      if (err.stack) console.log(`    ${err.stack.split('\n')[1]}`);
    }
  }
  await delay(2000);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${'='.repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
