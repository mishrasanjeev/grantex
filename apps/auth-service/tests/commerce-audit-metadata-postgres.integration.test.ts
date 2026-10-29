// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Commerce audit metadata against real Postgres: appendCommerceAudit stores
 * metadata as a JSON object, and migration 138 rewrites rows the old writer
 * stored as a JSON string, idempotently, leaving the table append-only.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { appendCommerceAudit } from '../src/lib/commerce/audit.js';
import { sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres audit metadata tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

let sql: ReturnType<typeof postgres>;
let dropTestDatabase: (() => Promise<void>) | undefined;

describePostgres('commerce audit metadata against Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('audit-metadata');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await dropTestDatabase?.();
  }, 60_000);

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  });

  it('stores metadata as a JSON object', async () => {
    const tenant = 'cten_AUDITMETA';
    await sql`INSERT INTO commerce_tenants (id, display_name) VALUES (${tenant}, 'Audit tenant') ON CONFLICT DO NOTHING`;
    const written = await appendCommerceAudit(sqlMock as never, {
      tenantId: tenant, eventType: 'tenant.updated', metadata: { reason: 'test', nested: { n: 1 } },
    });
    const [row] = await sql`SELECT jsonb_typeof(metadata) AS kind, metadata->>'reason' AS reason, metadata#>>'{nested,n}' AS n
      FROM commerce_audit_events WHERE id = ${written.id}`;
    expect(row).toEqual({ kind: 'object', reason: 'test', n: '1' });
  });

  it('repairs metadata stored as a JSON string, idempotently, and keeps the table append-only', async () => {
    const tenant = 'cten_AUDITREPAIR';
    await sql`INSERT INTO commerce_tenants (id, display_name) VALUES (${tenant}, 'Repair tenant') ON CONFLICT DO NOTHING`;
    // What the old writer produced: a jsonb string holding the object's text.
    await sql`INSERT INTO commerce_audit_events (id, tenant_id, event_type, metadata)
      VALUES ('caud_REPAIR_STRING', ${tenant}, 'tenant.updated', to_jsonb(${'{"reason":"legacy","n":2}'}::text))`;
    await sql`INSERT INTO commerce_audit_events (id, tenant_id, event_type, metadata)
      VALUES ('caud_REPAIR_SCALAR', ${tenant}, 'tenant.updated', to_jsonb(${'not json'}::text))`;
    await sql`INSERT INTO commerce_audit_events (id, tenant_id, event_type, metadata)
      VALUES ('caud_REPAIR_OBJECT', ${tenant}, 'tenant.updated', ${sql.json({ reason: 'fine' } as never)})`;
    const repair = readFileSync(new URL('../src/db/migrations/138_commerce_audit_metadata_objects.sql', import.meta.url), 'utf8');
    for (let run = 0; run < 2; run += 1) {
      await sql.begin((tx) => tx.unsafe(repair));
      const rows = await sql`SELECT id, jsonb_typeof(metadata) AS kind, metadata FROM commerce_audit_events
        WHERE id LIKE 'caud_REPAIR_%' ORDER BY id`;
      expect(rows.map((r) => [r['id'], r['kind']])).toEqual([
        ['caud_REPAIR_OBJECT', 'object'],
        ['caud_REPAIR_SCALAR', 'string'],
        ['caud_REPAIR_STRING', 'object'],
      ]);
      expect(rows[2]!['metadata']).toEqual({ reason: 'legacy', n: 2 });
    }
    await expect(sql`UPDATE commerce_audit_events SET event_type = 'x' WHERE id = 'caud_REPAIR_OBJECT'`).rejects.toThrow(/append-only/);
  });
});
