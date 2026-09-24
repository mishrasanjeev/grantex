import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { retryOnDeadlock } from './deadlock-retry.js';
import { matchStoredAuditHash } from '../src/lib/hash.js';
import { cascadeGrantAction, resumeSuspendedGrants } from '../src/lib/revocation/cascade.js';
import { mappingProcessor } from '../src/lib/event-bridge/actions.js';
import { createMappingRule } from '../src/lib/event-bridge/rules-store.js';
import { createEventSource } from '../src/lib/event-bridge/sources.js';
import type { NormalizedEvent } from '../src/lib/event-bridge/normalize.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own. Sharing one database across
// the Postgres integration files let `CREATE INDEX CONCURRENTLY` in one file
// deadlock against another file's migration run (FINDINGS G-24).
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres cascade revocation tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

const log = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  child: () => log,
};

function connect(): Sql {
  return postgres(databaseUrl!, { max: 16, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
}

interface Fixture {
  sql: Sql;
  dev: string;
  other: string;
  agent: string;
  suffix: string;
  /** Create a chain of delegated grants, root first. Returns their ids. */
  chain: (developerId: string, depth: number, label: string) => Promise<string[]>;
}

async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  return retryOnDeadlock(() => runFixture(fn));
}

async function runFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  const sql = connect();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const dev = `dev_casc_${suffix}`;
  const other = `dev_casc_other_${suffix}`;
  const agent = `ag_casc_${suffix}`;
  // Startup re-runs ALTER TABLE ... IF NOT EXISTS on `grants`, which needs a
  // lock this test's open transactions hold. Hold the migration lock in shared
  // mode so a parallel test file's migration run waits instead of deadlocking.
  const migrationLock = await sql.reserve();
  try {
    await runMigrations(sql);
    await migrationLock`SELECT pg_advisory_lock_shared(hashtextextended('grantex:migrations', 0))`;
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${dev}, ${'hash_' + suffix}, 'Cascade Test'), (${other}, ${'hash_other_' + suffix}, 'Other Developer')`;
    await sql`INSERT INTO agents (id, did, developer_id, name) VALUES
      (${agent}, ${'did:grantex:' + agent}, ${dev}, 'Underwriter'),
      (${agent + '_o'}, ${'did:grantex:' + agent + '_o'}, ${other}, 'Other Underwriter')`;

    const chain = async (developerId: string, depth: number, label: string): Promise<string[]> => {
      const ids: string[] = [];
      let parent: string | null = null;
      const agentId = developerId === dev ? agent : `${agent}_o`;
      for (let level = 0; level < depth; level += 1) {
        const id = `grnt_${label}_${level}_${suffix}`;
        await sql`
          INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id, delegation_depth, purpose)
          VALUES (${id}, ${agentId}, ${'user_' + label}, ${developerId}, ${['tool:acme_kyb:read']},
                  NOW() + INTERVAL '2 hours', ${parent}, ${level}, 'aml.cdd.onboarding')`;
        ids.push(id);
        parent = id;
      }
      return ids;
    };

    return await fn({ sql, dev, other, agent, suffix, chain });
  } finally {
    await sql`DELETE FROM audit_entries WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM grant_subject_refs WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM grant_suspensions WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM verifiable_credentials WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM event_mapping_rules WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM event_bridge_sources WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM grants WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM agents WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM audit_entry_counters WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM developers WHERE id IN (${dev}, ${other})`.catch(() => undefined);
    await migrationLock`SELECT pg_advisory_unlock_shared(hashtextextended('grantex:migrations', 0))`.catch(() => undefined);
    migrationLock.release();
    await sql.end();
  }
}

async function statuses(sql: Sql, ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM grants WHERE id = ANY(${ids})`;
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  return ids.map((id) => byId.get(id) ?? 'missing');
}

