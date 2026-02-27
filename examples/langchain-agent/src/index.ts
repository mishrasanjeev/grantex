/**
 * Grantex + LangChain — Scoped Tools with Audit Logging
 *
 * Shows a LangChain agent using Grantex-scoped tools:
 *   1. Register agent & get a grant token (sandbox flow)
 *   2. Create scoped tools via createGrantexTool
 *   3. Attach GrantexAuditHandler for automatic audit logging
 *   4. Invoke tools and inspect the audit trail
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/langchain-agent
 *   npm install && npm start
 *
 * Optional: Set OPENAI_API_KEY to use a real LLM agent.
 * Without it, this example directly invokes the tools to demonstrate
 * Grantex scope enforcement and audit logging.
 */

import { Grantex } from '@grantex/sdk';
import { createGrantexTool, GrantexAuditHandler } from '@grantex/langchain';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';

async function getGrantToken(
  grantex: Grantex,
  agentId: string,
): Promise<{ grantToken: string; grantId: string }> {
  const authRequest = await grantex.authorize({
    agentId,
    userId: 'test-user-001',
    scopes: ['calendar:read', 'email:send'],
  });

  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) throw new Error('No code returned — use the sandbox API key.');

  return grantex.tokens.exchange({ code, agentId });
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register agent & get grant token ────────────────────────────
  const agent = await grantex.agents.register({
    name: 'langchain-demo-agent',
    description: 'Demo LangChain agent with Grantex authorization',
    scopes: ['calendar:read', 'email:send'],
  });
  console.log('Agent registered:', agent.id);

  const { grantToken, grantId } = await getGrantToken(grantex, agent.id);
  console.log('Grant token received, grantId:', grantId);

  // ── 2. Create scoped tools ─────────────────────────────────────────
  const calendarTool = createGrantexTool({
    name: 'read_calendar',
    description: "Read the user's upcoming calendar events",
    grantToken,
    requiredScope: 'calendar:read',
    func: async (input: string) => {
      // Simulated calendar API call
      return JSON.stringify({
        events: [
          { title: 'Team standup', time: '9:00 AM', query: input },
          { title: 'Design review', time: '2:00 PM', query: input },
        ],
      });
    },
  });

  const emailTool = createGrantexTool({
    name: 'send_email',
    description: 'Send an email on behalf of the user',
    grantToken,
    requiredScope: 'email:send',
    func: async (input: string) => {
      // Simulated email API call
      return `Email sent successfully: "${input}"`;
    },
  });

  console.log('Tools created: read_calendar, send_email');

  // ── 3. Set up audit handler ────────────────────────────────────────
  const auditHandler = new GrantexAuditHandler({
    client: grantex,
    agentId: agent.id,
    grantToken,
  });
  console.log('Audit handler configured');

  // ── 4. Invoke tools directly ───────────────────────────────────────
  // In a full LangChain agent, the LLM selects and calls these tools.
  // Here we invoke them directly to show the Grantex integration.

  console.log('\n--- Invoking read_calendar ---');
  const calendarResult = await calendarTool.invoke('today');
  console.log('Result:', calendarResult);

  // Manually fire the audit handler to simulate what LangChain would do
  await auditHandler.handleToolStart({ name: 'read_calendar' }, 'today');

  console.log('\n--- Invoking send_email ---');
  const emailResult = await emailTool.invoke(
    'Meeting summary: standup at 9 AM, design review at 2 PM',
  );
  console.log('Result:', emailResult);
  await auditHandler.handleToolStart(
    { name: 'send_email' },
    'Meeting summary: standup at 9 AM, design review at 2 PM',
  );

  // ── 5. Demonstrate scope enforcement ───────────────────────────────
  console.log('\n--- Testing scope enforcement ---');
  try {
    createGrantexTool({
      name: 'delete_account',
      description: 'Delete the user account',
      grantToken,
      requiredScope: 'account:delete', // not in our grant!
      func: async () => 'deleted',
    });
    console.log('ERROR: should have thrown');
  } catch (err) {
    console.log('Scope check blocked unauthorized tool:', (err as Error).message);
  }

  // ── 6. Inspect audit trail ─────────────────────────────────────────
  console.log('\n--- Audit trail ---');
  const auditLog = await grantex.audit.list({ agentId: agent.id, grantId });
  for (const entry of auditLog.entries) {
    console.log(`  [${entry.status}] ${entry.action} — ${entry.timestamp}`);
  }

  console.log('\nDone! LangChain integration demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
