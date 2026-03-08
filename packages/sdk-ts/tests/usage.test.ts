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

describe('UsageClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('current() GETs /v1/usage', async () => {
    const usageResponse = {
      developerId: 'dev_01',
      period: '2026-03',
      tokenExchanges: 120,
      authorizations: 45,
      verifications: 300,
      totalRequests: 465,
    };
    const mockFetch = makeFetch(200, usageResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.usage.current();

    expect(result.developerId).toBe('dev_01');
    expect(result.totalRequests).toBe(465);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/usage$/);
    expect(init.method).toBe('GET');
  });

  it('history() GETs /v1/usage/history without params', async () => {
    const historyResponse = {
      developerId: 'dev_01',
      days: 30,
      entries: [],
    };
    const mockFetch = makeFetch(200, historyResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.usage.history();

    expect(result.days).toBe(30);
    expect(result.entries).toEqual([]);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/usage\/history$/);
  });

  it('history({ days: 7 }) GETs /v1/usage/history?days=7', async () => {
    const historyResponse = {
      developerId: 'dev_01',
      days: 7,
      entries: [
        { date: '2026-03-01', tokenExchanges: 10, authorizations: 5, verifications: 20, totalRequests: 35 },
      ],
    };
    const mockFetch = makeFetch(200, historyResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.usage.history({ days: 7 });

    expect(result.days).toBe(7);
    expect(result.entries).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/usage/history?days=7');
  });
});
