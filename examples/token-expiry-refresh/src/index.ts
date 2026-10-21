/**
 * Refresh lifecycle of a time-bound grant.
 *
 * Steps:
 *   1. Register an agent and authorize a grant that lives for GRANT_TTL
 *   2. Verify the grant token locally (JWKS) and with the service
 *   3. Refresh: a new grant token and refresh token for the same grantId
 *   4. Verify the refreshed token the same two ways
 *   5. Retry the first refresh token at once, as a client that lost the
 *      refresh response would, and get the same rotated refresh token back
 *   6. Use the rotated refresh token, after which the first one is refused
 *   7. Let a second, short grant expire: it no longer verifies and cannot be
 *      refreshed, so the caller has to authorize again
 *
 * Run against the local stack:
 *   docker compose up              (repository root)
 *   cd examples/token-expiry-refresh && npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

// Lifetime of the grant used for refreshing, and of the one left to expire.
// TOKEN_TTL is the older name for EXPIRED_GRANT_TTL and is still honoured.
const GRANT_TTL = process.env['GRANT_TTL'] ?? '5m';
const EXPIRED_GRANT_TTL = process.env['EXPIRED_GRANT_TTL'] ?? process.env['TOKEN_TTL'] ?? '3s';

const SCOPES = ['calendar:read', 'email:send'];
const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/** Seconds in a duration written as a whole number and one of s, m, h, d (for example 90s or 5m). */
function durationInSeconds(text: string): number {
  const parsed = /^(\d+)([smhd])$/i.exec(text.trim());
  if (parsed === null) {
    throw new Error(`TOKEN_TTL must be a duration such as 10s, 5m, 2h, or 1d (received ${text})`);
  }
  return Number(parsed[1]) * SECONDS_PER_UNIT[parsed[2]!.toLowerCase()]!;
}

function pause(seconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, seconds * 1000));
}

function heading(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function ensure(condition: boolean, failure: string): void {
  if (!condition) throw new Error(failure);
}

/** Resolves to the error message when `attempt` rejects, or null when it succeeds. */
async function rejectionOf(attempt: Promise<unknown>): Promise<string | null> {
  try {
    await attempt;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });
  console.log('=== Grant Refresh Lifecycle ===\n');

  const registered = await grantex.agents.register({
    name: 'time-bound-agent',
    description: 'Holds a short-lived grant to show refresh and expiry',
    scopes: SCOPES,
  });
  // Older API responses name the identifier `agentId`; newer SDKs also expose `id`.
  const fields = registered as unknown as { id?: string; agentId?: string };
  const agentId = (fields.id ?? fields.agentId) as string;
  console.log(`Agent: ${agentId}`);

  async function grantFor(userId: string, scopes: string[], expiresIn: string) {
    const request = await grantex.authorize({ agentId, userId, scopes, expiresIn });
    const code = (request as unknown as { code?: string }).code;
    if (!code) throw new Error('Authorization returned no code; use a sandbox API key so consent is auto-approved.');
    return grantex.tokens.exchange({ code, agentId });
  }

  heading(`Grant valid for ${GRANT_TTL}`);
  const first = await grantFor('user-alice', SCOPES, GRANT_TTL);
  console.log(`  grantId       ${first.grantId}`);
  console.log(`  scopes        ${first.scopes.join(', ')}`);
  console.log(`  expiresAt     ${first.expiresAt}`);
  console.log(`  refreshToken  ${first.refreshToken.slice(0, 12)}...`);

  heading('Verify the first grant token');
  const local = await verifyGrantToken(first.grantToken, { jwksUri: JWKS_URI, requiredScopes: ['calendar:read'] });
  console.log(`  local (JWKS)  ok, principal ${local.principalId}, scopes ${local.scopes.join(', ')}`);
  const remote = await grantex.tokens.verify(first.grantToken);
  console.log(`  service       valid=${remote.valid}`);
  ensure(remote.valid, 'The first grant token should verify while its grant is active.');

  heading('Refresh');
  const second = await grantex.tokens.refresh({ refreshToken: first.refreshToken, agentId });
  console.log(`  grantId       ${second.grantId} (unchanged)`);
  console.log(`  expiresAt     ${second.expiresAt} (refresh does not extend the grant)`);
  console.log(`  scopes        ${second.scopes.join(', ')}`);

  heading('Verify the refreshed grant token');
  const localAgain = await verifyGrantToken(second.grantToken, { jwksUri: JWKS_URI, requiredScopes: SCOPES });
  console.log(`  local (JWKS)  ok, token ${localAgain.tokenId}, scopes ${localAgain.scopes.join(', ')}`);
  const remoteAgain = await grantex.tokens.verify(second.grantToken);
  console.log(`  service       valid=${remoteAgain.valid}`);
  ensure(remoteAgain.valid, 'The refreshed grant token should verify while its grant is active.');

  heading('Recover a lost refresh response');
  console.log('  Sending the first refresh token again, as a client that never saw the reply would...');
  const replayed = await grantex.tokens.refresh({ refreshToken: first.refreshToken, agentId });
  const sameRotation = replayed.refreshToken === second.refreshToken;
  console.log(`  same rotated refresh token returned: ${sameRotation}`);
  ensure(sameRotation, 'Retrying the first refresh token should return the refresh token it already rotated to.');

  heading('Rotation moves on');
  console.log('  Using the rotated refresh token...');
  await grantex.tokens.refresh({ refreshToken: replayed.refreshToken, agentId });
  console.log('  Trying the first refresh token once more...');
  const staleRefusal = await rejectionOf(grantex.tokens.refresh({ refreshToken: first.refreshToken, agentId }));
  ensure(staleRefusal !== null, 'The first refresh token was accepted after its successor had been used.');
  console.log(`  refused: ${staleRefusal}`);
  console.log('  A refresh token is single-use; the retry window closes once the next token is used.');

  heading(`Grant valid for ${EXPIRED_GRANT_TTL}, left to expire`);
  const shortLived = await grantFor(`user-expired-${Date.now()}`, ['calendar:read'], EXPIRED_GRANT_TTL);
  const wait = durationInSeconds(EXPIRED_GRANT_TTL) + 2;
  console.log(`  waiting ${wait}s...`);
  await pause(wait);
  const afterExpiry = await grantex.tokens.verify(shortLived.grantToken);
  console.log(`  service       valid=${afterExpiry.valid} (expected false)`);
  ensure(!afterExpiry.valid, 'The short-lived grant token should have expired.');
  const expiredRefusal = await rejectionOf(
    grantex.tokens.refresh({ refreshToken: shortLived.refreshToken, agentId }),
  );
  ensure(expiredRefusal !== null, 'A refresh was accepted for a grant that had already expired.');
  console.log(`  refresh refused: ${expiredRefusal}`);
  console.log('  Refresh only renews credentials of an active grant; an expired grant needs a new authorization.');

  console.log('\nRefresh lifecycle complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
