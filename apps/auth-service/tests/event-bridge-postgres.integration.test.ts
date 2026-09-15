import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { claimReceipt, finaliseReceipt } from '../src/lib/event-bridge/receipts.js';
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
  it('migrates idempotently and stores webhook secrets encrypted and bound to the source', async () => {
    await withDevelopers(async (sql, dev, other) => {
      await runMigrations(sql); // every start re-applies all files
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
});
