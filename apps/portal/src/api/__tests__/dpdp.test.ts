import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import {
  createConsentRecord,
  withdrawConsent,
  getDataPrincipalRecords,
  createConsentNotice,
  fileGrievance,
  getGrievance,
  createExport,
  getExport,
} from '../dpdp';

describe('dpdp', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── createConsentRecord ───────────────────────────────────────────────

  it('createConsentRecord sends POST /v1/dpdp/consent-records', async () => {
    const data = {
      grantId: 'g1',
      dataPrincipalId: 'dp1',
      purposes: [{ code: 'P01', description: 'Analytics' }],
      consentNoticeId: 'cn1',
      processingExpiresAt: '2027-01-01T00:00:00Z',
    };
    const resp = { recordId: 'cr1', grantId: 'g1', dataPrincipalId: 'dp1', status: 'active' };
    ok(resp);
    const result = await createConsentRecord(data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/dpdp/consent-records');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createConsentRecord throws on 400', async () => {
    err(400, 'VALIDATION', 'Missing grantId');
    await expect(createConsentRecord({} as any)).rejects.toThrow('Missing grantId');
  });

  // ── withdrawConsent ───────────────────────────────────────────────────

  it('withdrawConsent sends POST /v1/dpdp/consent-records/:id/withdraw', async () => {
    const data = { reason: 'No longer needed', revokeGrant: true };
    const resp = { recordId: 'cr1', status: 'withdrawn', withdrawnAt: '2026-04-01', grantRevoked: true, dataDeleted: false };
    ok(resp);
    const result = await withdrawConsent('cr1', data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/dpdp/consent-records/cr1/withdraw');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('withdrawConsent encodes recordId', async () => {
    ok({ recordId: 'cr/1', status: 'withdrawn' });
    await withdrawConsent('cr/1', { reason: 'test' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/dpdp/consent-records/cr%2F1/withdraw');
  });

  it('withdrawConsent throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Record not found');
    await expect(withdrawConsent('missing', { reason: 'x' })).rejects.toThrow('Record not found');
  });

  // ── getDataPrincipalRecords ───────────────────────────────────────────

  it('getDataPrincipalRecords sends GET /v1/dpdp/data-principals/:id/records', async () => {
    const resp = { dataPrincipalId: 'dp1', records: [{ recordId: 'cr1' }], totalRecords: 1 };
    ok(resp);
    const result = await getDataPrincipalRecords('dp1');
    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/dpdp/data-principals/dp1/records',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getDataPrincipalRecords encodes principalId', async () => {
    ok({ dataPrincipalId: 'dp/1', records: [], totalRecords: 0 });
    await getDataPrincipalRecords('dp/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/dpdp/data-principals/dp%2F1/records');
  });

  it('getDataPrincipalRecords throws on error', async () => {
    err(404, 'NOT_FOUND', 'Principal not found');
    await expect(getDataPrincipalRecords('missing')).rejects.toThrow('Principal not found');
  });

  // ── createConsentNotice ───────────────────────────────────────────────

  it('createConsentNotice sends POST /v1/dpdp/consent-notices', async () => {
    const data = {
      noticeId: 'n1',
      version: '1.0',
      title: 'Consent Notice',
      content: 'We collect data...',
      purposes: [{ code: 'P01', description: 'Analytics' }],
    };
    const resp = { id: 'cn1', noticeId: 'n1', version: '1.0', language: 'en' };
    ok(resp);
    const result = await createConsentNotice(data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/dpdp/consent-notices');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createConsentNotice throws on 400', async () => {
    err(400, 'VALIDATION', 'Title required');
    await expect(createConsentNotice({} as any)).rejects.toThrow('Title required');
  });

  // ── fileGrievance ─────────────────────────────────────────────────────

  it('fileGrievance sends POST /v1/dpdp/grievances', async () => {
    const data = { dataPrincipalId: 'dp1', type: 'data-breach', description: 'Data exposed' };
    const resp = { grievanceId: 'gr1', referenceNumber: 'GR-001', type: 'data-breach', status: 'submitted' };
    ok(resp);
    const result = await fileGrievance(data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/dpdp/grievances');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('fileGrievance throws on error', async () => {
    err(400, 'VALIDATION', 'Description required');
    await expect(fileGrievance({} as any)).rejects.toThrow('Description required');
  });

  // ── getGrievance ──────────────────────────────────────────────────────

  it('getGrievance sends GET /v1/dpdp/grievances/:id', async () => {
    const grievance = { grievanceId: 'gr1', status: 'submitted', referenceNumber: 'GR-001' };
    ok(grievance);
    const result = await getGrievance('gr1');
    expect(result).toEqual(grievance);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/dpdp/grievances/gr1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getGrievance encodes id', async () => {
    ok({ grievanceId: 'gr/1' });
    await getGrievance('gr/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/dpdp/grievances/gr%2F1');
  });

  it('getGrievance throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Grievance not found');
    await expect(getGrievance('missing')).rejects.toThrow('Grievance not found');
  });

  // ── createExport ──────────────────────────────────────────────────────

  it('createExport sends POST /v1/dpdp/exports', async () => {
    const data = { type: 'dpdp-audit' as const, dateFrom: '2026-01-01', dateTo: '2026-04-01' };
    const resp = { exportId: 'ex1', type: 'dpdp-audit', format: 'json', recordCount: 10 };
    ok(resp);
    const result = await createExport(data);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/dpdp/exports');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createExport throws on error', async () => {
    err(400, 'VALIDATION', 'Invalid date range');
    await expect(createExport({} as any)).rejects.toThrow('Invalid date range');
  });

  // ── getExport ─────────────────────────────────────────────────────────

  it('getExport sends GET /v1/dpdp/exports/:id', async () => {
    const exp = { exportId: 'ex1', type: 'dpdp-audit', format: 'json' };
    ok(exp);
    const result = await getExport('ex1');
    expect(result).toEqual(exp);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/dpdp/exports/ex1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getExport encodes id', async () => {
    ok({ exportId: 'ex/1' });
    await getExport('ex/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/dpdp/exports/ex%2F1');
  });

  it('getExport throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Export not found');
    await expect(getExport('missing')).rejects.toThrow('Export not found');
  });
});
