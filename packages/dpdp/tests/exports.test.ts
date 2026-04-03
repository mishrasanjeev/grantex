import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requestDpdpExport,
  requestGdprExport,
  requestEuAiActExport,
  getExportStatus,
  EU_AI_ACT_ARTICLES,
} from '../src/index.js';
import type { ComplianceExportRequest } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeDpdpExportResult(): Record<string, unknown> {
  return {
    exportId: 'exp_001',
    type: 'dpdp-audit',
    status: 'complete',
    recordCount: 42,
    data: {
      consentRecords: [
        {
          recordId: 'rec_001',
          grantId: 'grant_abc',
          dataPrincipalId: 'principal_1',
          purposes: [{ purposeId: 'p1', name: 'Email Access' }],
          status: 'active',
          consentGivenAt: '2026-01-15T00:00:00Z',
        },
      ],
      actionLog: [
        {
          actionId: 'act_001',
          timestamp: '2026-02-10T12:00:00Z',
          action: 'email:read',
          agentId: 'agent_x',
          result: 'success',
        },
      ],
      summary: {
        totalRecords: 42,
        activeRecords: 35,
        withdrawnRecords: 5,
        expiredRecords: 2,
        period: { from: '2026-01-01', to: '2026-03-31' },
      },
    },
    downloadUrl: 'https://exports.grantex.dev/exp_001/download?token=abc',
    downloadExpiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
  };
}

function makeGdprExportResult(): Record<string, unknown> {
  return {
    exportId: 'exp_002',
    type: 'gdpr-article-15',
    status: 'complete',
    recordCount: 10,
    data: {
      dataSubject: { id: 'principal_1' },
      purposes: [
        { purposeId: 'p1', name: 'Email Access', legalBasis: 'consent' },
      ],
      recipients: [],
      retentionPeriods: [{ category: 'email', period: '1 year' }],
      dataCategories: ['email', 'contacts'],
      consentRecords: [],
      rights: {
        access: true,
        rectification: true,
        erasure: true,
        restriction: true,
        portability: true,
        objection: true,
      },
    },
    downloadUrl: 'https://exports.grantex.dev/exp_002/download?token=def',
    downloadExpiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
  };
}

function makeEuAiActResult(): Record<string, unknown> {
  const articleCoverage: Record<string, unknown> = {};
  for (const art of EU_AI_ACT_ARTICLES) {
    articleCoverage[`article_${art.article}`] = {
      title: art.title,
      status: 'compliant',
      evidence: [],
    };
  }

  return {
    exportId: 'exp_003',
    type: 'eu-ai-act-conformance',
    status: 'complete',
    recordCount: 1,
    data: {
      systemDescription: 'AI agent authorization system',
      riskLevel: 'high-risk',
      articles: articleCoverage,
      overallStatus: 'compliant',
    },
    downloadUrl: 'https://exports.grantex.dev/exp_003/download?token=ghi',
    downloadExpiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exports', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('DPDP audit export contains all required fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeDpdpExportResult()),
      }),
    );

    const result = await requestDpdpExport(makeExportParams(), 'test-key', 'https://api.test.local');

    expect(result.exportId).toBe('exp_001');
    expect(result.type).toBe('dpdp-audit');
    expect(result.status).toBe('complete');
    expect(result.recordCount).toBe(42);
    expect(result.data).toBeDefined();

    // Verify the data contains consent records and action log
    const data = result.data as Record<string, unknown>;
    expect(data.consentRecords).toBeDefined();
    expect(data.actionLog).toBeDefined();
    expect(data.summary).toBeDefined();

    // Verify request body
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.type).toBe('dpdp-audit');
    expect(body.includeActionLog).toBe(true);
    expect(body.includeConsentRecords).toBe(true);
  });

  it('GDPR Article 15 export is machine-readable JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeGdprExportResult()),
      }),
    );

    const result = await requestGdprExport(makeExportParams(), 'test-key', 'https://api.test.local');

    expect(result.type).toBe('gdpr-article-15');
    expect(result.status).toBe('complete');

    // GDPR Article 15 must include: purposes, recipients, retention periods,
    // data categories, and data subject rights
    const data = result.data as Record<string, unknown>;
    expect(data.purposes).toBeDefined();
    expect(data.recipients).toBeDefined();
    expect(data.retentionPeriods).toBeDefined();
    expect(data.dataCategories).toBeDefined();
    expect(data.rights).toBeDefined();

    const rights = data.rights as Record<string, boolean>;
    expect(rights.access).toBe(true);
    expect(rights.erasure).toBe(true);
    expect(rights.portability).toBe(true);
  });

  it('EU AI Act conformance report covers all articles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeEuAiActResult()),
      }),
    );

    const result = await requestEuAiActExport(
      makeExportParams(),
      'test-key',
      'https://api.test.local',
    );

    expect(result.type).toBe('eu-ai-act-conformance');
    expect(result.status).toBe('complete');

    const data = result.data as Record<string, unknown>;
    const articles = data.articles as Record<string, unknown>;

    // All defined EU AI Act articles should be covered
    for (const art of EU_AI_ACT_ARTICLES) {
      const key = `article_${art.article}`;
      expect(articles[key]).toBeDefined();
      const entry = articles[key] as Record<string, unknown>;
      expect(entry.title).toBe(art.title);
    }
  });

  it('export download URL expires after 24h', async () => {
    const expiresAt = new Date(Date.now() + 24 * 3600000);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...makeDpdpExportResult(),
            downloadExpiresAt: expiresAt.toISOString(),
          }),
      }),
    );

    const result = await requestDpdpExport(makeExportParams(), 'test-key', 'https://api.test.local');

    expect(result.downloadUrl).toBeTruthy();
    expect(result.downloadExpiresAt).toBeDefined();

    // Download expiry should be within ~24 hours from now
    const expiryMs = result.downloadExpiresAt!.getTime() - Date.now();
    const twentyFourHoursMs = 24 * 3600000;
    expect(expiryMs).toBeLessThanOrEqual(twentyFourHoursMs + 5000); // 5s tolerance
    expect(expiryMs).toBeGreaterThan(twentyFourHoursMs - 60000); // within 1 minute
  });

  it('getExportStatus fetches export by ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeDpdpExportResult()),
      }),
    );

    const result = await getExportStatus('exp_001', 'test-key', 'https://api.test.local');
    expect(result.exportId).toBe('exp_001');

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.test.local/v1/dpdp/exports/exp_001');
  });
});
