/**
 * Audit trail report: record activity for two agents, read it back, slice it,
 * summarise it and check that the developer's hash chain is unbroken.
 *
 * Steps:
 *   1. Register a reader agent and a sender agent and authorize both
 *   2. Record nine audit entries with success, failure and blocked outcomes
 *   3. Print every entry in time order
 *   4. Show each agent's entries, then only the email:send entries
 *   5. Print outcome percentages, entries per agent and action counts
 *   6. Walk the developer-wide chain and confirm each prevHash links back
 *
 * Run against the local stack:
 *   docker compose up              (repository root)
 *   cd examples/audit-dashboard && npm install && npm start
 */

import { Grantex } from '@grantex/sdk';
import type { AuditEntry } from '@grantex/sdk';

const BASE_URL = process.env['GRANTEX_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['GRANTEX_API_KEY'] ?? 'sandbox-api-key-local';
const PRINCIPAL = 'user-alice';

type Outcome = 'success' | 'failure' | 'blocked';
type Role = 'reader' | 'sender';

interface ActingAgent {
  label: string;
  id: string;
  did: string;
  grantId: string;
}

const ROLES: Record<Role, { label: string; description: string; scopes: string[] }> = {
  reader: {
    label: 'data-reader',
    description: 'Reads records and calendars for the user',
    scopes: ['data:read', 'calendar:read', 'email:send'],
  },
  sender: {
    label: 'notifier',
    description: 'Sends email and push notifications for the user',
    scopes: ['email:send', 'notification:push'],
  },
};

// Recorded in this order. Two entries are failures (scope not granted) and one
// is blocked, so the summary has something to show for each outcome.
const ACTIVITY: Array<{ by: Role; action: string; status: Outcome; metadata: Record<string, unknown> }> = [
  { by: 'reader', action: 'data:read', status: 'success', metadata: { source: 'database', rows: 150 } },
  { by: 'reader', action: 'calendar:read', status: 'success', metadata: { eventsFound: 5 } },
  { by: 'reader', action: 'data:read', status: 'success', metadata: { source: 'api', rows: 42 } },
  { by: 'reader', action: 'data:write', status: 'failure', metadata: { reason: 'scope_missing' } },
  { by: 'sender', action: 'email:send', status: 'success', metadata: { to: 'team@example.com' } },
  { by: 'sender', action: 'notification:push', status: 'success', metadata: { channel: 'chat' } },
  { by: 'sender', action: 'email:send', status: 'success', metadata: { to: 'manager@example.com' } },
  { by: 'sender', action: 'email:send', status: 'blocked', metadata: { reason: 'rate_limit_exceeded' } },
  { by: 'reader', action: 'calendar:write', status: 'failure', metadata: { reason: 'scope_missing' } },
];

const MARK: Record<string, string> = { success: '+', failure: 'x', blocked: '!' };

function byTime(entries: readonly AuditEntry[]): AuditEntry[] {
  return [...entries].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts];
}

