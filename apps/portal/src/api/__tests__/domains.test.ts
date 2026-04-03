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

import { listDomains, createDomain, verifyDomain, deleteDomain } from '../domains';

describe('domains', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listDomains ───────────────────────────────────────────────────────

  it('listDomains sends GET /v1/domains and unwraps .domains', async () => {
    ok({ domains: [{ id: 'd1', domain: 'example.com', verified: true }] });
    const result = await listDomains();
    expect(result).toEqual([{ id: 'd1', domain: 'example.com', verified: true }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/domains', expect.objectContaining({ method: 'GET' }));
  });

  it('listDomains throws on error', async () => {
    err(500, 'INTERNAL', 'DB error');
    await expect(listDomains()).rejects.toThrow('DB error');
  });

  // ── createDomain ──────────────────────────────────────────────────────

  it('createDomain sends POST /v1/domains with domain in body', async () => {
    const domain = { id: 'd2', domain: 'new.dev', verified: false, verificationToken: 'tok-123' };
    ok(domain);
    const result = await createDomain('new.dev');
    expect(result).toEqual(domain);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/domains');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ domain: 'new.dev' });
  });

  it('createDomain throws on 409', async () => {
    err(409, 'CONFLICT', 'Domain already registered');
    await expect(createDomain('taken.com')).rejects.toThrow('Domain already registered');
  });

  // ── verifyDomain ──────────────────────────────────────────────────────

  it('verifyDomain sends POST /v1/domains/:id/verify', async () => {
    ok({ verified: true });
    const result = await verifyDomain('d1');
    expect(result).toEqual({ verified: true });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/domains/d1/verify');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
  });

  it('verifyDomain encodes id', async () => {
    ok({ verified: false });
    await verifyDomain('d/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/domains/d%2F1/verify');
  });

  it('verifyDomain throws on error', async () => {
    err(400, 'VERIFICATION_FAILED', 'DNS record not found');
    await expect(verifyDomain('d1')).rejects.toThrow('DNS record not found');
  });

  // ── deleteDomain ──────────────────────────────────────────────────────

  it('deleteDomain sends DELETE /v1/domains/:id', async () => {
    noContent();
    await deleteDomain('d1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/domains/d1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteDomain throws on error', async () => {
    err(404, 'NOT_FOUND', 'Domain not found');
    await expect(deleteDomain('missing')).rejects.toThrow('Domain not found');
  });
});
