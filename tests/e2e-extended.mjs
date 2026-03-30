/**
 * Extended E2E Test Suite — covers flows not in the negative test suite:
 *
 *   1. Token refresh lifecycle (exchange → refresh → verify new token)
 *   2. Budget enforcement (allocate → debit → insufficient → 402)
 *   3. Principal sessions (create → verify fields)
 *   4. Webhook signature verification (valid, tampered, wrong secret)
 *   5. Concurrent access (race conditions on exchange/revoke)
 *   6. Payload edge cases (large metadata, many scopes, unicode)
 *   7. Grant listing & filtering
 *   8. Token introspection fields
 *
 * Run: node tests/e2e-extended.mjs
 */

import {
  Grantex,
  verifyGrantToken,
  verifyWebhookSignature,
  GrantexApiError,
} from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'gx_test_playground_demo_2026';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function setupAgent(name, scopes = ['calendar:read', 'email:send']) {
  const agent = await grantex.agents.register({ name: `ext-${name}-${Date.now()}`, description: 'extended test', scopes });
  const agentId = agent.id ?? agent['agentId'];
  const auth = await grantex.authorize({ agentId, userId: 'ext-test-user', scopes });
  const code = auth.code ?? auth['code'];
  const token = await grantex.tokens.exchange({ code, agentId });
  return { agentId, ...token };
}

// ════════════════════════════════════════════════════════════════════
// 1. TOKEN REFRESH LIFECYCLE
// ════════════════════════════════════════════════════════════════════

