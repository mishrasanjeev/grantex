/**
 * Grantex Gateway Proxy Example
 *
 * Demonstrates:
 *   1. A mock upstream API server
 *   2. The Grantex gateway proxying requests with scope enforcement
 *   3. Agents making requests through the gateway with grant tokens
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/gateway-proxy
 *   npm install && npm start
 */

import { createServer } from 'node:http';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const GATEWAY_PORT = 4000;
const UPSTREAM_PORT = 4001;

// ── Mock upstream API server ────────────────────────────────────────────

const upstreamServer = createServer((req, res) => {
  const sanitizedUrl = (req.url ?? '').replace(/[\r\n]/g, '');
  console.log(`  [upstream] ${req.method} ${sanitizedUrl}`);

  if (req.url?.startsWith('/api/calendar')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [
        { id: 'evt_1', summary: 'Team standup', time: '10:00 AM' },
        { id: 'evt_2', summary: 'Design review', time: '2:00 PM' },
      ],
    }));
    return;
  }

  if (req.url?.startsWith('/api/email')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'msg_1', subject: 'Hello!' }] }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Start mock upstream server ──────────────────────────────────
  await new Promise<void>((resolve) => {
    upstreamServer.listen(UPSTREAM_PORT, () => {
      console.log(`Mock upstream API listening on :${UPSTREAM_PORT}`);
      resolve();
    });
  });

  // ── 2. Register an agent and get a grant token ─────────────────────
  const agent = await grantex.agents.register({
    name: 'gateway-demo-agent',
    description: 'Agent for gateway proxy example',
    scopes: ['calendar:read', 'calendar:write', 'email:read', 'email:send'],
  });
  console.log('Agent registered:', agent.id);

  const authRequest = await grantex.authorize({
    agentId: agent.id,
    userId: 'demo-user-001',
    scopes: ['calendar:read', 'email:read'],
  });

  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }

  const token = await grantex.tokens.exchange({ code, agentId: agent.id });
  console.log('Grant token obtained, scopes:', token.scopes.join(', '));

  // ── 3. Make requests through the gateway ───────────────────────────
  console.log('\n--- Requests through Gateway (port', GATEWAY_PORT, ') ---\n');

  // Request with valid scope
  console.log('GET /api/calendar/events (has calendar:read scope):');
  try {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/api/calendar/events`, {
      headers: { Authorization: `Bearer ${token.grantToken}` },
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const body = await res.json();
      console.log('  Body:', JSON.stringify(body, null, 2));
    }
  } catch (err) {
    console.log(`  Gateway not running (start separately with: npx grantex-gateway gateway.yaml)`);
  }

  // Request that should be rejected (no email:send scope)
  console.log('\nPOST /api/email/send (does NOT have email:send scope):');
  try {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/api/email/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.grantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: 'bob@example.com', subject: 'Test' }),
    });
    console.log(`  Status: ${res.status} (expected 403 — scope not granted)`);
  } catch (err) {
    console.log(`  Gateway not running (start separately with: npx grantex-gateway gateway.yaml)`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────
  upstreamServer.close();
  console.log('\nDone! Gateway proxy example complete.');
  console.log('To run the full flow, start the gateway in another terminal:');
  console.log('  npx grantex-gateway gateway.yaml');
}

main().catch((err) => {
  console.error(err);
  upstreamServer.close();
  process.exit(1);
});
