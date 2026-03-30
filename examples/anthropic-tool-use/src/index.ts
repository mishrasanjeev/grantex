/**
 * Grantex + Anthropic SDK — Scoped Tool Use with Audit Logging
 *
 * Shows Anthropic SDK tool use with Grantex scope enforcement:
 *   1. Register agent & get a grant token (sandbox flow)
 *   2. Create scoped tools via createGrantexTool with JSON Schema
 *   3. Use GrantexToolRegistry to manage tools
 *   4. Invoke tools using client.messages.create()
 *   5. Demonstrate GrantexScopeError when scope is missing
 *   6. Inspect grant scopes offline with getGrantScopes
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/anthropic-tool-use
 *   npm install
 *   ANTHROPIC_API_KEY=sk-ant-... npm start
 *
 * Without ANTHROPIC_API_KEY, the example skips the Claude call
 * and demonstrates tool creation, scope checks, and audit logging directly.
 */

import { Grantex } from '@grantex/sdk';
import {
  createGrantexTool,
  getGrantScopes,
  handleToolCall,
  GrantexToolRegistry,
  GrantexScopeError,
} from '@grantex/anthropic';

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
    name: 'anthropic-demo-agent',
    description: 'Demo Anthropic SDK agent with Grantex authorization',
    scopes: ['calendar:read', 'email:send'],
  });
  // API returns agentId, SDK types say id — handle both
  const agentId = agent.id ?? (agent as unknown as Record<string, string>)['agentId'];
  console.log('Agent registered:', agentId);

  const { grantToken, grantId } = await getGrantToken(grantex, agentId);
  console.log('Grant token received, grantId:', grantId);

  // ── 2. Create scoped tools with JSON Schema ──────────────────────
  const calendarTool = createGrantexTool({
    name: 'read_calendar',
    description: "Read the user's upcoming calendar events",
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date to query, e.g. "today"' },
      },
      required: ['date'],
    },
    grantToken,
    requiredScope: 'calendar:read',
    execute: async (args) => {
      // Simulated calendar API
      return {
        date: args['date'],
        events: [
          { title: 'Team standup', time: '9:00 AM' },
          { title: 'Design review', time: '2:00 PM' },
        ],
      };
    },
  });

  const emailTool = createGrantexTool({
    name: 'send_email',
    description: 'Send an email on behalf of the user',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'subject', 'body'],
    },
    grantToken,
    requiredScope: 'email:send',
    execute: async (args) => {
      // Simulated email API
      return {
        sent: true,
        to: args['to'],
        subject: args['subject'],
        bodyLength: (args['body'] as string).length,
      };
    },
  });

  // ── 3. Register tools ──────────────────────────────────────────────
  const registry = new GrantexToolRegistry();
  registry.register(calendarTool).register(emailTool);

  console.log(
    `Tools created: read_calendar, send_email (registry has ${registry.definitions.length} tools)`,
  );

  // ── 4. Invoke tools ────────────────────────────────────────────────
  const auditOpts = {
    agentId: agentId,
    agentDid: `did:key:${agentId}`,
    grantId,
    principalId: 'test-user-001',
  };

  if (process.env['ANTHROPIC_API_KEY']) {
    // With an Anthropic key, use Claude to pick tools
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    console.log('\n--- Running with Claude (client.messages.create) ---');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: registry.definitions,
      messages: [
        {
          role: 'user',
          content:
            "Check my calendar for today and send alice@example.com an email summarizing today's events.",
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const tool = block.name === 'read_calendar' ? calendarTool : emailTool;
        const result = await handleToolCall(tool, block, grantex, auditOpts);
        console.log(`Tool ${block.name} result:`, JSON.stringify(result));
      } else if (block.type === 'text') {
        console.log('Claude:', block.text);
      }
    }
  } else {
    // Without an Anthropic key, invoke tools directly
    console.log('\n--- Invoking tools directly (no ANTHROPIC_API_KEY set) ---');

    const calendarBlock = {
      type: 'tool_use' as const,
      id: 'toolu_01',
      name: 'read_calendar',
      input: { date: 'today' },
    };
    const calendarResult = await handleToolCall(
      calendarTool,
      calendarBlock,
      grantex,
      auditOpts,
    );
    console.log('Calendar result:', JSON.stringify(calendarResult));

    const emailBlock = {
      type: 'tool_use' as const,
      id: 'toolu_02',
      name: 'send_email',
      input: {
        to: 'alice@example.com',
        subject: "Today's events",
        body: 'Team standup at 9 AM, Design review at 2 PM',
      },
    };
    const emailResult = await handleToolCall(
      emailTool,
      emailBlock,
      grantex,
      auditOpts,
    );
    console.log('Email result:', JSON.stringify(emailResult));
  }

  // ── 5. Demonstrate GrantexScopeError ───────────────────────────────
  console.log('\n--- Testing scope enforcement ---');
  const restrictedTool = createGrantexTool({
    name: 'delete_files',
    description: 'Delete files from storage',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    grantToken,
    requiredScope: 'storage:delete', // not in our grant!
    execute: async () => ({ deleted: true }),
  });

  try {
    await restrictedTool.execute({ path: '/tmp/secret.txt' });
    console.log('ERROR: should have thrown');
  } catch (err) {
    if (err instanceof GrantexScopeError) {
      console.log('GrantexScopeError caught:');
      console.log('  Required scope: ', err.requiredScope);
      console.log('  Granted scopes: ', err.grantedScopes.join(', '));
    } else {
      throw err;
    }
  }

  // ── 6. Inspect scopes offline ──────────────────────────────────────
  console.log('\n--- Inspecting grant scopes ---');
  const scopes = getGrantScopes(grantToken);
  console.log('Scopes in token:', scopes.join(', '));

  // ── 7. Inspect audit trail ─────────────────────────────────────────
  console.log('\n--- Audit trail ---');
  const auditLog = await grantex.audit.list({ agentId: agentId, grantId });
  for (const entry of auditLog.entries) {
    console.log(`  [${entry.status}] ${entry.action} — ${entry.timestamp}`);
  }

  console.log('\nDone! Anthropic SDK integration demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
