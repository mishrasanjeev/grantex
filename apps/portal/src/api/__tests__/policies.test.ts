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

import { listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy } from '../policies';

describe('policies', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listPolicies ──────────────────────────────────────────────────────

  it('listPolicies sends GET /v1/policies and unwraps .policies', async () => {
    ok({ policies: [{ id: 'p1', name: 'Policy 1' }], total: 1 });
    const result = await listPolicies();
    expect(result).toEqual([{ id: 'p1', name: 'Policy 1' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/policies', expect.objectContaining({ method: 'GET' }));
  });

  it('listPolicies throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listPolicies()).rejects.toThrow('Failed');
  });

  // ── getPolicy ─────────────────────────────────────────────────────────

  it('getPolicy sends GET /v1/policies/:id', async () => {
    ok({ id: 'p1', name: 'Policy 1' });
    const result = await getPolicy('p1');
    expect(result).toEqual({ id: 'p1', name: 'Policy 1' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/policies/p1', expect.objectContaining({ method: 'GET' }));
  });

  it('getPolicy encodes id', async () => {
    ok({ id: 'p/1' });
    await getPolicy('p/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/policies/p%2F1');
  });

  it('getPolicy throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Policy not found');
    await expect(getPolicy('missing')).rejects.toThrow('Policy not found');
  });

  // ── createPolicy ──────────────────────────────────────────────────────

  it('createPolicy sends POST /v1/policies with body', async () => {
    const data = { name: 'New', rules: [] };
    ok({ id: 'p2', ...data });
    const result = await createPolicy(data as any);
    expect(result).toEqual({ id: 'p2', ...data });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/policies');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createPolicy throws on 400', async () => {
    err(400, 'VALIDATION', 'Name required');
    await expect(createPolicy({} as any)).rejects.toThrow('Name required');
  });

  // ── updatePolicy ──────────────────────────────────────────────────────

  it('updatePolicy sends PATCH /v1/policies/:id with body', async () => {
    ok({ id: 'p1', name: 'Updated' });
    await updatePolicy('p1', { name: 'Updated' } as any);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/policies/p1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Updated' });
  });

  it('updatePolicy throws on error', async () => {
    err(404, 'NOT_FOUND', 'Not found');
    await expect(updatePolicy('x', {})).rejects.toThrow('Not found');
  });

  // ── deletePolicy ──────────────────────────────────────────────────────

  it('deletePolicy sends DELETE /v1/policies/:id', async () => {
    noContent();
    await deletePolicy('p1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/policies/p1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deletePolicy throws on error', async () => {
    err(404, 'NOT_FOUND', 'Policy not found');
    await expect(deletePolicy('missing')).rejects.toThrow('Policy not found');
  });
});
