/**
 * Grantex Token Refresh & Rotation - Time-Bound Grants
 *
 * Demonstrates how to work with time-bound grants and the refresh token
 * rotation pattern:
 *
 *   1. Register an agent and authorize a grant
 *   2. Verify the token while the grant is active
 *   3. Refresh the active grant - get a new JWT with the same grantId
 *   4. Demonstrate refresh response recovery for a lost HTTP response
 *   5. Demonstrate refresh token rotation (old refresh tokens cannot keep being reused)
 *   6. Demonstrate that an expired grant must be re-authorized, not refreshed
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

const GRANT_TTL = process.env['GRANT_TTL'] ?? '5m';
const EXPIRED_GRANT_TTL = process.env['EXPIRED_GRANT_TTL'] ?? process.env['TOKEN_TTL'] ?? '3s';

/** Handle agent.id vs agentId API response gotcha */
function getAgentId(agent: Record<string, unknown>): string {
  return (agent['id'] ?? agent['agentId']) as string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDurationSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/i.exec(value.trim());
  if (!match) {
    throw new Error(`TOKEN_TTL must be a duration such as 10s, 5m, 2h, or 1d (received ${value})`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return amount * multiplier!;
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register agent ──────────────────────────────────────────
  console.log('=== Token Refresh & Rotation Demo ===\n');

  const agentRaw = await grantex.agents.register({
    name: 'time-sensitive-agent',
    description: 'Agent with a short-lived grant token for expiry demo',
    scopes: ['calendar:read', 'email:send'],
  });
  const agentId = getAgentId(agentRaw as unknown as Record<string, unknown>);
  console.log('Agent registered:', agentId);

  // ── 2. Authorize a grant ───────────────────────────────────────
  console.log(`\n--- Authorizing an active grant (${GRANT_TTL}) ---`);

  const authRequest = await grantex.authorize({
    agentId,
    userId: 'user-alice',
    scopes: ['calendar:read', 'email:send'],
    expiresIn: GRANT_TTL,
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
  if (!onlineCheck.valid) {
    throw new Error('Expected the initial grant token to verify while the grant is active');
  }

  // ── 4. Refresh while the grant is active ───────────────────────
  console.log('\n--- Refreshing token ---');

  const refreshed = await grantex.tokens.refresh({
    refreshToken: savedRefreshToken,
    agentId,
  });
  console.log('Token refreshed successfully!');
  console.log('  grantId:  ', refreshed.grantId, '(same as original)');
  console.log('  expiresAt:', refreshed.expiresAt, '(grant lifetime unchanged)');
  console.log('  scopes:   ', refreshed.scopes.join(', '));

  // ── 5. Use refreshed token ─────────────────────────────────────
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
  if (!refreshedOnline.valid) {
    throw new Error('Expected the refreshed grant token to verify while the grant is active');
  }

  // ── 6. Refresh response recovery ──────────────────────────────
  console.log('\n--- Refresh response recovery window ---');
  console.log('Retrying the original refresh token immediately (simulates a lost HTTP response)...');

  const recovered = await grantex.tokens.refresh({
    refreshToken: savedRefreshToken,
    agentId,
  });
  console.log('Recovered refresh token matches first rotation:', recovered.refreshToken === refreshed.refreshToken);
  if (recovered.refreshToken !== refreshed.refreshToken) {
    throw new Error('Expected replay recovery to return the already-rotated refresh token');
  }

  // ── 7. Refresh token rotation (single-use) ────────────────────
  console.log('\n--- Refresh token rotation (single-use enforcement) ---');
  console.log('Advancing the rotation chain with the current refresh token...');

  await grantex.tokens.refresh({
    refreshToken: recovered.refreshToken,
    agentId,
  });
  console.log('Attempting to reuse the original refresh token after the chain moved forward...');

  let originalRefreshTokenRejected = false;
  try {
    await grantex.tokens.refresh({
      refreshToken: savedRefreshToken,
      agentId,
    });
  } catch (err) {
    originalRefreshTokenRejected = true;
    console.log('Blocked! Original refresh token rejected.');
    console.log('  Error:', (err as Error).message);
    console.log('  Reason: Refresh tokens are single-use; recovery only works before the rotated child is used.');
  }
  if (!originalRefreshTokenRejected) {
    throw new Error('Original refresh token was unexpectedly accepted after the rotated child was used');
  }

  // ── 8. Expired grant boundary ──────────────────────────────────
  console.log('\n--- Expired grant boundary ---');
  console.log(`Creating a short-lived grant (${EXPIRED_GRANT_TTL}) to show the re-authorization boundary...`);

  const expiringAuthRequest = await grantex.authorize({
    agentId,
    userId: `user-expired-${Date.now()}`,
    scopes: ['calendar:read'],
    expiresIn: EXPIRED_GRANT_TTL,
  });

  const expiringCode = (expiringAuthRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!expiringCode) {
    console.error('No code returned for expiring grant - are you using the sandbox API key?');
    process.exit(1);
  }

  const expiringToken = await grantex.tokens.exchange({ code: expiringCode, agentId });
  const expiringTtlSeconds = parseDurationSeconds(EXPIRED_GRANT_TTL);
  console.log(`Waiting ${expiringTtlSeconds + 2}s for the grant to expire...`);
  await sleep((expiringTtlSeconds + 2) * 1000);

  const expiredCheck = await grantex.tokens.verify(expiringToken.grantToken);
  console.log('Online verification after expiry: valid =', expiredCheck.valid, '(expected: false)');
  if (expiredCheck.valid) {
    throw new Error('Expected the short-lived grant token to be expired');
  }

  let expiredGrantRefreshRejected = false;
  try {
    await grantex.tokens.refresh({
      refreshToken: expiringToken.refreshToken,
      agentId,
    });
  } catch (err) {
    expiredGrantRefreshRejected = true;
    console.log('Refresh after grant expiry blocked.');
    console.log('  Error:', (err as Error).message);
    console.log('  Reason: Refresh rotates credentials for an active grant; expired grants require re-authorization.');
  }
  if (!expiredGrantRefreshRejected) {
    throw new Error('Expired grant refresh was unexpectedly accepted');
  }

  console.log('\nDone! Token refresh lifecycle complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
