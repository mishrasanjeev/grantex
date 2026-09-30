// SPDX-License-Identifier: Apache-2.0
/**
 * The DPDP routes against real Postgres, through the routes.
 *
 * Covered: migration 127 (erasure requests, the notice version on a record,
 * the grievance response period, the status CHECK constraints); consent
 * withdrawal in one transaction, revoking through the grant cascade, racing a
 * second withdrawal, refusing an erased record, and the
 * DPDP_WITHDRAWAL_REVOKES_GRANT default; deleteProcessedData leaving the
 * audit hash chain intact; erasure (revocation of live grants only, records
 * marked erased and retained, grievance redaction, stored exports deleted,
 * the persisted and idempotent request, GET /v1/dpdp/erasure-requests/:id);
 * record creation refusing inactive and expired grants, the principal check
 * behind DPDP_ENFORCE_GRANT_PRINCIPAL, notice version pinning and a consent
 * proof without an expiry; reads without side effects; notice and grievance
 * lists; grievance transitions; export validation, truncation, expiry and
 * the principal filter; pagination; the platform audit entries; and the
 * consent expiry worker. The SQL mock forwards to a database of this file's
 * own, so constraints, locks and the audit chain are the production ones.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { buildJwks, initEdKey } from '../src/lib/crypto.js';
import { emitEvent } from '../src/lib/events.js';
import { expireConsentRecordsOnce } from '../src/workers/dpdpConsentExpiry.js';
import { buildTestApp, mockRedis, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres DPDP tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
interface Tenant { id: string; apiKey: string; agentId: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let addressCounter = 0;

const quiet = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => quiet,
} as never;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function nextAddress(): string {
  addressCounter += 1;
  return `198.51.100.${(addressCounter % 250) + 1}`;
}

async function newTenant(): Promise<Tenant> {
  const s = suffix();
  const tenant = { id: `dev_dpdp_${s}`, apiKey: `gx_test_dpdp_${s}_key`, agentId: `ag_dpdp_${s}` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'DPDP Test Fiduciary', 'sandbox')`;
  await sql`INSERT INTO agents (id, did, developer_id, name)
            VALUES (${tenant.agentId}, ${'did:grantex:' + tenant.agentId}, ${tenant.id}, 'shopper-01')`;
  return tenant;
}

async function newGrant(
  tenant: Tenant,
  options: { principal?: string; status?: string; expired?: boolean; parent?: string } = {},
): Promise<string> {
  const id = `grnt_dpdp_${suffix()}`;
  await sql`
    INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, status, expires_at, parent_grant_id)
    VALUES (${id}, ${tenant.agentId}, ${options.principal ?? 'user_dpdp_1'}, ${tenant.id}, ${['read']},
            ${options.status ?? 'active'},
            ${options.expired ? sql`NOW() - INTERVAL '1 hour'` : sql`NOW() + INTERVAL '2 hours'`},
            ${options.parent ?? null})`;
  return id;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({
    method, url, remoteAddress: nextAddress(), headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function newNotice(tenant: Tenant, noticeId = `notice-${suffix()}`, version = '1.0', content = 'Notice text v1'): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/dpdp/consent-notices', {
    noticeId, version, title: 'Data Processing Notice', content,
    purposes: [{ code: 'service', description: 'Service delivery' }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return noticeId;
}

async function newRecord(
  tenant: Tenant,
  options: { grantId?: string; principal?: string; noticeId?: string; version?: string } = {},
): Promise<{ recordId: string; grantId: string; body: Record<string, unknown> }> {
  const principal = options.principal ?? 'user_dpdp_1';
  const grantId = options.grantId ?? await newGrant(tenant, { principal });
  const noticeId = options.noticeId ?? await newNotice(tenant);
  const res = await call(tenant, 'POST', '/v1/dpdp/consent-records', {
    grantId,
    dataPrincipalId: principal,
    purposes: [{ code: 'service', description: 'Service delivery' }],
    consentNoticeId: noticeId,
    ...(options.version ? { consentNoticeVersion: options.version } : {}),
    processingExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json<Record<string, unknown>>();
  return { recordId: body['recordId'] as string, grantId, body };
}

async function grantStatus(id: string): Promise<string | undefined> {
  return (await sql`SELECT status FROM grants WHERE id = ${id}`)[0]?.['status'] as string | undefined;
}

/** The events emitted for a tenant (the event bus is mocked in tests/setup.ts). */
async function deliveries(tenant: Tenant, type: string): Promise<Array<Record<string, unknown>>> {
  return vi.mocked(emitEvent).mock.calls
    .filter((args) => args[0] === tenant.id && args[1] === type)
    .map((args) => ({ data: args[2] }));
}