async function test_token_refresh() {
  console.log('\n── 1. Token Refresh Lifecycle ──');

  const { agentId, grantToken, refreshToken, grantId, scopes } = await setupAgent('refresh');

  ok(!!refreshToken, 'Exchange returns refreshToken');
  ok(!!grantId, 'Exchange returns grantId');

  // Verify original token
  const original = await grantex.tokens.verify(grantToken);
  ok(original.valid === true, 'Original token is valid');

  // Refresh
  const refreshed = await grantex.tokens.refresh({ refreshToken, agentId });
  ok(!!refreshed.grantToken, 'Refresh returns new grantToken');
  ok(!!refreshed.refreshToken, 'Refresh returns new refreshToken');
  ok(refreshed.grantId === grantId, 'Refresh preserves grantId');
  ok(JSON.stringify(refreshed.scopes) === JSON.stringify(scopes), 'Refresh preserves scopes');

  // New token is valid
  const newVerify = await grantex.tokens.verify(refreshed.grantToken);
  ok(newVerify.valid === true, 'Refreshed token is valid');

  // Old refresh token should be invalidated (rotated)
  try {
    await grantex.tokens.refresh({ refreshToken, agentId }); // replay old refresh token
    ok(false, 'Old refresh token replay should fail');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Old refresh token rejected (${err.statusCode})`);
  }

  // Offline verify the refreshed token
  const offlineVerified = await verifyGrantToken(refreshed.grantToken, { jwksUri: JWKS_URI });
  ok(offlineVerified.grantId === grantId, 'Offline verify refreshed token — same grantId');
}

// ════════════════════════════════════════════════════════════════════
// 2. BUDGET ENFORCEMENT
// ════════════════════════════════════════════════════════════════════

async function test_budget_enforcement() {
  console.log('\n── 2. Budget Enforcement ──');

  const { agentId, grantToken, grantId } = await setupAgent('budget');

  // Allocate budget
  const allocation = await grantex.budgets.allocate({ grantId, initialBudget: 100.00, currency: 'USD' });
  ok(Math.abs(allocation.initialBudget - 100) < 0.01, `Allocated budget: $${allocation.initialBudget}`);
  ok(Math.abs(allocation.remainingBudget - 100) < 0.01, `Remaining: $${allocation.remainingBudget}`);

  // Debit
  const debit1 = await grantex.budgets.debit({ grantId, amount: 30, description: 'API call' });
  ok(Math.abs(debit1.remaining - 70) < 0.01, `After $30 debit: $${debit1.remaining} remaining`);

  // Check balance
  const balance = await grantex.budgets.balance(grantId);
  ok(Math.abs(balance.remainingBudget - 70) < 0.01, `Balance check: $${balance.remainingBudget}`);

  // Debit more
  await grantex.budgets.debit({ grantId, amount: 50, description: 'Big call' });

  // Debit beyond remaining → should fail with 402
  try {
    await grantex.budgets.debit({ grantId, amount: 50, description: 'Exceeds budget' });
    ok(false, 'Exceeding budget should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Insufficient budget → GrantexApiError`);
    ok(err.statusCode === 402 || err.code === 'INSUFFICIENT_BUDGET', `Status: ${err.statusCode}, code: ${err.code}`);
  }

  // Transactions list
  const txns = await grantex.budgets.transactions(grantId);
  ok(txns.transactions.length >= 2, `${txns.transactions.length} transactions recorded`);

  // Allocate on non-existent grant
  try {
    await grantex.budgets.allocate({ grantId: 'grnt_nonexistent', initialBudget: 100 });
    ok(false, 'Budget on non-existent grant should throw');
  } catch (err) {
    ok(err instanceof GrantexApiError, `Non-existent grant budget → GrantexApiError (${err.statusCode})`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. PRINCIPAL SESSIONS
// ════════════════════════════════════════════════════════════════════

async function test_principal_sessions() {
  console.log('\n── 3. Principal Sessions ──');

  // Create session
  const session = await grantex.principalSessions.create({ principalId: 'ext-test-user' });
  ok(!!session.sessionToken, 'Session created with sessionToken');
  ok(!!session.dashboardUrl, `Dashboard URL: ${session.dashboardUrl.slice(0, 50)}...`);
  ok(!!session.expiresAt, `Expires at: ${session.expiresAt}`);

  // Create with custom expiry
  const shortSession = await grantex.principalSessions.create({ principalId: 'ext-test-user', expiresIn: '5m' });
  ok(!!shortSession.sessionToken, 'Short session created');

  // Create for principal that already has grants (from earlier tests)
  const existingPrincipal = await grantex.principalSessions.create({ principalId: 'ext-test-user' });
  ok(!!existingPrincipal.sessionToken, 'Existing principal session created');
}

// ════════════════════════════════════════════════════════════════════
// 4. WEBHOOK SIGNATURE VERIFICATION
// ════════════════════════════════════════════════════════════════════

async function test_webhook_verification() {
  console.log('\n── 4. Webhook Signature Verification ──');

  const secret = 'whsec_test_secret_for_verification';
  const payload = JSON.stringify({ event: 'grant.revoked', grantId: 'grnt_01' });

  // Compute valid signature
  const { createHmac } = await import('node:crypto');
  const validSig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

  // Valid signature
  ok(verifyWebhookSignature(payload, validSig, secret) === true, 'Valid signature verified');

  // Tampered payload
  ok(verifyWebhookSignature(payload + 'tampered', validSig, secret) === false, 'Tampered payload rejected');

  // Wrong secret
  ok(verifyWebhookSignature(payload, validSig, 'wrong_secret') === false, 'Wrong secret rejected');

  // Empty signature
  ok(verifyWebhookSignature(payload, '', secret) === false, 'Empty signature rejected');

  // Garbage signature
  ok(verifyWebhookSignature(payload, 'sha256=0000000000', secret) === false, 'Garbage signature rejected');

  // Buffer payload
  ok(verifyWebhookSignature(Buffer.from(payload), validSig, secret) === true, 'Buffer payload verified');

  // Different event payload
  const payload2 = JSON.stringify({ event: 'token.exchanged', agentId: 'ag_01' });
  const sig2 = 'sha256=' + createHmac('sha256', secret).update(payload2).digest('hex');
  ok(verifyWebhookSignature(payload2, sig2, secret) === true, 'Different event payload verified');
  ok(verifyWebhookSignature(payload2, validSig, secret) === false, 'Cross-event signature rejected');
}

// ════════════════════════════════════════════════════════════════════
// 5. CONCURRENT ACCESS
// ════════════════════════════════════════════════════════════════════

async function test_concurrent_access() {
  console.log('\n── 5. Concurrent Access ──');

  // Register 3 agents concurrently
  const results = await Promise.allSettled([
    grantex.agents.register({ name: `conc-a-${Date.now()}`, description: 'concurrent A', scopes: ['read'] }),
    grantex.agents.register({ name: `conc-b-${Date.now()}`, description: 'concurrent B', scopes: ['read'] }),
    grantex.agents.register({ name: `conc-c-${Date.now()}`, description: 'concurrent C', scopes: ['read'] }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  ok(fulfilled.length === 3, `3 concurrent registrations: ${fulfilled.length}/3 succeeded`);

  // Concurrent verify calls on same token
  const { grantToken } = await setupAgent('conc-verify');
  const verifyResults = await Promise.allSettled([
    grantex.tokens.verify(grantToken),
    grantex.tokens.verify(grantToken),
    grantex.tokens.verify(grantToken),
  ]);
  const allValid = verifyResults
    .filter(r => r.status === 'fulfilled')
    .every(r => r.value.valid === true);
  ok(allValid, 'Concurrent verify calls all return valid');

  // Concurrent revoke of same grant — one succeeds, others get 404
  const { grantId: revokeTarget } = await setupAgent('conc-revoke');
  const revokeResults = await Promise.allSettled([
    grantex.grants.revoke(revokeTarget),
    grantex.grants.revoke(revokeTarget),
  ]);
  const revokeSucceeded = revokeResults.filter(r => r.status === 'fulfilled').length;
  const revokeFailed = revokeResults.filter(r => r.status === 'rejected').length;
  ok(revokeSucceeded >= 1, `Concurrent revoke: ${revokeSucceeded} succeeded, ${revokeFailed} got expected error`);
}

// ════════════════════════════════════════════════════════════════════
// 6. PAYLOAD EDGE CASES
// ════════════════════════════════════════════════════════════════════

async function test_payload_edge_cases() {
  console.log('\n── 6. Payload Edge Cases ──');

  const { agentId, grantToken, grantId } = await setupAgent('payload');
  const agentDid = `did:grantex:${agentId}`;

  // Large metadata in audit log
  const largeMeta = {};
  for (let i = 0; i < 50; i++) {
    largeMeta[`key_${i}`] = `value_${i}_${'x'.repeat(100)}`;
  }
  try {
    const entry = await grantex.audit.log({
      agentId, agentDid, grantId, principalId: 'ext-test-user',
      action: 'large_metadata_test',
      status: 'success',
      metadata: largeMeta,
    });
    ok(!!entry.entryId, `Large metadata (${JSON.stringify(largeMeta).length} bytes) accepted`);
  } catch (err) {
    ok(err instanceof GrantexApiError, `Large metadata → GrantexApiError (${err.statusCode})`);
  }

  // Unicode in agent name and metadata
  const unicodeAgent = await grantex.agents.register({
    name: `unicode-日本語-émojis-🤖-${Date.now()}`,
    description: 'Ünïcödé тест agent 中文',
    scopes: ['read'],
  });
  const unicodeId = unicodeAgent.id ?? unicodeAgent['agentId'];
  ok(!!unicodeId, `Unicode agent created: ${unicodeId}`);

  // Unicode in audit metadata
  try {
    await grantex.audit.log({
      agentId, agentDid, grantId, principalId: 'ext-test-user',
      action: 'unicode_test',
      status: 'success',
      metadata: { message: '日本語テスト 中文测试 émojis 🎉🚀' },
    });
    ok(true, 'Unicode metadata accepted');
  } catch (err) {
    ok(false, `Unicode metadata rejected: ${err.message}`);
  }

  // Many scopes
  const manyScopes = Array.from({ length: 20 }, (_, i) => `scope:${i}`);
  try {
    const msAgent = await grantex.agents.register({
      name: `many-scopes-${Date.now()}`,
      description: 'test',
      scopes: manyScopes,
    });
    ok(!!(msAgent.id ?? msAgent['agentId']), `Agent with ${manyScopes.length} scopes created`);
  } catch (err) {
    ok(err instanceof GrantexApiError, `Many scopes → GrantexApiError (${err.statusCode})`);
  }

  // Special characters in action name
  try {
    await grantex.audit.log({
      agentId, agentDid, grantId, principalId: 'ext-test-user',
      action: 'action/with:special.chars-and_underscores',
      status: 'success',
    });
    ok(true, 'Special chars in action name accepted');
  } catch (err) {
    ok(false, `Special chars rejected: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 7. GRANT LISTING & FILTERING
// ════════════════════════════════════════════════════════════════════

async function test_grant_listing() {
  console.log('\n── 7. Grant Listing & Filtering ──');

  const { agentId, grantId } = await setupAgent('listing');

  // List grants for agent
  const grants = await grantex.grants.list({ agentId });
  ok(grants.grants.length >= 1, `Found ${grants.grants.length} grants for agent`);

  // Get specific grant
  const grant = await grantex.grants.get(grantId);
  ok(grant.agentId === agentId || grant['agentId'] === agentId, 'Grant belongs to correct agent');
  ok(grant.status === 'active', `Grant status: ${grant.status}`);

  // List by principalId
  const principalGrants = await grantex.grants.list({ principalId: 'ext-test-user' });
  ok(principalGrants.grants.length >= 1, `Found ${principalGrants.grants.length} grants for principal`);

  // List by status
  const activeGrants = await grantex.grants.list({ agentId, status: 'active' });
  ok(activeGrants.grants.every(g => g.status === 'active'), 'All listed grants are active');

  // Revoke and list revoked
  await grantex.grants.revoke(grantId);
  const revokedGrants = await grantex.grants.list({ agentId, status: 'revoked' });
  ok(revokedGrants.grants.some(g => g.grantId === grantId || g.id === grantId), 'Revoked grant appears in revoked list');
}

// ════════════════════════════════════════════════════════════════════
// 8. TOKEN INTROSPECTION FIELDS
// ════════════════════════════════════════════════════════════════════

async function test_token_introspection() {
  console.log('\n── 8. Token Introspection Fields ──');

  const { agentId, grantToken, grantId } = await setupAgent('introspect', ['calendar:read', 'email:send']);

  // Online verify — check all returned fields
  const verified = await grantex.tokens.verify(grantToken);
  ok(verified.valid === true, 'Token is valid');
  ok(!!verified.grantId, `grantId: ${verified.grantId}`);
  ok(Array.isArray(verified.scopes), `scopes: [${verified.scopes}]`);
  ok(verified.scopes.includes('calendar:read'), 'Has calendar:read scope');
  ok(verified.scopes.includes('email:send'), 'Has email:send scope');
  ok(!!verified.expiresAt, `expiresAt: ${verified.expiresAt}`);

  // Offline verify — check claim fields
  const offline = await verifyGrantToken(grantToken, { jwksUri: JWKS_URI });
  ok(!!offline.tokenId, `tokenId (jti): ${offline.tokenId}`);
  ok(!!offline.grantId, `grantId (grnt): ${offline.grantId}`);
  ok(!!offline.principalId, `principalId (sub): ${offline.principalId}`);
  ok(!!offline.agentDid, `agentDid (agt): ${offline.agentDid}`);
  ok(!!offline.developerId, `developerId (dev): ${offline.developerId}`);
  ok(typeof offline.issuedAt === 'number', `issuedAt: ${offline.issuedAt}`);
  ok(typeof offline.expiresAt === 'number', `expiresAt: ${offline.expiresAt}`);
  ok(offline.expiresAt > offline.issuedAt, 'expiresAt > issuedAt');
}

// ════════════════════════════════════════════════════════════════════
// RUN ALL
// ════════════════════════════════════════════════════════════════════

console.log('Extended E2E Tests against production');
console.log(`Target: ${BASE_URL}\n`);

const sections = [
  ['Token Refresh', test_token_refresh],
  ['Budget Enforcement', test_budget_enforcement],
  ['Principal Sessions', test_principal_sessions],
  ['Webhook Verification', test_webhook_verification],
  ['Concurrent Access', test_concurrent_access],
  ['Payload Edge Cases', test_payload_edge_cases],
  ['Grant Listing', test_grant_listing],
  ['Token Introspection', test_token_introspection],
];

for (let i = 0; i < sections.length; i++) {
  const [name, fn] = sections[i];
  if (i > 0 && i % 2 === 0) {
    console.log('\n  ⏳ Rate limit cooldown...');
    await delay(15000);
  }
  try {
    await fn();
  } catch (err) {
    if (err.message?.includes('Rate limit')) {
      console.log(`  ⏳ Rate limited in ${name}, waiting 60s...`);
      await delay(60000);
      try { await fn(); } catch (retryErr) {
        failed++;
        console.log(`  ✗ CRASH in ${name} (retry): ${retryErr.message}`);
      }
    } else {
      failed++;
      console.log(`  ✗ CRASH in ${name}: ${err.message}`);
      if (err.stack) console.log(`    ${err.stack.split('\n')[1]}`);
    }
  }
  await delay(3000);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
