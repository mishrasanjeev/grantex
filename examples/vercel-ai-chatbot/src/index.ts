/**
 * Grantex + Vercel AI SDK — Scoped Tools with Audit Logging
 *
 * Shows Vercel AI SDK tools with Grantex scope enforcement:
 *   1. Register agent & get a grant token (sandbox flow)
 *   2. Create scoped tools via createGrantexTool with Zod schemas
 *   3. Wrap tools with withAuditLogging
 *   4. Invoke tools using generateText
 *   5. Demonstrate GrantexScopeError when scope is missing
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/vercel-ai-chatbot
 *   npm install
 *   OPENAI_API_KEY=sk-... npm start
 *
 * Without OPENAI_API_KEY, the example skips the generateText call
 * and demonstrates tool creation, scope checks, and audit logging directly.
 */

import { Grantex } from '@grantex/sdk';
import {
  createGrantexTool,
  withAuditLogging,
  GrantexScopeError,
} from '@grantex/vercel-ai';
import { z } from 'zod';

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

  const res = await fetch(`${BASE_URL}/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code, agentId }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ grantToken: string; grantId: string }>;
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register agent & get grant token ────────────────────────────
  const agent = await grantex.agents.register({
    name: 'vercel-ai-demo-agent',
    description: 'Demo Vercel AI agent with Grantex authorization',
    scopes: ['calendar:read', 'email:send'],
  });
  console.log('Agent registered:', agent.id);

  const { grantToken, grantId } = await getGrantToken(grantex, agent.id);
  console.log('Grant token received, grantId:', grantId);

  // ── 2. Create scoped tools with Zod schemas ───────────────────────
  const calendarTool = createGrantexTool({
    name: 'read_calendar',
    description: "Read the user's upcoming calendar events",
    parameters: z.object({
      date: z.string().describe('Date to query, e.g. "today" or "2026-03-01"'),
    }),
    grantToken,
    requiredScope: 'calendar:read',
    execute: async ({ date }) => {
      // Simulated calendar API
      return {
        date,
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
    parameters: z.object({
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body text'),
    }),
    grantToken,
    requiredScope: 'email:send',
    execute: async ({ to, subject, body }) => {
      // Simulated email API
      return { sent: true, to, subject, bodyLength: body.length };
    },
  });

  console.log('Tools created: read_calendar, send_email');

  // ── 3. Wrap with audit logging ─────────────────────────────────────
  const auditedCalendar = withAuditLogging(calendarTool, grantex, {
    agentId: agent.id,
    grantId,
  });

  const auditedEmail = withAuditLogging(emailTool, grantex, {
    agentId: agent.id,
    grantId,
  });

  console.log('Audit logging attached');

  // ── 4. Invoke tools ────────────────────────────────────────────────
  if (process.env['OPENAI_API_KEY']) {
    // With an OpenAI key, use generateText to let the LLM pick tools
    const { generateText } = await import('ai');
    const { openai } = await import('@ai-sdk/openai');

    console.log('\n--- Running with LLM (generateText) ---');
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      tools: {
        read_calendar: auditedCalendar,
        send_email: auditedEmail,
      },
      prompt:
        "Check my calendar for today and send an email to alice@example.com with a summary of today's events.",
    });
    console.log('LLM response:', result.text);
  } else {
    // Without an OpenAI key, invoke tools directly
    console.log('\n--- Invoking tools directly (no OPENAI_API_KEY set) ---');

    const calendarResult = await auditedCalendar.execute(
      { date: 'today' },
      { toolCallId: 'call_1', messages: [] },
    );
    console.log('Calendar result:', JSON.stringify(calendarResult));

    const emailResult = await auditedEmail.execute(
      {
        to: 'alice@example.com',
        subject: "Today's events",
        body: 'Team standup at 9 AM, Design review at 2 PM',
      },
      { toolCallId: 'call_2', messages: [] },
    );
    console.log('Email result:', JSON.stringify(emailResult));
  }

  // ── 5. Demonstrate GrantexScopeError ───────────────────────────────
  console.log('\n--- Testing scope enforcement ---');
  try {
    createGrantexTool({
      name: 'delete_files',
      description: 'Delete files from storage',
      parameters: z.object({ path: z.string() }),
      grantToken,
      requiredScope: 'storage:delete', // not in our grant!
      execute: async () => ({ deleted: true }),
    });
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

  // ── 6. Inspect audit trail ─────────────────────────────────────────
  console.log('\n--- Audit trail ---');
  const auditLog = await grantex.audit.list({ agentId: agent.id, grantId });
  for (const entry of auditLog.entries) {
    console.log(`  [${entry.status}] ${entry.action} — ${entry.timestamp}`);
  }

  console.log('\nDone! Vercel AI integration demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