function share(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(0)}%`;
}

/** Index of the first entry whose prevHash does not name the entry before it, or -1. */
function firstBrokenLink(chain: readonly AuditEntry[]): number {
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index]!.prevHash !== chain[index - 1]!.hash) return index;
  }
  return -1;
}

interface Registered {
  role: Role;
  id: string;
  did: string;
}

async function register(grantex: Grantex, role: Role): Promise<Registered> {
  const spec = ROLES[role];
  const registered = await grantex.agents.register({
    name: spec.label,
    description: spec.description,
    scopes: spec.scopes,
  });
  // Older API responses name the identifier `agentId`; newer SDKs also expose `id`.
  const fields = registered as unknown as { id?: string; agentId?: string; did?: string };
  const id = (fields.id ?? fields.agentId) as string;
  return { role, id, did: fields.did ?? `did:grantex:${id}` };
}

async function authorize(grantex: Grantex, agent: Registered): Promise<ActingAgent> {
  const { label, scopes } = ROLES[agent.role];
  const request = await grantex.authorize({ agentId: agent.id, userId: PRINCIPAL, scopes });
  const code = (request as unknown as { code?: string }).code;
  if (!code) throw new Error('Authorization returned no code; use a sandbox API key so consent is auto-approved.');
  const token = await grantex.tokens.exchange({ code, agentId: agent.id });
  return { label, id: agent.id, did: agent.did, grantId: token.grantId };
}

async function main(): Promise<void> {
  const grantex = new Grantex({ apiKey: API_KEY, baseUrl: BASE_URL });
  console.log('=== Audit Trail Report ===\n');

  const reader = await register(grantex, 'reader');
  const sender = await register(grantex, 'sender');
  for (const agent of [reader, sender]) console.log(`Registered ${ROLES[agent.role].label}: ${agent.id}`);
  const agents: Record<Role, ActingAgent> = {
    reader: await authorize(grantex, reader),
    sender: await authorize(grantex, sender),
  };
  const labelOf = new Map(Object.values(agents).map((agent) => [agent.id, agent.label]));
  console.log('Both agents authorized.');

  console.log('\n--- Recording activity ---');
  for (const event of ACTIVITY) {
    const agent = agents[event.by];
    await grantex.audit.log({
      agentId: agent.id,
      agentDid: agent.did,
      grantId: agent.grantId,
      principalId: PRINCIPAL,
      action: event.action,
      status: event.status,
      metadata: event.metadata,
    });
  }
  const planned = countBy(ACTIVITY, (event) => event.status).map(([status, n]) => `${n} ${status}`);
  console.log(`Recorded ${ACTIVITY.length} entries (${planned.join(', ')}).`);

  const readerEntries = (await grantex.audit.list({ agentId: agents.reader.id })).entries;
  const senderEntries = (await grantex.audit.list({ agentId: agents.sender.id })).entries;
  const timeline = byTime([...readerEntries, ...senderEntries]);

  console.log('\n--- Timeline ---');
  console.log('   # Mark Outcome Agent          Action              Time (UTC)');
  timeline.forEach((entry, index) => {
    const columns = [
      String(index + 1).padStart(4),
      `[${MARK[entry.status] ?? '?'}] `,
      entry.status.padEnd(7),
      (labelOf.get(entry.agentId) ?? 'unknown').padEnd(14),
      entry.action.padEnd(19),
      new Date(entry.timestamp).toISOString().slice(11, 19),
    ];
    console.log(columns.join(' '));
  });

  for (const [agent, entries] of [[agents.reader, readerEntries], [agents.sender, senderEntries]] as const) {
    console.log(`\n--- Only ${agent.label} (${entries.length}) ---`);
    for (const entry of entries) console.log(`  [${MARK[entry.status] ?? '?'}] ${entry.action}: ${entry.status}`);
  }

  const emails = timeline.filter((entry) => entry.action === 'email:send');
  console.log(`\n--- Only email:send (${emails.length}) ---`);
  for (const entry of emails) {
    const who = labelOf.get(entry.agentId) ?? 'unknown';
    console.log(`  [${MARK[entry.status] ?? '?'}] ${who}: ${entry.status} ${JSON.stringify(entry.metadata)}`);
  }

  console.log('\n--- Summary ---');
  console.log(`  Entries: ${timeline.length}`);
  for (const status of ['success', 'failure', 'blocked'] as const) {
    const n = timeline.filter((entry) => entry.status === status).length;
    console.log(`  ${status.padEnd(8)} ${n} (${share(n, timeline.length)})`);
  }
  console.log('  Per agent:');
  for (const [id, n] of countBy(timeline, (entry) => entry.agentId)) console.log(`    ${labelOf.get(id) ?? id}: ${n}`);
  console.log('  Per action, most frequent first:');
  const actions = countBy(timeline, (entry) => entry.action).sort((left, right) => right[1] - left[1]);
  for (const [action, n] of actions) console.log(`    ${action}: ${n}`);

  console.log('\n--- Hash chain ---');
  // One chain per developer, not per agent: read the unfiltered list so links
  // that pass through other agents' entries are kept.
  const chain = byTime((await grantex.audit.list()).entries);
  const broken = firstBrokenLink(chain);
  if (broken !== -1) {
    console.log(`  Broken at position ${broken}: prevHash does not match the preceding entry`);
  } else {
    console.log(`  Intact: ${chain.length} linked entries`);
    if (chain.length > 0) {
      console.log(`  First hash ${chain[0]!.hash.slice(0, 16)}...`);
      console.log(`  Last hash  ${chain[chain.length - 1]!.hash.slice(0, 16)}...`);
    }
  }

  console.log('\nReport complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
