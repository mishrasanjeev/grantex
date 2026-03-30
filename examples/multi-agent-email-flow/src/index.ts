/**
 * Grantex Multi-Agent Email Flow — Failure & Recovery Patterns
 *
 * Demonstrates a realistic two-agent email automation workflow with
 * comprehensive error handling and failure recovery:
 *
 *   1. Register a planner agent (Agent A) and an executor agent (Agent B)
 *   2. Agent A obtains a grant with calendar:read + email:send scopes
 *   3. Agent A reads calendar events (simulated) with scope verification
 *   4. Agent A delegates only email:send to Agent B
 *   5. Agent B sends email (simulated) using delegated scope
 *   6. Failure: Agent B tries calendar:read (not delegated) — rejected
 *   7. Failure: Parent grant revoked — Agent B's delegated token cascades
 *   8. Full audit trail inspection showing success + failure timeline
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/multi-agent-email-flow
 *   npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

// ── Simulated services ──────────────────────────────────────────────

function readCalendar(date: string) {
  return {
    events: [
      { title: 'Team standup', time: '9:00 AM', date },
      { title: 'Design review', time: '2:00 PM', date },
      { title: '1:1 with manager', time: '4:00 PM', date },
    ],
  };
}

function sendEmail(to: string, subject: string, body: string) {
  return {
    sent: true,
    messageId: `msg_${Date.now()}`,
    to,
    subject,
    preview: body.slice(0, 60) + '...',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Handle agent.id vs agentId API response gotcha */
function getAgentId(agent: Record<string, unknown>): string {
  return (agent['id'] ?? agent['agentId']) as string;
}

