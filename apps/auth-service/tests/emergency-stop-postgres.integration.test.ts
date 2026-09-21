import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  suffix: string;
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

    return await fn({ sql, dev, other, suffix, agents, grant });
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
      expect(result.status).toBe('completed');
      expect(result.lockout).toBe(false);
      // One sweep that found grants, and one that came back empty.
      expect(result.sweeps).toBe(2);
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
      expect(stops[0]).toMatchObject({
        scope_type: 'agent', grants_revoked: 3, dry_run: false, status: 'completed', error: null,
      });
      expect(stops[0]!.completed_at).not.toBeNull();
    });
  }, 180_000);

  it('records what it revoked even when a later batch fails', async () => {
    await withFixture(async ({ sql, dev, grant, agents }) => {
      const root = await grant(dev, 'root', { agent: agents.a });
      await grant(dev, 'child', { agent: agents.a, parent: root });

      // A stop whose second sweep cannot read the scope: the row must still
      // say what the first sweep revoked, not `grants_revoked = 0`.
      let reads = 0;
      const failing = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          if (text.includes('SELECT id FROM grants') && text.includes('agent_id =')) {
            reads += 1;
            if (reads > 1) throw Object.assign(new Error('connection reset'), { code: '08006' });
          }
          return Reflect.apply(target as never, thisArg, args);
        },
        get: (target, property) => Reflect.get(target, property),
      }) as typeof sql;

      await expect(emergencyStop(failing, {
        developerId: dev, scope: { type: 'agent', id: agents.a }, reason: 'incident', requestedBy: 'admin',
      })).rejects.toThrow(/connection reset/);

      const stops = await listEmergencyStops(sql, dev);
      expect(stops[0]).toMatchObject({ status: 'failed', grants_revoked: 2 });
      expect(stops[0]!.error).toContain('connection reset');
      expect(stops[0]!.completed_at).not.toBeNull();
      // And the grants really were revoked, which is what the row now says.
      expect(await statuses(sql, [root])).toEqual(['revoked']);
    });
  }, 180_000);

  /**
   * The summary entry used to be appended *after* the row was marked
   * `completed`, and outside the try. Exhausting its retries therefore left a
   * row claiming success, no summary on the developer's chain, and a 500 for
   * a stop that had in fact revoked everything — the state an operator is
   * least able to reason about during an incident.
   *
   * Here the audit append fails every time. The stop must fail loudly, and
   * the row must say `failed`, not `completed`.
   */
  it('records failed, not completed, when the summary entry cannot be written', async () => {
    await withFixture(async ({ sql, dev, grant, agents }) => {
      const root = await grant(dev, 'root', { agent: agents.a });
      await grant(dev, 'child', { agent: agents.a, parent: root });

      // Only the summary's transaction is broken: the cascade's own audit
      // writes go through, so the grants really are revoked first.
      let cascadesDone = 0;
      const failingSummary = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          return Reflect.apply(target as never, thisArg, args);
        },
        get: (target, property) => {
          if (property === 'begin') {
            return async (fn: (tx: unknown) => Promise<unknown>) => {
              cascadesDone += 1;
              // The cascade runs first; the summary is the transaction after it.
              if (cascadesDone > 1) {
                throw Object.assign(new Error('audit chain unavailable'), { code: '08006' });
              }
              return (Reflect.get(target, property) as (callback: unknown) => Promise<unknown>)
                .call(target, fn);
            };
          }
          return Reflect.get(target, property);
        },
      }) as typeof sql;

      await expect(emergencyStop(failingSummary, {
        developerId: dev, scope: { type: 'agent', id: agents.a }, reason: 'incident', requestedBy: 'admin',
      })).rejects.toThrow(/audit chain unavailable/);

      const stops = await listEmergencyStops(sql, dev);
      expect(stops).toHaveLength(1);
      // The regression this guards: `completed` here, with no summary entry.
      expect(stops[0]!.status).toBe('failed');
      expect(stops[0]!.error).toContain('audit chain unavailable');
      expect(stops[0]!.grants_revoked).toBe(2);

      // The revocations themselves stand — they committed before the summary.
      expect(await statuses(sql, [root])).toEqual(['revoked']);
      const summary = await sql<{ action: string }[]>`
        SELECT action FROM audit_entries
         WHERE developer_id = ${dev} AND action = 'grantex.emergency_stop'`;
      expect(summary).toHaveLength(0);
    });
  }, 180_000);

  it('sweeps again, so a grant delegated while it runs is caught', async () => {
    await withFixture(async ({ sql, dev, grant, agents, suffix }) => {
      const root = await grant(dev, 'root', { agent: agents.a });

      // A grant that appears between the first sweep's read and the second.
      let reads = 0;
      const racing = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          const result = Reflect.apply(target as never, thisArg, args) as Promise<unknown>;
          if (text.includes('SELECT id FROM grants') && text.includes('agent_id =')) {
            reads += 1;
            if (reads === 1) {
              return result.then(async (rows) => {
                await sql`
                  INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
                  VALUES (${`grnt_stop_late_${suffix}`}, ${agents.a}, 'user_1', ${dev},
                          ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 hour')`;
                return rows;
              });
            }
          }
          return result;
        },
        get: (target, property) => Reflect.get(target, property),
      }) as typeof sql;

      const result = await emergencyStop(racing, {
        developerId: dev, scope: { type: 'agent', id: agents.a }, reason: 'incident', requestedBy: 'admin',
      });
      expect(result.status).toBe('completed');
      expect(result.sweeps).toBeGreaterThanOrEqual(2);
      expect(result.grantsRevoked).toBe(2);
      expect(await statuses(sql, [root, `grnt_stop_late_${suffix}`])).toEqual(['revoked', 'revoked']);
    });
  }, 180_000);

  /**
   * The migration has to be additive on a database that already has an
   * earlier version of this table, which is every database that ran a release
   * carrying the first version of the file. `CREATE TABLE IF NOT EXISTS` is
   * skipped whole there, so columns added inside it never appear and the
   * first `INSERT … status` fails with `column "status" does not exist`. A
   * fresh container never shows it, so the old shape is built here on
   * purpose, in a schema of its own.
   */
  it('adds its later columns to a table an earlier release already created', async () => {
    const sql = postgres(databaseUrl!, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const schema = `stop_migrate_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = postgres(databaseUrl!, {
        max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {},
        connection: { search_path: schema },
      });
      try {
        // Developers is referenced by the table's foreign key.
        await scoped.unsafe(`CREATE TABLE developers (id TEXT PRIMARY KEY)`);
        // The shape the first release shipped: no status, sweeps or error.
        await scoped.unsafe(`
          CREATE TABLE emergency_stops (
            id TEXT PRIMARY KEY,
            developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
            scope_type TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            requested_by TEXT NOT NULL,
            dry_run BOOLEAN NOT NULL DEFAULT FALSE,
            grants_matched INTEGER NOT NULL DEFAULT 0,
            grants_revoked INTEGER NOT NULL DEFAULT 0,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
          )`);

        const file = join(
          dirname(fileURLToPath(import.meta.url)),
          '..', 'src', 'db', 'migrations', '113_emergency_stops.sql',
        );
        await scoped.unsafe(readFileSync(file, 'utf-8'));

        const columns = await scoped<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
           WHERE table_schema = ${schema} AND table_name = 'emergency_stops'
             AND column_name IN ('status', 'sweeps', 'error')
           ORDER BY column_name`;
        expect(columns.map((row) => row.column_name)).toEqual(['error', 'status', 'sweeps']);

        // And the row the service writes first actually inserts.
        await scoped.unsafe(`INSERT INTO developers (id) VALUES ('dev_x')`);
        await scoped.unsafe(`
          INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, status)
          VALUES ('stop_x', 'dev_x', 'developer', 'dev_x', 'testing', 'admin', 'running')`);
        await expect(scoped.unsafe(`
          INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, status)
          VALUES ('stop_y', 'dev_x', 'developer', 'dev_x', 'testing', 'admin', 'not-a-status')`))
          .rejects.toThrow();

        // Applying it twice changes nothing.
        await scoped.unsafe(readFileSync(file, 'utf-8'));
      } finally {
        await scoped.end({ timeout: 5 }).catch(() => undefined);
      }
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 120_000);

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
      // The rehearsal is recorded — a probe of a tenant's blast radius is
      // worth knowing about — but it revokes nothing and writes nothing to
      // the audit chain, which is reserved for what actually happened.
      const recorded = await listEmergencyStops(sql, dev);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        id: rehearsal.stopId, dry_run: true, status: 'completed', grants_matched: 2, grants_revoked: 0,
      });
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
