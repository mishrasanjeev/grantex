import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_SUMMARY = {
  generatedAt: '2026-02-26T00:00:00Z',
  agents: { total: 5, active: 4, suspended: 1, revoked: 0 },
  grants: { total: 23, active: 18, revoked: 3, expired: 2 },
  auditEntries: { total: 412, success: 400, failure: 10, blocked: 2 },
  policies: { total: 2 },
  plan: 'pro',
};

describe('ComplianceClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('getSummary() GETs /v1/compliance/summary', async () => {
    const mockFetch = makeFetch(200, MOCK_SUMMARY);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.compliance.getSummary();

    expect(result.agents.total).toBe(5);
    expect(result.grants.active).toBe(18);
    expect(result.auditEntries.failure).toBe(10);
    expect(result.plan).toBe('pro');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/compliance\/summary$/);
    expect(init.method).toBe('GET');
  });

  it('getSummary() appends since/until query params', async () => {
    const mockFetch = makeFetch(200, MOCK_SUMMARY);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.compliance.getSummary({
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T00:00:00Z',
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('since=');
    expect(url).toContain('until=');
  });

  it('exportGrants() GETs /v1/compliance/export/grants', async () => {
    const mockFetch = makeFetch(200, { generatedAt: '2026-02-26T00:00:00Z', total: 1, grants: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.compliance.exportGrants();

    expect(result.total).toBe(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/compliance\/export\/grants$/);
    expect(init.method).toBe('GET');
  });

  it('exportGrants() appends filter query params', async () => {
    const mockFetch = makeFetch(200, { generatedAt: '2026-02-26T00:00:00Z', total: 0, grants: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.compliance.exportGrants({ status: 'active', since: '2026-01-01T00:00:00Z' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('status=active');
    expect(url).toContain('since=');
  });

  it('exportAudit() GETs /v1/compliance/export/audit', async () => {
    const mockFetch = makeFetch(200, { generatedAt: '2026-02-26T00:00:00Z', total: 0, entries: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.compliance.exportAudit();

    expect(result.total).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/compliance\/export\/audit$/);
    expect(init.method).toBe('GET');
  });
});
