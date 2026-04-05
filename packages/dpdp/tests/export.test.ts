import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestDpdpExport, getExportStatus } from '../src/export/dpdp-export.js';
import { requestEuAiActExport, EU_AI_ACT_ARTICLES } from '../src/export/eu-ai-act-export.js';
import { requestGdprExport } from '../src/export/gdpr-export.js';
import { ExportError } from '../src/errors.js';
import type { ComplianceExportRequest } from '../src/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeExportParams(): Omit<ComplianceExportRequest, 'type'> {
  return {
    dateFrom: new Date('2026-01-01T00:00:00Z'),
    dateTo: new Date('2026-03-31T23:59:59Z'),
    format: 'json',
    includeActionLog: true,
    includeConsentRecords: true,
    dataPrincipalId: 'principal_1',
  };
}

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchError(status: number, body?: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  });
}

/* ------------------------------------------------------------------ */
/*  DPDP export tests                                                  */
/* ------------------------------------------------------------------ */

describe('dpdp-export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('requestDpdpExport', () => {
    it('sends type "dpdp-audit" in request body', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                exportId: 'exp_01',
                type: 'dpdp-audit',
                status: 'complete',
                recordCount: 10,
                data: {},
              }),
          };
        }),
      );

      await requestDpdpExport(makeExportParams(), 'api-key', 'https://api.test.local');
      expect(capturedBody!.type).toBe('dpdp-audit');
    });

    it('calls correct endpoint with auth header', async () => {
      let calledUrl = '';
      let authHeader = '';

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calledUrl = url;
          authHeader = (init.headers as Record<string, string>)['Authorization'];
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                exportId: 'exp_01',
                type: 'dpdp-audit',
                status: 'complete',
                recordCount: 0,
                data: null,
              }),
          };
        }),
      );

      await requestDpdpExport(makeExportParams(), 'my-key', 'https://api.test.local');
      expect(calledUrl).toBe('https://api.test.local/v1/dpdp/exports');
      expect(authHeader).toBe('Bearer my-key');
    });

    it('serializes dates to ISO strings', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                exportId: 'e',
                type: 'dpdp-audit',
                status: 'complete',
                recordCount: 0,
                data: null,
              }),
          };
        }),
      );

      await requestDpdpExport(makeExportParams(), 'key', 'https://api.test.local');
      expect(capturedBody!.dateFrom).toBe('2026-01-01T00:00:00.000Z');
      expect(capturedBody!.dateTo).toBe('2026-03-31T23:59:59.000Z');
    });

    it('returns deserialized export result with downloadExpiresAt as Date', async () => {
      const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();

      vi.stubGlobal(
        'fetch',
        mockFetchOk({
          exportId: 'exp_01',
          type: 'dpdp-audit',
          status: 'complete',
          recordCount: 42,
          data: { records: [] },
          downloadUrl: 'https://downloads.test/exp_01',
          downloadExpiresAt: expiresAt,
        }),
      );

      const result = await requestDpdpExport(makeExportParams(), 'key', 'https://api.test.local');
      expect(result.exportId).toBe('exp_01');
      expect(result.recordCount).toBe(42);
      expect(result.downloadUrl).toBe('https://downloads.test/exp_01');
      expect(result.downloadExpiresAt).toBeInstanceOf(Date);
    });

    it('throws ExportError on HTTP error', async () => {
      vi.stubGlobal('fetch', mockFetchError(500, { message: 'Server error' }));

      await expect(
        requestDpdpExport(makeExportParams(), 'key', 'https://api.test.local'),
      ).rejects.toThrow(ExportError);
    });

    it('throws ExportError with server message', async () => {
      vi.stubGlobal('fetch', mockFetchError(403, { message: 'Forbidden' }));

      await expect(
        requestDpdpExport(makeExportParams(), 'key', 'https://api.test.local'),
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('getExportStatus', () => {
    it('fetches export by ID with GET request', async () => {
      let calledUrl = '';
      let calledMethod = '';

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calledUrl = url;
          calledMethod = init?.method ?? 'GET';
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                exportId: 'exp_42',
                type: 'dpdp-audit',
                status: 'complete',
                recordCount: 5,
                data: {},
              }),
          };
        }),
      );

      const result = await getExportStatus('exp_42', 'key', 'https://api.test.local');
      expect(calledUrl).toBe('https://api.test.local/v1/dpdp/exports/exp_42');
      expect(result.exportId).toBe('exp_42');
    });

    it('URL-encodes exportId', async () => {
      let calledUrl = '';

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calledUrl = url;
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                exportId: 'exp/special',
                type: 'dpdp-audit',
                status: 'complete',
                recordCount: 0,
                data: null,
              }),
          };
        }),
      );

      await getExportStatus('exp/special', 'key', 'https://api.test.local');
      expect(calledUrl).toContain('exp%2Fspecial');
    });

    it('throws ExportError on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 404,
        })),
      );

      await expect(
        getExportStatus('missing', 'key', 'https://api.test.local'),
      ).rejects.toThrow(ExportError);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  EU AI Act export tests                                             */
