// SPDX-License-Identifier: Apache-2.0
/**
 * The EU AI Act evidence pack and the per-person GDPR Art. 15 export against
 * real Postgres, through POST /v1/dpdp/exports.
 *
 * Covered: the `eu-ai-act-evidence` type and its sections (Art. 12 record
 * keeping with chain integrity and a retention statement, Art. 14 human
 * oversight, Art. 26 deployer grants, Art. 50 transparency, Art. 73
 * incidents from the breach register), the applicability block and the
 * disclaimer; tamper detection; truncation; `eu-ai-act-conformance` keeping
 * its existing keys and gaining the sections; the `gdpr-article-15` block
 * (purposes, recipients, retention, source) for one data principal, and
 * DPDP_EXPORT_GDPR_REQUIRES_PRINCIPAL refusing an export without one.
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
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres export tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
interface Tenant { id: string; apiKey: string; agents: string[] }
type Json = Record<string, unknown>;

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let addressCounter = 0;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function newTenant(): Promise<Tenant> {
  const s = suffix();
  const tenant = { id: `dev_evd_${s}`, apiKey: `gx_test_evd_${s}_key`, agents: [`ag_evd_a_${s}`, `ag_evd_b_${s}`] };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Evidence Test Operator', 'live')`;
  for (const agentId of tenant.agents) {
    await sql`INSERT INTO agents (id, did, developer_id, name)
              VALUES (${agentId}, ${'did:grantex:' + agentId}, ${tenant.id}, ${agentId.includes('_a_') ? 'shopper-01' : 'Nimbus Shopper 2.4'})`;
  }
  return tenant;
}

async function newGrant(tenant: Tenant, agentId: string, options: { principal?: string; scopes?: string[]; audience?: string } = {}): Promise<string> {
  const id = `grnt_evd_${suffix()}`;
  await sql`
    INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, status, expires_at, audience)
    VALUES (${id}, ${agentId}, ${options.principal ?? 'user_evd_1'}, ${tenant.id}, ${options.scopes ?? ['orders:read']},
            'active', NOW() + INTERVAL '2 hours', ${options.audience ?? null})`;
  return id;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  addressCounter += 1;
  return app.inject({
    method, url, remoteAddress: `198.18.0.${(addressCounter % 250) + 1}`,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const range = () => ({
  dateFrom: new Date(Date.now() - 86_400_000).toISOString(),
  dateTo: new Date(Date.now() + 86_400_000).toISOString(),
});

async function exportOf(tenant: Tenant, body: Json): Promise<Json> {
  const res = await call(tenant, 'POST', '/v1/dpdp/exports', { ...range(), ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Json>();
}

async function auditEntry(tenant: Tenant, grantId: string, agentId: string, principalId = 'user_evd_1'): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/audit/log', {
    agentId, agentDid: `did:grantex:${agentId}`, grantId, principalId, action: 'orders.read', metadata: { order: 'ord_1' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ entryId: string }>().entryId;
}

async function notice(tenant: Tenant): Promise<string> {
  const noticeId = `notice-${suffix()}`;
  const res = await call(tenant, 'POST', '/v1/dpdp/consent-notices', {
    noticeId, version: '1.0', title: 'Notice', content: 'Text',
    purposes: [{ code: 'orders', description: 'Fulfil orders' }, { code: 'support', description: 'Customer support' }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return noticeId;
}

async function consentRecord(tenant: Tenant, grantId: string, principal: string, noticeId: string, codes: string[]): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/dpdp/consent-records', {
    grantId, dataPrincipalId: principal, consentNoticeId: noticeId,
    purposes: codes.map((code) => ({ code, description: `Purpose ${code}` })),
    processingExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ recordId: string }>().recordId;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('dpdp_evidence');
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

describePostgres('the eu-ai-act-evidence export', () => {
  it('maps the operator\'s records to Art. 12, 14, 26, 50 and 73 sections, with applicability and a disclaimer', async () => {
    const tenant = await newTenant();
    const [agentA, agentB] = tenant.agents as [string, string];
    const g1 = await newGrant(tenant, agentA, { scopes: ['orders:read', 'orders:write'] });
    const g2 = await newGrant(tenant, agentA, { scopes: ['support:read'] });
    const g3 = await newGrant(tenant, agentB);
    await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${g2}`;
    await auditEntry(tenant, g1, agentA);
    await auditEntry(tenant, g3, agentB);
    for (const status of ['approved', 'denied', 'pending']) {
      await sql`INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, expires_at, status)
                VALUES (${'areq_' + suffix()}, ${agentA}, 'user_evd_1', ${tenant.id}, ${['orders:read']}, NOW() + INTERVAL '1 hour', ${status})`;
    }
    await sql`INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, grants_matched, grants_revoked)
              VALUES (${'estop_' + suffix()}, ${tenant.id}, 'agent', ${agentB}, 'Irregular spending', 'operator', 1, 1)`;
    const breach = await call(tenant, 'POST', '/v1/dpdp/breaches', {
      description: 'Agent exposed order data', nature: 'confidentiality', extent: 'One customer', affectedCount: 1,
    });
    expect(breach.statusCode, breach.body).toBe(201);

    const body = await exportOf(tenant, { type: 'eu-ai-act-evidence' });

    expect(body['type']).toBe('eu-ai-act-evidence');
    const data = body['data'] as Json;
    expect(data['exportType']).toBe('eu-ai-act-evidence');
    // Not the generic DPDP dump.
    expect(data['consentRecords']).toBeUndefined();
    expect(data['auditLog']).toBeUndefined();

    const art12 = data['art12RecordKeeping'] as Json;
    expect(art12['source']).toEqual(expect.stringContaining('audit_entries'));
    expect(art12['eventCount']).toBeGreaterThanOrEqual(2);
    expect((art12['events'] as unknown[]).length).toBe(art12['eventCount']);
    expect(art12['chainIntegrity']).toMatchObject({ valid: true, complete: true });
    expect(art12['firstEventAt']).toEqual(expect.any(String));
    expect(art12['lastEventAt']).toEqual(expect.any(String));
    expect(JSON.stringify(art12['retention'])).toMatch(/19\(1\).*26\(6\).*six months/s);
    expect(art12['truncated']).toBe(false);

    const art14 = data['art14HumanOversight'] as Json;
    expect(art14['sources']).toEqual(expect.arrayContaining(['auth_requests', 'emergency_stops', 'decision_grants']));
    expect((art14['consentDecisions'] as Json)['byStatus']).toMatchObject({ approved: 1, denied: 1, pending: 1 });
    expect(art14['emergencyStops']).toMatchObject({ count: 1 });
    expect(art14['revocations']).toMatchObject({ grantsRevoked: 1 });
    expect(art14['decisionApprovals']).toMatchObject({ approvalsIssued: 0 });

    const art26 = data['art26Deployer'] as Json;
    const agents = art26['agents'] as Json[];
    const a = agents.find((row) => row['agentId'] === agentA)!;
    expect(a).toMatchObject({ grantsIssued: 2, revokedGrants: 1, agentName: 'shopper-01' });
    expect(a['scopes']).toEqual(['orders:read', 'orders:write', 'support:read']);
    expect(agents.find((row) => row['agentId'] === agentB)).toMatchObject({ grantsIssued: 1 });

    expect(data['art50Transparency']).toMatchObject({ recorded: false, truncated: false });
    expect((data['art50Transparency'] as Json)['statement']).toMatch(/not recorded/i);

    const art73 = data['art73Incidents'] as Json;
    expect(art73['source']).toEqual(expect.stringContaining('dpdp_breaches'));
    expect(art73['count']).toBe(1);
    expect((art73['items'] as Json[])[0]).toMatchObject({ breachId: breach.json()['breachId'] });
    expect(JSON.stringify(art73)).toContain('15 days');

    for (const key of ['art12RecordKeeping', 'art14HumanOversight', 'art26Deployer', 'art50Transparency', 'art73Incidents']) {
      const section = data[key] as Json;
      expect(section['source'] ?? section['sources'], key).toBeDefined();
      expect(typeof section['truncated'], key).toBe('boolean');
    }
    expect(data['applicability']).toMatchObject({
      regulation: expect.stringContaining('2026/1744'),
      art50TransparencyFrom: '2026-08-02',
      highRiskAnnexIIIFrom: '2027-12-02',
      highRiskAnnexIFrom: '2028-08-02',
    });
    expect(data['disclaimer']).toEqual(expect.stringContaining('not a conformity assessment'));
    expect(body['truncated']).toBe(false);

    const stored = await call(tenant, 'GET', `/v1/dpdp/exports/${body['exportId'] as string}`);
    expect(stored.json()['data']['art12RecordKeeping']['eventCount']).toBe(art12['eventCount']);
  });

  it('reports a tampered audit chain', async () => {
    const tenant = await newTenant();
    const grantId = await newGrant(tenant, tenant.agents[0]!);
    const entryId = await auditEntry(tenant, grantId, tenant.agents[0]!);
    await auditEntry(tenant, grantId, tenant.agents[0]!);
    await sql`UPDATE audit_entries SET metadata = '{"order":"ord_forged"}'::jsonb WHERE id = ${entryId}`;

    const body = await exportOf(tenant, { type: 'eu-ai-act-evidence' });

    expect((body['data'] as Json)['art12RecordKeeping']).toMatchObject({
      chainIntegrity: { valid: false, firstBrokenAt: entryId, reason: 'content' },
    });
  });

  it('says when the event list is truncated', async () => {
    const tenant = await newTenant();
    await sql`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
      SELECT 'alog_evd_' || ${tenant.id} || '_' || g, ${tenant.agents[0]!}, 'did:grantex:x', 'grnt_x', 'user_evd_1', ${tenant.id},
             'orders.read', '{}'::jsonb, md5(g::text), NULL, NOW() - (g || ' seconds')::interval, 'success'
      FROM generate_series(1, 1001) AS g`;

    const body = await exportOf(tenant, { type: 'eu-ai-act-evidence' });

    const art12 = (body['data'] as Json)['art12RecordKeeping'] as Json;
    expect(art12['eventCount']).toBe(1001);
    expect(art12['events']).toHaveLength(1000);
    expect(art12['truncated']).toBe(true);
    expect(body['truncated']).toBe(true);
  });

  it('refuses a data principal filter, since the pack covers the operator', async () => {
    const tenant = await newTenant();
    const res = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'eu-ai-act-evidence', ...range(), dataPrincipalId: 'user_evd_1' });
    expect(res.statusCode).toBe(400);
    expect(res.json()['message']).toContain('dataPrincipalId');
  });

  it('keeps the eu-ai-act-conformance keys and adds the sections', async () => {
    const tenant = await newTenant();
    const grantId = await newGrant(tenant, tenant.agents[0]!);
    await auditEntry(tenant, grantId, tenant.agents[0]!);

    const body = await exportOf(tenant, { type: 'eu-ai-act-conformance' });

    const data = body['data'] as Json;
    expect(data['exportType']).toBe('eu-ai-act-conformance');
    expect(data['consentRecords']).toEqual(expect.any(Array));
    expect(data['auditLog']).toEqual(expect.any(Array));
    expect(data['art12RecordKeeping']).toMatchObject({ chainIntegrity: { valid: true } });
    expect(data['disclaimer']).toEqual(expect.any(String));
  });
});

describePostgres('the gdpr-article-15 export', () => {
  it('adds purposes, recipients, retention and source for the data principal', async () => {
    const tenant = await newTenant();
    const noticeId = await notice(tenant);
    const g1 = await newGrant(tenant, tenant.agents[0]!, { principal: 'user_evd_subject', audience: 'https://api.merchant.example' });
    const g2 = await newGrant(tenant, tenant.agents[1]!, { principal: 'user_evd_subject' });
    const other = await newGrant(tenant, tenant.agents[1]!, { principal: 'user_evd_other', audience: 'https://other.merchant.example' });
    const r1 = await consentRecord(tenant, g1, 'user_evd_subject', noticeId, ['orders']);
    await consentRecord(tenant, g2, 'user_evd_subject', noticeId, ['orders', 'support']);
    await consentRecord(tenant, other, 'user_evd_other', noticeId, ['support']);

    const body = await exportOf(tenant, { type: 'gdpr-article-15', dataPrincipalId: 'user_evd_subject' });

    const art15 = (body['data'] as Json)['article15'] as Json;
    expect(art15['dataPrincipalId']).toBe('user_evd_subject');
    const purposes = art15['purposes'] as Json[];
    expect(purposes.map((p) => p['code']).sort()).toEqual(['orders', 'support']);
    expect(purposes.find((p) => p['code'] === 'orders')!['recordIds']).toHaveLength(2);
    const recipients = art15['recipients'] as Json[];
    expect(recipients.map((r) => r['agentId']).sort()).toEqual([...tenant.agents].sort());
    expect(recipients.find((r) => r['agentId'] === tenant.agents[0])).toMatchObject({
      agentName: 'shopper-01', audiences: ['https://api.merchant.example'],
    });
    const retention = art15['retention'] as Json;
    expect((retention['records'] as Json[]).find((r) => r['recordId'] === r1)!['retentionUntil']).toEqual(expect.any(String));
    expect(retention['statement']).toEqual(expect.any(String));
    const source = art15['source'] as Json;
    expect((source['records'] as Json[])[0]).toMatchObject({ consentNoticeId: noticeId, consentNoticeVersion: '1.0' });
    expect(art15['automatedDecisionMaking']).toMatchObject({ recorded: false });
    expect(JSON.stringify(art15)).not.toContain('user_evd_other');
    expect(JSON.stringify(art15)).not.toContain('other.merchant.example');
  });

  it('keeps working without dataPrincipalId unless DPDP_EXPORT_GDPR_REQUIRES_PRINCIPAL=true', async () => {
    const tenant = await newTenant();
    const legacy = await exportOf(tenant, { type: 'gdpr-article-15' });
    expect((legacy['data'] as Json)['article15']).toBeUndefined();

    vi.stubEnv('DPDP_EXPORT_GDPR_REQUIRES_PRINCIPAL', 'true');
    const refused = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'gdpr-article-15', ...range() });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()['message']).toContain('dataPrincipalId');
    const perPerson = await call(tenant, 'POST', '/v1/dpdp/exports', { type: 'gdpr-article-15', ...range(), dataPrincipalId: 'user_evd_x' });
    expect(perPerson.statusCode, perPerson.body).toBe(201);
  });
});
