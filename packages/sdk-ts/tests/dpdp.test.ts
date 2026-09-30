import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grantex } from '../src/client.js';
import { GrantexApiError } from '../src/errors.js';

// Response bodies exactly as the auth-service DPDP routes send them.
// Keys starting with "_" are annotations, and "<name>" strings refer to
// another fixture; `fx()` resolves both.
const RAW = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dpdp-server-fixtures.json'), 'utf-8'),
) as Record<string, unknown>;

function resolve(value: unknown): unknown {
  if (typeof value === 'string') {
    const ref = /^<(\w+)>$/.exec(value);
    return ref ? resolve(RAW[ref[1]!]) : value;
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith('_')) out[k] = resolve(v);
    }
    return out;
  }
  return value;
}

function fx(name: string): Record<string, unknown> {
  return resolve(RAW[name]) as Record<string, unknown>;
}

function errFx(name: string): Record<string, unknown> {
  return (RAW['errors'] as Record<string, unknown>)[name] as Record<string, unknown>;
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockImplementation(() => Promise.resolve(response(status, body)));
}

function call(mockFetch: ReturnType<typeof vi.fn>, i = 0): [string, RequestInit] {
  return mockFetch.mock.calls[i] as [string, RequestInit];
}

const TRAVERSAL_ID = 'user@test.com/../x';
const TRAVERSAL_ENC = 'user%40test.com%2F..%2Fx';