async function auditActions(tenant: Tenant): Promise<string[]> {
  const rows = await sql`SELECT action FROM audit_entries WHERE developer_id = ${tenant.id} ORDER BY timestamp, id`;
  return rows.map((row) => row['action'] as string);
}

async function chainIntegrity(tenant: Tenant): Promise<Record<string, unknown>> {
  const res = await call(tenant, 'GET', '/v1/compliance/evidence-pack');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ chainIntegrity: Record<string, unknown> }>().chainIntegrity;
}

async function tenantAuditEntry(tenant: Tenant, grantId: string, principalId: string): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/audit/log', {
    agentId: tenant.agentId, agentDid: `did:grantex:${tenant.agentId}`, grantId, principalId,
    action: 'files.read', metadata: { file: 'report.pdf' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ entryId: string }>().entryId;
}

async function waitFor<T>(fn: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  // Events are emitted after the response; give the fire-and-forget promise a moment.
  let value = await fn();
  for (let i = 0; i < 50 && !done(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await fn();
  }
  return value;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('dpdp');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
  await initEdKey();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  if (!adminDatabaseUrl) return;
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('migration 127', () => {
  it('is recorded in the ledger and adds the erasure store, the new columns and the constraints', async () => {
    expect(await sql`SELECT filename FROM schema_migrations WHERE filename = '127_dpdp_server_correctness.sql'`)
      .toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('dpdp_erasure_requests', 'dpdp_consent_records', 'dpdp_grievances', 'dpdp_exports')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('dpdp_erasure_requests')).toEqual(expect.arrayContaining([
      'id', 'developer_id', 'data_principal_id', 'status', 'records_erased', 'grants_revoked', 'retained',
      'submitted_at', 'completed_at',
    ]));
    expect(names('dpdp_consent_records')).toEqual(expect.arrayContaining(['consent_notice_version', 'erased_at']));
    expect(names('dpdp_grievances')).toEqual(expect.arrayContaining(['response_period_days', 'updated_at']));
    expect(names('dpdp_exports')).toEqual(expect.arrayContaining(['data_principal_id', 'truncated']));
    const indexes = await sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'dpdp_exports'`;
    expect(indexes.some((row) => /\(developer_id\b/.test(row['indexdef'] as string))).toBe(true);

    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant);
    await expect(sql`UPDATE dpdp_consent_records SET status = 'deleted' WHERE id = ${recordId}`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO dpdp_grievances (id, developer_id, data_principal_id, type, description, reference_number, expected_resolution_by, status)
      VALUES (${'grv_' + suffix()}, ${tenant.id}, 'user_dpdp_1', 'other', 'x', ${'GRV-' + suffix()}, NOW(), 'lost')`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO dpdp_grievances (id, developer_id, data_principal_id, type, description, reference_number, expected_resolution_by, response_period_days)
      VALUES (${'grv_' + suffix()}, ${tenant.id}, 'user_dpdp_1', 'other', 'x', ${'GRV-' + suffix()}, NOW(), 91)`)
      .rejects.toMatchObject({ code: '23514' });
  });
});

describePostgres('migration 127 repairs double-encoded JSON', () => {
  it('decodes JSONB values the routes stored as JSON strings', async () => {
    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant);
    await sql`UPDATE dpdp_consent_records
              SET purposes = to_jsonb(purposes::text), consent_proof = to_jsonb(consent_proof::text)
              WHERE id = ${recordId}`;
    expect((await sql`SELECT jsonb_typeof(purposes) AS t FROM dpdp_consent_records WHERE id = ${recordId}`)[0]!['t']).toBe('string');
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations/127_dpdp_server_correctness.sql'), 'utf8');
    const repairs = file.split(/;\s*\r?\n/).map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.startsWith('UPDATE') && statement.includes("#>> '{}'"));
    expect(repairs).toHaveLength(6);
    for (const statement of repairs) await sql.unsafe(statement);
    const [row] = await sql`SELECT jsonb_typeof(purposes) AS p, jsonb_typeof(consent_proof) AS c, purposes FROM dpdp_consent_records WHERE id = ${recordId}`;
    expect(row).toMatchObject({ p: 'array', c: 'object', purposes: [{ code: 'service', description: 'Service delivery' }] });
  });
});

describePostgres('withdrawing consent', () => {
  it('revokes the grant through the cascade: descendants, the revocation cache and the grant.revoked event', async () => {
    const tenant = await newTenant();
    const grantId = await newGrant(tenant);
    const child = await newGrant(tenant, { parent: grantId });
    const { recordId } = await newRecord(tenant, { grantId });
    mockRedis.set.mockClear();

    const res = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, { reason: 'No longer wanted', revokeGrant: true });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ recordId, status: 'withdrawn', grantRevoked: true, dataDeleted: false });
    expect(await grantStatus(grantId)).toBe('revoked');
    expect(await grantStatus(child)).toBe('revoked');
    const cached = mockRedis.set.mock.calls.map((args) => args[0]);
    expect(cached).toEqual(expect.arrayContaining([`revoked:grant:${grantId}`, `revoked:grant:${child}`]));
    const revoked = await waitFor(() => deliveries(tenant, 'grant.revoked'), (rows) => rows.length > 0);
    expect(revoked[0]!['data']).toMatchObject({ grantId, cascade: true });
    expect(await auditActions(tenant)).toContain('grantex.dpdp.consent_withdrawn');
    expect((await chainIntegrity(tenant))['valid']).toBe(true);
  });

  it('leaves the grant alone by default, and revokes it by default under DPDP_WITHDRAWAL_REVOKES_GRANT=true', async () => {
    const tenant = await newTenant();
    const first = await newRecord(tenant);
    const off = await call(tenant, 'POST', `/v1/dpdp/consent-records/${first.recordId}/withdraw`, { reason: 'Changed my mind' });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()['grantRevoked']).toBe(false);
    expect(await grantStatus(first.grantId)).toBe('active');

    vi.stubEnv('DPDP_WITHDRAWAL_REVOKES_GRANT', 'true');
    const second = await newRecord(tenant);
    const on = await call(tenant, 'POST', `/v1/dpdp/consent-records/${second.recordId}/withdraw`, { reason: 'Changed my mind' });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()['grantRevoked']).toBe(true);
    expect(await grantStatus(second.grantId)).toBe('revoked');

    // An explicit false still wins over the flag.
    const third = await newRecord(tenant);
    const explicit = await call(tenant, 'POST', `/v1/dpdp/consent-records/${third.recordId}/withdraw`, { reason: 'x', revokeGrant: false });
    expect(explicit.json()['grantRevoked']).toBe(false);
    expect(await grantStatus(third.grantId)).toBe('active');
  });

  it('reports grantRevoked=false when the grant was no longer active', async () => {
    const tenant = await newTenant();
    const { recordId, grantId } = await newRecord(tenant);
    await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${grantId}`;

    const res = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, { reason: 'x', revokeGrant: true });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()['grantRevoked']).toBe(false);
  });

  it('lets exactly one of two concurrent withdrawals succeed', async () => {
    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant);

    const results = await Promise.all([1, 2, 3].map(() =>
      call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, { reason: 'Race', revokeGrant: true })));

    const codes = results.map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    for (const res of results.filter((r) => r.statusCode === 409)) expect(res.json()['code']).toBe('ALREADY_WITHDRAWN');
    const withdrawn = (await auditActions(tenant)).filter((action) => action === 'grantex.dpdp.consent_withdrawn');
    expect(withdrawn).toHaveLength(1);
  });

  it('refuses an erased record with 409', async () => {
    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant, { principal: 'user_dpdp_erased' });
    const erased = await call(tenant, 'POST', '/v1/dpdp/data-principals/user_dpdp_erased/erasure');
    expect(erased.statusCode, erased.body).toBe(201);

    const res = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, { reason: 'x' });

    expect(res.statusCode).toBe(409);
    expect(res.json()['code']).toBe('CONSENT_ERASED');
  });

  it('answers 400, not 500, for a missing or non-object body', async () => {
    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant);
    const missing = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`);
    expect(missing.statusCode).toBe(400);
    const array = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, ['x']);
    expect(array.statusCode).toBe(400);
    const badFlag = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, { reason: 'x', revokeGrant: 'yes' });
    expect(badFlag.statusCode).toBe(400);
  });

  it('with deleteProcessedData, asks the fiduciary to delete and leaves the audit chain valid', async () => {
    const tenant = await newTenant();
    const { recordId, grantId } = await newRecord(tenant);
    const entryId = await tenantAuditEntry(tenant, grantId, 'user_dpdp_1');
    const [before] = await sql`SELECT metadata, hash FROM audit_entries WHERE id = ${entryId}`;

    const res = await call(tenant, 'POST', `/v1/dpdp/consent-records/${recordId}/withdraw`, {
      reason: 'Delete my data', deleteProcessedData: true,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ dataDeleted: false, dataDeletionRequested: true });
    const [after] = await sql`SELECT metadata, hash FROM audit_entries WHERE id = ${entryId}`;
    expect(after).toEqual(before);
    expect(await chainIntegrity(tenant)).toMatchObject({ valid: true });
    const requested = await waitFor(() => deliveries(tenant, 'dpdp.data_deletion.requested'), (rows) => rows.length > 0);
    expect(requested[0]!['data']).toMatchObject({ recordId, grantId, dataPrincipalId: 'user_dpdp_1' });
  });
});

describePostgres('erasure', () => {
  it('revokes live grants, retains the marked records, redacts grievances, deletes exports and keeps the chain valid', async () => {
    const tenant = await newTenant();
    const principal = `user_dpdp_erase_${suffix()}`;
    const live = await newRecord(tenant, { principal });
    const alreadyRevoked = await newRecord(tenant, { principal });
    await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${alreadyRevoked.grantId}`;
    const other = await newRecord(tenant, { principal: 'user_dpdp_bystander' });
    const entryId = await tenantAuditEntry(tenant, live.grantId, principal);
    const [entryBefore] = await sql`SELECT metadata, hash FROM audit_entries WHERE id = ${entryId}`;

    const grievance = await call(tenant, 'POST', '/v1/dpdp/grievances', {
      dataPrincipalId: principal, recordId: live.recordId, type: 'access-request',
      description: 'Contact me at a private address', evidence: { note: 'personal detail' },
    });
    expect(grievance.statusCode, grievance.body).toBe(202);
    const range = { dateFrom: new Date(Date.now() - 86_400_000).toISOString(), dateTo: new Date(Date.now() + 86_400_000).toISOString() };
    const filtered = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'gdpr-article-15', ...range, dataPrincipalId: principal });
    const unfiltered = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'dpdp-audit', ...range });
    const bystanderOnly = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'gdpr-article-15', ...range, dataPrincipalId: 'user_dpdp_bystander' });
    for (const res of [filtered, unfiltered, bystanderOnly]) expect(res.statusCode, res.body).toBe(201);

    const res = await call(tenant, 'POST', `/v1/dpdp/data-principals/${principal}/erasure`);

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      dataPrincipalId: principal, status: 'completed', recordsErased: 2, grantsRevoked: 1,
    });
    expect(body['expectedCompletionBy']).toBe(body['completedAt']);
    const retained = body['retained'] as Array<Record<string, unknown>>;
    expect(retained.map((item) => item['category'])).toEqual(expect.arrayContaining(['consent_records', 'audit_log']));
    for (const item of retained) expect(typeof item['reason']).toBe('string');

    expect(await grantStatus(live.grantId)).toBe('revoked');
    expect(await grantStatus(other.grantId)).toBe('active');
    const records = await sql`SELECT status, erased_at FROM dpdp_consent_records WHERE data_principal_id = ${principal}`;
    expect(records).toHaveLength(2);
    expect(records.every((row) => row['status'] === 'erased' && row['erased_at'] !== null)).toBe(true);
    const [storedGrievance] = await sql`SELECT description, evidence, reference_number FROM dpdp_grievances WHERE data_principal_id = ${principal}`;
    expect(storedGrievance!['description']).not.toContain('private address');
    expect(JSON.stringify(storedGrievance!['evidence'])).not.toContain('personal detail');
    const exportIds = (await sql`SELECT id FROM dpdp_exports WHERE developer_id = ${tenant.id}`).map((row) => row['id']);
    expect(exportIds).toEqual([bystanderOnly.json()['exportId']]);
    const [stored] = await sql`SELECT * FROM dpdp_erasure_requests WHERE id = ${body['requestId'] as string}`;
    expect(stored).toMatchObject({ developer_id: tenant.id, data_principal_id: principal, status: 'completed', records_erased: 2, grants_revoked: 1 });

    const [entryAfter] = await sql`SELECT metadata, hash FROM audit_entries WHERE id = ${entryId}`;
    expect(entryAfter).toEqual(entryBefore);
    expect(await auditActions(tenant)).toContain('grantex.dpdp.erasure_completed');
    expect(await chainIntegrity(tenant)).toMatchObject({ valid: true });

    const again = await call(tenant, 'POST', `/v1/dpdp/data-principals/${principal}/erasure`);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()['requestId']).toBe(body['requestId']);
    expect(await sql`SELECT id FROM dpdp_erasure_requests WHERE data_principal_id = ${principal}`).toHaveLength(1);

    const fetched = await call(tenant, 'GET', `/v1/dpdp/erasure-requests/${body['requestId'] as string}`);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json()).toMatchObject({ requestId: body['requestId'], recordsErased: 2, grantsRevoked: 1, status: 'completed' });
    const stranger = await newTenant();
    expect((await call(stranger, 'GET', `/v1/dpdp/erasure-requests/${body['requestId'] as string}`)).statusCode).toBe(404);
  });

  it('still answers 404 for a principal with no records', async () => {
    const tenant = await newTenant();
    const res = await call(tenant, 'POST', '/v1/dpdp/data-principals/user_dpdp_nobody/erasure');
    expect(res.statusCode).toBe(404);
  });
});

