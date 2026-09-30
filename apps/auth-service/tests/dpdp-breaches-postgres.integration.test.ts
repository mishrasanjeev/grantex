// SPDX-License-Identifier: Apache-2.0
/**
 * The DPDP breach register against real Postgres, through the routes.
 *
 * Covered: migration 128 (the breach and principal intimation tables, their
 * CHECK constraints); recording a breach (DPDP Act s.8(6), DPDP Rules 2025
 * r.7) with its computed deadlines, events and audit entries; validation;
 * the list, its status filter and pagination; tenant isolation; the detailed
 * report fields, Board intimation times, an extension and the status
 * transitions (invalid ones 409); recording principal intimations; and the
 * deadline alert worker behind DPDP_BREACH_DEADLINE_ALERTS_ENABLED. The SQL
 * mock forwards to a database of this file's own.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { initEdKey } from '../src/lib/crypto.js';
import { emitEvent } from '../src/lib/events.js';
import {
  runBreachDeadlineAlertsOnce,
  startDpdpBreachDeadlineWorker,
  stopDpdpBreachDeadlineWorker,
} from '../src/workers/dpdpBreachDeadlines.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres DPDP breach tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
interface Tenant { id: string; apiKey: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let addressCounter = 0;

const HOUR = 3_600_000;
const quiet = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => quiet,
} as never;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function newTenant(): Promise<Tenant> {
  const s = suffix();
  const tenant = { id: `dev_brch_${s}`, apiKey: `gx_test_brch_${s}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Breach Test Fiduciary', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  addressCounter += 1;
  return app.inject({
    method, url, remoteAddress: `203.0.113.${(addressCounter % 250) + 1}`,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

function breachBody(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Unauthorised read of the order history export bucket',
    nature: 'confidentiality',
    extent: 'Order history of listed customers',
    occurredAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    awareAt: new Date(Date.now() - HOUR).toISOString(),
    location: 'Object storage, region example-1',
    likelyImpact: 'Exposure of names and order contents',
    affectedDataPrincipalIds: ['user_brch_1', 'user_brch_2', 'user_brch_3'],
    mitigation: 'Bucket access revoked and keys rotated',
    ...overrides,
  };
}

async function newBreach(tenant: Tenant, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await call(tenant, 'POST', '/v1/dpdp/breaches', breachBody(overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Record<string, unknown>>();
}

const fullReport = {
  updatedDetails: 'Three customer records were read by an expired contractor credential',
  factsCircumstancesReasons: 'A credential was not revoked when the contract ended',
  mitigation: 'Credential revoked, bucket policy narrowed',
  causeFindings: 'Former contractor account, no evidence of onward disclosure',
  remedialMeasures: 'Offboarding now revokes storage credentials automatically',
};

async function auditActions(tenant: Tenant): Promise<string[]> {
  const rows = await sql`SELECT action FROM audit_entries WHERE developer_id = ${tenant.id} ORDER BY timestamp, id`;
  return rows.map((row) => row['action'] as string);
}

function events(tenant: Tenant, type: string): Array<Record<string, unknown>> {
  return vi.mocked(emitEvent).mock.calls
    .filter((args) => args[0] === tenant.id && args[1] === type)
    .map((args) => args[2] as Record<string, unknown>);
}

async function waitForEvents(tenant: Tenant, type: string, count: number): Promise<Array<Record<string, unknown>>> {
  let found = events(tenant, type);
  for (let i = 0; i < 50 && found.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    found = events(tenant, type);
  }
  return found;
}

async function chainValid(tenant: Tenant): Promise<boolean> {
  const res = await call(tenant, 'GET', '/v1/compliance/evidence-pack');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ chainIntegrity: { valid: boolean } }>().chainIntegrity.valid;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('dpdp_breach');
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
  stopDpdpBreachDeadlineWorker();
  vi.unstubAllEnvs();
});

describePostgres('migration 128', () => {
  it('is recorded in the ledger and adds the breach register with its constraints', async () => {
    expect(await sql`SELECT filename FROM schema_migrations WHERE filename = '128_dpdp_breach_register.sql'`).toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('dpdp_breaches', 'dpdp_breach_principal_intimations')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('dpdp_breaches')).toEqual(expect.arrayContaining([
      'id', 'developer_id', 'description', 'nature', 'extent', 'occurred_at', 'aware_at', 'location',
      'likely_impact', 'affected_data_principal_ids', 'affected_count', 'mitigation', 'status',
      'report_updated_details', 'report_facts_circumstances_reasons', 'report_mitigation',
      'report_cause_findings', 'report_remedial_measures', 'board_initial_intimation_sent_at',
      'board_detailed_report_sent_at', 'extension_requested_at', 'extension_granted', 'extension_due_at',
      'board_report_due_at', 'due_alert_sent_at', 'overdue_alert_sent_at',
    ]));
    expect(names('dpdp_breach_principal_intimations')).toEqual(expect.arrayContaining([
      'id', 'breach_id', 'developer_id', 'data_principal_ids', 'channel', 'intimated_at', 'content_included',
    ]));

    const tenant = await newTenant();
    const breach = await newBreach(tenant);
    await expect(sql`UPDATE dpdp_breaches SET status = 'lost' WHERE id = ${breach['breachId'] as string}`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE dpdp_breaches SET affected_count = -1 WHERE id = ${breach['breachId'] as string}`)
      .rejects.toMatchObject({ code: '23514' });
  });
});

describePostgres('recording a breach', () => {
  it('stores it, computes the 72-hour Board deadline, emits the events and audits it', async () => {
    const tenant = await newTenant();
    const awareAt = new Date(Date.now() - HOUR);

    const res = await call(tenant, 'POST', '/v1/dpdp/breaches', breachBody({ awareAt: awareAt.toISOString() }));

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['breachId']).toMatch(/^brch_/);
    expect(body).toMatchObject({
      status: 'open',
      affectedCount: 3,
      principalIntimationRequired: true,
      boardInitialIntimationRequired: true,
      boardDetailedReportOverdue: false,
      boardDetailedReportDueAt: new Date(awareAt.getTime() + 72 * HOUR).toISOString(),
      awareAt: awareAt.toISOString(),
    });
    expect(body['principalIntimation']).toMatchObject({ intimatedCount: 0, pendingCount: 3 });
    const recorded = await waitForEvents(tenant, 'dpdp.breach.recorded', 1);
    expect(recorded[0]).toMatchObject({ breachId: body['breachId'], affectedCount: 3 });
    const due = await waitForEvents(tenant, 'dpdp.breach.principal_intimation_due', 1);
    expect(due[0]).toMatchObject({ breachId: body['breachId'], affectedCount: 3 });
    // The event names no data principal.
    expect(JSON.stringify(due[0])).not.toContain('user_brch_1');
    expect(await auditActions(tenant)).toContain('grantex.dpdp.breach_recorded');
    expect(await chainValid(tenant)).toBe(true);
  });

  it('defaults awareAt to now and takes a bare affectedCount', async () => {
    const tenant = await newTenant();
    const before = Date.now();
    const body = await newBreach(tenant, { awareAt: undefined, affectedDataPrincipalIds: undefined, affectedCount: 1200 });
    const awareAt = new Date(body['awareAt'] as string).getTime();
    expect(awareAt).toBeGreaterThanOrEqual(before - 1000);
    expect(body['affectedCount']).toBe(1200);
    expect(body['principalIntimation']).toMatchObject({ intimatedCount: 0, pendingCount: null });
  });

  it('answers 400 for malformed input', async () => {
    const tenant = await newTenant();
    const future = new Date(Date.now() + 2 * HOUR).toISOString();
    for (const payload of [
      breachBody({ description: undefined }),
      breachBody({ nature: '' }),
      breachBody({ extent: 7 }),
      breachBody({ awareAt: 'yesterday' }),
      breachBody({ awareAt: future }),
      breachBody({ occurredAt: new Date().toISOString(), awareAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
      breachBody({ affectedDataPrincipalIds: undefined, affectedCount: undefined }),
      breachBody({ affectedDataPrincipalIds: 'user_brch_1' }),
      breachBody({ affectedDataPrincipalIds: [''] }),
      breachBody({ affectedCount: -1 }),
      breachBody({ affectedCount: 1.5 }),
      breachBody({ affectedCount: 2 }),
    ]) {
      const res = await call(tenant, 'POST', '/v1/dpdp/breaches', payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 160)).toBe(400);
      expect(res.json()['code']).toBe('BAD_REQUEST');
    }
    expect((await call(tenant, 'POST', '/v1/dpdp/breaches', ['x'])).statusCode).toBe(400);
    expect(await sql`SELECT id FROM dpdp_breaches WHERE developer_id = ${tenant.id}`).toHaveLength(0);
  });

  it('reports the Board deadline as overdue once 72 hours have passed without a detailed report', async () => {
    const tenant = await newTenant();
    const body = await newBreach(tenant, {
      occurredAt: new Date(Date.now() - 100 * HOUR).toISOString(),
      awareAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    });
    expect(body['boardDetailedReportOverdue']).toBe(true);
  });
});

describePostgres('reading breaches', () => {
  it('lists newest first with a status filter and pagination, and keeps tenants apart', async () => {
    const tenant = await newTenant();
    const first = await newBreach(tenant);
    const second = await newBreach(tenant);
    const third = await newBreach(tenant);
    const moved = await call(tenant, 'PATCH', `/v1/dpdp/breaches/${first['breachId'] as string}`, { status: 'initial_intimated' });
    expect(moved.statusCode, moved.body).toBe(200);

    const page1 = await call(tenant, 'GET', '/v1/dpdp/breaches?limit=2');
    expect(page1.statusCode, page1.body).toBe(200);
    expect(page1.json()['breaches'].map((b: Record<string, unknown>) => b['breachId']))
      .toEqual([third['breachId'], second['breachId']]);
    // The list does not carry the principal ids.
    expect(page1.json()['breaches'][0]['affectedDataPrincipalIds']).toBeUndefined();
    const page2 = await call(tenant, 'GET', `/v1/dpdp/breaches?limit=2&cursor=${encodeURIComponent(page1.json()['nextCursor'] as string)}`);
    expect(page2.json()['breaches'].map((b: Record<string, unknown>) => b['breachId'])).toEqual([first['breachId']]);
    expect(page2.json()['nextCursor']).toBeNull();

    const open = await call(tenant, 'GET', '/v1/dpdp/breaches?status=open');
    expect(open.json()['breaches']).toHaveLength(2);
    const intimated = await call(tenant, 'GET', '/v1/dpdp/breaches?status=initial_intimated');
    expect(intimated.json()['breaches'].map((b: Record<string, unknown>) => b['breachId'])).toEqual([first['breachId']]);
    expect((await call(tenant, 'GET', '/v1/dpdp/breaches?status=bogus')).statusCode).toBe(400);

    const one = await call(tenant, 'GET', `/v1/dpdp/breaches/${second['breachId'] as string}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()['affectedDataPrincipalIds']).toEqual(['user_brch_1', 'user_brch_2', 'user_brch_3']);

    const stranger = await newTenant();
    expect((await call(stranger, 'GET', `/v1/dpdp/breaches/${second['breachId'] as string}`)).statusCode).toBe(404);
    expect((await call(stranger, 'GET', '/v1/dpdp/breaches')).json()['breaches']).toHaveLength(0);
    expect((await call(stranger, 'PATCH', `/v1/dpdp/breaches/${second['breachId'] as string}`, { status: 'initial_intimated' })).statusCode).toBe(404);
  });
});

describePostgres('updating a breach', () => {
  it('walks open -> initial_intimated -> reported -> closed and refuses other moves with 409', async () => {
    const tenant = await newTenant();
    const breach = await newBreach(tenant);
    const url = `/v1/dpdp/breaches/${breach['breachId'] as string}`;

    const skip = await call(tenant, 'PATCH', url, { status: 'reported' });
    expect(skip.statusCode).toBe(409);
    expect(skip.json()['code']).toBe('INVALID_TRANSITION');

    const initial = await call(tenant, 'PATCH', url, { status: 'initial_intimated' });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()['status']).toBe('initial_intimated');
    expect(initial.json()['boardInitialIntimationSentAt']).toEqual(expect.any(String));
    expect((await call(tenant, 'PATCH', url, { status: 'initial_intimated' })).statusCode).toBe(409);

    // The detailed report must be complete before the breach is reported.
    const incomplete = await call(tenant, 'PATCH', url, { status: 'reported', detailedReport: { updatedDetails: 'x' } });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()['code']).toBe('REPORT_INCOMPLETE');
    expect((await sql`SELECT status, report_updated_details FROM dpdp_breaches WHERE id = ${breach['breachId'] as string}`)[0])
      .toMatchObject({ status: 'initial_intimated', report_updated_details: null });

    const report = await call(tenant, 'PATCH', url, { detailedReport: fullReport });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json()['detailedReport']).toEqual(fullReport);
    const reported = await call(tenant, 'PATCH', url, { status: 'reported' });
    expect(reported.statusCode, reported.body).toBe(200);
    expect(reported.json()).toMatchObject({ status: 'reported', boardDetailedReportOverdue: false });
    expect(reported.json()['boardDetailedReportSentAt']).toEqual(expect.any(String));

    const closed = await call(tenant, 'PATCH', url, { status: 'closed' });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()['closedAt']).toEqual(expect.any(String));
    const after = await call(tenant, 'PATCH', url, { detailedReport: { remedialMeasures: 'more' } });
    expect(after.statusCode).toBe(409);
    expect(after.json()['code']).toBe('BREACH_CLOSED');
    expect((await call(tenant, 'PATCH', url, { status: 'open' })).statusCode).toBe(400);

    const actions = await auditActions(tenant);
    expect(actions.filter((a) => a === 'grantex.dpdp.breach_updated')).toHaveLength(4);
    expect(await chainValid(tenant)).toBe(true);
  });

  it('moves the deadline with a granted extension only', async () => {
    const tenant = await newTenant();
    const awareAt = new Date(Date.now() - 70 * HOUR);
    const breach = await newBreach(tenant, {
      occurredAt: new Date(Date.now() - 71 * HOUR).toISOString(), awareAt: awareAt.toISOString(),
    });
    const url = `/v1/dpdp/breaches/${breach['breachId'] as string}`;
    const newDueAt = new Date(awareAt.getTime() + 120 * HOUR).toISOString();

    const requested = await call(tenant, 'PATCH', url, { extension: { requestedAt: new Date().toISOString() } });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json()['boardDetailedReportDueAt']).toBe(new Date(awareAt.getTime() + 72 * HOUR).toISOString());
    expect(requested.json()['extension']).toMatchObject({ granted: null });

    const granted = await call(tenant, 'PATCH', url, { extension: { granted: true, newDueAt } });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(granted.json()['boardDetailedReportDueAt']).toBe(newDueAt);
    expect(granted.json()['extension']).toMatchObject({ granted: true, newDueAt });

    for (const extension of [
      { granted: true },
      { granted: true, newDueAt: new Date(awareAt.getTime() - HOUR).toISOString() },
      { granted: 'yes' },
    ]) {
      const res = await call(tenant, 'PATCH', url, { extension });
      expect(res.statusCode, JSON.stringify(extension)).toBe(400);
    }
    for (const payload of [
      {},
      { boardInitialIntimationSentAt: new Date(Date.now() + 2 * HOUR).toISOString() },
      { boardInitialIntimationSentAt: new Date(awareAt.getTime() - HOUR).toISOString() },
      { detailedReport: 'text' },
    ]) {
      const res = await call(tenant, 'PATCH', url, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describePostgres('principal intimations', () => {
  it('records who was told, how and what was included, and what is still pending', async () => {
    const tenant = await newTenant();
    const breach = await newBreach(tenant);
    const url = `/v1/dpdp/breaches/${breach['breachId'] as string}/principal-intimations`;

    const res = await call(tenant, 'POST', url, {
      dataPrincipalIds: ['user_brch_1', 'user_brch_2'], channel: 'email',
      contentIncluded: ['description', 'likely_consequences', 'mitigation', 'safety_measures'],
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['intimationId']).toMatch(/^bint_/);
    expect(body).toMatchObject({ channel: 'email', principalCount: 2, contentMissing: ['contact'] });
    expect(body['principalIntimation']).toMatchObject({ intimatedCount: 2, pendingCount: 1 });

    const again = await call(tenant, 'POST', url, {
      dataPrincipalIds: ['user_brch_2', 'user_brch_3'], channel: 'sms',
      contentIncluded: ['description', 'likely_consequences', 'mitigation', 'safety_measures', 'contact'],
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()['contentMissing']).toEqual([]);
    expect(again.json()['principalIntimation']).toMatchObject({ intimatedCount: 3, pendingCount: 0 });

    const detail = await call(tenant, 'GET', `/v1/dpdp/breaches/${breach['breachId'] as string}`);
    expect(detail.json()['principalIntimations']).toHaveLength(2);

    for (const payload of [
      { dataPrincipalIds: ['user_brch_9'], channel: 'email', contentIncluded: ['description'] },
      { dataPrincipalIds: [], channel: 'email', contentIncluded: ['description'] },
      { dataPrincipalIds: ['user_brch_1'], contentIncluded: ['description'] },
      { dataPrincipalIds: ['user_brch_1'], channel: 'email', contentIncluded: ['gossip'] },
      { dataPrincipalIds: ['user_brch_1'], channel: 'email', contentIncluded: [] },
      { dataPrincipalIds: ['user_brch_1'], channel: 'email', contentIncluded: ['description'], intimatedAt: new Date(Date.now() + 2 * HOUR).toISOString() },
    ]) {
      const bad = await call(tenant, 'POST', url, payload);
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const stranger = await newTenant();
    expect((await call(stranger, 'POST', url, {
      dataPrincipalIds: ['user_brch_1'], channel: 'email', contentIncluded: ['description'],
    })).statusCode).toBe(404);
    expect((await auditActions(tenant)).filter((a) => a === 'grantex.dpdp.breach_principals_intimated')).toHaveLength(2);
    expect(await chainValid(tenant)).toBe(true);
  });

  it('accepts any principal when the breach recorded only a count', async () => {
    const tenant = await newTenant();
    const breach = await newBreach(tenant, { affectedDataPrincipalIds: undefined, affectedCount: 10 });
    const res = await call(tenant, 'POST', `/v1/dpdp/breaches/${breach['breachId'] as string}/principal-intimations`, {
      dataPrincipalIds: ['user_brch_any'], channel: 'in_app', contentIncluded: ['description'],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()['principalIntimation']).toMatchObject({ intimatedCount: 1, pendingCount: null });
  });
});

describePostgres('the breach deadline alert worker', () => {
  it('does not start unless DPDP_BREACH_DEADLINE_ALERTS_ENABLED is exactly true', () => {
    expect(startDpdpBreachDeadlineWorker(sql, quiet)).toBe(false);
    vi.stubEnv('DPDP_BREACH_DEADLINE_ALERTS_ENABLED', '1');
    expect(startDpdpBreachDeadlineWorker(sql, quiet)).toBe(false);
    vi.stubEnv('DPDP_BREACH_DEADLINE_ALERTS_ENABLED', 'true');
    expect(startDpdpBreachDeadlineWorker(sql, quiet)).toBe(true);
    expect(startDpdpBreachDeadlineWorker(sql, quiet)).toBe(false);
  });

  it('alerts once when the deadline is within the lead time and once when it has passed', async () => {
    const tenant = await newTenant();
    // Due in two hours: inside a three-hour lead time.
    const approaching = await newBreach(tenant, {
      occurredAt: new Date(Date.now() - 71 * HOUR).toISOString(), awareAt: new Date(Date.now() - 70 * HOUR).toISOString(),
    });
    const overdue = await newBreach(tenant, {
      occurredAt: new Date(Date.now() - 81 * HOUR).toISOString(), awareAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    });
    const distant = await newBreach(tenant);
    const reported = await newBreach(tenant, {
      occurredAt: new Date(Date.now() - 81 * HOUR).toISOString(), awareAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    });
    await sql`UPDATE dpdp_breaches SET board_detailed_report_sent_at = NOW() WHERE id = ${reported['breachId'] as string}`;

    const first = await runBreachDeadlineAlertsOnce(sql, quiet, { leadMinutes: 180 });
    expect(first.alerted).toBeGreaterThanOrEqual(2);
    const alerts = events(tenant, 'dpdp.breach.board_report_due');
    const byBreach = new Map(alerts.map((a) => [a['breachId'], a]));
    expect(byBreach.get(approaching['breachId'])).toMatchObject({ stage: 'approaching', overdue: false });
    expect(byBreach.get(overdue['breachId'])).toMatchObject({ stage: 'overdue', overdue: true });
    expect(byBreach.has(distant['breachId'])).toBe(false);
    expect(byBreach.has(reported['breachId'])).toBe(false);

    await runBreachDeadlineAlertsOnce(sql, quiet, { leadMinutes: 180 });
    expect(events(tenant, 'dpdp.breach.board_report_due')).toHaveLength(2);

    // Once the approaching one is overdue it alerts again, as overdue.
    await sql`UPDATE dpdp_breaches SET aware_at = NOW() - INTERVAL '80 hours', occurred_at = NOW() - INTERVAL '81 hours',
                                       board_report_due_at = NOW() - INTERVAL '8 hours'
              WHERE id = ${approaching['breachId'] as string}`;
    await runBreachDeadlineAlertsOnce(sql, quiet, { leadMinutes: 180 });
    const later = events(tenant, 'dpdp.breach.board_report_due').filter((a) => a['breachId'] === approaching['breachId']);
    expect(later.map((a) => a['stage'])).toEqual(['approaching', 'overdue']);
    expect((await auditActions(tenant)).filter((a) => a === 'grantex.dpdp.breach_deadline_alerted')).toHaveLength(3);
    expect(await chainValid(tenant)).toBe(true);
  });
});