describe('DpdpClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // ─── Consent Records ────────────────────────────────────────────────

  it('createConsentRecord() POSTs and returns the proof only create sends', async () => {
    const mockFetch = makeFetch(201, fx('createConsentRecord_201'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createConsentRecord({
      grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
      dataPrincipalId: 'user_123',
      purposes: [{ code: 'analytics', description: 'Usage analytics for service improvement' }],
      consentNoticeId: 'privacy-notice',
      consentNoticeVersion: '2.0',
      processingExpiresAt: '2027-09-30T00:00:00.000Z',
    });

    expect(result.recordId).toBe('crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W');
    expect(result.status).toBe('active');
    expect(result.consentNoticeVersion).toBe('2.0');
    expect(result.consentNoticeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.consentProof).toEqual({
      type: 'JWS-EdDSA',
      alg: 'EdDSA',
      kid: 'ed25519-2026-09',
      proofJwt: expect.any(String),
      jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
      signedAt: '2026-09-30T10:15:00.000Z',
    });
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-records$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.grantId).toBe('grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V');
    expect(body.consentNoticeVersion).toBe('2.0');
    expect(body.purposes).toEqual([{ code: 'analytics', description: 'Usage analytics for service improvement' }]);
  });

  it('getConsentRecord() returns the GET shape (no proof, erasedAt, notice version)', async () => {
    const mockFetch = makeFetch(200, fx('consentRecord_erased_legacy_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getConsentRecord('crec_01J9Z0AAAAAAAAAAAAAAAAAAAA');

    expect(result.status).toBe('erased');
    expect(result.erasedAt).toBe('2026-09-29T12:00:00.000Z');
    expect(result.consentNoticeVersion).toBeNull();
    expect(result.consentProof).toBeUndefined();
    expect(result.consentNoticeHash).toBeUndefined();
    expect(result.purposes?.[0]).toEqual({ code: 'analytics', description: 'Usage analytics for service improvement' });
    const [url] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-records\/crec_01J9Z0AAAAAAAAAAAAAAAAAAAA$/);
  });

  it('listConsentRecords() returns records, totalRecords and nextCursor', async () => {
    const mockFetch = makeFetch(200, fx('listConsentRecords_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listConsentRecords();

    expect(result.records).toHaveLength(2);
    expect(result.totalRecords).toBe(7);
    expect(result.nextCursor).toMatch(/^eyJ/);
    const [url] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-records$/);
  });

  it('listConsentRecords() keeps the principal-id string form', async () => {
    const mockFetch = makeFetch(200, fx('listConsentRecords_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.dpdp.listConsentRecords('user@example.com');

    const [url] = call(mockFetch);
    expect(url).toContain('dataPrincipalId=user%40example.com');
  });

  it('listConsentRecords() sends dataPrincipalId, limit and cursor', async () => {
    const mockFetch = makeFetch(200, fx('listConsentRecords_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.dpdp.listConsentRecords({ dataPrincipalId: 'user_123', limit: 2, cursor: 'eyJ0Ijo+/=' });

    const u = new URL(call(mockFetch)[0]);
    expect(u.pathname).toBe('/v1/dpdp/consent-records');
    expect(u.searchParams.get('dataPrincipalId')).toBe('user_123');
    expect(u.searchParams.get('limit')).toBe('2');
    expect(u.searchParams.get('cursor')).toBe('eyJ0Ijo+/=');
  });

  it('withdrawConsent() sends reason, revokeGrant, deleteProcessedData and decodes the result', async () => {
    const mockFetch = makeFetch(200, fx('withdrawConsent_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.withdrawConsent('crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W', {
      reason: 'No longer needed',
      revokeGrant: false,
      deleteProcessedData: true,
    });

    expect(result.status).toBe('withdrawn');
    expect(result.grantRevoked).toBe(true);
    expect(result.dataDeleted).toBe(false);
    expect(result.dataDeletionRequested).toBe(true);
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-records\/crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W\/withdraw$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'No longer needed',
      revokeGrant: false,
      deleteProcessedData: true,
    });
  });

  // ─── Data Principal Rights ──────────────────────────────────────────

  it('listPrincipalRecords() returns records with totalRecords and nextCursor', async () => {
    const mockFetch = makeFetch(200, fx('principalRecords_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listPrincipalRecords('user@example.com');

    expect(result.dataPrincipalId).toBe('user_123');
    expect(result.records).toHaveLength(1);
    expect(result.totalRecords).toBe(1);
    expect(result.nextCursor).toBeNull();
    const [url] = call(mockFetch);
    expect(url).toContain('/v1/dpdp/data-principals/user%40example.com/records');
  });

  it('listPrincipalRecords() sends limit and cursor', async () => {
    const mockFetch = makeFetch(200, fx('principalRecords_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.dpdp.listPrincipalRecords('user_123', { limit: 10, cursor: 'c1' });

    const u = new URL(call(mockFetch)[0]);
    expect(u.searchParams.get('limit')).toBe('10');
    expect(u.searchParams.get('cursor')).toBe('c1');
  });

  it('listPrincipalRecords() fills a per-record dataPrincipalId an older server omitted', async () => {
    const body = fx('principalRecords_200');
    const records = (body['records'] as Record<string, unknown>[]).map((r) => {
      const copy = { ...r };
      delete copy['dataPrincipalId'];
      return copy;
    });
    const mockFetch = makeFetch(200, { ...body, records });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listPrincipalRecords('user_123');

    expect(result.records[0]!.dataPrincipalId).toBe('user_123');
  });

  it('requestErasure() POSTs no body and returns the full erasure result', async () => {
    const mockFetch = makeFetch(201, fx('erasure_201'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.requestErasure('user@example.com');

    expect(result.requestId).toBe('ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R');
    expect(result.status).toBe('completed');
    expect(result.recordsErased).toBe(2);
    expect(result.grantsRevoked).toBe(1);
    expect(result.delegatedGrantsRevoked).toBe(0);
    expect(result.grievancesRedacted).toBe(1);
    expect(result.exportsDeleted).toBe(0);
    expect(result.completedAt).toBe('2026-09-30T14:00:00.120Z');
    expect(result.retained).toHaveLength(4);
    expect(result.retained[0]).toMatchObject({ category: 'consent_records', count: 2 });
    expect(result.retained[1]!.count).toBeUndefined();
    const [url, init] = call(mockFetch);
    expect(url).toContain('/v1/dpdp/data-principals/user%40example.com/erasure');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('getErasureRequest() GETs /v1/dpdp/erasure-requests/:id', async () => {
    const mockFetch = makeFetch(200, fx('erasure_201'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getErasureRequest('ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R');

    expect(result.recordsErased).toBe(2);
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/erasure-requests\/ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R$/);
    expect(init.method).toBe('GET');
  });

  // ─── Consent Notices ────────────────────────────────────────────────

  it('createConsentNotice() POSTs noticeId and returns the 201 shape', async () => {
    const mockFetch = makeFetch(201, fx('createConsentNotice_201'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createConsentNotice({
      noticeId: 'privacy-notice',
      version: '2.0',
      title: 'Data Processing Consent Notice',
      content: 'We collect and process your data for the following purposes...',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@acme.example', phone: '+91-00000-00000' },
    });

    expect(result).toEqual(fx('createConsentNotice_201'));
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-notices$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.noticeId).toBe('privacy-notice');
    expect(body.grievanceOfficer.phone).toBe('+91-00000-00000');
  });

  it('listConsentNotices() GETs with limit and cursor', async () => {
    const mockFetch = makeFetch(200, fx('listConsentNotices_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listConsentNotices({ limit: 5, cursor: 'c2' });

    expect(result.notices[0]!.title).toBe('Data Processing Consent Notice');
    expect(result.nextCursor).toBeNull();
    const u = new URL(call(mockFetch)[0]);
    expect(u.pathname).toBe('/v1/dpdp/consent-notices');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('cursor')).toBe('c2');
  });

  it('getConsentNotice() returns every version, newest first', async () => {
    const mockFetch = makeFetch(200, fx('getConsentNotice_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getConsentNotice('privacy-notice');

    expect(result.noticeId).toBe('privacy-notice');
    expect(result.versions.map((v) => v.version)).toEqual(['2.0', '1.0']);
    expect(result.versions[0]!.grievanceOfficer?.phone).toBe('+91-00000-00000');
    expect(result.versions[1]!.grievanceOfficer).toBeNull();
    const [url] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/consent-notices\/privacy-notice$/);
  });

  // ─── Grievances ─────────────────────────────────────────────────────

  it('fileGrievance() POSTs optional recordId, evidence, responsePeriodDays', async () => {
    const mockFetch = makeFetch(202, fx('fileGrievance_202'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.fileGrievance({
      dataPrincipalId: 'user_123',
      type: 'unauthorized-processing',
      description: 'My data was used for marketing without consent',
      recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
      evidence: { screenshots: ['https://files.example.com/s1.png'] },
      responsePeriodDays: 30,
    });

    expect(result.grievanceId).toBe('grv_01J9ZC5D6E7F8G9H0J1K2M3N4P');
    expect(result.referenceNumber).toBe('GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q');
    expect(result.status).toBe('submitted');
    expect(result.responsePeriodDays).toBe(7);
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/grievances$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.recordId).toBe('crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W');
    expect(body.responsePeriodDays).toBe(30);
    expect(body.evidence).toEqual({ screenshots: ['https://files.example.com/s1.png'] });
  });

  it('getGrievance() returns the detail shape', async () => {
    const mockFetch = makeFetch(200, fx('getGrievance_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getGrievance('grv_01J9ZC5D6E7F8G9H0J1K2M3N4P');

    expect(result.status).toBe('in_review');
    expect(result.updatedAt).toBe('2026-10-01T08:00:00.000Z');
    expect(result.description).toBe('My data was used for marketing without consent');
    const [url] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/grievances\/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P$/);
  });

  it('listGrievances() sends status, dataPrincipalId, limit and cursor', async () => {
    const mockFetch = makeFetch(200, fx('listGrievances_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listGrievances({
      status: 'submitted', dataPrincipalId: 'user_123', limit: 20, cursor: 'c3',
    });

    expect(result.grievances).toHaveLength(1);
    expect(result.grievances[0]!.description).toBeUndefined();
    expect(result.nextCursor).toBeNull();
    const u = new URL(call(mockFetch)[0]);
    expect(u.pathname).toBe('/v1/dpdp/grievances');
    expect(u.searchParams.get('status')).toBe('submitted');
    expect(u.searchParams.get('dataPrincipalId')).toBe('user_123');
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.get('cursor')).toBe('c3');
  });

  it('listGrievances() with no params sends no query', async () => {
    const mockFetch = makeFetch(200, fx('listGrievances_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.dpdp.listGrievances();
    expect(call(mockFetch)[0]).toMatch(/\/v1\/dpdp\/grievances$/);
  });

  it('updateGrievance() PATCHes status and resolution', async () => {
    const mockFetch = makeFetch(200, fx('updateGrievance_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.updateGrievance('grv_01J9ZC5D6E7F8G9H0J1K2M3N4P', {
      status: 'resolved',
      resolution: 'Marketing processing stopped and the data principal informed',
    });

    expect(result.status).toBe('resolved');
    expect(result.resolvedAt).toBe('2026-10-02T09:30:00.000Z');
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/grievances\/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      status: 'resolved',
      resolution: 'Marketing processing stopped and the data principal informed',
    });
  });

  // ─── Compliance Exports ─────────────────────────────────────────────

  it('createExport() returns the 201 shape (no status)', async () => {
    const mockFetch = makeFetch(201, fx('createExport_201'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createExport({
      type: 'dpdp-audit',
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
      format: 'json',
    });

    expect(result.exportId).toBe('exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q');
    expect(result.type).toBe('dpdp-audit');
    expect(result.status).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.auditLogLimit).toBe(1000);
    expect(result.dataPrincipalId).toBeNull();
    const [url, init] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/exports$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('dpdp-audit');
    expect(body.dateTo).toBe('2026-09-30T23:59:59.999Z');
  });

  it("getExport() returns status 'complete' and truncation", async () => {
    const mockFetch = makeFetch(200, fx('getExport_200'));
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getExport('exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q');

    expect(result.status).toBe('complete');
    expect(result.truncated).toBe(true);
    expect(result.recordCount).toBe(1001);
    expect(result.dataPrincipalId).toBe('user_123');
    const [url] = call(mockFetch);
    expect(url).toMatch(/\/v1\/dpdp\/exports\/exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q$/);
  });

  // ─── Path encoding ──────────────────────────────────────────────────

  it('URL-encodes every path parameter', async () => {
    const mockFetch = makeFetch(200, { records: [], retained: [] });
    vi.stubGlobal('fetch', mockFetch);
    const grantex = new Grantex({ apiKey: 'test_key' });
    const d = grantex.dpdp;

    await d.getConsentRecord(TRAVERSAL_ID);
    await d.withdrawConsent(TRAVERSAL_ID, { reason: 'r' });
    await d.listPrincipalRecords(TRAVERSAL_ID);
    await d.requestErasure(TRAVERSAL_ID);
    await d.getErasureRequest(TRAVERSAL_ID);
    await d.getConsentNotice(TRAVERSAL_ID);
    await d.getGrievance(TRAVERSAL_ID);
    await d.updateGrievance(TRAVERSAL_ID, { status: 'in_review' });
    await d.getExport(TRAVERSAL_ID);

    const paths = mockFetch.mock.calls.map((c) => (c[0] as string).replace(/^https?:\/\/[^/]+/, ''));
    expect(paths).toEqual([
      `/v1/dpdp/consent-records/${TRAVERSAL_ENC}`,
      `/v1/dpdp/consent-records/${TRAVERSAL_ENC}/withdraw`,
      `/v1/dpdp/data-principals/${TRAVERSAL_ENC}/records`,
      `/v1/dpdp/data-principals/${TRAVERSAL_ENC}/erasure`,
      `/v1/dpdp/erasure-requests/${TRAVERSAL_ENC}`,
      `/v1/dpdp/consent-notices/${TRAVERSAL_ENC}`,
      `/v1/dpdp/grievances/${TRAVERSAL_ENC}`,
      `/v1/dpdp/grievances/${TRAVERSAL_ENC}`,
      `/v1/dpdp/exports/${TRAVERSAL_ENC}`,
    ]);
  });

  // ─── No auto-retry on writes ────────────────────────────────────────

  const writes: Array<[string, (g: Grantex) => Promise<unknown>]> = [
    ['createConsentRecord', (g) => g.dpdp.createConsentRecord({
      grantId: 'g', dataPrincipalId: 'p', purposes: [{ code: 'c', description: 'd' }],
      consentNoticeId: 'n', processingExpiresAt: '2027-01-01T00:00:00.000Z',
    })],
    ['withdrawConsent', (g) => g.dpdp.withdrawConsent('r', { reason: 'x' })],
    ['requestErasure', (g) => g.dpdp.requestErasure('p')],
    ['createConsentNotice', (g) => g.dpdp.createConsentNotice({
      noticeId: 'n', version: '1', title: 't', content: 'c', purposes: [{ code: 'c', description: 'd' }],
    })],
    ['fileGrievance', (g) => g.dpdp.fileGrievance({ dataPrincipalId: 'p', type: 't', description: 'd' })],
    ['updateGrievance', (g) => g.dpdp.updateGrievance('grv', { status: 'in_review' })],
    ['createExport', (g) => g.dpdp.createExport({ type: 'dpdp-audit', dateFrom: 'a', dateTo: 'b' })],
  ];

  for (const [name, invoke] of writes) {
    it(`${name}() is not retried after a 503`, async () => {
      const mockFetch = makeFetch(503, errFx('503_CONSENT_PROOF_UNAVAILABLE'));
      vi.stubGlobal('fetch', mockFetch);
      const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 3 });
      await expect(invoke(grantex)).rejects.toBeInstanceOf(GrantexApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}() is not retried after a timeout`, async () => {
      const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const mockFetch = vi.fn().mockRejectedValue(abort);
      vi.stubGlobal('fetch', mockFetch);
      const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 3 });
      await expect(invoke(grantex)).rejects.toThrow(/timed out/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  }

  it('GETs keep retrying a 503', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(response(503, { message: 'unavailable' }))
      .mockResolvedValueOnce(response(200, fx('getGrievance_200')));
    vi.stubGlobal('fetch', mockFetch);
    const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 1 });

    const result = await grantex.dpdp.getGrievance('grv_01J9ZC5D6E7F8G9H0J1K2M3N4P');
    expect(result.status).toBe('in_review');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ─── Error Handling ─────────────────────────────────────────────────

  const errorCases: Array<[string, number, (g: Grantex) => Promise<unknown>]> = [
    ['404_NOT_FOUND', 404, (g) => g.dpdp.getConsentRecord('crec_unknown')],
    ['409_ALREADY_WITHDRAWN', 409, (g) => g.dpdp.withdrawConsent('crec_01', { reason: 'again' })],
    ['410_GONE', 410, (g) => g.dpdp.getExport('exp_old')],
    ['409_INVALID_TRANSITION', 409, (g) => g.dpdp.updateGrievance('grv_01', { status: 'in_review' })],
  ];

  for (const [name, status, invoke] of errorCases) {
    it(`surfaces ${name} with status, code, message and requestId`, async () => {
      const body = errFx(name);
      vi.stubGlobal('fetch', makeFetch(status, body));
      const grantex = new Grantex({ apiKey: 'test_key' });

      const err = await invoke(grantex).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GrantexApiError);
      const apiErr = err as GrantexApiError;
      expect(apiErr.statusCode).toBe(status);
      expect(apiErr.code).toBe(body['code']);
      expect(apiErr.message).toBe(body['message']);
      expect(apiErr.requestId).toBe(body['requestId']);
    });
  }

  it('prefers the x-request-id header over the body requestId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ...response(404, errFx('404_NOT_FOUND')),
      headers: { get: (h: string) => (h === 'x-request-id' ? 'hdr-1' : null) },
    }));
    const grantex = new Grantex({ apiKey: 'test_key' });
    const err = await grantex.dpdp.getConsentRecord('x').catch((e: unknown) => e) as GrantexApiError;
    expect(err.requestId).toBe('hdr-1');
  });
});
