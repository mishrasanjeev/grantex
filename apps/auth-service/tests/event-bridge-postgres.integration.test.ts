import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { claimReceipt, finaliseReceipt } from '../src/lib/event-bridge/receipts.js';
import { pruneEventBridgeReceiptsOnce } from '../src/workers/eventBridgeReceiptPrune.js';
import {
  acceptedWebhookSecrets,
  createEventSource,
  getEventSource,
  loadEventSourceForIngest,
  rotateWebhookSecret,
  updateEventSource,
  SourceValidationError,
} from '../src/lib/event-bridge/sources.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres event bridge integration tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;

function connect(): ReturnType<typeof postgres> {
  return postgres(databaseUrl!, { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
}

async function withDevelopers<T>(fn: (sql: ReturnType<typeof postgres>, dev: string, other: string) => Promise<T>): Promise<T> {
  const sql = connect();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const dev = `dev_evb_${suffix}`;
  const other = `dev_evb_other_${suffix}`;
  try {
    await runMigrations(sql);
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${dev}, ${'hash_' + suffix}, 'Event Bridge Test'), (${other}, ${'hash_other_' + suffix}, 'Other Developer')`;
    return await fn(sql, dev, other);
  } finally {
    await sql`DELETE FROM developers WHERE id IN (${dev}, ${other})`.catch(() => undefined);
    await sql.end();
  }
}

describePostgres('event bridge sources and replay store against real Postgres', () => {
  it('applies nothing on a repeat start and stores webhook secrets encrypted and bound to the source', async () => {
    await withDevelopers(async (sql, dev, other) => {
      // `withDevelopers` has already migrated this database. Before the ledger
      // this second call re-applied every file; it is now a no-op, which is
      // what is asserted instead.
      expect((await runMigrations(sql)).applied).toEqual([]);
      const created = await createEventSource(sql, dev, { kind: 'webhook', name: 'provider events', toleranceSeconds: 120 });
      expect(created.secret).toMatch(/^gxevs_/);
      const [raw] = await sql`SELECT encrypted_secret FROM event_bridge_sources WHERE id = ${created.row.id}`;
      expect(raw!['encrypted_secret']).toMatch(/^ctx1:/);
      expect(raw!['encrypted_secret']).not.toContain(created.secret);
      expect(acceptedWebhookSecrets(created.row)).toEqual([created.secret]);

      // A ciphertext copied onto another source does not decrypt there.
      const second = await createEventSource(sql, dev, { kind: 'webhook', name: 'second' });
      await sql`UPDATE event_bridge_sources SET encrypted_secret = ${created.row.encrypted_secret} WHERE id = ${second.row.id}`;
      const moved = await loadEventSourceForIngest(sql, second.row.id);
      expect(() => acceptedWebhookSecrets(moved!)).toThrow();

      // Tenancy: another developer cannot read or update the source.
      expect(await getEventSource(sql, other, created.row.id)).toBeNull();
      expect(await updateEventSource(sql, other, created.row.id, { status: 'disabled' })).toBeNull();
      expect((await getEventSource(sql, dev, created.row.id))!.status).toBe('active');
    });
  }, 120_000);

  it('rotates a webhook secret with a grace period for the previous one, or none for a leaked secret', async () => {
    await withDevelopers(async (sql, dev) => {
      const created = await createEventSource(sql, dev, { kind: 'webhook', name: 'provider events' });
      const rotated = await rotateWebhookSecret(sql, dev, created.row.id, { previousSecretTtlSeconds: 600 });
      expect(rotated!.secret).not.toBe(created.secret);
      expect(acceptedWebhookSecrets(rotated!.row)).toEqual([rotated!.secret, created.secret]);
      expect(acceptedWebhookSecrets(rotated!.row, Date.now() + 601_000)).toEqual([rotated!.secret]);

      const leaked = await rotateWebhookSecret(sql, dev, created.row.id, { previousSecretTtlSeconds: 0 });
      expect(acceptedWebhookSecrets(leaked!.row)).toEqual([leaked!.secret]);

      await expect(rotateWebhookSecret(sql, dev, created.row.id, { previousSecretTtlSeconds: 8 * 86_400 }))
        .rejects.toBeInstanceOf(SourceValidationError);
    });
  }, 120_000);

  it('registers an SSF transmitter with a default audience of its ingest URL', async () => {
    await withDevelopers(async (sql, dev) => {
      const created = await createEventSource(sql, dev, {
        kind: 'ssf', name: 'transmitter', issuer: 'https://transmitter.example.com',
        jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }] },
      });
      expect(created.secret).toBeUndefined();
      expect(created.row.audience).toMatch(new RegExp(`/v1/event-bridge/ssf/${created.row.id}$`));
      await expect(updateEventSource(sql, dev, created.row.id, { jwks: null }))
        .rejects.toBeInstanceOf(SourceValidationError);
    });
  }, 120_000);

  it('acts on an event id at most once: concurrent deliveries, duplicates, conflicts and retries', async () => {
    await withDevelopers(async (sql, dev) => {
      const { row } = await createEventSource(sql, dev, { kind: 'webhook', name: 'provider events' });
      const input = { sourceId: row.id, eventId: 'evt_once', developerId: dev, bodySha256: 'a'.repeat(64), eventTypes: ['business.dissolved'] };

      const claims = await Promise.all(Array.from({ length: 20 }, () => claimReceipt(sql, input)));
      expect(claims.filter((claim) => claim === 'new')).toHaveLength(1);
      expect(claims.filter((claim) => claim === 'duplicate')).toHaveLength(19);

      await finaliseReceipt(sql, row.id, 'evt_once', 'unmapped', { events: [] });
      expect(await claimReceipt(sql, input)).toBe('duplicate');
      expect(await claimReceipt(sql, { ...input, bodySha256: 'b'.repeat(64) })).toBe('conflict');

      // A failed delivery is reprocessed by exactly one of several retries.
      await finaliseReceipt(sql, row.id, 'evt_once', 'failed', { error: 'Error' });
      const retries = await Promise.all(Array.from({ length: 10 }, () => claimReceipt(sql, input)));
      expect(retries.filter((claim) => claim === 'retry')).toHaveLength(1);

      // The same event id from a different source is a different event.
      const { row: otherSource } = await createEventSource(sql, dev, { kind: 'webhook', name: 'other sender' });
      expect(await claimReceipt(sql, { ...input, sourceId: otherSource.id })).toBe('new');
    });
  }, 120_000);

  it('keeps a receipt while its delivery could still be replayed, and no longer', async () => {
    await withDevelopers(async (sql, dev) => {
      const { row } = await createEventSource(sql, dev, {
        kind: 'webhook', name: 'provider events', toleranceSeconds: 3_600,
      });
      const insert = async (eventId: string, ageHours: number): Promise<void> => {
        await sql`
          INSERT INTO event_bridge_receipts
            (source_id, event_id, developer_id, body_sha256, event_types, status, received_at)
          VALUES (${row.id}, ${eventId}, ${dev}, ${'a'.repeat(64)}, ${['business.dissolved']}, 'applied',
                  NOW() - make_interval(hours => ${ageHours}))`;
      };
      await insert('evt_fresh', 0);
      await insert('evt_day', 30);
      await insert('evt_ancient', 24 * 30);

      const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => log };
      // Off: nothing is pruned, whatever its age.
      vi.stubEnv('EVENT_BRIDGE_ENABLED', 'false');
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(0);

      vi.stubEnv('EVENT_BRIDGE_ENABLED', 'true');
      vi.stubEnv('EVENT_BRIDGE_RECEIPT_RETENTION_HOURS', '24');
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(2);
      const left = await sql<{ event_id: string }[]>`
        SELECT event_id FROM event_bridge_receipts WHERE source_id = ${row.id} ORDER BY event_id`;
      expect(left.map((entry) => entry.event_id)).toEqual(['evt_fresh']);

      // A source's own window, not the retention setting, is the floor —
      // and that window is TWICE its tolerance. The webhook timestamp check
      // is two-sided (`|now - timestamp| > tolerance`), so a delivery may
      // arrive timestamped up to `tolerance` in the future and stays
      // acceptable until `received_at + 2 × tolerance`. A receipt deleted at
      // `tolerance + skew` — which is what this used to do — leaves an hour
      // in which the delivery replays with a signature that still verifies.
      const longWindow = await createEventSource(sql, dev, {
        kind: 'webhook', name: 'slow sender', toleranceSeconds: 3_600,
      });
      await sql`
        INSERT INTO event_bridge_receipts
          (source_id, event_id, developer_id, body_sha256, event_types, status, received_at)
        VALUES (${longWindow.row.id}, 'evt_window', ${dev}, ${'b'.repeat(64)}, ${['x']}, 'applied',
                NOW() - INTERVAL '90 minutes')`;
      vi.stubEnv('EVENT_BRIDGE_RECEIPT_RETENTION_HOURS', '1');
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(0);
      // Past 2 × tolerance it can go: nothing would accept the delivery now.
      await sql`
        UPDATE event_bridge_receipts SET received_at = NOW() - INTERVAL '121 minutes'
         WHERE source_id = ${longWindow.row.id}`;
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(1);

      // A SET source is bounded by `max_age_seconds` plus twice the 60 s
      // clock skew, because `iat` may itself be up to a skew in the future.
      const ssf = await createEventSource(sql, dev, {
        kind: 'ssf', name: 'transmitter', issuer: 'https://issuer.example.com',
        jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }] },
        maxAgeSeconds: 7_200,
      });
      await sql`
        INSERT INTO event_bridge_receipts
          (source_id, event_id, developer_id, body_sha256, event_types, status, received_at)
        VALUES (${ssf.row.id}, 'evt_set', ${dev}, ${'c'.repeat(64)}, ${['x']}, 'applied',
                NOW() - make_interval(secs => 7290))`;
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(0);
      await sql`
        UPDATE event_bridge_receipts SET received_at = NOW() - make_interval(secs => 7400)
         WHERE source_id = ${ssf.row.id}`;
      expect(await pruneEventBridgeReceiptsOnce(sql, log)).toBe(1);
      vi.unstubAllEnvs();
    });
  }, 120_000);
});