describePostgres('creating a consent record', () => {
  it('refuses a revoked or expired grant', async () => {
    const tenant = await newTenant();
    const noticeId = await newNotice(tenant);
    for (const grantId of [await newGrant(tenant, { status: 'revoked' }), await newGrant(tenant, { expired: true })]) {
      const res = await call(tenant, 'POST', '/v1/dpdp/consent-records', {
        grantId, dataPrincipalId: 'user_dpdp_1', purposes: [{ code: 'service', description: 'Service' }],
        consentNoticeId: noticeId, processingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()['code']).toBe('INVALID_GRANT');
    }
    expect(await sql`SELECT id FROM dpdp_consent_records WHERE developer_id = ${tenant.id}`).toHaveLength(0);
  });

  it('checks the grant principal only under DPDP_ENFORCE_GRANT_PRINCIPAL=true', async () => {
    const tenant = await newTenant();
    const noticeId = await newNotice(tenant);
    const grantId = await newGrant(tenant, { principal: 'user_dpdp_grant_holder' });
    const payload = {
      grantId, dataPrincipalId: 'user_dpdp_someone_else', purposes: [{ code: 'service', description: 'Service' }],
      consentNoticeId: noticeId, processingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect((await call(tenant, 'POST', '/v1/dpdp/consent-records', payload)).statusCode).toBe(201);

    vi.stubEnv('DPDP_ENFORCE_GRANT_PRINCIPAL', 'true');
    const refused = await call(tenant, 'POST', '/v1/dpdp/consent-records', payload);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()['code']).toBe('PRINCIPAL_MISMATCH');
    const matching = await call(tenant, 'POST', '/v1/dpdp/consent-records', { ...payload, dataPrincipalId: 'user_dpdp_grant_holder' });
    expect(matching.statusCode, matching.body).toBe(201);
  });

  it('pins a notice version, defaults to the latest, and stores the version on the record', async () => {
    const tenant = await newTenant();
    const noticeId = await newNotice(tenant, `notice-${suffix()}`, '1.0', 'First text');
    const second = await call(tenant, 'POST', '/v1/dpdp/consent-notices', {
      noticeId, version: '2.0', title: 'Notice', content: 'Second text',
      purposes: [{ code: 'service', description: 'Service' }],
    });
    expect(second.statusCode).toBe(201);

    const pinned = await newRecord(tenant, { noticeId, version: '1.0' });
    expect(pinned.body['consentNoticeVersion']).toBe('1.0');
    const latest = await newRecord(tenant, { noticeId });
    expect(latest.body['consentNoticeVersion']).toBe('2.0');
    expect(pinned.body['consentNoticeHash']).not.toBe(latest.body['consentNoticeHash']);
    const [row] = await sql`SELECT consent_notice_version FROM dpdp_consent_records WHERE id = ${pinned.recordId}`;
    expect(row!['consent_notice_version']).toBe('1.0');

    const unknown = await call(tenant, 'POST', '/v1/dpdp/consent-records', {
      grantId: await newGrant(tenant), dataPrincipalId: 'user_dpdp_1',
      purposes: [{ code: 'service', description: 'Service' }], consentNoticeId: noticeId, consentNoticeVersion: '9.9',
      processingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()['code']).toBe('INVALID_NOTICE');
  });

  it('signs a proof that does not expire, names its kid and verifies against the published JWKS', async () => {
    const tenant = await newTenant();
    const { body, recordId } = await newRecord(tenant);
    const proof = body['consentProof'] as Record<string, unknown>;
    expect(proof['type']).toBe('JWS-EdDSA');
    const jws = proof['proofJwt'] as string;
    const header = decodeProtectedHeader(jws);
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe(proof['kid']);
    const claims = decodeJwt(jws);
    expect(claims.exp).toBeUndefined();
    expect(claims['recordId']).toBe(recordId);
    const jwk = (await buildJwks()).keys.find((key) => key['kid'] === header.kid);
    expect(jwk).toBeDefined();
    await expect(jwtVerify(jws, await importJWK(jwk as never, 'EdDSA'))).resolves.toBeDefined();
    expect(await auditActions(tenant)).toContain('grantex.dpdp.consent_created');
  });
});

describePostgres('reads', () => {
  it('do not count developer reads as principal access', async () => {
    const tenant = await newTenant();
    const { recordId } = await newRecord(tenant, { principal: 'user_dpdp_reader' });

    const one = await call(tenant, 'GET', `/v1/dpdp/consent-records/${recordId}`);
    const all = await call(tenant, 'GET', '/v1/dpdp/data-principals/user_dpdp_reader/records');

    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ accessCount: 0, lastAccessedAt: null });
    // JSONB is stored as JSON, not as a JSON-encoded string.
    expect(one.json()['purposes']).toEqual([{ code: 'service', description: 'Service delivery' }]);
    expect(all.json()['records'][0]).toMatchObject({ accessCount: 0, lastAccessedAt: null });
    const [row] = await sql`SELECT access_count, last_accessed_at FROM dpdp_consent_records WHERE id = ${recordId}`;
    expect(row).toMatchObject({ access_count: 0, last_accessed_at: null });
  });

  it('page with limit and cursor, and count the whole result', async () => {
    const tenant = await newTenant();
    const noticeId = await newNotice(tenant);
    for (let i = 0; i < 3; i += 1) await newRecord(tenant, { principal: 'user_dpdp_pager', noticeId });
    await newRecord(tenant, { principal: 'user_dpdp_other', noticeId });

    const first = await call(tenant, 'GET', '/v1/dpdp/consent-records?dataPrincipalId=user_dpdp_pager&limit=2');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()['records']).toHaveLength(2);
    expect(first.json()['totalRecords']).toBe(3);
    const cursor = first.json()['nextCursor'] as string;
    expect(typeof cursor).toBe('string');
    const second = await call(tenant, 'GET', `/v1/dpdp/consent-records?dataPrincipalId=user_dpdp_pager&limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.json()['records']).toHaveLength(1);
    expect(second.json()['nextCursor']).toBeNull();
    const ids = [...first.json()['records'], ...second.json()['records']].map((r: Record<string, unknown>) => r['recordId']);
    expect(new Set(ids).size).toBe(3);

    const everything = await call(tenant, 'GET', '/v1/dpdp/consent-records');
    expect(everything.json()['totalRecords']).toBe(4);
    const principal = await call(tenant, 'GET', '/v1/dpdp/data-principals/user_dpdp_pager/records?limit=1');
    expect(principal.json()['records']).toHaveLength(1);
    expect(principal.json()['totalRecords']).toBe(3);
    expect(principal.json()['nextCursor']).toEqual(expect.any(String));

    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'cursor=not-a-cursor']) {
      expect((await call(tenant, 'GET', `/v1/dpdp/consent-records?${query}`)).statusCode).toBe(400);
    }
  });
});

describePostgres('consent notices', () => {
  it('lists notices and returns the versions of one', async () => {
    const tenant = await newTenant();
    const noticeId = await newNotice(tenant, `notice-${suffix()}`, '1.0', 'One');
    await call(tenant, 'POST', '/v1/dpdp/consent-notices', {
      noticeId, version: '1.1', title: 'Notice', content: 'Two', purposes: [{ code: 'service', description: 'Service' }],
    });
    await newNotice(tenant);
    const stranger = await newTenant();
    await newNotice(stranger);

    const list = await call(tenant, 'GET', '/v1/dpdp/consent-notices?limit=10');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()['notices']).toHaveLength(3);
    const versions = await call(tenant, 'GET', `/v1/dpdp/consent-notices/${noticeId}`);
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json()['versions'].map((v: Record<string, unknown>) => v['version'])).toEqual(['1.1', '1.0']);
    expect(versions.json()['versions'][0]['content']).toBe('Two');
    expect((await call(stranger, 'GET', `/v1/dpdp/consent-notices/${noticeId}`)).statusCode).toBe(404);
    expect(await auditActions(tenant)).toContain('grantex.dpdp.notice_created');
  });
});

describePostgres('grievances', () => {
  it('refuses a record of another developer', async () => {
    const tenant = await newTenant();
    const stranger = await newTenant();
    const theirs = await newRecord(stranger);

    const res = await call(tenant, 'POST', '/v1/dpdp/grievances', {
      dataPrincipalId: 'user_dpdp_1', recordId: theirs.recordId, type: 'other', description: 'x',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()['code']).toBe('INVALID_RECORD');
  });

  it('keeps the 7-day default, takes a published response period of up to 90 days, lists and transitions', async () => {
    const tenant = await newTenant();
    const byDefault = await call(tenant, 'POST', '/v1/dpdp/grievances', { dataPrincipalId: 'user_dpdp_g', type: 'other', description: 'a' });
    expect(byDefault.statusCode, byDefault.body).toBe(202);
    const sevenDays = new Date(byDefault.json()['expectedResolutionBy'] as string).getTime() - Date.now();
    expect(Math.round(sevenDays / 86_400_000)).toBe(7);
    const thirty = await call(tenant, 'POST', '/v1/dpdp/grievances', {
      dataPrincipalId: 'user_dpdp_g2', type: 'other', description: 'b', responsePeriodDays: 30,
    });
    expect(thirty.statusCode).toBe(202);
    expect(thirty.json()['responsePeriodDays']).toBe(30);
    expect(Math.round((new Date(thirty.json()['expectedResolutionBy'] as string).getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect((await call(tenant, 'POST', '/v1/dpdp/grievances', {
      dataPrincipalId: 'user_dpdp_g', type: 'other', description: 'c', responsePeriodDays: 91,
    })).statusCode).toBe(400);

    const list = await call(tenant, 'GET', '/v1/dpdp/grievances?dataPrincipalId=user_dpdp_g');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()['grievances']).toHaveLength(1);
    expect((await call(tenant, 'GET', '/v1/dpdp/grievances?status=bogus')).statusCode).toBe(400);

    const id = byDefault.json()['grievanceId'] as string;
    const skip = await call(tenant, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'resolved', resolution: 'Done' });
    expect(skip.statusCode).toBe(409);
    expect(skip.json()['code']).toBe('INVALID_TRANSITION');
    expect((await call(tenant, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'in_review' })).statusCode).toBe(200);
    expect((await call(tenant, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'resolved' })).statusCode).toBe(400);
    const resolved = await call(tenant, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'resolved', resolution: 'Records corrected' });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolution: 'Records corrected' });
    expect(resolved.json()['resolvedAt']).toEqual(expect.any(String));
    expect((await call(tenant, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'in_review' })).statusCode).toBe(409);
    const inReview = await call(tenant, 'GET', '/v1/dpdp/grievances?status=resolved');
    expect(inReview.json()['grievances'].map((g: Record<string, unknown>) => g['grievanceId'])).toEqual([id]);

    const stranger = await newTenant();
    expect((await call(stranger, 'PATCH', `/v1/dpdp/grievances/${id}`, { status: 'in_review' })).statusCode).toBe(404);
    const updated = await waitFor(() => deliveries(tenant, 'dpdp.grievance.updated'), (rows) => rows.length >= 2);
    expect(updated.map((row) => (row['data'] as Record<string, unknown>)['status'])).toEqual(expect.arrayContaining(['in_review', 'resolved']));
    const actions = await auditActions(tenant);
    expect(actions).toContain('grantex.dpdp.grievance_filed');
    expect(actions.filter((a) => a === 'grantex.dpdp.grievance_updated')).toHaveLength(2);
  });
});

describePostgres('exports', () => {
  const range = () => ({ dateFrom: new Date(Date.now() - 86_400_000).toISOString(), dateTo: new Date(Date.now() + 86_400_000).toISOString() });

  it('validates the range and the format', async () => {
    const tenant = await newTenant();
    const now = Date.now();
    for (const payload of [
      { type: 'dpdp-audit', dateFrom: 'yesterday', dateTo: new Date(now).toISOString() },
      { type: 'dpdp-audit', dateFrom: new Date(now).toISOString(), dateTo: new Date(now - 1000).toISOString() },
      { type: 'dpdp-audit', ...range(), format: 'csv' },
    ]) {
      const res = await call(tenant, 'POST', '/v1/dpdp/exports', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('reports truncation of the audit log honestly', async () => {
    const tenant = await newTenant();
    await sql`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
      SELECT 'alog_dpdp_' || ${tenant.id} || '_' || g, ${tenant.agentId}, 'did:grantex:x', 'grnt_x', 'user_dpdp_1', ${tenant.id},
             'files.read', '{}'::jsonb, md5(g::text), NULL, NOW() - (g || ' seconds')::interval, 'success'
      FROM generate_series(1, 1001) AS g`;

    const res = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'dpdp-audit', ...range() });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ truncated: true, auditLogLimit: 1000 });
    expect(res.json()['data']['auditLog']).toHaveLength(1000);
    const small = await newTenant();
    const complete = await call(small, 'POST', '/v1/dpdp/exports', { type: 'dpdp-audit', ...range() });
    expect(complete.json()['truncated']).toBe(false);
  });

  it('answers 410 once expired and purges the data', async () => {
    const tenant = await newTenant();
    const created = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'dpdp-audit', ...range() });
    const exportId = created.json()['exportId'] as string;
    const fresh = await call(tenant, 'GET', `/v1/dpdp/exports/${exportId}`);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()['data']).toMatchObject({ exportType: 'dpdp-audit', truncated: false });
    await sql`UPDATE dpdp_exports SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${exportId}`;

    const gone = await call(tenant, 'GET', `/v1/dpdp/exports/${exportId}`);

    expect(gone.statusCode).toBe(410);
    expect(gone.json()['code']).toBe('GONE');
    const [row] = await sql`SELECT data FROM dpdp_exports WHERE id = ${exportId}`;
    expect(row?.['data'] ?? null).toBeNull();
    expect((await call(tenant, 'GET', `/v1/dpdp/exports/${exportId}`)).statusCode).toBe(410);
  });

  it('filters a principal export to that principal: records, their grants\' audit entries and grievances', async () => {
    const tenant = await newTenant();
    const mine = await newRecord(tenant, { principal: 'user_dpdp_export' });
    const theirs = await newRecord(tenant, { principal: 'user_dpdp_neighbour' });
    // A tenant audit entry names the grant's own principal namespace.
    await tenantAuditEntry(tenant, mine.grantId, 'user_dpdp_grant_namespace');
    await tenantAuditEntry(tenant, theirs.grantId, 'user_dpdp_neighbour');
    await call(tenant, 'POST', '/v1/dpdp/grievances', { dataPrincipalId: 'user_dpdp_neighbour', type: 'other', description: 'n' });
    await call(tenant, 'POST', '/v1/dpdp/grievances', { dataPrincipalId: 'user_dpdp_export', type: 'other', description: 'm' });

    const res = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'dpdp-audit', ...range(), dataPrincipalId: 'user_dpdp_export' });

    expect(res.statusCode, res.body).toBe(201);
    const data = res.json()['data'] as Record<string, Array<Record<string, unknown>>>;
    expect(data['consentRecords']!.map((r) => r['id'])).toEqual([mine.recordId]);
    const tenantEntries = data['auditLog']!.filter((e) => e['action'] === 'files.read');
    expect(tenantEntries).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('user_dpdp_neighbour');
    expect(data['grievances']).toHaveLength(1);
    expect(await auditActions(tenant)).toContain('grantex.dpdp.export_created');
  });
});

describePostgres('the consent expiry worker', () => {
  it('marks records past processing_expires_at expired, and revokes only under DPDP_CONSENT_EXPIRY_REVOKES_GRANT=true', async () => {
    const tenant = await newTenant();
    const kept = await newRecord(tenant);
    const revoked = await newRecord(tenant);
    const current = await newRecord(tenant);
    await sql`UPDATE dpdp_consent_records SET processing_expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${kept.recordId}`;

    const first = await expireConsentRecordsOnce(sql, quiet);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect((await sql`SELECT status FROM dpdp_consent_records WHERE id = ${kept.recordId}`)[0]!['status']).toBe('expired');
    expect(await grantStatus(kept.grantId)).toBe('active');
    expect((await sql`SELECT status FROM dpdp_consent_records WHERE id = ${current.recordId}`)[0]!['status']).toBe('active');

    vi.stubEnv('DPDP_CONSENT_EXPIRY_REVOKES_GRANT', 'true');
    await sql`UPDATE dpdp_consent_records SET processing_expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${revoked.recordId}`;
    const second = await expireConsentRecordsOnce(sql, quiet);
    expect(second.grantsRevoked).toBeGreaterThanOrEqual(1);
    expect(await grantStatus(revoked.grantId)).toBe('revoked');
    expect(await grantStatus(current.grantId)).toBe('active');
    expect((await auditActions(tenant)).filter((a) => a === 'grantex.dpdp.consent_expired')).toHaveLength(2);
    expect(await chainIntegrity(tenant)).toMatchObject({ valid: true });
  });
});
