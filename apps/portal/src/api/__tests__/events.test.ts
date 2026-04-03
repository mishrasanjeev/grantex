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

import { listRecentEvents } from '../events';

describe('events', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listRecentEvents ──────────────────────────────────────────────────

  it('listRecentEvents sends GET /v1/events/stream and returns events', async () => {
    const events = [{ id: 'ev1', type: 'grant.created' }, { id: 'ev2', type: 'token.exchange' }];
    ok({ events });
    const result = await listRecentEvents();
    expect(result).toEqual(events);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/events/stream', expect.objectContaining({ method: 'GET' }));
  });

  it('listRecentEvents returns empty array when events is null', async () => {
    ok({ events: null });
    const result = await listRecentEvents();
    expect(result).toEqual([]);
  });

  it('listRecentEvents returns empty array when events is undefined', async () => {
    ok({});
    const result = await listRecentEvents();
    expect(result).toEqual([]);
  });

  it('listRecentEvents throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Not authenticated');
    await expect(listRecentEvents()).rejects.toThrow('Not authenticated');
  });
});
