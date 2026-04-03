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

import { getUsage, getUsageHistory } from '../usage';

describe('usage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getUsage ──────────────────────────────────────────────────────────

  it('getUsage sends GET /v1/usage', async () => {
    const data = { developerId: 'dev-1', period: '2026-04', tokenExchanges: 100, totalRequests: 500 };
    ok(data);
    const result = await getUsage();
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/usage', expect.objectContaining({ method: 'GET' }));
  });

  it('getUsage throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Invalid key');
    await expect(getUsage()).rejects.toThrow('Invalid key');
  });

  // ── getUsageHistory ───────────────────────────────────────────────────

  it('getUsageHistory sends GET /v1/usage/history with days param', async () => {
    const data = { entries: [{ date: '2026-04-01', requests: 50 }] };
    ok(data);
    const result = await getUsageHistory(30);
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/usage/history?days=30',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getUsageHistory with different days value', async () => {
    ok({ entries: [] });
    await getUsageHistory(7);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/usage/history?days=7');
  });

  it('getUsageHistory throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(getUsageHistory(30)).rejects.toThrow('Failed');
  });
});
