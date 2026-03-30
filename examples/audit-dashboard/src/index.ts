/**
 * Grantex Audit Dashboard — Querying, Filtering & Metrics
 *
 * Demonstrates how to use the Grantex audit trail as a rich data source:
 *
 *   1. Set up two agents with different scopes and generate audit entries
 *   2. Generate a mix of success, failure, and blocked entries
 *   3. Display the full audit timeline with formatted output
 *   4. Filter audit entries by agent and by action
 *   5. Compute metrics — success rate, entries per agent, top actions
 *   6. Verify hash chain integrity for tamper evidence
 *
 * Prerequisites:
 *   docker compose up          # from repo root
 *   cd examples/audit-dashboard
 *   npm install && npm start
 */

import { Grantex, verifyGrantToken } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;

/** Handle agent.id vs agentId API response gotcha */
function getAgentId(agent: Record<string, unknown>): string {
  return (agent['id'] ?? agent['agentId']) as string;
}

function getAgentDid(agent: Record<string, unknown>, id: string): string {
  return (agent['did'] as string) ?? `did:grantex:${id}`;
}

interface AuditEntry {
  entryId: string;
  agentId: string;
  action: string;
  status: string;
  timestamp: string;
  hash: string;
  prevHash: string | null;
  metadata: Record<string, unknown>;
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });

  // ── 1. Setup: Register agents and get tokens ──────────────────
  console.log('=== Audit Dashboard Demo ===\n');

  const agentARaw = await grantex.agents.register({
    name: 'data-reader',
    description: 'Agent that reads data from various sources',
    scopes: ['data:read', 'calendar:read', 'email:send'],
  });
  const agentAId = getAgentId(agentARaw as unknown as Record<string, unknown>);
  const agentADid = getAgentDid(agentARaw as unknown as Record<string, unknown>, agentAId);
  console.log('Agent A (data-reader) registered:', agentAId);

  const agentBRaw = await grantex.agents.register({
    name: 'notifier',
    description: 'Agent that sends notifications and emails',
    scopes: ['email:send', 'notification:push'],
  });
  const agentBId = getAgentId(agentBRaw as unknown as Record<string, unknown>);
  const agentBDid = getAgentDid(agentBRaw as unknown as Record<string, unknown>, agentBId);
  console.log('Agent B (notifier) registered:', agentBId);

  // Authorize Agent A
  const authA = await grantex.authorize({
    agentId: agentAId,
    userId: 'user-alice',
    scopes: ['data:read', 'calendar:read', 'email:send'],
  });
  const codeA = (authA as unknown as Record<string, unknown>)['code'] as string;
  if (!codeA) { console.error('No code — sandbox key?'); process.exit(1); }
  const tokenA = await grantex.tokens.exchange({ code: codeA, agentId: agentAId });

  // Authorize Agent B
  const authB = await grantex.authorize({
    agentId: agentBId,
    userId: 'user-alice',
    scopes: ['email:send', 'notification:push'],
  });
  const codeB = (authB as unknown as Record<string, unknown>)['code'] as string;
  if (!codeB) { console.error('No code — sandbox key?'); process.exit(1); }
  const tokenB = await grantex.tokens.exchange({ code: codeB, agentId: agentBId });

  console.log('Both agents authorized.\n');

  // ── 2. Generate audit entries ─────────────────────────────────
  console.log('--- Generating audit entries ---');

  const auditBase = { principalId: 'user-alice' };

  // Agent A — success entries
  await grantex.audit.log({ ...auditBase, agentId: agentAId, agentDid: agentADid, grantId: tokenA.grantId, action: 'data:read', status: 'success', metadata: { source: 'database', rows: 150 } });
  await grantex.audit.log({ ...auditBase, agentId: agentAId, agentDid: agentADid, grantId: tokenA.grantId, action: 'calendar:read', status: 'success', metadata: { eventsFound: 5 } });
  await grantex.audit.log({ ...auditBase, agentId: agentAId, agentDid: agentADid, grantId: tokenA.grantId, action: 'data:read', status: 'success', metadata: { source: 'api', rows: 42 } });

  // Agent A — failure entry
  await grantex.audit.log({ ...auditBase, agentId: agentAId, agentDid: agentADid, grantId: tokenA.grantId, action: 'data:write', status: 'failure', metadata: { reason: 'scope_missing' } });

  // Agent B — success entries
  await grantex.audit.log({ ...auditBase, agentId: agentBId, agentDid: agentBDid, grantId: tokenB.grantId, action: 'email:send', status: 'success', metadata: { to: 'team@company.com' } });
  await grantex.audit.log({ ...auditBase, agentId: agentBId, agentDid: agentBDid, grantId: tokenB.grantId, action: 'notification:push', status: 'success', metadata: { channel: 'slack' } });
  await grantex.audit.log({ ...auditBase, agentId: agentBId, agentDid: agentBDid, grantId: tokenB.grantId, action: 'email:send', status: 'success', metadata: { to: 'manager@company.com' } });

  // Agent B — blocked entry
  await grantex.audit.log({ ...auditBase, agentId: agentBId, agentDid: agentBDid, grantId: tokenB.grantId, action: 'email:send', status: 'blocked', metadata: { reason: 'rate_limit_exceeded' } });

  // Agent A — another failure
  await grantex.audit.log({ ...auditBase, agentId: agentAId, agentDid: agentADid, grantId: tokenA.grantId, action: 'calendar:write', status: 'failure', metadata: { reason: 'scope_missing' } });

  console.log('Generated 9 audit entries (5 success, 2 failure, 1 blocked, 1 more success).\n');

  // ── 3. Full audit timeline ────────────────────────────────────
  console.log('--- Full Audit Timeline ---');
  console.log('');

  const auditA = await grantex.audit.list({ agentId: agentAId });
  const auditB = await grantex.audit.list({ agentId: agentBId });

  const allEntries = [...auditA.entries, ...auditB.entries]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) as AuditEntry[];

  const statusIcon: Record<string, string> = { success: '+', failure: 'x', blocked: '!' };
  const agentNames: Record<string, string> = { [agentAId]: 'data-reader', [agentBId]: 'notifier' };

  console.log('  #  Status    Agent          Action              Time');
  console.log('  -  ------    -----          ------              ----');
  allEntries.forEach((entry, i) => {
    const num = String(i + 1).padStart(2);
    const icon = `[${statusIcon[entry.status] ?? '?'}]`;
    const status = entry.status.padEnd(7);
    const agent = (agentNames[entry.agentId] ?? 'unknown').padEnd(14);
    const action = entry.action.padEnd(19);
    const time = new Date(entry.timestamp).toISOString().slice(11, 19);
    console.log(`  ${num} ${icon} ${status} ${agent} ${action} ${time}`);
  });

  // ── 4. Filter by agent ────────────────────────────────────────
  console.log('\n--- Filter: Agent A (data-reader) only ---');
  console.log(`  Entries: ${auditA.entries.length}`);
  for (const entry of auditA.entries) {
    console.log(`    [${statusIcon[entry.status] ?? '?'}] ${entry.action} — ${entry.status}`);
  }

  console.log('\n--- Filter: Agent B (notifier) only ---');
  console.log(`  Entries: ${auditB.entries.length}`);
  for (const entry of auditB.entries) {
    console.log(`    [${statusIcon[entry.status] ?? '?'}] ${entry.action} — ${entry.status}`);
  }

  // ── 5. Filter by action ───────────────────────────────────────
  console.log('\n--- Filter: email:send actions only ---');
  const emailEntries = allEntries.filter((e) => e.action === 'email:send');
  console.log(`  Entries: ${emailEntries.length}`);
  for (const entry of emailEntries) {
    const agent = agentNames[entry.agentId] ?? 'unknown';
    console.log(`    [${statusIcon[entry.status] ?? '?'}] ${agent} — ${entry.status} — ${JSON.stringify(entry.metadata)}`);
  }

  // ── 6. Metrics summary ────────────────────────────────────────
  console.log('\n--- Metrics Summary ---');

  const total = allEntries.length;
  const successCount = allEntries.filter((e) => e.status === 'success').length;
  const failureCount = allEntries.filter((e) => e.status === 'failure').length;
  const blockedCount = allEntries.filter((e) => e.status === 'blocked').length;

  console.log(`  Total entries:  ${total}`);
  console.log(`  Success:        ${successCount} (${((successCount / total) * 100).toFixed(0)}%)`);
  console.log(`  Failure:        ${failureCount} (${((failureCount / total) * 100).toFixed(0)}%)`);
  console.log(`  Blocked:        ${blockedCount} (${((blockedCount / total) * 100).toFixed(0)}%)`);

  // Entries per agent
  console.log('\n  Entries per agent:');
  const agentCounts = new Map<string, number>();
  for (const entry of allEntries) {
    agentCounts.set(entry.agentId, (agentCounts.get(entry.agentId) ?? 0) + 1);
  }
  for (const [id, count] of agentCounts) {
    console.log(`    ${agentNames[id] ?? id}: ${count}`);
  }

  // Most common actions
  console.log('\n  Top actions:');
  const actionCounts = new Map<string, number>();
  for (const entry of allEntries) {
    actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
  }
  const sortedActions = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [action, count] of sortedActions) {
    console.log(`    ${action}: ${count}`);
  }

  // ── 7. Hash chain integrity check ─────────────────────────────
  console.log('\n--- Hash Chain Integrity Check ---');

  // Check each agent's audit chain separately (chains are per-developer)
  let chainValid = true;
  for (const [agentName, entries] of [['data-reader', auditA.entries], ['notifier', auditB.entries]] as const) {
    const typed = entries as AuditEntry[];
    for (let i = 1; i < typed.length; i++) {
      const current = typed[i]!;
      const previous = typed[i - 1]!;
      if (current.prevHash !== previous.hash) {
        console.log(`  BROKEN at entry ${i}: prevHash mismatch for ${agentName}`);
        chainValid = false;
      }
    }
  }

  if (chainValid) {
    console.log('  All hash chains verified: integrity PASSED');
    console.log(`  Chain length: ${allEntries.length} entries`);
    if (allEntries.length > 0) {
      console.log(`  First hash: ${allEntries[0]!.hash.slice(0, 16)}...`);
      console.log(`  Last hash:  ${allEntries[allEntries.length - 1]!.hash.slice(0, 16)}...`);
    }
  }

  console.log('\nDone! Audit dashboard demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