/* ------------------------------------------------------------------ */

describe('eu-ai-act-export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('EU_AI_ACT_ARTICLES has expected articles', () => {
    expect(EU_AI_ACT_ARTICLES.length).toBe(9);

    const articleNumbers = EU_AI_ACT_ARTICLES.map((a) => a.article);
    expect(articleNumbers).toContain('9');
    expect(articleNumbers).toContain('12');
    expect(articleNumbers).toContain('13');
    expect(articleNumbers).toContain('14');
    expect(articleNumbers).toContain('50');
  });

  it('each article has article, title, and description', () => {
    for (const art of EU_AI_ACT_ARTICLES) {
      expect(art.article).toBeTruthy();
      expect(art.title).toBeTruthy();
      expect(art.description).toBeTruthy();
    }
  });

  it('sends type "eu-ai-act-conformance" in request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              exportId: 'exp_eu',
              type: 'eu-ai-act-conformance',
              status: 'complete',
              recordCount: 1,
              data: {},
            }),
        };
      }),
    );

    await requestEuAiActExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(capturedBody!.type).toBe('eu-ai-act-conformance');
  });

  it('returns deserialized result', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk({
        exportId: 'exp_eu',
        type: 'eu-ai-act-conformance',
        status: 'complete',
        recordCount: 1,
        data: { overallStatus: 'compliant' },
        downloadUrl: 'https://downloads.test/eu',
      }),
    );

    const result = await requestEuAiActExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(result.type).toBe('eu-ai-act-conformance');
    expect(result.downloadUrl).toBe('https://downloads.test/eu');
  });

  it('throws ExportError on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetchError(502, { message: 'Bad Gateway' }));

    await expect(
      requestEuAiActExport(makeExportParams(), 'key', 'https://api.test.local'),
    ).rejects.toThrow(ExportError);
  });

  it('deserializes downloadExpiresAt as Date', async () => {
    const expires = new Date(Date.now() + 86400_000).toISOString();

    vi.stubGlobal(
      'fetch',
      mockFetchOk({
        exportId: 'exp_eu',
        type: 'eu-ai-act-conformance',
        status: 'complete',
        recordCount: 1,
        data: {},
        downloadExpiresAt: expires,
      }),
    );

    const result = await requestEuAiActExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(result.downloadExpiresAt).toBeInstanceOf(Date);
  });
});

/* ------------------------------------------------------------------ */
/*  GDPR export tests                                                  */
/* ------------------------------------------------------------------ */

describe('gdpr-export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends type "gdpr-article-15" in request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              exportId: 'exp_gdpr',
              type: 'gdpr-article-15',
              status: 'complete',
              recordCount: 5,
              data: {},
            }),
        };
      }),
    );

    await requestGdprExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(capturedBody!.type).toBe('gdpr-article-15');
  });

  it('returns deserialized result', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk({
        exportId: 'exp_gdpr',
        type: 'gdpr-article-15',
        status: 'complete',
        recordCount: 10,
        data: { dataSubject: { id: 'principal_1' } },
      }),
    );

    const result = await requestGdprExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(result.type).toBe('gdpr-article-15');
    expect(result.recordCount).toBe(10);
    const data = result.data as Record<string, unknown>;
    expect(data.dataSubject).toEqual({ id: 'principal_1' });
  });

  it('throws ExportError on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetchError(401, { message: 'Unauthorized' }));

    await expect(
      requestGdprExport(makeExportParams(), 'key', 'https://api.test.local'),
    ).rejects.toThrow(ExportError);

    await expect(
      requestGdprExport(makeExportParams(), 'key', 'https://api.test.local'),
    ).rejects.toThrow('Unauthorized');
  });

  it('serializes dates to ISO strings', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              exportId: 'e',
              type: 'gdpr-article-15',
              status: 'complete',
              recordCount: 0,
              data: null,
            }),
        };
      }),
    );

    await requestGdprExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(typeof capturedBody!.dateFrom).toBe('string');
    expect(typeof capturedBody!.dateTo).toBe('string');
  });

  it('handles export without downloadUrl', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk({
        exportId: 'exp_no_url',
        type: 'gdpr-article-15',
        status: 'complete',
        recordCount: 0,
        data: null,
      }),
    );

    const result = await requestGdprExport(makeExportParams(), 'key', 'https://api.test.local');
    expect(result.downloadUrl).toBeUndefined();
    expect(result.downloadExpiresAt).toBeUndefined();
  });
});
