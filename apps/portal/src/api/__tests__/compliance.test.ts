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

import { getComplianceSummary, exportGrants, exportAudit, exportEvidencePack } from '../compliance';

describe('compliance', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getComplianceSummary ──────────────────────────────────────────────

  it('getComplianceSummary sends GET /v1/compliance/summary', async () => {
    const summary = { soc2: 'compliant', gdpr: 'partial' };
    ok(summary);
    const result = await getComplianceSummary();
    expect(result).toEqual(summary);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/compliance/summary', expect.objectContaining({ method: 'GET' }));
  });

  it('getComplianceSummary throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(getComplianceSummary()).rejects.toThrow('Failed');
  });

  // ── exportGrants ──────────────────────────────────────────────────────

  it('exportGrants sends GET /v1/compliance/export/grants', async () => {
    const data = { generatedAt: '2026-04-01', total: 5, grants: [] };
    ok(data);
    const result = await exportGrants();
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/compliance/export/grants', expect.objectContaining({ method: 'GET' }));
  });

  it('exportGrants throws on error', async () => {
    err(403, 'FORBIDDEN', 'Not allowed');
    await expect(exportGrants()).rejects.toThrow('Not allowed');
  });

  // ── exportAudit ───────────────────────────────────────────────────────

  it('exportAudit sends GET /v1/compliance/export/audit', async () => {
    const data = { generatedAt: '2026-04-01', total: 10, entries: [] };
    ok(data);
    const result = await exportAudit();
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/compliance/export/audit', expect.objectContaining({ method: 'GET' }));
  });

  it('exportAudit throws on error', async () => {
    err(500, 'INTERNAL', 'Export failed');
    await expect(exportAudit()).rejects.toThrow('Export failed');
  });

  // ── exportEvidencePack ────────────────────────────────────────────────

  it('exportEvidencePack sends GET with framework query param', async () => {
    const data = { framework: 'soc2', evidence: {} };
    ok(data);
    const result = await exportEvidencePack('soc2');
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/compliance/evidence-pack?framework=soc2',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('exportEvidencePack encodes framework with special chars', async () => {
    ok({});
    await exportEvidencePack('iso 27001');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/compliance/evidence-pack?framework=iso%2027001');
  });

  it('exportEvidencePack throws on error', async () => {
    err(400, 'BAD_REQUEST', 'Unknown framework');
    await expect(exportEvidencePack('invalid')).rejects.toThrow('Unknown framework');
  });
});
