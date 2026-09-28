// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's attestation-acceptance store against real Postgres.
 *
 * Migration 123 holds the registry's own acceptance lists — never one per
 * tenant — with at least 131,072 entries each. An entry's index is drawn at
 * random (Bitstring Status List v1.0 §2.1: "Implementations SHOULD assign
 * indexes randomly") and must never be handed out twice
 * (draft-ietf-oauth-status-list-21 §13.3), including when many allocations
 * run at once. Both published outputs are built from these rows.
 *
 * The SQL mock forwards to the real database, so the routes read the same
 * rows the module API writes.
 */
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { TxSql } from '../src/db/client.js';
import {
  AcceptanceStatusError,
  acceptanceListIdFromUri,
  allocateAcceptanceEntry,
  loadAcceptanceSnapshot,
  noteRegistryCascade,
  resetAcceptanceStatusCache,
  setAcceptance,
  signBitstringStatusListCredential,
  signTokenStatusList,
} from '../src/lib/registry/acceptance-status.js';
import {
  ACCEPTANCE_LIST_CAPACITY,
  decodeBitstringStatusList,
  decodeTokenStatusList,
} from '../src/lib/registry/status-list-codec.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres acceptance list tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

let sql: Sql;
let app: FastifyInstance;

async function resetStore(): Promise<void> {
  await sql`DELETE FROM registry_acceptance_entries`;
  await sql`DELETE FROM registry_acceptance_lists`;
  resetAcceptanceStatusCache();
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('acceptance-lists');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
  sql = postgres(databaseUrl, { max: 16, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(async () => {
  if (!adminDatabaseUrl) return;
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
  await resetStore();
});

describePostgres('migration 123: the registry acceptance lists', () => {
  it('is recorded in the ledger and keeps lists the registry\'s own, not per tenant', async () => {
    const ledger = await sql`SELECT filename FROM schema_migrations WHERE filename = '123_registry_acceptance_lists.sql'`;
    expect(ledger).toHaveLength(1);
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('registry_acceptance_lists', 'registry_acceptance_entries')`;
    const names = columns.map((c) => c.column_name);
    expect(names).toEqual(expect.arrayContaining(['capacity', 'version', 'updated_at', 'cascade_at', 'idx', 'status']));
    expect(names).not.toContain('developer_id');
    expect(names).not.toContain('tenant_id');
  });

  it('refuses a list smaller than 131,072 entries, an index outside it, and an unknown status', async () => {
    await expect(sql`INSERT INTO registry_acceptance_lists (id, capacity) VALUES ('racl_small', 131064)`)
      .rejects.toThrow(/check/i);
    await sql`INSERT INTO registry_acceptance_lists (id, capacity) VALUES ('racl_ok', ${ACCEPTANCE_LIST_CAPACITY})`;
    await expect(sql`INSERT INTO registry_acceptance_entries (list_id, idx) VALUES ('racl_ok', ${ACCEPTANCE_LIST_CAPACITY})`)
      .rejects.toThrow(/check|capacity/i);
    await expect(sql`INSERT INTO registry_acceptance_entries (list_id, idx, status) VALUES ('racl_ok', 1, 3)`)
      .rejects.toThrow(/check/i);
    await sql`INSERT INTO registry_acceptance_entries (list_id, idx) VALUES ('racl_ok', 1)`;
    await expect(sql`INSERT INTO registry_acceptance_entries (list_id, idx) VALUES ('racl_ok', 1)`)
      .rejects.toThrow(/duplicate|unique/i);
  });
});

describePostgres('allocateAcceptanceEntry', () => {
  it('returns a status list URI and an index inside a list of full capacity', async () => {
    const { uri, idx } = await allocateAcceptanceEntry();
    expect(uri).toMatch(/^https:\/\/grantex\.dev\/status\/attestations\/racl_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number.isInteger(idx)).toBe(true);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(ACCEPTANCE_LIST_CAPACITY);
    const [row] = await sql`SELECT capacity, allocated, version FROM registry_acceptance_lists WHERE id = ${acceptanceListIdFromUri(uri)}`;
    expect(row!['capacity']).toBe(ACCEPTANCE_LIST_CAPACITY);
    expect(row!['allocated']).toBe(1);
    const [entry] = await sql`SELECT status FROM registry_acceptance_entries WHERE idx = ${idx}`;
    // draft-ietf-oauth-status-list-21 §13.3: new entries default to VALID.
    expect(entry!['status']).toBe(0);
  });

  it('never hands out the same index twice, however many allocations run at once', async () => {
    const results = await Promise.all(Array.from({ length: 400 }, () => allocateAcceptanceEntry()));
    const keys = new Set(results.map((r) => `${r.uri}#${r.idx}`));
    expect(keys.size).toBe(400);
    // One list: concurrent first allocations create exactly one.
    expect(new Set(results.map((r) => r.uri)).size).toBe(1);
    const [counts] = await sql`
      SELECT (SELECT COUNT(*)::int FROM registry_acceptance_entries) AS entries,
             (SELECT allocated FROM registry_acceptance_lists) AS allocated`;
    expect(counts!['entries']).toBe(400);
    expect(counts!['allocated']).toBe(400);
    // Random, not sequential: 400 draws from 131,072 are spread across the list.
    const indices = results.map((r) => r.idx).sort((a, b) => a - b);
    expect(indices[indices.length - 1]!).toBeGreaterThan(65_536);
    expect(indices.filter((idx) => idx < 400).length).toBeLessThan(20);
  }, 120_000);

  it('rolls onto one new list when the current one reaches its allocation ceiling, even under concurrency', async () => {
    const first = await allocateAcceptanceEntry();
    const firstId = acceptanceListIdFromUri(first.uri)!;
    // Three quarters full is the ceiling; random draws past it get slow.
    await sql`UPDATE registry_acceptance_lists SET allocated = (capacity / 4) * 3 WHERE id = ${firstId}`;
    const next = await Promise.all(Array.from({ length: 50 }, () => allocateAcceptanceEntry()));
    const lists = new Set(next.map((r) => r.uri));
    expect(lists.size).toBe(1);
    expect(lists.has(first.uri)).toBe(false);
    const [count] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM registry_acceptance_lists`;
    expect(count!.n).toBe(2);
  }, 60_000);

  it('commits or rolls back with the caller\'s transaction', async () => {
    let allocated: { uri: string; idx: number } | undefined;
    await expect(sql.begin(async (tx) => {
      allocated = await allocateAcceptanceEntry(tx as unknown as TxSql);
      throw new Error('caller aborts');
    })).rejects.toThrow('caller aborts');
    expect(allocated).toBeDefined();
    const rows = await sql`SELECT 1 FROM registry_acceptance_entries WHERE idx = ${allocated!.idx}`;
    expect(rows).toHaveLength(0);
  });
});

describePostgres('setAcceptance', () => {
  it('records suspension, reinstatement and withdrawal, bumping the version and the cascade window', async () => {
    const { uri, idx } = await allocateAcceptanceEntry();
    const listId = acceptanceListIdFromUri(uri)!;
    const before = (await sql`SELECT version, cascade_at FROM registry_acceptance_lists WHERE id = ${listId}`)[0]!;
    expect(before['cascade_at']).toBeNull();

    const suspended = await setAcceptance(uri, idx, 'suspended');
    expect(suspended.version).toBe(Number(before['version']) + 1);
    const reinstated = await setAcceptance(uri, idx, 'valid');
    expect(reinstated.version).toBe(suspended.version + 1);
    // Setting the status it already has changes nothing.
    const same = await setAcceptance(uri, idx, 'valid');
    expect(same.version).toBe(reinstated.version);
    const withdrawn = await setAcceptance(uri, idx, 'invalid');
    expect(withdrawn.version).toBe(reinstated.version + 1);

    const [row] = await sql`SELECT version, cascade_at, updated_at FROM registry_acceptance_lists WHERE id = ${listId}`;
    expect(Number(row!['version'])).toBe(withdrawn.version);
    expect(row!['cascade_at']).not.toBeNull();
    const [entry] = await sql`SELECT status FROM registry_acceptance_entries WHERE list_id = ${listId} AND idx = ${idx}`;
    expect(entry!['status']).toBe(1);
  });

  it('never reinstates a withdrawn acceptance (revocation is final)', async () => {
    const { uri, idx } = await allocateAcceptanceEntry();
    await setAcceptance(uri, idx, 'invalid');
    for (const status of ['valid', 'suspended'] as const) {
      const err = await setAcceptance(uri, idx, status).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AcceptanceStatusError);
      expect((err as AcceptanceStatusError).code).toBe('attestation_not_accepted');
    }
  });

  it('refuses an entry that was never allocated, a URI that is not one of the registry\'s lists, and a bad status', async () => {
    const { uri, idx } = await allocateAcceptanceEntry();
    const unallocated = (idx + 1) % ACCEPTANCE_LIST_CAPACITY;
    const missing = await setAcceptance(uri, unallocated, 'invalid').catch((e: unknown) => e);
    expect((missing as AcceptanceStatusError).code).toBe('attestation_not_registered');

    for (const foreign of [
      'https://issuer.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3',
      `${uri}/bitstring`,
      `${uri}?x=1`,
    ]) {
      const err = await setAcceptance(foreign, idx, 'invalid').catch((e: unknown) => e);
      expect((err as AcceptanceStatusError).code).toBe('attestation_not_registered');
    }
    await expect(setAcceptance(uri, idx, 'revoked' as never)).rejects.toBeInstanceOf(AcceptanceStatusError);
    await expect(setAcceptance(uri, -1, 'invalid')).rejects.toBeInstanceOf(AcceptanceStatusError);
    // Nothing above changed the list.
    const [row] = await sql`SELECT version, cascade_at FROM registry_acceptance_lists WHERE id = ${acceptanceListIdFromUri(uri)}`;
    expect(row!['cascade_at']).toBeNull();
  });
});

describePostgres('outputs built from the store', () => {
  it('publishes each entry\'s status in both formats, with the cascade ttl after a change', async () => {
    const a = await allocateAcceptanceEntry();
    const b = await allocateAcceptanceEntry();
    const c = await allocateAcceptanceEntry();
    await setAcceptance(a.uri, a.idx, 'invalid');
    await setAcceptance(b.uri, b.idx, 'suspended');
    const listId = acceptanceListIdFromUri(a.uri)!;

    const snapshot = (await loadAcceptanceSnapshot(listId))!;
    const tsl = await signTokenStatusList(snapshot);
    expect(tsl.ttlSeconds).toBe(60);
    const lst = decodeTokenStatusList(tsl.claims['status_list'] as { bits: 2; lst: string });
    expect(lst.statusAt(a.idx)).toBe(1);
    expect(lst.statusAt(b.idx)).toBe(2);
    expect(lst.statusAt(c.idx)).toBe(0);

    const revocation = await signBitstringStatusListCredential(snapshot, 'revocation');
    const suspension = await signBitstringStatusListCredential(snapshot, 'suspension');
    const revoked = decodeBitstringStatusList((revocation.claims['credentialSubject'] as { encodedList: string }).encodedList);
    const suspended = decodeBitstringStatusList((suspension.claims['credentialSubject'] as { encodedList: string }).encodedList);
    expect([revoked.isSet(a.idx), revoked.isSet(b.idx), revoked.isSet(c.idx)]).toEqual([true, false, false]);
    expect([suspended.isSet(a.idx), suspended.isSet(b.idx), suspended.isSet(c.idx)]).toEqual([false, true, false]);
    expect((revocation.claims['credentialSubject'] as { ttl: number }).ttl).toBe(60_000);

    // An hour after the last change the window closes.
    await sql`UPDATE registry_acceptance_lists SET cascade_at = NOW() - INTERVAL '61 minutes'`;
    const later = (await loadAcceptanceSnapshot(listId))!;
    expect((await signTokenStatusList(later)).ttlSeconds).toBe(600);
  });

  it('opens the cascade window on every list when the registry notes a cascade (for example an issuer suspension)', async () => {
    const { uri } = await allocateAcceptanceEntry();
    const listId = acceptanceListIdFromUri(uri)!;
    expect((await signTokenStatusList((await loadAcceptanceSnapshot(listId))!)).ttlSeconds).toBe(600);
    await noteRegistryCascade();
    expect((await signTokenStatusList((await loadAcceptanceSnapshot(listId))!)).ttlSeconds).toBe(60);
  });

  it('serves the stored statuses over HTTP, verifiable with the published JWK Set, with a working ETag', async () => {
    const { uri, idx } = await allocateAcceptanceEntry();
    const path = new URL(uri).pathname;
    const keys = createLocalJWKSet((await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json());

    const first = await app.inject({ method: 'GET', url: path, remoteAddress: '192.0.2.10' });
    expect(first.statusCode).toBe(200);
    const { payload } = await jwtVerify(first.body, keys, { typ: 'statuslist+jwt' });
    expect(payload.sub).toBe(uri);
    expect(decodeTokenStatusList(payload['status_list'] as { bits: 2; lst: string }).statusAt(idx)).toBe(0);

    const etag = first.headers['etag'] as string;
    const unchanged = await app.inject({
      method: 'GET', url: path, remoteAddress: '192.0.2.10', headers: { 'if-none-match': etag },
    });
    expect(unchanged.statusCode).toBe(304);

    await setAcceptance(uri, idx, 'suspended');
    const changed = await app.inject({
      method: 'GET', url: path, remoteAddress: '192.0.2.10', headers: { 'if-none-match': etag },
    });
    expect(changed.statusCode).toBe(200);
    const after = await jwtVerify(changed.body, keys, { typ: 'statuslist+jwt' });
    expect(decodeTokenStatusList(after.payload['status_list'] as { bits: 2; lst: string }).statusAt(idx)).toBe(2);
    expect(after.payload['ttl']).toBe(60);

    const bsl = await app.inject({ method: 'GET', url: `${path}/bitstring/suspension`, remoteAddress: '192.0.2.10' });
    expect(bsl.statusCode).toBe(200);
    const credential = await jwtVerify(bsl.body, keys, { typ: 'vc+jwt' });
    const subject = credential.payload['credentialSubject'] as { encodedList: string };
    expect(decodeBitstringStatusList(subject.encodedList).isSet(idx)).toBe(true);
  });
});
