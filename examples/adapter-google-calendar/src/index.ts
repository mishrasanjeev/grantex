/**
 * Grantex Adapter Example — Google Calendar
 *
 * Demonstrates using the GoogleCalendarAdapter with a grant token:
 *   1. Register an agent with calendar scopes
 *   2. Authorize and get a grant token (sandbox auto-approve)
 *   3. Use the adapter to list events and create an event
 *   4. The adapter verifies the grant token and enforces scopes
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/adapter-google-calendar
 *   npm install && npm start
 *
 * Note: This example uses a mock credential. In production, you would
 * store the user's Google OAuth token in the Grantex Credential Vault
 * and use vault.exchange() to retrieve it.
 */

import { Grantex } from '@grantex/sdk';
import { GoogleCalendarAdapter } from '@grantex/adapters';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register an agent with calendar scopes ──────────────────────
  const agent = await grantex.agents.register({
    name: 'calendar-agent',
    description: 'Agent that reads and writes calendar events',
    scopes: ['calendar:read', 'calendar:write'],
  });
  console.log('Agent registered:', agent.id);

  // ── 2. Authorize — sandbox mode auto-approves ─────────────────────
  const authRequest = await grantex.authorize({
    agentId: agent.id,
    userId: 'user-alice',
    scopes: ['calendar:read', 'calendar:write'],
  });

  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }

  const token = await grantex.tokens.exchange({ code, agentId: agent.id });
  console.log('Grant token obtained, scopes:', token.scopes.join(', '));

  // ── 3. Create the adapter ─────────────────────────────────────────
  // In production, credentials would come from the Vault:
  //   const cred = await grantex.vault.exchange(token.grantToken, { service: 'google' });
  //   const credential = cred.accessToken;
  const adapter = new GoogleCalendarAdapter({
    jwksUri: JWKS_URI,
    credentials: 'mock-google-oauth-token',
    auditLogger: async (params) => {
      console.log(`  [audit] ${params.action} — ${params.status}`);
    },
  });

  // ── 4. List events ─────────────────────────────────────────────────
  console.log('\nListing calendar events...');
  try {
    const result = await adapter.listEvents(token.grantToken, {
      calendarId: 'primary',
      maxResults: 10,
    });
    console.log('  Success:', result.success);
    console.log('  Data:', JSON.stringify(result.data, null, 2));
  } catch (err) {
    // Expected: upstream call will fail with mock credential
    console.log('  Expected error (mock credential):', (err as Error).message);
  }

  // ── 5. Create an event ─────────────────────────────────────────────
  console.log('\nCreating a calendar event...');
  try {
    const result = await adapter.createEvent(token.grantToken, {
      summary: 'Team Planning',
      start: { dateTime: '2026-03-15T10:00:00Z' },
      end: { dateTime: '2026-03-15T11:00:00Z' },
      description: 'Weekly planning session',
      attendees: [{ email: 'bob@example.com' }],
    });
    console.log('  Success:', result.success);
  } catch (err) {
    console.log('  Expected error (mock credential):', (err as Error).message);
  }

  // ── 6. Demonstrate scope enforcement ───────────────────────────────
  console.log('\nScope enforcement demo:');

  // Get a token with only calendar:read scope
  const readOnlyAuth = await grantex.authorize({
    agentId: agent.id,
    userId: 'user-bob',
    scopes: ['calendar:read'],
  });
  const readOnlyCode = (readOnlyAuth as unknown as Record<string, unknown>)['code'] as string;
  const readOnlyToken = await grantex.tokens.exchange({ code: readOnlyCode, agentId: agent.id });
  console.log('  Read-only token scopes:', readOnlyToken.scopes.join(', '));

  try {
    // This should fail — createEvent requires calendar:write
    await adapter.createEvent(readOnlyToken.grantToken, {
      summary: 'Unauthorized Event',
      start: { dateTime: '2026-03-15T14:00:00Z' },
      end: { dateTime: '2026-03-15T15:00:00Z' },
    });
  } catch (err) {
    console.log('  Correctly blocked:', (err as Error).message);
  }

  console.log('\nDone! Adapter example complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
