// SPDX-License-Identifier: Apache-2.0
/**
 * Accredited issuers against real Postgres, through the routes and the
 * lookups later registry work builds on.
 *
 * The SQL mock forwards to a database of this file's own, so the table's
 * constraints, the per-kid revocation record and the audit chain are the
 * production ones. Covered: operator keys, the trust mark taxonomy, https-only
 * entity identifiers, suspension with an effective time in the future and in
 * the past, revoking one kid, the public minimised read and its ETag, and an
 * audit entry for every write. The request bodies in
 * docs/issuers/becoming-an-accredited-issuer.md are replayed here as written.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { matchStoredAuditHash } from '../src/lib/hash.js';
import {
  REGISTRY_AUDIT_CHAIN,
  getAccreditedIssuer,
  isAccreditedFor,
  issuerVerificationKey,
} from '../src/lib/registry/issuers.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres accredited issuer tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const MIGRATION = '121_registry_accredited_issuers.sql';
const DOC = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/issuers/becoming-an-accredited-issuer.md');

type Sql = ReturnType<typeof postgres>;
type Jwk = Record<string, unknown>;

let sql: Sql;
let app: FastifyInstance;
const operatorKey = randomBytes(32).toString('hex');
const secondOperatorKey = randomBytes(32).toString('hex');
let issuerCounter = 0;
let addressCounter = 0;

function ecKey(kid: string): Jwk {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
}

function edKey(kid: string): Jwk {
  const { publicKey } = generateKeyPairSync('ed25519');
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' };
}

/** A documentation-range address per call, so route limits never collide between tests. */
function nextAddress(): string {
  addressCounter += 1;
  return `198.51.100.${addressCounter % 250 + 1}`;
}

function newRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  issuerCounter += 1;
  const host = `issuer-${issuerCounter}-${randomBytes(3).toString('hex')}.example`;
  return {
    entity_id: `https://${host}`,
    did: `did:web:${host}`,
    jwks: { keys: [ecKey('k1'), edKey('k2')] },
    trust_marks: ['urn:grantex:tm:provider.entity', 'urn:grantex:tm:agent.identity'],
    status_list_base: `https://${host}/status/`,
    events_endpoint: `https://${host}/events`,
    data_residency: 'EU',
    accreditation_evidence_ref: `accreditation-case-${issuerCounter}`,
    ...overrides,
  };
}

async function accredit(body: Record<string, unknown>, key = operatorKey) {
  return app.inject({
    method: 'POST', url: '/v1/registry/issuers', headers: { authorization: `Bearer ${key}` },
    payload: body, remoteAddress: nextAddress(),
  });
}

async function patch(id: string, body: Record<string, unknown>, key = operatorKey) {
  return app.inject({
    method: 'PATCH', url: `/v1/registry/issuers/${id}`, headers: { authorization: `Bearer ${key}` },
    payload: body, remoteAddress: nextAddress(),
  });
}

async function publicList(address = nextAddress(), headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/registry/issuers', headers, remoteAddress: address });
}

async function registryEntries(): Promise<Array<Record<string, unknown>>> {
  return sql<Array<Record<string, unknown>>>`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries WHERE developer_id = ${REGISTRY_AUDIT_CHAIN} ORDER BY timestamp, id`;
}

