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

import { listScimTokens, createScimToken, deleteScimToken } from '../scim';

describe('scim', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listScimTokens ────────────────────────────────────────────────────

  it('listScimTokens sends GET /v1/scim/tokens and unwraps .tokens', async () => {
    ok({ tokens: [{ id: 't1', label: 'CI Token', createdAt: '2026-04-01', lastUsedAt: null }] });
    const result = await listScimTokens();
    expect(result).toEqual([{ id: 't1', label: 'CI Token', createdAt: '2026-04-01', lastUsedAt: null }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/scim/tokens', expect.objectContaining({ method: 'GET' }));
  });

  it('listScimTokens throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Not authenticated');
    await expect(listScimTokens()).rejects.toThrow('Not authenticated');
  });

  // ── createScimToken ───────────────────────────────────────────────────

  it('createScimToken sends POST /v1/scim/tokens with label', async () => {
    const resp = { id: 't2', label: 'Deploy', token: 'scim_tok_xxx', createdAt: '2026-04-01', lastUsedAt: null };
    ok(resp);
    const result = await createScimToken({ label: 'Deploy' });
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/scim/tokens');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ label: 'Deploy' });
  });

  it('createScimToken throws on 400', async () => {
    err(400, 'VALIDATION', 'Label required');
    await expect(createScimToken({ label: '' })).rejects.toThrow('Label required');
  });

  // ── deleteScimToken ───────────────────────────────────────────────────

  it('deleteScimToken sends DELETE /v1/scim/tokens/:id', async () => {
    noContent();
    await deleteScimToken('t1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/scim/tokens/t1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteScimToken encodes id', async () => {
    noContent();
    await deleteScimToken('t/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/scim/tokens/t%2F1');
  });

  it('deleteScimToken throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Token not found');
    await expect(deleteScimToken('missing')).rejects.toThrow('Token not found');
  });
});
