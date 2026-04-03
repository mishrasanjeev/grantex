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

import { listCredentials, getCredential } from '../credentials';

describe('credentials', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listCredentials ───────────────────────────────────────────────────

  it('listCredentials without params sends GET /v1/credentials', async () => {
    ok({ credentials: [{ id: 'vc1', type: ['VerifiableCredential'] }] });
    const result = await listCredentials();
    expect(result).toEqual([{ id: 'vc1', type: ['VerifiableCredential'] }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/credentials', expect.objectContaining({ method: 'GET' }));
  });

  it('listCredentials with grantId param', async () => {
    ok({ credentials: [] });
    await listCredentials({ grantId: 'g1' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/credentials?grantId=g1');
  });

  it('listCredentials with status param', async () => {
    ok({ credentials: [] });
    await listCredentials({ status: 'active' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/credentials?status=active');
  });

  it('listCredentials with both params', async () => {
    ok({ credentials: [] });
    await listCredentials({ grantId: 'g1', status: 'revoked' });
    const url = mockFetch.mock.calls[0]![0];
    expect(url).toContain('grantId=g1');
    expect(url).toContain('status=revoked');
  });

  it('listCredentials throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listCredentials()).rejects.toThrow('Failed');
  });

  // ── getCredential ─────────────────────────────────────────────────────

  it('getCredential sends GET /v1/credentials/:id', async () => {
    const cred = { id: 'vc1', type: ['VerifiableCredential'], issuer: 'did:web:grantex.dev' };
    ok(cred);
    const result = await getCredential('vc1');
    expect(result).toEqual(cred);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/credentials/vc1', expect.objectContaining({ method: 'GET' }));
  });

  it('getCredential encodes id', async () => {
    ok({ id: 'vc/1' });
    await getCredential('vc/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/credentials/vc%2F1');
  });

  it('getCredential throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Credential not found');
    await expect(getCredential('missing')).rejects.toThrow('Credential not found');
  });
});
