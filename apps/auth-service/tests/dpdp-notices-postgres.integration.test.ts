// SPDX-License-Identifier: Apache-2.0
/**
 * DPDP consent notice content (DPDP Act s.5; DPDP Rules 2025 r.3) against
 * real Postgres, through the routes.
 *
 * Covered: migration 129 (the structured notice columns, the notice language
 * on a consent record, the unique key widened to include the language while
 * existing rows stay valid); the structured fields stored and read back; the
 * informational `validation` block; DPDP_NOTICE_REQUIRE_RULE3 refusing an
 * incomplete notice or a language outside English and the Eighth Schedule;
 * one notice version in several languages, and consent records choosing
 * among them.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { initEdKey } from '../src/lib/crypto.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres DPDP notice tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
interface Tenant { id: string; apiKey: string; agentId: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let addressCounter = 0;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function newTenant(): Promise<Tenant> {
  const s = suffix();
  const tenant = { id: `dev_ntc_${s}`, apiKey: `gx_test_ntc_${s}_key`, agentId: `ag_ntc_${s}` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Notice Test Fiduciary', 'sandbox')`;
  await sql`INSERT INTO agents (id, did, developer_id, name)
            VALUES (${tenant.agentId}, ${'did:grantex:' + tenant.agentId}, ${tenant.id}, 'shopper-01')`;
  return tenant;
}

async function newGrant(tenant: Tenant): Promise<string> {
  const id = `grnt_ntc_${suffix()}`;
  await sql`
    INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, status, expires_at)
    VALUES (${id}, ${tenant.agentId}, 'user_ntc_1', ${tenant.id}, ${['read']}, 'active', NOW() + INTERVAL '2 hours')`;
  return id;
}

async function call(tenant: Tenant, method: 'GET' | 'POST', url: string, payload?: unknown) {
  addressCounter += 1;
  return app.inject({
    method, url, remoteAddress: `192.0.2.${(addressCounter % 250) + 1}`,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const baseNotice = (overrides: Record<string, unknown> = {}) => ({
  noticeId: `notice-${suffix()}`,
  version: '1.0',
  title: 'How we use your data',
  content: 'We use your email address to fulfil your orders.',
  purposes: [{ code: 'orders', description: 'Fulfil orders' }],
  ...overrides,
});

const structured = {
  itemisedPersonalData: [
    { category: 'contact', description: 'Email address' },
    { category: 'transaction', description: 'Order contents and amounts' },
  ],
  purposeDetails: [{ code: 'orders', description: 'Fulfil your orders', goodsOrServices: 'Online ordering and delivery' }],
  withdrawalUrl: 'https://merchant.example/consent/withdraw',
  rightsUrl: 'https://merchant.example/privacy/rights',
  boardComplaintUrl: 'https://merchant.example/privacy/complaints',
  contact: { name: 'Data Protection Officer', email: 'dpo@merchant.example', phone: '+91-00000-00000' },
};

function record(grantId: string, noticeId: string, extra: Record<string, unknown> = {}) {
  return {
    grantId, dataPrincipalId: 'user_ntc_1', purposes: [{ code: 'orders', description: 'Fulfil orders' }],
    consentNoticeId: noticeId, processingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...extra,
  };
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('dpdp_notice');
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

describePostgres('migration 129', () => {
  it('adds the structured notice columns and keys notice versions by language', async () => {
    expect(await sql`SELECT filename FROM schema_migrations WHERE filename = '129_dpdp_notice_content.sql'`).toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('dpdp_consent_notices', 'dpdp_consent_records')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('dpdp_consent_notices')).toEqual(expect.arrayContaining([
      'itemised_personal_data', 'purpose_details', 'withdrawal_url', 'rights_url', 'board_complaint_url', 'contact',
    ]));
    expect(names('dpdp_consent_records')).toEqual(expect.arrayContaining(['consent_notice_language']));
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'dpdp_consent_notices'`;
    expect(indexes.map((i) => i.indexname)).not.toContain('idx_dpdp_notices_id_version');
    const unique = indexes.find((i) => i.indexname === 'idx_dpdp_notices_id_version_language');
    expect(unique?.indexdef).toMatch(/UNIQUE INDEX .*\(developer_id, notice_id, version, language\)/);
  });

  it('leaves a notice written before it readable, with its elements reported missing', async () => {
    const tenant = await newTenant();
    const noticeId = `notice-${suffix()}`;
    await sql`
      INSERT INTO dpdp_consent_notices (id, developer_id, notice_id, language, version, title, content, purposes, content_hash)
      VALUES (${'notice_' + suffix()}, ${tenant.id}, ${noticeId}, 'en', '0.9', 'Old notice', 'Old text',
              ${sql.json([{ code: 'orders', description: 'Orders' }])}, 'hash-old')`;

    const res = await call(tenant, 'GET', `/v1/dpdp/consent-notices/${noticeId}`);

    expect(res.statusCode, res.body).toBe(200);
    const version = res.json()['versions'][0];
    expect(version).toMatchObject({
      itemisedPersonalData: null, purposeDetails: null, withdrawalUrl: null, rightsUrl: null,
      boardComplaintUrl: null, contact: null,
    });
    expect(version['validation']).toMatchObject({ complete: false, enforced: false });
  });
});

describePostgres('structured notice content', () => {
  it('stores the fields and reports every r.3 element present', async () => {
    const tenant = await newTenant();
    const payload = baseNotice(structured);

    const res = await call(tenant, 'POST', '/v1/dpdp/consent-notices', payload);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()['validation']).toMatchObject({ enforced: false, complete: true, missing: [] });
    const read = await call(tenant, 'GET', `/v1/dpdp/consent-notices/${payload.noticeId}`);
    expect(read.json()['versions'][0]).toMatchObject({ ...structured, validation: { complete: true } });
    const list = await call(tenant, 'GET', '/v1/dpdp/consent-notices');
    expect(list.json()['notices'][0]).toMatchObject({ ...structured, validation: { complete: true } });
  });

  it('reports the missing elements without refusing, while DPDP_NOTICE_REQUIRE_RULE3 is off', async () => {
    const tenant = await newTenant();
    const res = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ language: 'fr' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()['validation']).toMatchObject({
      enforced: false,
      complete: false,
      missing: ['itemisedPersonalData', 'specificPurposes', 'withdrawalMeans', 'rightsMeans', 'boardComplaintMeans', 'language'],
    });
  });

  it('refuses an incomplete notice or another language under DPDP_NOTICE_REQUIRE_RULE3=true', async () => {
    vi.stubEnv('DPDP_NOTICE_REQUIRE_RULE3', 'true');
    const tenant = await newTenant();
    const incomplete = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ ...structured, rightsUrl: undefined }));
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()).toMatchObject({ code: 'NOTICE_INCOMPLETE' });
    expect(incomplete.json()['message']).toContain('rightsMeans');
    const french = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ ...structured, language: 'fr' }));
    expect(french.statusCode).toBe(400);
    expect(french.json()['code']).toBe('NOTICE_INCOMPLETE');
    for (const language of ['en', 'hi-IN', 'sat', 'kok']) {
      const ok = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ ...structured, language }));
      expect(ok.statusCode, `${language}: ${ok.body}`).toBe(201);
      expect(ok.json()['validation']).toMatchObject({ enforced: true, complete: true });
    }
    expect(await sql`SELECT id FROM dpdp_consent_notices WHERE developer_id = ${tenant.id}`).toHaveLength(4);
  });

  it('answers 400 for malformed structured fields', async () => {
    const tenant = await newTenant();
    for (const extra of [
      { itemisedPersonalData: 'email' },
      { itemisedPersonalData: [{ category: 'contact' }] },
      { purposeDetails: [{ code: 'orders', description: 'x' }] },
      { purposeDetails: [{ code: 'unlisted', description: 'x', goodsOrServices: 'y' }] },
      { withdrawalUrl: 'javascript:alert(1)' },
      { rightsUrl: 'not a url' },
      { boardComplaintUrl: 42 },
      { contact: 'dpo@merchant.example' },
      { contact: { name: 'Officer' } },
      { contact: { email: 'not-an-email' } },
    ]) {
      const res = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice(extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json()['code']).toBe('BAD_REQUEST');
    }
  });
});

describePostgres('one notice version in several languages', () => {
  it('takes the same noticeId and version per language, and a consent record picks one', async () => {
    const tenant = await newTenant();
    const noticeId = `notice-${suffix()}`;
    const english = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ noticeId, language: 'en', content: 'English text' }));
    const hindi = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ noticeId, language: 'hi', content: 'Hindi text' }));
    expect(english.statusCode, english.body).toBe(201);
    expect(hindi.statusCode, hindi.body).toBe(201);
    const duplicate = await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ noticeId, language: 'hi', content: 'Again' }));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()['code']).toBe('CONFLICT');

    const ambiguous = await call(tenant, 'POST', '/v1/dpdp/consent-records', record(await newGrant(tenant), noticeId));
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json()['code']).toBe('NOTICE_LANGUAGE_REQUIRED');
    const pinnedAmbiguous = await call(tenant, 'POST', '/v1/dpdp/consent-records',
      record(await newGrant(tenant), noticeId, { consentNoticeVersion: '1.0' }));
    expect(pinnedAmbiguous.json()['code']).toBe('NOTICE_LANGUAGE_REQUIRED');

    const chosen = await call(tenant, 'POST', '/v1/dpdp/consent-records',
      record(await newGrant(tenant), noticeId, { consentNoticeLanguage: 'hi' }));
    expect(chosen.statusCode, chosen.body).toBe(201);
    expect(chosen.json()).toMatchObject({
      consentNoticeVersion: '1.0', consentNoticeLanguage: 'hi', consentNoticeHash: hindi.json()['contentHash'],
    });
    const stored = await call(tenant, 'GET', `/v1/dpdp/consent-records/${chosen.json()['recordId'] as string}`);
    expect(stored.json()['consentNoticeLanguage']).toBe('hi');
    const missingLanguage = await call(tenant, 'POST', '/v1/dpdp/consent-records',
      record(await newGrant(tenant), noticeId, { consentNoticeLanguage: 'ta' }));
    expect(missingLanguage.statusCode).toBe(400);
    expect(missingLanguage.json()['code']).toBe('INVALID_NOTICE');

    const versions = await call(tenant, 'GET', `/v1/dpdp/consent-notices/${noticeId}`);
    expect(versions.json()['versions'].map((v: Record<string, unknown>) => v['language']).sort()).toEqual(['en', 'hi']);
  });

  it('still records against a single-language notice without a language', async () => {
    const tenant = await newTenant();
    const noticeId = `notice-${suffix()}`;
    expect((await call(tenant, 'POST', '/v1/dpdp/consent-notices', baseNotice({ noticeId }))).statusCode).toBe(201);
    const res = await call(tenant, 'POST', '/v1/dpdp/consent-records', record(await newGrant(tenant), noticeId));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()['consentNoticeLanguage']).toBe('en');
  });
});
