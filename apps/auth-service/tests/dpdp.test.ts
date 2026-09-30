/**
 * The DPDP routes with the SQL mock: input validation, which answers before
 * any database work, and the refusals that follow from a single lookup.
 * Everything that depends on what the database does (transactions, the
 * grant cascade, the audit chain, concurrency, erasure, pagination) is in
 * dpdp-postgres.integration.test.ts against real Postgres.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initEdKey } from '../src/lib/crypto.js';
import { newErasureRequestId } from '../src/lib/ids.js';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_GRANT } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  await initEdKey();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString();

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    grantId: TEST_GRANT.id,
    dataPrincipalId: 'user_123',
    purposes: [{ code: 'analytics', description: 'Usage analytics' }],
    consentNoticeId: 'data-processing-v1',
    processingExpiresAt: inAYear(),
    ...overrides,
  };
}

function activeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_GRANT.id,
    scopes: ['read'],
    principal_id: 'user_123',
    status: 'active',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

async function post(url: string, payload?: unknown) {
  seedAuth();
  return app.inject({
    method: 'POST', url, headers: authHeader(),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function get(url: string) {
  seedAuth();
  return app.inject({ method: 'GET', url, headers: authHeader() });
}

// ── Consent notices ─────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-notices', () => {
  const notice = {
    noticeId: 'data-processing-v1',
    version: '1.0.0',
    title: 'Data Processing Notice',
    content: 'We process your data for the following purposes...',
    purposes: [{ code: 'analytics', description: 'Usage analytics' }],
  };

  it('creates a consent notice', async () => {
    const res = await post('/v1/dpdp/consent-notices', notice);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.noticeId).toBe('data-processing-v1');
    expect(body.version).toBe('1.0.0');
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.id).toMatch(/^notice_/);
  });

  it('returns 400 for missing fields or malformed purposes', async () => {
    for (const payload of [
      { noticeId: 'test' },
      { ...notice, purposes: [] },
      { ...notice, purposes: [{ code: 'analytics' }] },
      { ...notice, grievanceOfficer: 'someone' },
      { ...notice, title: 'x'.repeat(1001) },
    ]) {
      const res = await post('/v1/dpdp/consent-notices', payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
  });

  it('returns 409 for a duplicate notice version (unique violation)', async () => {
    seedAuth();
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-notices', headers: authHeader(), payload: notice });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });

  it('does not report other database failures as a conflict', async () => {
    seedAuth();
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));

    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-notices', headers: authHeader(), payload: notice });

    expect(res.statusCode).toBe(500);
  });
});

// ── Consent records ─────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-records', () => {
  it('creates a consent record with a JWS-EdDSA proof and the notice version', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([activeGrant()]);
    sqlMock.mockResolvedValueOnce([{ id: 'notice_TEST', version: '1.0.0', content_hash: 'abc123hash' }]);

    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(), payload: validRecord() });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.recordId).toMatch(/^crec_/);
    expect(body.consentNoticeHash).toBe('abc123hash');
    expect(body.consentNoticeVersion).toBe('1.0.0');
    expect(body.status).toBe('active');
    expect(body.consentProof).toMatchObject({ type: 'JWS-EdDSA', alg: 'EdDSA', kid: expect.any(String) });
  });

  it('returns 400, not 500, for malformed input', async () => {
    for (const payload of [
      { grantId: 'grnt_TEST' },
      validRecord({ purposes: 'analytics' }),
      validRecord({ purposes: [] }),
      validRecord({ purposes: [{ code: 1, description: 'x' }] }),
      validRecord({ purposes: ['analytics'] }),
      validRecord({ processingExpiresAt: 'next year' }),
      validRecord({ processingExpiresAt: '2027-02-30T00:00:00Z-ish' }),
      validRecord({ processingExpiresAt: new Date(Date.now() - 1000).toISOString() }),
      validRecord({ dataPrincipalId: 'x'.repeat(257) }),
      validRecord({ consentNoticeVersion: 7 }),
    ]) {
      const res = await post('/v1/dpdp/consent-records', payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 120)).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
    const array = await post('/v1/dpdp/consent-records', [validRecord()]);
    expect(array.statusCode).toBe(400);
  });

  it('returns 400 INVALID_GRANT for an unknown, revoked or expired grant', async () => {
    for (const grant of [
      null,
      activeGrant({ status: 'revoked' }),
      activeGrant({ status: 'suspended' }),
      activeGrant({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]) {
      seedAuth();
      sqlMock.mockResolvedValueOnce(grant ? [grant] : []);
      const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(), payload: validRecord() });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_GRANT');
    }
  });

  it('returns 400 PRINCIPAL_MISMATCH only under DPDP_ENFORCE_GRANT_PRINCIPAL=true', async () => {
    vi.stubEnv('DPDP_ENFORCE_GRANT_PRINCIPAL', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([activeGrant({ principal_id: 'user_other' })]);

    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(), payload: validRecord() });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PRINCIPAL_MISMATCH');
  });

  it('returns 400 for an unknown notice or notice version', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([activeGrant()]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(),
      payload: validRecord({ consentNoticeVersion: '9.9' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_NOTICE');
  });
});

// ── Withdrawal ──────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-records/:recordId/withdraw', () => {
  it('returns 400, not 500, for a missing or malformed body', async () => {
    for (const payload of [undefined, ['x'], {}, { reason: '' }, { reason: 'x', revokeGrant: 'yes' }, { reason: 'x', deleteProcessedData: 1 }]) {
      const res = await post('/v1/dpdp/consent-records/crec_TEST/withdraw', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('returns 404 for an unknown record', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // conditional UPDATE matched nothing
    sqlMock.mockResolvedValueOnce([]); // no such record

    const res = await app.inject({
      method: 'POST', url: '/v1/dpdp/consent-records/crec_UNKNOWN/withdraw', headers: authHeader(), payload: { reason: 'x' },
    });

    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['withdrawn', 'ALREADY_WITHDRAWN'],
    ['erased', 'CONSENT_ERASED'],
    ['expired', 'CONSENT_EXPIRED'],
  ])('returns 409 for a %s record', async (status, code) => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/dpdp/consent-records/crec_TEST/withdraw', headers: authHeader(), payload: { reason: 'x' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(code);
  });

  it('never rewrites audit entries, and reports dataDeleted=false with dataDeletionRequested', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ grant_id: TEST_GRANT.id, data_principal_id: 'user_123' }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/dpdp/consent-records/crec_TEST/withdraw', headers: authHeader(),
      payload: { reason: 'Delete my data', deleteProcessedData: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'withdrawn', grantRevoked: false, dataDeleted: false, dataDeletionRequested: true });
    const statements = sqlMock.mock.calls.map((args) => (Array.isArray(args[0]) ? (args[0] as string[]).join('?') : ''));
    expect(statements.some((text) => /UPDATE\s+audit_entries/i.test(text))).toBe(false);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('GET /v1/dpdp/consent-records/:recordId', () => {
  it('returns the stored access count and does not write', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // the column-list fragment, built before the query
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST', grant_id: TEST_GRANT.id, data_principal_id: 'user_123', data_fiduciary_name: 'Test',
      purposes: [], scopes: ['read'], consent_notice_id: 'n', consent_notice_version: '1.0', status: 'active',
      consent_given_at: '2026-01-01T00:00:00Z', processing_expires_at: '2027-01-01T00:00:00Z',
      retention_until: '2027-01-31T00:00:00Z', access_count: 2, last_accessed_at: null,
      withdrawn_at: null, withdrawn_reason: null, erased_at: null, created_at: '2026-01-01T00:00:00Z',
    }]);

    const res = await app.inject({ method: 'GET', url: '/v1/dpdp/consent-records/crec_TEST', headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessCount: 2, lastAccessedAt: null, consentNoticeVersion: '1.0' });
    const statements = sqlMock.mock.calls.map((args) => (Array.isArray(args[0]) ? (args[0] as string[]).join('?') : ''));
    expect(statements.some((text) => /UPDATE\s+dpdp_consent_records/i.test(text))).toBe(false);
  });

  it('returns 404 for an unknown record', async () => {
    const res = await get('/v1/dpdp/consent-records/crec_UNKNOWN');
    expect(res.statusCode).toBe(404);
  });
});

describe('list pagination', () => {
  it.each([
    '/v1/dpdp/consent-records?limit=0',
    '/v1/dpdp/consent-records?limit=201',
    '/v1/dpdp/consent-records?limit=1.5',
    '/v1/dpdp/consent-records?cursor=%%%',
    '/v1/dpdp/data-principals/user_123/records?limit=-1',
    '/v1/dpdp/consent-notices?cursor=eyJ4IjoxfQ',
    '/v1/dpdp/grievances?limit=500',
    '/v1/dpdp/grievances?status=closed',
  ])('refuses %s with 400', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
  });
});

// ── Erasure ─────────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/data-principals/:principalId/erasure', () => {
  it('returns 404 when no consent records are found for the principal', async () => {
    const res = await post('/v1/dpdp/data-principals/user_UNKNOWN/erasure');
    expect(res.statusCode).toBe(404);
  });

  it('issues non-predictable, non-enumerable request ids', () => {
    const ids = Array.from({ length: 5 }, () => newErasureRequestId());
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^ER-\d{4}-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('completes and says what it retained, with expectedCompletionBy equal to completedAt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // principal lock
    sqlMock.mockResolvedValueOnce([{ id: 'crec_1', grant_id: null, status: 'withdrawn' }]);

    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/data-principals/user_456/erasure', headers: authHeader() });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'completed', recordsErased: 1, grantsRevoked: 0 });
    expect(body.expectedCompletionBy).toBe(body.completedAt);
    expect(body.retained.map((item: { category: string }) => item.category))
      .toEqual(['consent_records', 'audit_log', 'grievances', 'fiduciary_data']);
  });
});

// ── Grievances ──────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/grievances', () => {
  const grievance = { dataPrincipalId: 'user_123', type: 'data-erasure', description: 'Please delete my data' };

  it('files a grievance with the default 7-day response period', async () => {
    const res = await post('/v1/dpdp/grievances', grievance);

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.grievanceId).toMatch(/^grv_/);
    // ULID-suffixed, non-enumerable.
    expect(body.referenceNumber).toMatch(/^GRV-\d{4}-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.status).toBe('submitted');
    expect(body.responsePeriodDays).toBe(7);
  });

  it('returns non-predictable, non-enumerable grievance references on successive calls', async () => {
    const refs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await post('/v1/dpdp/grievances', grievance);
      expect(res.statusCode).toBe(202);
      refs.add(res.json().referenceNumber as string);
    }
    expect(refs.size).toBe(5);
  });

  it('returns 400 for missing fields, a bad response period or bad evidence', async () => {
    for (const payload of [
      { dataPrincipalId: 'user_123' },
      { ...grievance, responsePeriodDays: 0 },
      { ...grievance, responsePeriodDays: 91 },
      { ...grievance, responsePeriodDays: 7.5 },
      { ...grievance, evidence: 'text' },
      { ...grievance, evidence: { blob: 'x'.repeat(20_000) } },
    ]) {
      const res = await post('/v1/dpdp/grievances', payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
  });

  it('returns 400 INVALID_RECORD for a record the developer does not have', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST', url: '/v1/dpdp/grievances', headers: authHeader(), payload: { ...grievance, recordId: 'crec_OTHER' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_RECORD');
  });
});

describe('PATCH /v1/dpdp/grievances/:grievanceId', () => {
  it('returns 400 for an unknown status or a final status without a resolution', async () => {
    for (const payload of [{ status: 'submitted' }, { status: 'closed' }, { status: 'resolved' }, { status: 'rejected', resolution: '' }]) {
      seedAuth();
      const res = await app.inject({ method: 'PATCH', url: '/v1/dpdp/grievances/grv_TEST', headers: authHeader(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('returns 409 INVALID_TRANSITION when the grievance is not in the status the move needs', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ status: 'submitted' }]);

    const res = await app.inject({
      method: 'PATCH', url: '/v1/dpdp/grievances/grv_TEST', headers: authHeader(), payload: { status: 'resolved', resolution: 'Done' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');
  });
});

describe('GET /v1/dpdp/grievances/:grievanceId', () => {
  it('returns 404 for an unknown grievance', async () => {
    const res = await get('/v1/dpdp/grievances/grv_UNKNOWN');
    expect(res.statusCode).toBe(404);
  });
});

// ── Exports ─────────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/exports', () => {
  const range = { dateFrom: '2026-01-01T00:00:00Z', dateTo: '2026-12-31T23:59:59Z' };

  it('returns 400 for a bad type, range or format', async () => {
    for (const payload of [
      { type: 'invalid-type', ...range },
      { type: 'dpdp-audit' },
      { type: 'dpdp-audit', dateFrom: 'soon', dateTo: range.dateTo },
      { type: 'dpdp-audit', dateFrom: range.dateTo, dateTo: range.dateFrom },
      { type: 'dpdp-audit', ...range, format: 'csv' },
      { type: 'dpdp-audit', ...range, includeActionLog: 'yes' },
    ]) {
      const res = await post('/v1/dpdp/exports', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
  });

  it('creates an export and says whether the audit log was truncated', async () => {
    const res = await post('/v1/dpdp/exports', { type: 'dpdp-audit', ...range });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ format: 'json', truncated: false, auditLogLimit: 1000 });
  });
});

describe('GET /v1/dpdp/exports/:exportId', () => {
  it('returns 410 GONE for an expired export', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'exp_TEST', type: 'dpdp-audit', status: 'complete', data: { secret: true },
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }]);

    const res = await app.inject({ method: 'GET', url: '/v1/dpdp/exports/exp_TEST', headers: authHeader() });

    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('GONE');
    expect(res.body).not.toContain('secret');
  });

  it('returns 404 for an unknown export', async () => {
    const res = await get('/v1/dpdp/exports/exp_UNKNOWN');
    expect(res.statusCode).toBe(404);
  });
});
