/**
 * Grantex Quickstart — Basic Authorization Flow
 *
 * Shows the core Grantex flow with no framework dependencies:
 *   1. Register an agent
 *   2. Authorize in sandbox mode (auto-approved)
 *   3. Exchange code for a grant token
 *   4. Verify the token offline
 *   5. Log an audit entry
 *   6. Revoke the token
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/quickstart-ts
 *   npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register an agent ───────────────────────────────────────────
  const agent = await grantex.agents.register({
    name: 'quickstart-agent',
    description: 'Demo agent for the Grantex quickstart',
    scopes: ['calendar:read', 'email:send'],
  });
  console.log('Agent registered:', agent.id, agent.did);

  // ── 2. Authorize (sandbox mode — auto-approved) ────────────────────
  const authRequest = await grantex.authorize({
    agentId: agent.id,
    userId: 'test-user-001',
    scopes: ['calendar:read', 'email:send'],
  });
  console.log('Auth request:', authRequest.authRequestId);

  // In sandbox mode the response includes a `code` we can exchange immediately.
  // The SDK types don't include the sandbox-only fields, so we cast.
  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }
  console.log('Sandbox auto-approved, code:', code);

  // ── 3. Exchange code for a grant token ─────────────────────────────
  // POST /v1/token is not part of the SDK surface, so we use fetch directly.
  const tokenRes = await fetch(`${BASE_URL}/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code, agentId: agent.id }),
  });
  if (!tokenRes.ok) {
    console.error('Token exchange failed:', await tokenRes.text());
    process.exit(1);
  }
  const token = (await tokenRes.json()) as {
    grantToken: string;
    expiresAt: string;
    scopes: string[];
    grantId: string;
  };
  console.log('Grant token received, grantId:', token.grantId);
  console.log('Scopes:', token.scopes.join(', '));

  // ── 4. Verify the token offline ────────────────────────────────────
  const verified = await verifyGrantToken(token.grantToken, {
    jwksUri: `${BASE_URL}/.well-known/jwks.json`,
    requiredScopes: ['calendar:read'],
  });
  console.log('Token verified offline:');
  console.log('  principalId:', verified.principalId);
  console.log('  agentDid:   ', verified.agentDid);
  console.log('  scopes:     ', verified.scopes.join(', '));

  // ── 5. Log an audit entry ──────────────────────────────────────────
  const entry = await grantex.audit.log({
    agentId: agent.id,
    grantId: token.grantId,
    action: 'calendar.read',
    status: 'success',
    metadata: { query: 'today', results: 3 },
  });
  console.log('Audit entry logged:', entry.entryId);

  // ── 6. Revoke the token ────────────────────────────────────────────
  await grantex.tokens.revoke(verified.tokenId);
  console.log('Token revoked.');

  // Verify revocation — online check should now say invalid
  const check = await grantex.tokens.verify(token.grantToken);
  console.log('Post-revocation verify:', check.valid ? 'still valid' : 'revoked');

  console.log('\nDone! Full authorization lifecycle complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