/** Recompute the developer's whole audit chain and return the entries in order. */
async function verifyChain(sql: Sql, developerId: string): Promise<Array<{ action: string; metadata: Record<string, unknown>; grant_id: string }>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp, id`;
  let previous: string | null = null;
  for (const row of rows) {
    expect(row['previous_hash'] ?? null).toBe(previous);
    const matched = matchStoredAuditHash({
      id: row['id'] as string,
      agentId: row['agent_id'] as string,
      agentDid: row['agent_did'] as string,
      grantId: row['grant_id'] as string,
      principalId: row['principal_id'] as string,
      developerId: row['developer_id'] as string,
      action: row['action'] as string,
      metadata: row['metadata'],
      timestamp: new Date(row['timestamp'] as string).toISOString(),
      prevHash: (row['previous_hash'] as string | null) ?? null,
      status: row['status'] as string,
    }, row['hash'] as string);
    expect(matched).not.toBeNull();
    previous = row['hash'] as string;
  }
  return rows.map((row) => ({
    action: row['action'] as string,
    metadata: row['metadata'] as Record<string, unknown>,
    grant_id: row['grant_id'] as string,
  }));
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('event-cascade');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('cascade revocation against real Postgres', () => {
  it('revokes a depth-4 delegation tree in one call and records an unbroken audit chain', async () => {
    await withFixture(async ({ sql, dev, other, chain }) => {
      const ours = await chain(dev, 4, 'deep');
      const theirs = await chain(other, 2, 'theirs');

      const outcome = await cascadeGrantAction(sql, {
        developerId: dev,
        rootGrantIds: [ours[0]!],
        action: 'revoke',
        cause: 'event',
        reason: 'provider reported the company dissolved',
        context: { event_id: 'evt_0001', source_id: 'evsrc_01' },
      });

      expect(outcome.affected).toHaveLength(4);
      expect(outcome.roots).toEqual([ours[0]]);
      expect(outcome.affected.map((a) => a.depth).sort()).toEqual([0, 1, 2, 3]);
      expect(await statuses(sql, ours)).toEqual(['revoked', 'revoked', 'revoked', 'revoked']);
      // Another developer's tree is untouched.
      expect(await statuses(sql, theirs)).toEqual(['active', 'active']);

      const entries = await verifyChain(sql, dev);
      expect(entries).toHaveLength(4);
      expect(new Set(entries.map((e) => e.action))).toEqual(new Set(['grantex.grant.revoked']));
      expect(entries.map((e) => e.grant_id).sort()).toEqual([...ours].sort());
      const root = entries.find((e) => e.grant_id === ours[0])!;
      expect(root.metadata).toMatchObject({
        cause: 'event', trigger: 'event', depth: 0, cascade: false,
        event_id: 'evt_0001', source_id: 'evsrc_01', 'grantex:platform': true,
        reason: 'provider reported the company dissolved',
      });
      const leaf = entries.find((e) => e.grant_id === ours[3])!;
      expect(leaf.metadata).toMatchObject({ trigger: 'cascade', depth: 3, cascade: true, root_grant_id: ours[0] });
      expect(await verifyChain(sql, other)).toHaveLength(0);

      // Revoking again is a no-op: nothing changes and no second entry is written.
      const again = await cascadeGrantAction(sql, {
        developerId: dev, rootGrantIds: [ours[0]!], action: 'revoke', cause: 'api',
      });
      expect(again.affected).toHaveLength(0);
      expect(await verifyChain(sql, dev)).toHaveLength(4);
    });
  }, 180_000);

  it('refuses to touch another developer\'s grant, however the root is named', async () => {
    await withFixture(async ({ sql, dev, other, chain }) => {
      const theirs = await chain(other, 3, 'theirs');
      const outcome = await cascadeGrantAction(sql, {
        developerId: dev, rootGrantIds: [theirs[0]!, theirs[1]!], action: 'revoke', cause: 'event',
      });
      expect(outcome.affected).toEqual([]);
      expect(await statuses(sql, theirs)).toEqual(['active', 'active', 'active']);
      expect(await verifyChain(sql, dev)).toHaveLength(0);
      expect(await verifyChain(sql, other)).toHaveLength(0);
    });
  }, 180_000);

  it('keeps one suspension per action when a target resolves a parent and its children', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 3, 'nested');
      // A principal target resolves all three grants at once.
      const outcome = await cascadeGrantAction(sql, {
        developerId: dev, rootGrantIds: [...ids], action: 'suspend', cause: 'event',
      });
      expect(outcome.affected).toHaveLength(3);
      const rows = await sql<{ grant_id: string; root_grant_id: string }[]>`
        SELECT grant_id, root_grant_id FROM grant_suspensions WHERE developer_id = ${dev}`;
      // One suspension, rooted at the top-most grant the action named — not
      // three suspensions each rooted at itself.
      expect(new Set(rows.map((row) => row.root_grant_id))).toEqual(new Set([ids[0]]));

      const resumed = await resumeSuspendedGrants(sql, dev, ids[0]!);
      expect(resumed.status).toBe('resumed');
      expect(resumed.grantIds.sort()).toEqual([...ids].sort());
      expect(await statuses(sql, ids)).toEqual(['active', 'active', 'active']);
    });
  }, 180_000);

  it('does not move a grant into a later suspension', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 3, 'steal');
      // The child is suspended on its own first.
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[1]!], action: 'suspend', cause: 'event' });
      // Then an ancestor is suspended: the child keeps the suspension that
      // already held it, so resuming the ancestor cannot resurrect it.
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[0]!], action: 'suspend', cause: 'event' });

      const rows = await sql<{ grant_id: string; root_grant_id: string }[]>`
        SELECT grant_id, root_grant_id FROM grant_suspensions WHERE developer_id = ${dev} ORDER BY grant_id`;
      const byGrant = new Map(rows.map((row) => [row.grant_id, row.root_grant_id]));
      expect(byGrant.get(ids[1]!)).toBe(ids[1]);
      expect(byGrant.get(ids[2]!)).toBe(ids[1]);
      expect(byGrant.get(ids[0]!)).toBe(ids[0]);

      const resumed = await resumeSuspendedGrants(sql, dev, ids[0]!);
      expect(resumed.grantIds).toEqual([ids[0]]);
      expect(await statuses(sql, ids)).toEqual(['active', 'suspended', 'suspended']);
      expect((await resumeSuspendedGrants(sql, dev, ids[1]!)).status).toBe('resumed');
      expect(await statuses(sql, ids)).toEqual(['active', 'active', 'active']);
    });
  }, 180_000);

  /**
   * The credential this covers is backed by a status list, because every
   * credential `issueAgentGrantVC` writes is: it always fills in
   * `status_list_id` and `status_list_idx`. A fixture without them skips
   * `setRevocationBits` entirely, so the test would pass while the real path
   * threw — which is exactly what happened once.
   */
  it('revokes credentials issued for a grant, and flips the status-list bit, in the same transaction', async () => {
    await withFixture(async ({ sql, dev, chain, suffix }) => {
      const ids = await chain(dev, 2, 'vc');
      const vcId = `vc_${suffix}`;
      const listId = `vcsl_${suffix}`;
      const index = 7;
      const emptyList = gzipSync(Buffer.alloc(16384, 0)).toString('base64url');
      await sql`
        INSERT INTO vc_status_lists (id, developer_id, purpose, encoded_list, size, next_index)
        VALUES (${listId}, ${dev}, 'revocation', ${emptyList}, 131072, ${index + 1})`;
      await sql`
        INSERT INTO verifiable_credentials
          (id, grant_id, developer_id, principal_id, agent_did, credential_type, credential_jwt, status,
           status_list_id, status_list_idx, expires_at)
        VALUES (${vcId}, ${ids[1]!}, ${dev}, 'user_vc', 'did:grantex:agent', 'AgentGrantCredential',
                'placeholder', 'active', ${listId}, ${index}, NOW() + INTERVAL '1 hour')`;

      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[0]!], action: 'revoke', cause: 'event' });

      const [row] = await sql<{ status: string }[]>`SELECT status FROM verifiable_credentials WHERE id = ${vcId}`;
      // Fire-and-forget would leave this 'active' whenever the call failed,
      // with every retry of the delivery a duplicate that never retries it.
      expect(row!.status).toBe('revoked');
      // And the grant itself really is revoked: a throw inside the
      // credential work rolls the whole cascade back, which is how this
      // regression left grants active while reporting nothing.
      expect(await statuses(sql, ids)).toEqual(['revoked', 'revoked']);

      const [list] = await sql<{ encoded_list: string }[]>`
        SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}`;
      const bits = gunzipSync(Buffer.from(list!.encoded_list, 'base64url'));
      expect((bits[Math.floor(index / 8)]! >> (7 - (index % 8))) & 1).toBe(1);
    });
  }, 180_000);

  it('suspends and resumes a subtree, and refuses a resume under an inactive ancestor', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 3, 'susp');

      const suspended = await cascadeGrantAction(sql, {
        developerId: dev, rootGrantIds: [ids[1]!], action: 'suspend', cause: 'event',
        context: { event_id: 'evt_susp' },
      });
      expect(suspended.affected).toHaveLength(2);
      expect(await statuses(sql, ids)).toEqual(['active', 'suspended', 'suspended']);
      const suspendedRows = await sql<{ grant_id: string; root_grant_id: string }[]>`
        SELECT grant_id, root_grant_id FROM grant_suspensions WHERE developer_id = ${dev} ORDER BY grant_id`;
      expect(suspendedRows.map((row) => row.grant_id).sort()).toEqual([ids[1], ids[2]].sort());
      expect(suspendedRows.every((row) => row.root_grant_id === ids[1])).toBe(true);

      const resumed = await resumeSuspendedGrants(sql, dev, ids[1]!);
      expect(resumed.status).toBe('resumed');
      expect(resumed.grantIds.sort()).toEqual([ids[1], ids[2]].sort());
      expect(await statuses(sql, ids)).toEqual(['active', 'active', 'active']);

      // Suspend again, then revoke the parent: the suspended subtree is revoked too.
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[1]!], action: 'suspend', cause: 'event' });
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[0]!], action: 'revoke', cause: 'api' });
      expect(await statuses(sql, ids)).toEqual(['revoked', 'revoked', 'revoked']);
      expect((await resumeSuspendedGrants(sql, dev, ids[1]!)).status).toBe('not_suspended');
      // Revocation removed the suspension bookkeeping, so nothing can be resumed.
      expect(await sql`SELECT grant_id FROM grant_suspensions WHERE developer_id = ${dev}`).toEqual([]);

      // A suspension whose ancestor is not active cannot be resumed.
      const fresh = await chain(dev, 3, 'anc');
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [fresh[2]!], action: 'suspend', cause: 'event' });
      await cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [fresh[1]!], action: 'suspend', cause: 'event' });
      expect((await resumeSuspendedGrants(sql, dev, fresh[2]!)).status).toBe('ancestor_inactive');
      expect((await resumeSuspendedGrants(sql, dev, fresh[1]!)).status).toBe('resumed');
      expect(await statuses(sql, fresh)).toEqual(['active', 'active', 'suspended']);

      await verifyChain(sql, dev);
    });
  }, 180_000);

  it('leaves no active grant under a revoked parent when delegation races the cascade', async () => {
    await withFixture(async ({ sql, dev, agent, chain, suffix }) => {
      const ids = await chain(dev, 2, 'race');
      const parent = ids[1]!;

      // Each delegation does what POST /v1/grants/delegate does: take the
      // developer's grant lock, re-check the parent, then insert the child.
      const delegate = async (index: number): Promise<void> => {
        await sql.begin(async (raw) => {
          const tx = raw as unknown as Sql;
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${dev}, 4))`;
          const locked = await tx`
            SELECT id FROM grants
             WHERE id = ${parent} AND developer_id = ${dev} AND status = 'active' AND expires_at > NOW()
             FOR UPDATE`;
          if (!locked[0]) return;
          await tx`
            INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id, delegation_depth)
            VALUES (${`grnt_child_${index}_${suffix}`}, ${agent}, 'user_race', ${dev}, ${['tool:acme_kyb:read']},
                    NOW() + INTERVAL '1 hour', ${parent}, 2)`;
        });
      };

      const work: Array<Promise<unknown>> = [];
      for (let index = 0; index < 12; index += 1) work.push(delegate(index));
      work.push(cascadeGrantAction(sql, { developerId: dev, rootGrantIds: [ids[0]!], action: 'revoke', cause: 'emergency_stop' }));
      for (let index = 12; index < 24; index += 1) work.push(delegate(index));
      await Promise.all(work);

      const stragglers = await sql<{ id: string }[]>`
        WITH RECURSIVE revoked AS (
          SELECT id FROM grants WHERE developer_id = ${dev} AND status = 'revoked'
          UNION
          SELECT g.id FROM grants g JOIN revoked r ON g.parent_grant_id = r.id WHERE g.developer_id = ${dev}
        )
        SELECT g.id FROM grants g JOIN revoked r ON g.id = r.id
         WHERE g.developer_id = ${dev} AND g.status <> 'revoked'`;
      expect(stragglers).toEqual([]);

      const entries = await verifyChain(sql, dev);
      const revoked = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM grants WHERE developer_id = ${dev} AND status = 'revoked'`;
      expect(entries).toHaveLength(Number(revoked[0]!.count));
    });
  }, 180_000);
});

describePostgres('mapping rules acting on verified events', () => {
  async function process(sql: Sql, developerId: string, sourceId: string, events: NormalizedEvent | NormalizedEvent[]) {
    return mappingProcessor(sql, log, { developerId, sourceId, receivedAt: Date.now() })(
      Array.isArray(events) ? events : [events],
    );
  }

  /** A real source: actions are recorded against it, so it has to exist. */
  async function source(sql: Sql, developerId: string): Promise<string> {
    const created = await createEventSource(sql, developerId, { kind: 'webhook', name: 'provider events' });
    return created.row.id;
  }

  function dissolution(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    return {
      sourceId: 'evsrc_mapping', sourceKind: 'webhook', developerId: 'x', eventId: 'evt_1',
      type: 'business.dissolved', subject: { business_ref: 'gb:00000001' }, data: { status: 'dissolved' },
      occurredAt: null, ...overrides,
    };
  }

  it('revokes the grants a subject binding resolves to, and nothing else', async () => {
    await withFixture(async ({ sql, dev, other, chain }) => {
      const ours = await chain(dev, 3, 'map');
      const theirs = await chain(other, 2, 'mapother');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${dev}, ${ours[0]!}, 'business_ref', 'gb:00000001')`;
      // The other developer binds the same identifier to their own grant.
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${other}, ${theirs[0]!}, 'business_ref', 'gb:00000001')`;

      await createMappingRule(sql, dev, {
        name: 'dissolution revokes', eventType: 'business.*',
        conditions: [{ path: 'data.status', equals: 'dissolved' }],
        target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
        action: 'revoke',
      });

      const outcome = await process(sql, dev, await source(sql, dev), dissolution());
      expect(outcome.status).toBe('applied');
      expect(outcome.result['revoked']).toBe(3);
      expect(await statuses(sql, ours)).toEqual(['revoked', 'revoked', 'revoked']);
      expect(await statuses(sql, theirs)).toEqual(['active', 'active']);
      await verifyChain(sql, dev);
      expect(await verifyChain(sql, other)).toHaveLength(0);
    });
  }, 180_000);

  it('records an unmatched event as unmapped and an observe rule as observed, without changing a grant', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 2, 'obs');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${dev}, ${ids[0]!}, 'business_ref', 'gb:00000001')`;
      await createMappingRule(sql, dev, {
        name: 'watch dissolutions', eventType: 'business.dissolved',
        target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
        action: 'revoke', mode: 'observe',
      });

      const sourceId = await source(sql, dev);
      const unmapped = await process(sql, dev, sourceId, dissolution({ type: 'business.renamed' }));
      expect(unmapped.status).toBe('unmapped');
      const observed = await process(sql, dev, sourceId, dissolution());
      expect(observed.status).toBe('observed');
      expect(await statuses(sql, ids)).toEqual(['active', 'active']);
      expect(await verifyChain(sql, dev)).toHaveLength(0);
    });
  }, 180_000);

  it('records target_invalid and no_target without acting, including a grant of another developer', async () => {
    await withFixture(async ({ sql, dev, other, chain }) => {
      const theirs = await chain(other, 1, 'crosstenant');
      await createMappingRule(sql, dev, {
        name: 'revoke by grant id', eventType: 'session.revoked',
        target: { by: 'grant_id', path: 'subject.grant_id' }, action: 'revoke',
      });

      const sourceId = await source(sql, dev);
      const invalid = await process(sql, dev, sourceId, dissolution({
        type: 'session.revoked', subject: { grant_id: { id: theirs[0] } },
      }));
      expect(invalid.status).toBe('applied');
      expect((invalid.result['events'] as Array<{ rules: Array<{ outcome: string }> }>)[0]!.rules[0]!.outcome).toBe('target_invalid');

      const crossTenant = await process(sql, dev, sourceId, dissolution({
        eventId: 'evt_2', type: 'session.revoked', subject: { grant_id: theirs[0] },
      }));
      expect((crossTenant.result['events'] as Array<{ rules: Array<{ outcome: string }> }>)[0]!.rules[0]!.outcome).toBe('no_target');
      expect(await statuses(sql, theirs)).toEqual(['active']);
      expect(await verifyChain(sql, other)).toHaveLength(0);
    });
  }, 180_000);

  it('suspends on one rule and asks for re-evaluation on another', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 2, 'multi');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${dev}, ${ids[0]!}, 'case_id', 'case_0001')`;
      await createMappingRule(sql, dev, {
        name: 'suspend on risk', eventType: 'risk.raised',
        target: { by: 'subject_ref', path: 'subject.case_id', kind: 'case_id' }, action: 'suspend',
      });
      await createMappingRule(sql, dev, {
        name: 're-evaluate on risk', eventType: 'risk.raised',
        target: { by: 'subject_ref', path: 'subject.case_id', kind: 'case_id' }, action: 're_evaluate',
      });

      const sourceId = await source(sql, dev);
      const outcome = await process(sql, dev, sourceId, dissolution({
        type: 'risk.raised', subject: { case_id: 'case_0001' },
      }));
      expect(outcome.status).toBe('applied');
      expect(outcome.result['suspended']).toBe(2);
      expect(outcome.result['re_evaluated']).toBe(1);
      expect(await statuses(sql, ids)).toEqual(['suspended', 'suspended']);

      const entries = await verifyChain(sql, dev);
      expect(entries.map((e) => e.action).sort()).toEqual([
        'grantex.grant.re_evaluation_requested', 'grantex.grant.suspended', 'grantex.grant.suspended',
      ]);
    });
  }, 180_000);

  it('labels each action with the event that matched, in a set carrying several', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const dissolved = await chain(dev, 1, 'multi_a');
      const risky = await chain(dev, 1, 'multi_b');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value) VALUES
        (${dev}, ${dissolved[0]!}, 'business_ref', 'gb:00000001'),
        (${dev}, ${risky[0]!}, 'case_id', 'case_0002')`;
      await createMappingRule(sql, dev, {
        name: 'dissolution revokes', eventType: 'business.dissolved',
        target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' }, action: 'revoke',
      });
      await createMappingRule(sql, dev, {
        name: 'risk suspends', eventType: 'risk.raised',
        target: { by: 'subject_ref', path: 'subject.case_id', kind: 'case_id' }, action: 'suspend',
      });

      const sourceId = await source(sql, dev);
      const outcome = await process(sql, dev, sourceId, [
        dissolution({ eventId: 'set_multi' }),
        dissolution({ eventId: 'set_multi', type: 'risk.raised', subject: { case_id: 'case_0002' } }),
      ]);
      expect(outcome.status).toBe('applied');
      expect(await statuses(sql, [dissolved[0]!, risky[0]!])).toEqual(['revoked', 'suspended']);

      const entries = await verifyChain(sql, dev);
      const revocation = entries.find((entry) => entry.grant_id === dissolved[0]!)!;
      const suspension = entries.find((entry) => entry.grant_id === risky[0]!)!;
      // Each entry names the event that actually matched its rule, not the
      // first member of the set.
      expect(revocation.metadata).toMatchObject({ event_type: 'business.dissolved', event_index: 0 });
      expect(suspension.metadata).toMatchObject({ event_type: 'risk.raised', event_index: 1 });
    });
  }, 180_000);

  it('asks for re-evaluation once, however often the delivery is retried', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 1, 'reeval');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${dev}, ${ids[0]!}, 'case_id', 'case_0003')`;
      await createMappingRule(sql, dev, {
        name: 're-evaluate on risk', eventType: 'risk.raised',
        target: { by: 'subject_ref', path: 'subject.case_id', kind: 'case_id' }, action: 're_evaluate',
      });

      const sourceId = await source(sql, dev);
      const event = dissolution({ eventId: 'evt_retry', type: 'risk.raised', subject: { case_id: 'case_0003' } });
      const first = await process(sql, dev, sourceId, event);
      expect(first.result['re_evaluated']).toBe(1);
      // The same delivery again: a later rule failing, or the receipt not
      // being finalised, must not ask the platform twice.
      const second = await process(sql, dev, sourceId, event);
      expect(second.result['re_evaluated']).toBe(0);

      const entries = await verifyChain(sql, dev);
      expect(entries.filter((entry) => entry.action === 'grantex.grant.re_evaluation_requested')).toHaveLength(1);
    });
  }, 180_000);

  it('keeps a subject that is large or oddly shaped out of the audit chain', async () => {
    await withFixture(async ({ sql, dev, chain }) => {
      const ids = await chain(dev, 1, 'subj');
      await sql`INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
        VALUES (${dev}, ${ids[0]!}, 'case_id', 'case_0004')`;
      await createMappingRule(sql, dev, {
        name: 're-evaluate', eventType: 'risk.raised',
        target: { by: 'subject_ref', path: 'subject.case_id', kind: 'case_id' }, action: 're_evaluate',
      });

      const sourceId = await source(sql, dev);
      await process(sql, dev, sourceId, dissolution({
        eventId: 'evt_subject', type: 'risk.raised',
        subject: {
          case_id: 'case_0004',
          long: 'x'.repeat(5_000),
          nested: { anything: 'here' },
          'not a key': 'dropped',
        },
      }));

      const entry = (await verifyChain(sql, dev))
        .find((row) => row.action === 'grantex.grant.re_evaluation_requested')!;
      const subject = entry.metadata['subject'] as Record<string, unknown>;
      expect(subject['case_id']).toBe('case_0004');
      expect(String(subject['long']).length).toBeLessThanOrEqual(257);
      expect(subject).not.toHaveProperty('nested');
      expect(subject).not.toHaveProperty('not a key');
      expect(subject['subject_truncated']).toBe(true);
    });
  }, 180_000);
});
