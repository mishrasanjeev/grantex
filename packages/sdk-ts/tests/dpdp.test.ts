import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_CONSENT_RECORD = {
  recordId: 'crec_01',
  grantId: 'grant_01',
  dataPrincipalId: 'user@example.com',
  consentNoticeHash: 'sha256:abc123',
  consentProof: { type: 'Ed25519Signature2020', proofJwt: 'eyJ...' },
  status: 'active',
  processingExpiresAt: '2027-01-01T00:00:00Z',
  retentionUntil: '2027-01-31T00:00:00Z',
  createdAt: '2026-04-01T00:00:00Z',
};

const MOCK_CONSENT_NOTICE = {
  id: 'notice_01',
  noticeId: 'privacy-v1',
  version: '1.0',
  language: 'en',
  contentHash: 'sha256:def456',
  createdAt: '2026-04-01T00:00:00Z',
};

const MOCK_GRIEVANCE = {
  grievanceId: 'grv_01',
  type: 'data_breach',
  status: 'submitted',
  referenceNumber: 'GRV-2026-00001',
  expectedResolutionBy: '2026-04-15T00:00:00Z',
  createdAt: '2026-04-08T00:00:00Z',
};

const MOCK_EXPORT = {
  exportId: 'exp_01',
  type: 'dpdp-audit',
  format: 'json',
  recordCount: 5,
  data: { exportType: 'dpdp-audit' },
  expiresAt: '2026-04-15T00:00:00Z',
  createdAt: '2026-04-08T00:00:00Z',
};

