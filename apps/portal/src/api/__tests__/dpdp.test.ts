import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fx from './fixtures/dpdpServer';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE = 'http://localhost:3000';

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
/** Error bodies exactly as the DPDP routes send them: {message, code, requestId}. */
function fail(status: number, body: { message: string; code: string; requestId: string }) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve(body),
  });
}
function call(i = 0): { url: string; method: string; body: unknown } {
  const [url, opts] = mockFetch.mock.calls[i]!;
  const init = opts as RequestInit;
  return {
    url: url as string,
    method: init.method as string,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

import { ApiError } from '../client';
import {
  createConsentRecord,
  getConsentRecord,
  listConsentRecords,
  withdrawConsent,
  getDataPrincipalRecords,
  requestErasure,
  getErasureRequest,
  createConsentNotice,
  listConsentNotices,
  getConsentNotice,
  fileGrievance,
  listGrievances,
  getGrievance,
  updateGrievance,
  createExport,
  getExport,
} from '../dpdp';

describe('dpdp api (server response shapes)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── errors ──────────────────────────────────────────────────────────────

  it('preserves status, code and requestId from the error body', async () => {
    fail(409, fx.errors['409_ALREADY_WITHDRAWN']);
    const e = await withdrawConsent('crec_1', { reason: 'x', revokeGrant: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      status: 409,
      code: 'ALREADY_WITHDRAWN',
      requestId: 'req-7f40',
      message: 'Consent already withdrawn',
    });
  });

  // ── consent records ─────────────────────────────────────────────────────

  it('createConsentRecord POSTs the request and returns the 201 body', async () => {
    const data = {
      grantId: 'grnt_1',
      dataPrincipalId: 'user_123',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      consentNoticeId: 'privacy-notice',
      consentNoticeVersion: '2.0',
      processingExpiresAt: '2027-09-30T00:00:00.000Z',
    };
    ok(fx.createConsentRecord_201, 201);
    const result = await createConsentRecord(data);
    expect(result).toEqual(fx.createConsentRecord_201);
    expect(result.consentProof.proofJwt).toBeTruthy();
    expect(result.consentProof.keyPersistence).toBe('persistent');
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/consent-records`, method: 'POST', body: data });
  });

  it('createConsentRecord surfaces 503 CONSENT_PROOF_UNAVAILABLE', async () => {
    fail(503, fx.errors['503_CONSENT_PROOF_UNAVAILABLE']);
    await expect(createConsentRecord({} as never)).rejects.toMatchObject({ status: 503, code: 'CONSENT_PROOF_UNAVAILABLE' });
  });

  it('createConsentRecord surfaces 503 CONSENT_PROOF_KEY_NOT_PERSISTENT', async () => {
    fail(503, fx.errors['503_CONSENT_PROOF_KEY_NOT_PERSISTENT']);
    await expect(createConsentRecord({} as never)).rejects.toMatchObject({
      status: 503, code: 'CONSENT_PROOF_KEY_NOT_PERSISTENT', requestId: 'req-7f47',
    });
  });

  it('getConsentRecord GETs /v1/dpdp/consent-records/:id (encoded)', async () => {
    ok(fx.consentRecord_200);
    const result = await getConsentRecord('crec/1 ?');
    expect(result).toEqual(fx.consentRecord_200);
    expect(result.purposes[0]).toEqual({ code: 'analytics', description: 'Usage analytics for service improvement' });
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/consent-records/crec%2F1%20%3F`, method: 'GET', body: undefined });
  });

  it('getConsentRecord rejects with 404 NOT_FOUND', async () => {
    fail(404, fx.errors['404_NOT_FOUND']);
    await expect(getConsentRecord('missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('listConsentRecords GETs with dataPrincipalId, limit and cursor query', async () => {
    ok(fx.listConsentRecords_200);
    const result = await listConsentRecords({ dataPrincipalId: 'user 1&x', limit: 25, cursor: 'c/1=' });
    expect(result.totalRecords).toBe(7);
    expect(result.nextCursor).toBe(fx.listConsentRecords_200.nextCursor);
    expect(result.records[1]!.status).toBe('erased');
    expect(result.records[1]!.consentNoticeVersion).toBeNull();
    const { url, method } = call();
    expect(method).toBe('GET');
    const u = new URL(url);
    expect(u.pathname).toBe('/v1/dpdp/consent-records');
    expect(u.searchParams.get('dataPrincipalId')).toBe('user 1&x');
    expect(u.searchParams.get('limit')).toBe('25');
    expect(u.searchParams.get('cursor')).toBe('c/1=');
  });

  it('listConsentRecords without params sends no query string', async () => {
    ok(fx.listConsentRecords_200);
    await listConsentRecords();
    expect(call().url).toBe(`${BASE}/v1/dpdp/consent-records`);
  });

  it('withdrawConsent POSTs {reason, revokeGrant, deleteProcessedData}', async () => {
    const data = { reason: 'No longer needed', revokeGrant: true, deleteProcessedData: true };
    ok(fx.withdrawConsent_200);
    const result = await withdrawConsent('crec_1', data);
    expect(result).toEqual(fx.withdrawConsent_200);
    expect(result.dataDeletionRequested).toBe(true);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/consent-records/crec_1/withdraw`, method: 'POST', body: data });
  });

  it('withdrawConsent encodes recordId', async () => {
    ok(fx.withdrawConsent_200);
    await withdrawConsent('cr/1', { reason: 'test', revokeGrant: false });
    expect(call().url).toBe(`${BASE}/v1/dpdp/consent-records/cr%2F1/withdraw`);
  });

  it.each([
    ['409_ALREADY_WITHDRAWN', 'ALREADY_WITHDRAWN'],
    ['409_CONSENT_ERASED', 'CONSENT_ERASED'],
    ['409_CONSENT_EXPIRED', 'CONSENT_EXPIRED'],
  ] as const)('withdrawConsent rejects with %s', async (key, code) => {
    fail(409, fx.errors[key]);
    await expect(withdrawConsent('crec_1', { reason: 'x', revokeGrant: true })).rejects.toMatchObject({ status: 409, code });
  });

  it('getDataPrincipalRecords GETs principal records (encoded) with pagination', async () => {
    ok(fx.principalRecords_200);
    const result = await getDataPrincipalRecords('dp/1', { limit: 10, cursor: 'abc' });
    expect(result).toEqual(fx.principalRecords_200);
    expect(result.nextCursor).toBeNull();
    expect(call().url).toBe(`${BASE}/v1/dpdp/data-principals/dp%2F1/records?limit=10&cursor=abc`);
  });

  it('getDataPrincipalRecords tolerates records without per-record dataPrincipalId', async () => {
    const { dataPrincipalId: _omit, ...legacyRecord } = fx.consentRecord_200;
    void _omit;
    ok({ ...fx.principalRecords_200, records: [legacyRecord] });
    const result = await getDataPrincipalRecords('user_123');
    expect(result.records[0]!.dataPrincipalId).toBeUndefined();
    expect(result.dataPrincipalId).toBe('user_123');
  });

  // ── erasure ─────────────────────────────────────────────────────────────

  it('requestErasure POSTs with no body to the encoded principal path', async () => {
    ok(fx.erasure_201, 201);
    const result = await requestErasure('user/1');
    expect(result).toEqual(fx.erasure_201);
    expect(result.retained.map((r) => r.category)).toEqual(['consent_records', 'audit_log', 'grievances', 'stored_exports', 'fiduciary_data']);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/dpdp/data-principals/user%2F1/erasure`);
    expect((opts as RequestInit).method).toBe('POST');
    expect((opts as RequestInit).body).toBeUndefined();
  });

  it('requestErasure rejects with 404 when the principal has no records', async () => {
    fail(404, { message: 'No consent records for this data principal', code: 'NOT_FOUND', requestId: 'req-1' });
    await expect(requestErasure('nobody')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('getErasureRequest GETs /v1/dpdp/erasure-requests/:id (encoded)', async () => {
    ok(fx.erasure_201);
    const result = await getErasureRequest('ER-2026/1');
    expect(result.requestId).toBe(fx.erasure_201.requestId);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/erasure-requests/ER-2026%2F1`, method: 'GET', body: undefined });
  });

  // ── consent notices ─────────────────────────────────────────────────────

  it('createConsentNotice POSTs /v1/dpdp/consent-notices and returns the 201 body', async () => {
    const data = {
      noticeId: 'privacy-notice',
      version: '2.0',
      title: 'Data Processing Consent Notice',
      content: 'We collect data...',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@acme.example', phone: '+91-00000-00000' },
    };
    ok(fx.createConsentNotice_201, 201);
    const result = await createConsentNotice(data);
    expect(result).toEqual(fx.createConsentNotice_201);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/consent-notices`, method: 'POST', body: data });
  });

  it('createConsentNotice rejects with 409 CONFLICT', async () => {
    fail(409, fx.errors['409_CONFLICT']);
    await expect(createConsentNotice({} as never)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('listConsentNotices GETs with pagination', async () => {
    ok(fx.listConsentNotices_200);
    const result = await listConsentNotices({ limit: 200 });
    expect(result).toEqual(fx.listConsentNotices_200);
    expect(call().url).toBe(`${BASE}/v1/dpdp/consent-notices?limit=200`);
  });

  it('getConsentNotice GETs every version of an encoded notice id', async () => {
    ok(fx.getConsentNotice_200);
    const result = await getConsentNotice('privacy/notice');
    expect(result.versions).toHaveLength(2);
    expect(result.versions[1]!.grievanceOfficer).toBeNull();
    expect(call().url).toBe(`${BASE}/v1/dpdp/consent-notices/privacy%2Fnotice`);
  });

  // ── grievances ──────────────────────────────────────────────────────────

  it('fileGrievance POSTs with optional recordId and responsePeriodDays', async () => {
    const data = { dataPrincipalId: 'user_123', type: 'unauthorized-processing', description: 'Data used without consent', responsePeriodDays: 7 };
    ok(fx.fileGrievance_202, 202);
    const result = await fileGrievance(data);
    expect(result).toEqual(fx.fileGrievance_202);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/grievances`, method: 'POST', body: data });
  });

  it('listGrievances GETs with status, dataPrincipalId, limit and cursor', async () => {
    ok(fx.listGrievances_200);
    const result = await listGrievances({ status: 'in_review', dataPrincipalId: 'user_123', limit: 50, cursor: 'n1' });
    expect(result).toEqual(fx.listGrievances_200);
    const u = new URL(call().url);
    expect(u.pathname).toBe('/v1/dpdp/grievances');
    expect(Object.fromEntries(u.searchParams)).toEqual({ status: 'in_review', dataPrincipalId: 'user_123', limit: '50', cursor: 'n1' });
  });

  it('getGrievance GETs /v1/dpdp/grievances/:id (encoded)', async () => {
    ok(fx.getGrievance_200);
    const result = await getGrievance('grv/1');
    expect(result).toEqual(fx.getGrievance_200);
    expect(call().url).toBe(`${BASE}/v1/dpdp/grievances/grv%2F1`);
  });

  it('updateGrievance PATCHes {status, resolution}', async () => {
    ok(fx.updateGrievance_200);
    const body = { status: 'resolved' as const, resolution: 'Marketing processing stopped and the data principal informed' };
    const result = await updateGrievance('grv/1', body);
    expect(result).toEqual(fx.updateGrievance_200);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/grievances/grv%2F1`, method: 'PATCH', body });
  });

  it('updateGrievance rejects with 409 INVALID_TRANSITION', async () => {
    fail(409, fx.errors['409_INVALID_TRANSITION']);
    await expect(updateGrievance('grv_1', { status: 'in_review' })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  // ── exports ─────────────────────────────────────────────────────────────

  it('createExport POSTs /v1/dpdp/exports and returns the 201 body (no status)', async () => {
    const data = {
      type: 'dpdp-audit' as const,
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
    };
    ok(fx.createExport_201, 201);
    const result = await createExport(data);
    expect(result).toEqual(fx.createExport_201);
    expect(result.truncated).toBe(false);
    expect(result.auditLogLimit).toBe(1000);
    expect(call()).toEqual({ url: `${BASE}/v1/dpdp/exports`, method: 'POST', body: data });
  });

  it('getExport GETs /v1/dpdp/exports/:id (encoded)', async () => {
    ok(fx.getExport_200);
    const result = await getExport('exp/1');
    expect(result).toEqual(fx.getExport_200);
    expect(result.status).toBe('complete');
    expect(call().url).toBe(`${BASE}/v1/dpdp/exports/exp%2F1`);
  });

  it('getExport rejects with 410 GONE once expired', async () => {
    fail(410, fx.errors['410_GONE']);
    await expect(getExport('exp_1')).rejects.toMatchObject({ status: 410, code: 'GONE' });
  });
});
