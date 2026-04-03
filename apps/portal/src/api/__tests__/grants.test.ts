import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function noContent() {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { listGrants, getGrant, revokeGrant } from '../grants';

describe('grants', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listGrants ─────────────────────────────────────────────────────────

  it('listGrants without params sends GET /v1/grants', async () => {
    ok({ grants: [{ grantId: 'g1' }] });
    const result = await listGrants();
    expect(result).toEqual([{ grantId: 'g1' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/grants', expect.objectContaining({ method: 'GET' }));
  });

  it('listGrants with agentId adds query param', async () => {
    ok({ grants: [] });
    await listGrants({ agentId: 'agent-1' });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('http://localhost:3000/v1/grants?agentId=agent-1');
  });

  it('listGrants with status adds query param', async () => {
    ok({ grants: [] });
    await listGrants({ status: 'active' });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('http://localhost:3000/v1/grants?status=active');
  });

  it('listGrants with both params adds both', async () => {
    ok({ grants: [] });
    await listGrants({ agentId: 'a1', status: 'revoked' });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('agentId=a1');
    expect(url).toContain('status=revoked');
  });

  it('listGrants throws on error', async () => {
    err(500, 'INTERNAL', 'Database error');
    await expect(listGrants()).rejects.toThrow('Database error');
  });

  // ── getGrant ───────────────────────────────────────────────────────────

  it('getGrant sends GET /v1/grants/:id', async () => {
    ok({ grantId: 'g1', scopes: ['read'] });
    const result = await getGrant('g1');
    expect(result).toEqual({ grantId: 'g1', scopes: ['read'] });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/grants/g1', expect.objectContaining({ method: 'GET' }));
  });

  it('getGrant encodes id', async () => {
    ok({ grantId: 'g/1' });
    await getGrant('g/1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/grants/g%2F1', expect.anything());
  });

  it('getGrant throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Grant not found');
    await expect(getGrant('missing')).rejects.toThrow('Grant not found');
  });

  // ── revokeGrant ────────────────────────────────────────────────────────

  it('revokeGrant sends DELETE /v1/grants/:id', async () => {
    noContent();
    await revokeGrant('g1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/grants/g1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('revokeGrant throws on error', async () => {
    err(404, 'NOT_FOUND', 'Grant not found');
    await expect(revokeGrant('bad')).rejects.toThrow('Grant not found');
  });
});
