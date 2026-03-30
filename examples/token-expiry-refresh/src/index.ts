/**
 * Grantex Token Expiry & Refresh — Time-Bound Grants
 *
 * Demonstrates how to work with short-lived grant tokens and the
 * refresh token rotation pattern:
 *
 *   1. Register an agent and authorize with a short-lived token (10s)
 *   2. Use the token successfully before it expires
 *   3. Wait for the token to expire, detect expiry (offline + online)
 *   4. Refresh the expired token — get a new JWT with the same grantId
 *   5. Use the refreshed token successfully
 *   6. Demonstrate refresh token rotation (old refresh token is single-use)
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/token-expiry-refresh
 *   npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

const TOKEN_TTL = process.env['TOKEN_TTL'] ?? '10s';

/** Handle agent.id vs agentId API response gotcha */
function getAgentId(agent: Record<string, unknown>): string {
  return (agent['id'] ?? agent['agentId']) as string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register agent ──────────────────────────────────────────
  console.log('=== Token Expiry & Refresh Demo ===\n');

  const agentRaw = await grantex.agents.register({
    name: 'time-sensitive-agent',
    description: 'Agent with a short-lived grant token for expiry demo',
    scopes: ['calendar:read', 'email:send'],
  });
  const agentId = getAgentId(agentRaw as unknown as Record<string, unknown>);
  console.log('Agent registered:', agentId);

  // ── 2. Authorize with short-lived token ────────────────────────
  console.log(`\n--- Authorizing with ${TOKEN_TTL} TTL ---`);

  const authRequest = await grantex.authorize({
    agentId,
    userId: 'user-alice',
    scopes: ['calendar:read', 'email:send'],
    expiresIn: TOKEN_TTL,
  });

  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }

  const tokenResponse = await grantex.tokens.exchange({ code, agentId });
  console.log('Grant token received:');
  console.log('  grantId:     ', tokenResponse.grantId);
  console.log('  scopes:      ', tokenResponse.scopes.join(', '));
  console.log('  expiresAt:   ', tokenResponse.expiresAt);
  console.log('  refreshToken:', tokenResponse.refreshToken.slice(0, 12) + '...');

  const savedRefreshToken = tokenResponse.refreshToken;

  // ── 3. Use token before expiry ─────────────────────────────────
  console.log('\n--- Using token before expiry ---');

  const verified = await verifyGrantToken(tokenResponse.grantToken, {
    jwksUri: JWKS_URI,
    requiredScopes: ['calendar:read'],
  });
  console.log('Offline verification: PASSED');
  console.log('  principalId:', verified.principalId);
  console.log('  scopes:     ', verified.scopes.join(', '));

  const onlineCheck = await grantex.tokens.verify(tokenResponse.grantToken);
  console.log('Online verification:  valid =', onlineCheck.valid);

  // ── 4. Wait for expiry ─────────────────────────────────────────
  const ttlSeconds = parseInt(TOKEN_TTL.replace(/[^0-9]/g, ''), 10);
  const waitMs = (ttlSeconds + 2) * 1000;  // wait TTL + 2s buffer

  console.log(`\n--- Waiting ${ttlSeconds + 2}s for token to expire ---`);
  for (let i = ttlSeconds + 2; i > 0; i--) {
    process.stdout.write(`  ${i}s remaining...\r`);
    await sleep(1000);
  }
  console.log('  Token should now be expired.       ');

  // Detect expiry offline
  console.log('\n--- Detecting expiry ---');
  try {
    await verifyGrantToken(tokenResponse.grantToken, { jwksUri: JWKS_URI });
    console.log('ERROR: should not reach here');
  } catch (err) {
    console.log('Offline verification: EXPIRED');
    console.log('  Error:', (err as Error).message);
  }

  // Detect expiry online
  const expiredCheck = await grantex.tokens.verify(tokenResponse.grantToken);
  console.log('Online verification:  valid =', expiredCheck.valid, '(expected: false)');

  // ── 5. Refresh the token ───────────────────────────────────────
  console.log('\n--- Refreshing token ---');

  const refreshed = await grantex.tokens.refresh({
    refreshToken: savedRefreshToken,
    agentId,
  });
  console.log('Token refreshed successfully!');
  console.log('  grantId:      ', refreshed.grantId, '(same as original)');
  console.log('  new expiresAt:', refreshed.expiresAt);
  console.log('  scopes:       ', refreshed.scopes.join(', '));

  // ── 6. Use refreshed token ─────────────────────────────────────
  console.log('\n--- Using refreshed token ---');

  const refreshedVerified = await verifyGrantToken(refreshed.grantToken, {
    jwksUri: JWKS_URI,
    requiredScopes: ['calendar:read', 'email:send'],
  });
  console.log('Offline verification: PASSED');
  console.log('  tokenId:', refreshedVerified.tokenId);
  console.log('  scopes: ', refreshedVerified.scopes.join(', '));

  const refreshedOnline = await grantex.tokens.verify(refreshed.grantToken);
  console.log('Online verification:  valid =', refreshedOnline.valid);

  // ── 7. Refresh token rotation (single-use) ────────────────────
  console.log('\n--- Refresh token rotation (single-use enforcement) ---');
  console.log('Attempting to reuse the old refresh token...');

  try {
    await grantex.tokens.refresh({
      refreshToken: savedRefreshToken,  // already used!
      agentId,
    });
    console.log('ERROR: should not reach here');
  } catch (err) {
    console.log('Blocked! Old refresh token rejected.');
    console.log('  Error:', (err as Error).message);
    console.log('  Reason: Refresh tokens are single-use and rotate on each refresh.');
  }

  console.log('\nDone! Token expiry and refresh lifecycle complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
