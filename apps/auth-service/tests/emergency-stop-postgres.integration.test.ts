import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { retryOnDeadlock } from './deadlock-retry.js';
import { matchStoredAuditHash } from '../src/lib/hash.js';
import { emergencyStop, listEmergencyStops } from '../src/lib/revocation/emergency-stop.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres emergency stop tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

interface Fixture {
  sql: Sql;
  dev: string;
  other: string;
  agents: { a: string; b: string; other: string };
  grant: (developerId: string, label: string, options?: { agent?: string; principal?: string; parent?: string }) => Promise<string>;
}

async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  return retryOnDeadlock(() => runFixture(fn));
}

async function runFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl!, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const dev = `dev_stop_${suffix}`;
  const other = `dev_stop_other_${suffix}`;
  const agents = { a: `ag_stop_a_${suffix}`, b: `ag_stop_b_${suffix}`, other: `ag_stop_o_${suffix}` };
  const migrationLock = await sql.reserve();
  try {
    await runMigrations(sql);
    // Startup re-runs ALTER TABLE ... IF NOT EXISTS on `grants`; hold the
    // migration lock in shared mode so a parallel test file's migration run
    // cannot take it while this file holds row locks on the same table.
    await migrationLock`SELECT pg_advisory_lock_shared(hashtextextended('grantex:migrations', 0))`;
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${dev}, ${'hash_' + suffix}, 'Stop Test'), (${other}, ${'hash_other_' + suffix}, 'Other Developer')`;
    await sql`INSERT INTO agents (id, did, developer_id, name) VALUES
      (${agents.a}, ${'did:grantex:' + agents.a}, ${dev}, 'Underwriter'),
      (${agents.b}, ${'did:grantex:' + agents.b}, ${dev}, 'Screener'),
      (${agents.other}, ${'did:grantex:' + agents.other}, ${other}, 'Their Agent')`;

    const grant = async (
      developerId: string,
      label: string,
      options: { agent?: string; principal?: string; parent?: string } = {},
    ): Promise<string> => {
      const id = `grnt_stop_${label}_${suffix}`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id)
        VALUES (${id}, ${options.agent ?? (developerId === dev ? agents.a : agents.other)},
                ${options.principal ?? 'user_1'}, ${developerId}, ${['tool:acme_kyb:read']},
                NOW() + INTERVAL '2 hours', ${options.parent ?? null})`;
      return id;
    };

    return await fn({ sql, dev, other, agents, grant });
  } finally {
    await sql`DELETE FROM emergency_stops WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM audit_entries WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM grant_suspensions WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
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
  const rows = await sql<{ id: string; status: string }[]>`SELECT id, status FROM grants WHERE id = ANY(${ids})`;
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  return ids.map((id) => byId.get(id) ?? 'missing');
}

async function verifyChain(sql: Sql, developerId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp, id`;
  let previous: string | null = null;
  for (const row of rows) {
    expect(row['previous_hash'] ?? null).toBe(previous);
    expect(matchStoredAuditHash({
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
    }, row['hash'] as string)).not.toBeNull();
    previous = row['hash'] as string;
  }
  return rows;
}

