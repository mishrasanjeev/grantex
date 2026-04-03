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

import { searchRegistryOrgs, getRegistryOrg, registerOrg, verifyOrgDns } from '../registry';

describe('registry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── searchRegistryOrgs ────────────────────────────────────────────────

  it('searchRegistryOrgs without params sends GET /v1/registry/orgs', async () => {
    const resp = { data: [{ did: 'did:web:example.com', name: 'Example' }], meta: { total: 1 } };
    ok(resp);
    const result = await searchRegistryOrgs();
    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/registry/orgs', expect.objectContaining({ method: 'GET' }));
  });

  it('searchRegistryOrgs with q param', async () => {
    ok({ data: [], meta: { total: 0 } });
    await searchRegistryOrgs({ q: 'test' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/registry/orgs?q=test');
  });

  it('searchRegistryOrgs with verified param', async () => {
    ok({ data: [], meta: { total: 0 } });
    await searchRegistryOrgs({ verified: true });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/registry/orgs?verified=true');
  });

  it('searchRegistryOrgs with badge param', async () => {
    ok({ data: [], meta: { total: 0 } });
    await searchRegistryOrgs({ badge: 'gold' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/registry/orgs?badge=gold');
  });

  it('searchRegistryOrgs with all params', async () => {
    ok({ data: [], meta: { total: 0 } });
    await searchRegistryOrgs({ q: 'acme', verified: true, badge: 'silver' });
    const url = mockFetch.mock.calls[0]![0];
    expect(url).toContain('q=acme');
    expect(url).toContain('verified=true');
    expect(url).toContain('badge=silver');
  });

  it('searchRegistryOrgs returns full {data, meta} structure', async () => {
    const resp = { data: [], meta: { total: 0 } };
    ok(resp);
    const result = await searchRegistryOrgs();
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual({ total: 0 });
  });

  it('searchRegistryOrgs throws on error', async () => {
    err(500, 'INTERNAL', 'Search failed');
    await expect(searchRegistryOrgs()).rejects.toThrow('Search failed');
  });

  // ── getRegistryOrg ────────────────────────────────────────────────────

  it('getRegistryOrg sends GET /v1/registry/orgs/:did', async () => {
    const org = { did: 'did:web:example.com', name: 'Example', agents: [] };
    ok(org);
    const result = await getRegistryOrg('did:web:example.com');
    expect(result).toEqual(org);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/registry/orgs/did%3Aweb%3Aexample.com',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getRegistryOrg throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Org not found');
    await expect(getRegistryOrg('did:web:missing')).rejects.toThrow('Org not found');
  });

  // ── registerOrg ───────────────────────────────────────────────────────

  it('registerOrg sends POST /v1/registry/orgs with params', async () => {
    const params = {
      did: 'did:web:neworg.com',
      name: 'New Org',
      contact: { security: 'sec@neworg.com' },
    };
    ok({ ...params, verificationLevel: 'none', badges: [], agents: [] });
    const result = await registerOrg(params);
    expect(result.did).toBe('did:web:neworg.com');
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/registry/orgs');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(params);
  });

  it('registerOrg throws on 409', async () => {
    err(409, 'CONFLICT', 'Org already registered');
    await expect(registerOrg({ did: 'x', name: 'x', contact: { security: 'x' } })).rejects.toThrow('Org already registered');
  });

  // ── verifyOrgDns ──────────────────────────────────────────────────────

  it('verifyOrgDns sends POST /v1/registry/orgs/:id/verify-dns', async () => {
    ok({ verified: true });
    const result = await verifyOrgDns('org-1');
    expect(result).toEqual({ verified: true });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/registry/orgs/org-1/verify-dns');
    expect(opts.method).toBe('POST');
  });

  it('verifyOrgDns encodes orgId', async () => {
    ok({ verified: false });
    await verifyOrgDns('org/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/registry/orgs/org%2F1/verify-dns');
  });

  it('verifyOrgDns throws on error', async () => {
    err(400, 'VERIFICATION_FAILED', 'DNS not configured');
    await expect(verifyOrgDns('org-1')).rejects.toThrow('DNS not configured');
  });
});
