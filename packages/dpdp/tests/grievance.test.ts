import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fileGrievance,
  getGrievanceStatus,
  generateReferenceNumber,
  calculateExpectedResolution,
  GrievanceError,
} from '../src/index.js';
import type { FileGrievanceParams } from '../src/index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('grievance', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('grievance creates record with reference number', async () => {
    const expectedResolutionBy = new Date(Date.now() + 7 * 86400000).toISOString();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            grievanceId: 'grv_001',
            dataPrincipalId: 'principal_1',
            recordId: 'rec_001',
            type: 'unauthorized_processing',
            description: 'Data processed without consent',
            status: 'submitted',
            referenceNumber: 'GRV-2026-00042',
            expectedResolutionBy,
          }),
      }),
    );

    const params: FileGrievanceParams = {
      dataPrincipalId: 'principal_1',
      recordId: 'rec_001',
      type: 'unauthorized_processing',
      description: 'Data processed without consent',
    };

    const grievance = await fileGrievance(params, 'test-key', 'https://api.test.local');

    expect(grievance.grievanceId).toBe('grv_001');
    expect(grievance.referenceNumber).toMatch(/^GRV-\d{4}-\d{5}$/);
    expect(grievance.status).toBe('submitted');
  });

  it('grievance has expected resolution date (7 days)', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const expected = calculateExpectedResolution(now);

    // 7 calendar days later
    expect(expected.toISOString()).toBe('2026-04-08T00:00:00.000Z');
  });

  it('generates valid reference number format', () => {
    const ref = generateReferenceNumber();
    expect(ref).toMatch(/^GRV-\d{4}-\d{5}$/);

    // Year should be current
    const year = new Date().getFullYear().toString();
    expect(ref).toContain(year);
  });

  it('rejects grievance without required fields', async () => {
    await expect(
      fileGrievance(
        { dataPrincipalId: '', recordId: 'rec_001', type: 'other', description: 'test' },
        'key',
        'https://api.test.local',
      ),
    ).rejects.toThrow(GrievanceError);
  });

  it('gets grievance status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            grievanceId: 'grv_001',
            dataPrincipalId: 'principal_1',
            recordId: 'rec_001',
            type: 'data_breach',
            description: 'Breach detected',
            status: 'under_review',
            referenceNumber: 'GRV-2026-00099',
            expectedResolutionBy: new Date(Date.now() + 5 * 86400000).toISOString(),
          }),
      }),
    );

    const status = await getGrievanceStatus('grv_001', 'test-key', 'https://api.test.local');
    expect(status.status).toBe('under_review');
    expect(status.type).toBe('data_breach');
  });
});
