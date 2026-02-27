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

const MOCK_ANOMALY = {
  id: 'anm_01',
  type: 'rate_spike',
  severity: 'high',
  agentId: 'ag_01',
  principalId: null,
  description: 'Agent ag_01 performed 72 actions in the last hour (threshold: 50).',
  metadata: { count: 72, windowHours: 1, threshold: 50 },
  detectedAt: '2026-02-26T00:00:00Z',
  acknowledgedAt: null,
};

describe('AnomaliesClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('detect() POSTs to /v1/anomalies/detect', async () => {
    const mockResponse = { detectedAt: '2026-02-26T00:00:00Z', total: 1, anomalies: [MOCK_ANOMALY] };
    const mockFetch = makeFetch(200, mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.anomalies.detect();

    expect(result.total).toBe(1);
    expect(result.anomalies[0]!.type).toBe('rate_spike');
    expect(result.anomalies[0]!.severity).toBe('high');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/anomalies\/detect$/);
    expect(init.method).toBe('POST');
  });

  it('list() GETs /v1/anomalies', async () => {
    const mockResponse = { anomalies: [MOCK_ANOMALY], total: 1 };
    const mockFetch = makeFetch(200, mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.anomalies.list();

    expect(result.total).toBe(1);
    expect(result.anomalies[0]!.id).toBe('anm_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/anomalies$/);
    expect(init.method).toBe('GET');
  });

  it('list({ unacknowledged: true }) appends query param', async () => {
    const mockFetch = makeFetch(200, { anomalies: [], total: 0 });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.anomalies.list({ unacknowledged: true });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('unacknowledged=true');
  });

  it('acknowledge() PATCHes /v1/anomalies/:id/acknowledge', async () => {
    const acked = { ...MOCK_ANOMALY, acknowledgedAt: '2026-02-26T01:00:00Z' };
    const mockFetch = makeFetch(200, acked);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.anomalies.acknowledge('anm_01');

    expect(result.acknowledgedAt).toBe('2026-02-26T01:00:00Z');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/anomalies\/anm_01\/acknowledge$/);
    expect(init.method).toBe('PATCH');
  });
});