describePostgres('the emergency stop against real Postgres', () => {
  it('halts every grant under an agent, and records what it did on the audit chain', async () => {
    await withFixture(async ({ sql, dev, other, agents, grant }) => {
      const root = await grant(dev, 'root', { agent: agents.a });
      const child = await grant(dev, 'child', { agent: agents.b, parent: root });
      const grandchild = await grant(dev, 'grandchild', { agent: agents.b, parent: child });
      const unrelated = await grant(dev, 'unrelated', { agent: agents.b });
      const theirs = await grant(other, 'theirs');

      const result = await emergencyStop(sql, {
        developerId: dev,
        scope: { type: 'agent', id: agents.a },
        reason: 'incident 4102: provider credentials leaked',
        requestedBy: 'admin',
      });

      expect(result.stopId).toMatch(/^stop_/);
      expect(result.grantsMatched).toBe(1);
      expect(result.grantsRevoked).toBe(3);
      expect(result.agentsStopped.sort()).toEqual([agents.a, agents.b].sort());
      expect(await statuses(sql, [root, child, grandchild])).toEqual(['revoked', 'revoked', 'revoked']);
      // A grant of the same developer that the scope does not cover survives.
      expect(await statuses(sql, [unrelated])).toEqual(['active']);
      expect(await statuses(sql, [theirs])).toEqual(['active']);

      const entries = await verifyChain(sql, dev);
      expect(entries.filter((entry) => entry['action'] === 'grantex.grant.revoked')).toHaveLength(3);
      const summary = entries.find((entry) => entry['action'] === 'grantex.emergency_stop');
      expect(summary).toBeDefined();
      expect(summary!['metadata']).toMatchObject({
        stop_id: result.stopId,
        scope_type: 'agent',
        scope_id: agents.a,
        grants_revoked: 3,
        requested_by: 'admin',
        reason: 'incident 4102: provider credentials leaked',
        'grantex:platform': true,
      });
      expect(await verifyChain(sql, other)).toHaveLength(0);

      const stops = await listEmergencyStops(sql, dev);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ scope_type: 'agent', grants_revoked: 3, dry_run: false });
      expect(stops[0]!.completed_at).not.toBeNull();
    });
  }, 180_000);

  it('rehearses without revoking anything', async () => {
    await withFixture(async ({ sql, dev, grant, agents }) => {
      const root = await grant(dev, 'root', { agent: agents.a });
      const child = await grant(dev, 'child', { agent: agents.a, parent: root });

      const rehearsal = await emergencyStop(sql, {
        developerId: dev,
        scope: { type: 'developer', id: dev },
        reason: 'quarterly emergency stop rehearsal',
        requestedBy: 'admin',
        dryRun: true,
      });
      expect(rehearsal.dryRun).toBe(true);
      expect(rehearsal.grantsMatched).toBe(2);
      expect(rehearsal.grantsRevoked).toBe(0);
      expect(await statuses(sql, [root, child])).toEqual(['active', 'active']);
      expect(await listEmergencyStops(sql, dev)).toHaveLength(0);
      expect(await verifyChain(sql, dev)).toHaveLength(0);
    });
  }, 180_000);

  it('stops a principal, a single grant tree and a whole developer, and is idempotent', async () => {
    await withFixture(async ({ sql, dev, other, grant, agents }) => {
      const byPrincipal = await grant(dev, 'principal', { principal: 'user_stop' });
      const tree = await grant(dev, 'tree', { agent: agents.b });
      const treeChild = await grant(dev, 'treechild', { agent: agents.b, parent: tree });
      const rest = await grant(dev, 'rest', { agent: agents.b, principal: 'user_other' });
      const theirs = await grant(other, 'theirs');

      const principal = await emergencyStop(sql, {
        developerId: dev, scope: { type: 'principal', id: 'user_stop' }, reason: 'principal offboarded', requestedBy: 'admin',
      });
      expect(principal.grantsRevoked).toBe(1);
      expect(await statuses(sql, [byPrincipal])).toEqual(['revoked']);

      const single = await emergencyStop(sql, {
        developerId: dev, scope: { type: 'grant', id: tree }, reason: 'suspect grant', requestedBy: 'admin',
      });
      expect(single.grantsRevoked).toBe(2);
      expect(await statuses(sql, [tree, treeChild])).toEqual(['revoked', 'revoked']);

      // Running it again finds nothing left to do.
      const again = await emergencyStop(sql, {
        developerId: dev, scope: { type: 'grant', id: tree }, reason: 'suspect grant', requestedBy: 'admin',
      });
      expect(again.grantsMatched).toBe(0);
      expect(again.grantsRevoked).toBe(0);

      const everything = await emergencyStop(sql, {
        developerId: dev, scope: { type: 'developer', id: dev }, reason: 'incident 4103', requestedBy: 'admin',
      });
      expect(everything.grantsRevoked).toBe(1);
      expect(await statuses(sql, [rest])).toEqual(['revoked']);
      const live = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM grants WHERE developer_id = ${dev} AND status <> 'revoked'`;
      expect(live[0]!.count).toBe('0');
      // The other developer is untouched by all of it.
      expect(await statuses(sql, [theirs])).toEqual(['active']);

      await verifyChain(sql, dev);
      expect(await listEmergencyStops(sql, dev)).toHaveLength(4);
    });
  }, 180_000);

  it('refuses to reach into another developer, whatever it is pointed at', async () => {
    await withFixture(async ({ sql, dev, other, grant, agents }) => {
      const theirGrant = await grant(other, 'theirs');
      for (const scope of [
        { type: 'grant' as const, id: theirGrant },
        { type: 'agent' as const, id: agents.other },
        { type: 'principal' as const, id: 'user_1' },
      ]) {
        const result = await emergencyStop(sql, {
          developerId: dev, scope, reason: 'attempted cross-tenant stop', requestedBy: 'admin',
        });
        expect(result.grantsRevoked).toBe(0);
      }
      expect(await statuses(sql, [theirGrant])).toEqual(['active']);
      expect(await verifyChain(sql, other)).toHaveLength(0);
    });
  }, 180_000);
});