// ── Main flow ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Register agents ──────────────────────────────────────────
  console.log('=== Multi-Agent Email Flow ===\n');

  const plannerRaw = await grantex.agents.register({
    name: 'email-planner',
    description: 'Reads calendar and plans email communications',
    scopes: ['calendar:read', 'email:send'],
  });
  const plannerId = getAgentId(plannerRaw as unknown as Record<string, unknown>);
  const plannerDid = (plannerRaw as unknown as Record<string, unknown>)['did'] as string ?? `did:grantex:${plannerId}`;
  console.log('Agent A (planner) registered:', plannerId);

  const executorRaw = await grantex.agents.register({
    name: 'email-executor',
    description: 'Sends emails on behalf of the planner agent',
    scopes: ['email:send'],
  });
  const executorId = getAgentId(executorRaw as unknown as Record<string, unknown>);
  const executorDid = (executorRaw as unknown as Record<string, unknown>)['did'] as string ?? `did:grantex:${executorId}`;
  console.log('Agent B (executor) registered:', executorId);

  // ── 2. Authorize Agent A ────────────────────────────────────────
  const authRequest = await grantex.authorize({
    agentId: plannerId,
    userId: 'user-alice',
    scopes: ['calendar:read', 'email:send'],
  });

  const code = (authRequest as unknown as Record<string, unknown>)['code'] as string;
  if (!code) {
    console.error('No code returned — are you using the sandbox API key?');
    process.exit(1);
  }

  const plannerToken = await grantex.tokens.exchange({
    code,
    agentId: plannerId,
  });
  console.log('\nAgent A grant token:');
  console.log('  grantId:', plannerToken.grantId);
  console.log('  scopes: ', plannerToken.scopes.join(', '));

  // ── 3. Agent A reads calendar (scope-verified) ──────────────────
  console.log('\n--- Agent A: Reading calendar ---');

  const plannerVerified = await verifyGrantToken(plannerToken.grantToken, {
    jwksUri: JWKS_URI,
    requiredScopes: ['calendar:read'],
  });
  console.log('Scope verified offline: calendar:read');
  console.log('  principalId:', plannerVerified.principalId);

  const calendar = readCalendar('2026-03-30');
  console.log('Calendar events found:', calendar.events.length);
  for (const event of calendar.events) {
    console.log(`  ${event.time} — ${event.title}`);
  }

  await grantex.audit.log({
    agentId: plannerId,
    agentDid: plannerDid,
    grantId: plannerToken.grantId,
    principalId: 'user-alice',
    action: 'calendar:read',
    status: 'success',
    metadata: { eventsFound: calendar.events.length },
  });

  // ── 4. Agent A delegates email:send to Agent B ──────────────────
  console.log('\n--- Agent A: Delegating email:send to Agent B ---');

  const delegatedToken = await grantex.grants.delegate({
    parentGrantToken: plannerToken.grantToken,
    subAgentId: executorId,
    scopes: ['email:send'],  // only email, NOT calendar
  });
  console.log('Delegated token issued:');
  console.log('  grantId:', delegatedToken.grantId);
  console.log('  scopes: ', delegatedToken.scopes.join(', '));

  const delegatedVerified = await verifyGrantToken(delegatedToken.grantToken, {
    jwksUri: JWKS_URI,
  });
  console.log('  delegationDepth:', delegatedVerified.delegationDepth);
  if (delegatedVerified.parentAgentDid) {
    console.log('  parentAgentDid:', delegatedVerified.parentAgentDid);
  }

  // ── 5. Agent B sends email (delegated scope) ───────────────────
  console.log('\n--- Agent B: Sending email ---');

  await verifyGrantToken(delegatedToken.grantToken, {
    jwksUri: JWKS_URI,
    requiredScopes: ['email:send'],
  });
  console.log('Scope verified offline: email:send');

  const summary = calendar.events
    .map((e) => `${e.title} at ${e.time}`)
    .join(', ');

  const emailResult = sendEmail(
    'team@company.com',
    'Daily schedule summary',
    `Here is your schedule for today: ${summary}`,
  );
  console.log('Email sent:', emailResult.messageId);
  console.log('  to:     ', emailResult.to);
  console.log('  subject:', emailResult.subject);

  await grantex.audit.log({
    agentId: executorId,
    agentDid: executorDid,
    grantId: delegatedToken.grantId,
    principalId: 'user-alice',
    action: 'email:send',
    status: 'success',
    metadata: { to: emailResult.to, messageId: emailResult.messageId },
  });

  // ── 6. Failure: Agent B tries unauthorized scope ────────────────
  console.log('\n--- Failure: Agent B tries calendar:read (not delegated) ---');

  try {
    await verifyGrantToken(delegatedToken.grantToken, {
      jwksUri: JWKS_URI,
      requiredScopes: ['calendar:read'],  // not in delegated scopes!
    });
    console.log('ERROR: should not reach here');
  } catch (err) {
    console.log('Blocked! Agent B cannot read calendar.');
    console.log('  Error:', (err as Error).message);

    await grantex.audit.log({
      agentId: executorId,
      agentDid: executorDid,
      grantId: delegatedToken.grantId,
      principalId: 'user-alice',
      action: 'calendar:read',
      status: 'failure',
      metadata: { reason: 'scope_not_delegated' },
    });
  }

  // ── 7. Failure: Revocation mid-flow (cascade) ──────────────────
  console.log('\n--- Failure: Revoking Agent A\'s grant (cascade to Agent B) ---');

  const beforeParent = await grantex.tokens.verify(plannerToken.grantToken);
  const beforeChild = await grantex.tokens.verify(delegatedToken.grantToken);
  console.log('Before revocation:');
  console.log('  Agent A token valid:', beforeParent.valid);
  console.log('  Agent B token valid:', beforeChild.valid);

  await grantex.grants.revoke(plannerToken.grantId);
  console.log('\nParent grant revoked.');

  const afterParent = await grantex.tokens.verify(plannerToken.grantToken);
  const afterChild = await grantex.tokens.verify(delegatedToken.grantToken);
  console.log('After revocation:');
  console.log('  Agent A token valid:', afterParent.valid, '(revoked)');
  console.log('  Agent B token valid:', afterChild.valid, '(cascade revoked)');

  // Agent B tries to send another email — fails
  console.log('\nAgent B tries to send email after revocation...');
  const postRevoke = await grantex.tokens.verify(delegatedToken.grantToken);
  if (!postRevoke.valid) {
    console.log('Blocked! Delegated token is no longer valid.');
    console.log('Recovery: Agent B must request a new delegation from Agent A.');

    await grantex.audit.log({
      agentId: executorId,
      agentDid: executorDid,
      grantId: delegatedToken.grantId,
      principalId: 'user-alice',
      action: 'email:send',
      status: 'failure',
      metadata: { reason: 'grant_revoked_cascade' },
    });
  }

  // ── 8. Audit trail inspection ──────────────────────────────────
  console.log('\n--- Audit trail ---');

  const plannerAudit = await grantex.audit.list({ agentId: plannerId });
  const executorAudit = await grantex.audit.list({ agentId: executorId });

  const allEntries = [...plannerAudit.entries, ...executorAudit.entries]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const entry of allEntries) {
    const agent = entry.agentId === plannerId ? 'Agent A' : 'Agent B';
    const icon = entry.status === 'success' ? '+' : 'x';
    console.log(`  [${icon}] ${agent} ${entry.action} — ${entry.status} — ${entry.timestamp}`);
  }

  console.log(`\nTotal audit entries: ${allEntries.length}`);
  console.log('  Success:', allEntries.filter((e) => e.status === 'success').length);
  console.log('  Failure:', allEntries.filter((e) => e.status === 'failure').length);

  console.log('\nDone! Multi-agent email flow with failure handling complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
