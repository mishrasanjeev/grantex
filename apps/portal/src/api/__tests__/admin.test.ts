import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock sessionStorage
const mockSessionStorage: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => mockSessionStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockSessionStorage[key] = value; },
  removeItem: (key: string) => { delete mockSessionStorage[key]; },
});

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

import { setAdminKey, getAdminKey, clearAdminKey, fetchStats, fetchDevelopers } from '../admin';

describe('admin', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Clear admin key state
    clearAdminKey();
    Object.keys(mockSessionStorage).forEach((k) => delete mockSessionStorage[k]);
  });

  // ── setAdminKey / getAdminKey / clearAdminKey ─────────────────────────

  it('getAdminKey returns null when no key set', () => {
    expect(getAdminKey()).toBeNull();
  });

  it('setAdminKey stores key and getAdminKey retrieves it', () => {
    setAdminKey('admin-key-123');
    expect(getAdminKey()).toBe('admin-key-123');
  });

  it('setAdminKey persists to sessionStorage', () => {
    setAdminKey('admin-key-456');
    expect(mockSessionStorage['gx_admin_key']).toBe('admin-key-456');
  });

  it('getAdminKey falls back to sessionStorage', () => {
    mockSessionStorage['gx_admin_key'] = 'stored-key';
    // clearAdminKey sets the in-memory key to null, so we need a fresh import state
    // but the function should read from sessionStorage when in-memory is null
    const result = getAdminKey();
    expect(result).toBe('stored-key');
  });

  it('clearAdminKey removes key from memory and sessionStorage', () => {
    setAdminKey('key');
    clearAdminKey();
    expect(getAdminKey()).toBeNull();
    expect(mockSessionStorage['gx_admin_key']).toBeUndefined();
  });

  // ── fetchStats ────────────────────────────────────────────────────────

  it('fetchStats sends GET /v1/admin/stats with admin key', async () => {
    setAdminKey('admin-key');
    const stats = { totalDevelopers: 100, last24h: 5, last7d: 20, last30d: 50, byMode: {}, totalAgents: 200, totalGrants: 500 };
    ok(stats);
    const result = await fetchStats();
    expect(result).toEqual(stats);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/admin/stats');
    expect(opts.method).toBe('GET');
    expect(opts.headers['Authorization']).toBe('Bearer admin-key');
  });

  it('fetchStats throws when no admin key set', async () => {
    await expect(fetchStats()).rejects.toThrow('Admin API key not set');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetchStats throws on server error', async () => {
    setAdminKey('admin-key');
    err(403, 'FORBIDDEN', 'Invalid admin key');
    await expect(fetchStats()).rejects.toThrow('Invalid admin key');
  });

  // ── fetchDevelopers ───────────────────────────────────────────────────

  it('fetchDevelopers sends GET with default page and pageSize', async () => {
    setAdminKey('admin-key');
    const resp = { developers: [{ id: 'd1', name: 'Alice' }], total: 1, page: 1, pageSize: 50 };
    ok(resp);
    const result = await fetchDevelopers();
    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/admin/developers?page=1&pageSize=50',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fetchDevelopers sends GET with custom page and pageSize', async () => {
    setAdminKey('admin-key');
    ok({ developers: [], total: 0, page: 2, pageSize: 25 });
    await fetchDevelopers(2, 25);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/admin/developers?page=2&pageSize=25',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fetchDevelopers includes admin key in Authorization header', async () => {
    setAdminKey('my-admin-key');
    ok({ developers: [], total: 0, page: 1, pageSize: 50 });
    await fetchDevelopers();
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers['Authorization']).toBe('Bearer my-admin-key');
  });

  it('fetchDevelopers throws when no admin key set', async () => {
    await expect(fetchDevelopers()).rejects.toThrow('Admin API key not set');
  });

  it('fetchDevelopers throws on server error', async () => {
    setAdminKey('admin-key');
    err(500, 'INTERNAL', 'Database error');
    await expect(fetchDevelopers()).rejects.toThrow('Database error');
  });
});