/** Every entry on the registry chain links to the one before it and hashes to what is stored. */
async function verifyChain(): Promise<Array<Record<string, unknown>>> {
  const rows = await registryEntries();
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

/** The JSON blocks of the documentation page, by the file name on each fence (```json accredit.json). */
function documentedExamples(): Map<string, Record<string, unknown>> {
  const text = readFileSync(DOC, 'utf8');
  const examples = new Map<string, Record<string, unknown>>();
  for (const match of text.matchAll(/```json ([a-z-]+)\.json\r?\n([\s\S]*?)```/g)) {
    examples.set(match[1]!, JSON.parse(match[2]!) as Record<string, unknown>);
  }
  return examples;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('registry-issuers');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 }).catch(() => undefined);
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', `${operatorKey},${secondOperatorKey}`);
  if (!adminDatabaseUrl) return;
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('accredited issuers against real Postgres', () => {
  it('records migration 121 and enforces the taxonomy and status in the table itself', async () => {
    const ledger = await sql`SELECT filename FROM schema_migrations WHERE filename = ${MIGRATION}`;
    expect(ledger).toHaveLength(1);

    const base = {
      id: 'aiss_direct', entity_id: 'https://direct.example', jwks: sql.json({ keys: [] }),
      status_list_base: 'https://direct.example/status/', accreditation_evidence_ref: 'ref-direct',
    };
    await expect(sql`
      INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
      VALUES (${base.id}, ${base.entity_id}, ${base.jwks}, ${['urn:grantex:tm:provider.wealth']}, 'active',
              ${base.status_list_base}, ${base.accreditation_evidence_ref})`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
      VALUES (${base.id}, ${base.entity_id}, ${base.jwks}, ${[]}, 'paused',
              ${base.status_list_base}, ${base.accreditation_evidence_ref})`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
      VALUES (${base.id}, 'http://direct.example', ${base.jwks}, ${[]}, 'active',
              ${base.status_list_base}, ${base.accreditation_evidence_ref})`).rejects.toMatchObject({ code: '23514' });
    // One stored spelling per bare origin: the trailing-slash form of
    // https://direct.example is refused, so UNIQUE(entity_id) covers both.
    await expect(sql`
      INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
      VALUES (${base.id}, 'https://direct.example/', ${base.jwks}, ${[]}, 'active',
              ${base.status_list_base}, ${base.accreditation_evidence_ref})`).rejects.toMatchObject({ code: '23514' });
    // A suspension always says when it takes effect.
    await expect(sql`
      INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
      VALUES (${base.id}, ${base.entity_id}, ${base.jwks}, ${[]}, 'suspended',
              ${base.status_list_base}, ${base.accreditation_evidence_ref})`).rejects.toMatchObject({ code: '23514' });
  });

  it('needs an operator key: 503 when none is configured, 401 for a wrong one, any configured one works', async () => {
    vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', '');
    expect((await accredit(newRecord())).statusCode).toBe(503);
    vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', `${operatorKey},${secondOperatorKey}`);
    expect((await accredit(newRecord(), randomBytes(32).toString('hex'))).statusCode).toBe(401);
    expect((await accredit(newRecord(), process.env['ADMIN_API_KEY'] ?? '')).statusCode).toBe(401);
    const before = (await sql`SELECT COUNT(*)::int AS count FROM accredited_issuers`)[0]!['count'];
    const created = await accredit(newRecord(), secondOperatorKey);
    expect(created.statusCode).toBe(201);
    const after = (await sql`SELECT COUNT(*)::int AS count FROM accredited_issuers`)[0]!['count'];
    expect(after).toBe(before + 1);
  });

  it('refuses an unknown trust mark and a non-https entity_id, writing nothing and auditing nothing', async () => {
    const entriesBefore = (await registryEntries()).length;
    const rowsBefore = (await sql`SELECT COUNT(*)::int AS count FROM accredited_issuers`)[0]!['count'];

    const unknownMark = await accredit(newRecord({ trust_marks: ['urn:grantex:tm:agent.identity', 'urn:grantex:tm:agent.wealth'] }));
    expect(unknownMark.statusCode).toBe(400);
    expect(unknownMark.json().field).toBe('trust_marks');
    for (const entityId of ['http://issuer.example', 'https://op@issuer.example', 'https://issuer.example/?a=1', 'https://issuer.example/#x']) {
      const res = await accredit(newRecord({ entity_id: entityId }));
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('entity_id');
    }

    expect((await sql`SELECT COUNT(*)::int AS count FROM accredited_issuers`)[0]!['count']).toBe(rowsBefore);
    expect((await registryEntries()).length).toBe(entriesBefore);
  });

  it('accredits an issuer once, audits it, and refuses the same entity_id again', async () => {
    const record = newRecord();
    const res = await accredit(record);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      entity_id: record['entity_id'],
      did: record['did'],
      status: 'active',
      suspended_effective_from: null,
      trust_marks: record['trust_marks'],
      status_list_base: record['status_list_base'],
      events_endpoint: record['events_endpoint'],
      data_residency: 'EU',
      accreditation_evidence_ref: record['accreditation_evidence_ref'],
      revoked_keys: [],
    });
    expect(body.id).toMatch(/^aiss_/);
    expect(typeof body.accredited_at).toBe('string');

    const again = await accredit({ ...newRecord(), entity_id: record['entity_id'] });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ISSUER_EXISTS');
    // The trailing-slash spelling of the same origin is not a second record.
    const slashed = await accredit({ ...newRecord(), entity_id: `${record['entity_id']}/` });
    expect(slashed.statusCode).toBe(400);
    expect(slashed.json().field).toBe('entity_id');

    const entries = await verifyChain();
    const mine = entries.filter((entry) => (entry['metadata'] as Record<string, unknown>)['issuerId'] === body.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!['action']).toBe('grantex.registry.issuer_accredited');
    expect(mine[0]!['metadata']).toMatchObject({
      issuerId: body.id,
      entityId: record['entity_id'],
      trustMarks: record['trust_marks'],
      kids: ['k1', 'k2'],
      'grantex:platform': true,
    });
    // The operator's key is never recorded, and neither is the evidence itself.
    expect(JSON.stringify(mine[0])).not.toContain(operatorKey);

    const found = await getAccreditedIssuer(sql, record['entity_id'] as string);
    expect(found?.id).toBe(body.id);
    expect(await getAccreditedIssuer(sql, 'https://unknown-issuer.example')).toBeNull();
  });

  it('honours a suspension that takes effect in the future only from then on', async () => {
    const record = newRecord();
    const { id } = (await accredit(record)).json();
    const entityId = record['entity_id'] as string;
    const effective = new Date(Date.now() + 3_600_000);

    const res = await patch(id, { status: 'suspended', effective_from: effective.toISOString(), reason: 'scheduled review' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'suspended', suspended_effective_from: effective.toISOString() });

    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity')).toEqual({ accredited: true });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity', new Date(effective.getTime() - 1)))
      .toEqual({ accredited: true });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity', effective))
      .toEqual({ accredited: false, code: 'issuer_suspended' });

    const shown = (await publicList()).json().issuers.find((issuer: { entity_id: string }) => issuer.entity_id === entityId);
    expect(shown.status).toBe('active');
  });

  it('honours a suspension whose effective time is already past straight away, and lifts it on reactivation', async () => {
    const record = newRecord();
    const { id } = (await accredit(record)).json();
    const entityId = record['entity_id'] as string;

    const past = new Date(Date.now() - 60_000);
    expect((await patch(id, { status: 'suspended', effective_from: past.toISOString(), reason: 'incident' })).statusCode).toBe(200);
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity'))
      .toEqual({ accredited: false, code: 'issuer_suspended' });
    // Before the suspension took effect the issuer was accredited.
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity', new Date(past.getTime() - 1)))
      .toEqual({ accredited: true });
    const shown = (await publicList()).json().issuers.find((issuer: { entity_id: string }) => issuer.entity_id === entityId);
    expect(shown.status).toBe('suspended');

    const reactivated = await patch(id, { status: 'active', reason: 'incident closed' });
    expect(reactivated.json()).toMatchObject({ status: 'active', suspended_effective_from: null });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.identity')).toEqual({ accredited: true });
  });

  it('refuses a withdrawn, an unknown or an unmarked issuer with the matching code', async () => {
    const record = newRecord({ trust_marks: ['urn:grantex:tm:provider.entity'] });
    const { id } = (await accredit(record)).json();
    const entityId = record['entity_id'] as string;

    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:provider.entity')).toEqual({ accredited: true });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.security'))
      .toEqual({ accredited: false, code: 'trust_mark_missing' });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:not-a-mark'))
      .toEqual({ accredited: false, code: 'trust_mark_missing' });
    expect(await isAccreditedFor(sql, 'https://unknown-issuer.example', 'urn:grantex:tm:provider.entity'))
      .toEqual({ accredited: false, code: 'issuer_not_accredited' });

    expect((await patch(id, { trust_marks: ['urn:grantex:tm:agent.security'], reason: 'scope change' })).statusCode).toBe(200);
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:provider.entity'))
      .toEqual({ accredited: false, code: 'trust_mark_missing' });
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.security')).toEqual({ accredited: true });

    expect((await patch(id, { status: 'withdrawn', reason: 'accreditation ended' })).statusCode).toBe(200);
    expect(await isAccreditedFor(sql, entityId, 'urn:grantex:tm:agent.security'))
      .toEqual({ accredited: false, code: 'issuer_not_accredited' });
    expect(await issuerVerificationKey(sql, entityId, 'k1')).toBeNull();
    const shown = (await publicList()).json().issuers.find((issuer: { entity_id: string }) => issuer.entity_id === entityId);
    expect(shown).toMatchObject({ status: 'withdrawn', jwks: { keys: [] } });
  });

  it('revoking one kid hides that key everywhere and it cannot come back', async () => {
    const record = newRecord();
    const { id } = (await accredit(record)).json();
    const entityId = record['entity_id'] as string;
    expect(await issuerVerificationKey(sql, entityId, 'k1')).toMatchObject({ kid: 'k1', kty: 'EC', crv: 'P-256' });

    const res = await patch(id, { revoke_kids: ['k1'], reason: 'key exposed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked_keys).toEqual([{ kid: 'k1', revoked_at: expect.any(String) }]);

    expect(await issuerVerificationKey(sql, entityId, 'k1')).toBeNull();
    expect(await issuerVerificationKey(sql, entityId, 'k2')).toMatchObject({ kid: 'k2', kty: 'OKP', crv: 'Ed25519' });
    expect(await issuerVerificationKey(sql, entityId, 'k3')).toBeNull();
    const shown = (await publicList()).json().issuers.find((issuer: { entity_id: string }) => issuer.entity_id === entityId);
    expect(shown.jwks.keys.map((key: Jwk) => key['kid'])).toEqual(['k2']);

    // Revoking again keeps the first time.
    const firstAt = res.json().revoked_keys[0].revoked_at;
    const repeat = await patch(id, { revoke_kids: ['k1'], reason: 'again' });
    expect(repeat.json().revoked_keys).toEqual([{ kid: 'k1', revoked_at: firstAt }]);

    // A replacement set may not bring a revoked kid back under the same name.
    const reuse = await patch(id, { jwks: { keys: [ecKey('k1')] }, reason: 'rotation' });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().code).toBe('KID_REVOKED');

    const rotated = await patch(id, { jwks: { keys: [ecKey('k3')] }, reason: 'rotation' });
    expect(rotated.statusCode).toBe(200);
    expect(await issuerVerificationKey(sql, entityId, 'k2')).toBeNull();
    expect(await issuerVerificationKey(sql, entityId, 'k3')).toMatchObject({ kid: 'k3' });
  });

  it('answers 404 for an issuer that does not exist and audits nothing', async () => {
    const before = (await registryEntries()).length;
    const res = await patch('aiss_01JUNKNOWN', { status: 'withdrawn', reason: 'x' });
    expect(res.statusCode).toBe(404);
    expect((await registryEntries()).length).toBe(before);
  });

  it('audits every write on the registry chain, in order, with the change it made', async () => {
    const record = newRecord();
    const { id } = (await accredit(record)).json();
    await patch(id, { status: 'suspended', effective_from: new Date(Date.now() + 60_000).toISOString(), reason: 'r1' });
    await patch(id, { trust_marks: ['urn:grantex:tm:agent.identity'], reason: 'r2' });
    await patch(id, { revoke_kids: ['k2'], reason: 'r3' });
    await patch(id, { jwks: { keys: [ecKey('k4')] }, reason: 'r4' });

    const entries = (await verifyChain())
      .filter((entry) => (entry['metadata'] as Record<string, unknown>)['issuerId'] === id);
    expect(entries.map((entry) => entry['action'])).toEqual([
      'grantex.registry.issuer_accredited',
      'grantex.registry.issuer_updated',
      'grantex.registry.issuer_updated',
      'grantex.registry.issuer_updated',
      'grantex.registry.issuer_updated',
    ]);
    expect(entries.map((entry) => (entry['metadata'] as Record<string, unknown>)['reason'])).toEqual([
      undefined, 'r1', 'r2', 'r3', 'r4',
    ]);
    expect((entries[1]!['metadata'] as Record<string, unknown>)['changes']).toMatchObject({ status: 'suspended' });
    expect((entries[3]!['metadata'] as Record<string, unknown>)['changes']).toMatchObject({ revokedKids: ['k2'] });
    expect((entries[4]!['metadata'] as Record<string, unknown>)['changes']).toMatchObject({ kids: ['k4'] });
    for (const entry of entries) expect(entry['principal_id']).toBe('platform');
  });

  it('serves the public list minimised, with an ETag, and rate-limited per client', async () => {
    const record = newRecord();
    await accredit(record);
    const address = '203.0.113.40';
    const first = await publicList(address);
    expect(first.statusCode).toBe(200);
    const mine = first.json().issuers.find((issuer: { entity_id: string }) => issuer.entity_id === record['entity_id']);
    expect(Object.keys(mine).sort()).toEqual(['entity_id', 'jwks', 'status', 'status_list_base', 'trust_marks']);
    expect(first.body).not.toContain('accreditation-case-');
    expect(first.body).not.toContain('aiss_');

    expect(first.headers['cache-control']).toBe('no-cache');
    const etag = first.headers['etag'] as string;
    const unchanged = await publicList(address, { 'if-none-match': etag });
    expect(unchanged.statusCode).toBe(304);

    await accredit(newRecord());
    const changed = await publicList(address, { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers['etag']).not.toBe(etag);

    let last = changed;
    for (let i = 0; i < 60 && last.statusCode !== 429; i += 1) last = await publicList(address);
    expect(last.statusCode).toBe(429);
    expect((await publicList('203.0.113.41')).statusCode).toBe(200);
  });

  it('accepts the requests the issuer documentation shows, as written', async () => {
    const examples = documentedExamples();
    expect([...examples.keys()].sort()).toEqual(['accredit', 'revoke-kid', 'suspend']);

    const created = await accredit(examples.get('accredit')!);
    expect(created.statusCode).toBe(201);
    const { id, entity_id: entityId } = created.json();
    expect(entityId).toBe('https://issuer.example');

    const suspended = await patch(id, examples.get('suspend')!);
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe('suspended');

    const revoked = await patch(id, examples.get('revoke-kid')!);
    expect(revoked.statusCode).toBe(200);
    expect(await issuerVerificationKey(sql, entityId, 'issuer-2026-01')).toBeNull();
  });
});
