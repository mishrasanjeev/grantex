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

import { listBundles, getBundle, createBundle, revokeBundle, getBundleAuditEntries, getRevocationStatus } from '../bundles';

describe('bundles', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listBundles ───────────────────────────────────────────────────────

  it('listBundles without params sends GET /v1/consent-bundles', async () => {
    ok({ bundles: [{ id: 'cb1', status: 'active' }] });
    const result = await listBundles();
    expect(result).toEqual([{ id: 'cb1', status: 'active' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/consent-bundles', expect.objectContaining({ method: 'GET' }));
  });

  it('listBundles with status param', async () => {
    ok({ bundles: [] });
    await listBundles({ status: 'revoked' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/consent-bundles?status=revoked');
  });

  it('listBundles with agentId param', async () => {
    ok({ bundles: [] });
    await listBundles({ agentId: 'agent-1' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/consent-bundles?agentId=agent-1');
  });

  it('listBundles with both params', async () => {
    ok({ bundles: [] });
    await listBundles({ status: 'active', agentId: 'a1' });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('status=active');
    expect(url).toContain('agentId=a1');
  });

  it('listBundles throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listBundles()).rejects.toThrow('Failed');
  });

  // ── getBundle ─────────────────────────────────────────────────────────

  it('getBundle sends GET /v1/consent-bundles/:id', async () => {
    ok({ id: 'cb1', status: 'active' });
    const result = await getBundle('cb1');
    expect(result).toEqual({ id: 'cb1', status: 'active' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/consent-bundles/cb1', expect.objectContaining({ method: 'GET' }));
  });

  it('getBundle encodes id', async () => {
    ok({ id: 'cb/1' });
    await getBundle('cb/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/consent-bundles/cb%2F1');
  });

  it('getBundle throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Bundle not found');
    await expect(getBundle('missing')).rejects.toThrow('Bundle not found');
  });

  // ── createBundle ──────────────────────────────────────────────────────

  it('createBundle sends POST /v1/consent-bundles with params', async () => {
    const params = { agentId: 'a1', userId: 'u1', scopes: ['read', 'write'] };
    const resp = { bundle: { id: 'cb2' }, grantToken: 'tok', jwks: {}, auditKey: 'ak' };
    ok(resp);
    const result = await createBundle(params);
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/consent-bundles');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(params);
  });

  it('createBundle throws on 400', async () => {
    err(400, 'VALIDATION', 'Missing agentId');
    await expect(createBundle({} as any)).rejects.toThrow('Missing agentId');
  });

  // ── revokeBundle ──────────────────────────────────────────────────────

  it('revokeBundle sends POST /v1/consent-bundles/:id/revoke', async () => {
    ok(undefined);
    await revokeBundle('cb1');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/consent-bundles/cb1/revoke');
    expect(opts.method).toBe('POST');
  });

  it('revokeBundle throws on error', async () => {
    err(404, 'NOT_FOUND', 'Bundle not found');
    await expect(revokeBundle('missing')).rejects.toThrow('Bundle not found');
  });

  // ── getBundleAuditEntries ─────────────────────────────────────────────

  it('getBundleAuditEntries sends GET /v1/consent-bundles/:id/audit and unwraps .entries', async () => {
    ok({ entries: [{ id: 'ae1', action: 'access' }] });
    const result = await getBundleAuditEntries('cb1');
    expect(result).toEqual([{ id: 'ae1', action: 'access' }]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/consent-bundles/cb1/audit',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getBundleAuditEntries encodes id', async () => {
    ok({ entries: [] });
    await getBundleAuditEntries('cb/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/consent-bundles/cb%2F1/audit');
  });

  it('getBundleAuditEntries throws on error', async () => {
    err(404, 'NOT_FOUND', 'Not found');
    await expect(getBundleAuditEntries('x')).rejects.toThrow('Not found');
  });

  // ── getRevocationStatus ───────────────────────────────────────────────

  it('getRevocationStatus sends GET /v1/consent-bundles/:id/revocation', async () => {
    const status = { bundleId: 'cb1', revoked: false, revokedAt: null, propagated: false };
    ok(status);
    const result = await getRevocationStatus('cb1');
    expect(result).toEqual(status);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/consent-bundles/cb1/revocation',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getRevocationStatus throws on error', async () => {
    err(404, 'NOT_FOUND', 'Not found');
    await expect(getRevocationStatus('x')).rejects.toThrow('Not found');
  });
});