const MOCK_ERASURE = {
  requestId: 'ER-2026-00001',
  dataPrincipalId: 'user@example.com',
  status: 'completed',
  recordsErased: 3,
  grantsRevoked: 1,
  submittedAt: '2026-04-08T00:00:00Z',
  expectedCompletionBy: '2026-04-15T00:00:00Z',
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('DpdpClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // ─── Consent Records ────────────────────────────────────────────────

  it('createConsentRecord() POSTs to /v1/dpdp/consent-records', async () => {
    const mockFetch = makeFetch(201, MOCK_CONSENT_RECORD);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createConsentRecord({
      grantId: 'grant_01',
      dataPrincipalId: 'user@example.com',
      purposes: [{ code: 'marketing', description: 'Email marketing' }],
      consentNoticeId: 'privacy-v1',
      processingExpiresAt: '2027-01-01T00:00:00Z',
    });

    expect(result.recordId).toBe('crec_01');
    expect(result.status).toBe('active');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dpdp\/consent-records$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.grantId).toBe('grant_01');
    expect(body.dataPrincipalId).toBe('user@example.com');
    expect(body.purposes).toHaveLength(1);
  });

  it('getConsentRecord() GETs /v1/dpdp/consent-records/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_CONSENT_RECORD);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getConsentRecord('crec_01');

    expect(result.recordId).toBe('crec_01');
    expect(result.grantId).toBe('grant_01');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/dpdp\/consent-records\/crec_01$/);
  });

  it('listConsentRecords() GETs /v1/dpdp/consent-records', async () => {
    const mockFetch = makeFetch(200, { records: [MOCK_CONSENT_RECORD], totalRecords: 1 });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listConsentRecords();

    expect(result.records).toHaveLength(1);
    expect(result.totalRecords).toBe(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/dpdp\/consent-records$/);
  });

  it('listConsentRecords() with principalId adds query param', async () => {
    const mockFetch = makeFetch(200, { records: [MOCK_CONSENT_RECORD], totalRecords: 1 });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.dpdp.listConsentRecords('user@example.com');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('dataPrincipalId=user%40example.com');
  });

  it('withdrawConsent() POSTs to /v1/dpdp/consent-records/:id/withdraw', async () => {
    const mockResponse = {
      recordId: 'crec_01',
      status: 'withdrawn',
      withdrawnAt: '2026-04-08T00:00:00Z',
      grantRevoked: true,
      dataDeleted: false,
    };
    const mockFetch = makeFetch(200, mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.withdrawConsent('crec_01', {
      reason: 'No longer needed',
      revokeGrant: true,
    });

    expect(result.status).toBe('withdrawn');
    expect(result.grantRevoked).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dpdp\/consent-records\/crec_01\/withdraw$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.reason).toBe('No longer needed');
    expect(body.revokeGrant).toBe(true);
  });

  // ─── Data Principal Rights ──────────────────────────────────────────

  it('listPrincipalRecords() GETs /v1/dpdp/data-principals/:id/records', async () => {
    const mockResponse = {
      dataPrincipalId: 'user@example.com',
      records: [MOCK_CONSENT_RECORD],
      totalRecords: 1,
    };
    const mockFetch = makeFetch(200, mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.listPrincipalRecords('user@example.com');

    expect(result.dataPrincipalId).toBe('user@example.com');
    expect(result.records).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/dpdp/data-principals/user%40example.com/records');
  });

  it('requestErasure() POSTs to /v1/dpdp/data-principals/:id/erasure', async () => {
    const mockFetch = makeFetch(201, MOCK_ERASURE);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.requestErasure('user@example.com');

    expect(result.requestId).toBe('ER-2026-00001');
    expect(result.recordsErased).toBe(3);
    expect(result.grantsRevoked).toBe(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/dpdp/data-principals/user%40example.com/erasure');
    expect(init.method).toBe('POST');
  });

  // ─── Consent Notices ────────────────────────────────────────────────

  it('createConsentNotice() POSTs to /v1/dpdp/consent-notices', async () => {
    const mockFetch = makeFetch(201, MOCK_CONSENT_NOTICE);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createConsentNotice({
      noticeId: 'privacy-v1',
      version: '1.0',
      title: 'Privacy Notice',
      content: 'We collect data for...',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
    });

    expect(result.id).toBe('notice_01');
    expect(result.noticeId).toBe('privacy-v1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dpdp\/consent-notices$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.title).toBe('Privacy Notice');
    expect(body.purposes).toHaveLength(1);
  });

  // ─── Grievances ─────────────────────────────────────────────────────

  it('fileGrievance() POSTs to /v1/dpdp/grievances', async () => {
    const mockFetch = makeFetch(202, MOCK_GRIEVANCE);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.fileGrievance({
      dataPrincipalId: 'user@example.com',
      type: 'data_breach',
      description: 'My data was exposed',
    });

    expect(result.grievanceId).toBe('grv_01');
    expect(result.referenceNumber).toBe('GRV-2026-00001');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dpdp\/grievances$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.dataPrincipalId).toBe('user@example.com');
    expect(body.type).toBe('data_breach');
  });

  it('getGrievance() GETs /v1/dpdp/grievances/:id', async () => {
    const fullGrievance = {
      ...MOCK_GRIEVANCE,
      dataPrincipalId: 'user@example.com',
      description: 'My data was exposed',
      evidence: {},
      resolvedAt: null,
      resolution: null,
    };
    const mockFetch = makeFetch(200, fullGrievance);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getGrievance('grv_01');

    expect(result.grievanceId).toBe('grv_01');
    expect(result.status).toBe('submitted');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/dpdp\/grievances\/grv_01$/);
  });

  // ─── Compliance Exports ─────────────────────────────────────────────

  it('createExport() POSTs to /v1/dpdp/exports', async () => {
    const mockFetch = makeFetch(201, MOCK_EXPORT);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.createExport({
      type: 'dpdp-audit',
      dateFrom: '2026-03-01T00:00:00Z',
      dateTo: '2026-04-01T00:00:00Z',
      format: 'json',
    });

    expect(result.exportId).toBe('exp_01');
    expect(result.type).toBe('dpdp-audit');
    expect(result.recordCount).toBe(5);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dpdp\/exports$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('dpdp-audit');
    expect(body.dateFrom).toBe('2026-03-01T00:00:00Z');
  });

  it('getExport() GETs /v1/dpdp/exports/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_EXPORT);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.dpdp.getExport('exp_01');

    expect(result.exportId).toBe('exp_01');
    expect(result.type).toBe('dpdp-audit');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/dpdp\/exports\/exp_01$/);
  });

  // ─── Error Handling ─────────────────────────────────────────────────

  it('rejects on 404 for unknown consent record', async () => {
    const mockFetch = makeFetch(404, { code: 'NOT_FOUND', message: 'Consent record not found' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.dpdp.getConsentRecord('crec_unknown')).rejects.toThrow();
  });

  it('rejects on 404 for unknown grievance', async () => {
    const mockFetch = makeFetch(404, { code: 'NOT_FOUND', message: 'Grievance not found' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.dpdp.getGrievance('grv_unknown')).rejects.toThrow();
  });
});
