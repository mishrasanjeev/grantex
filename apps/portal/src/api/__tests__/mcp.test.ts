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

import { listMcpServers, getMcpServer, createMcpServer, applyForCertification, getCertification } from '../mcp';

describe('mcp', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listMcpServers ────────────────────────────────────────────────────

  it('listMcpServers without params sends GET /v1/mcp/servers', async () => {
    ok({ servers: [{ id: 's1', name: 'Server 1' }] });
    const result = await listMcpServers();
    expect(result).toEqual([{ id: 's1', name: 'Server 1' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/mcp/servers', expect.objectContaining({ method: 'GET' }));
  });

  it('listMcpServers with category param', async () => {
    ok({ servers: [] });
    await listMcpServers({ category: 'data' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/mcp/servers?category=data');
  });

  it('listMcpServers with certified param (true)', async () => {
    ok({ servers: [] });
    await listMcpServers({ certified: true });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/mcp/servers?certified=true');
  });

  it('listMcpServers with certified param (false)', async () => {
    ok({ servers: [] });
    await listMcpServers({ certified: false });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/mcp/servers?certified=false');
  });

  it('listMcpServers with both params', async () => {
    ok({ servers: [] });
    await listMcpServers({ category: 'auth', certified: true });
    const url = mockFetch.mock.calls[0]![0];
    expect(url).toContain('category=auth');
    expect(url).toContain('certified=true');
  });

  it('listMcpServers throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listMcpServers()).rejects.toThrow('Failed');
  });

  // ── getMcpServer ──────────────────────────────────────────────────────

  it('getMcpServer sends GET /v1/mcp/servers/:id', async () => {
    ok({ id: 's1', name: 'Server 1' });
    const result = await getMcpServer('s1');
    expect(result).toEqual({ id: 's1', name: 'Server 1' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/mcp/servers/s1', expect.objectContaining({ method: 'GET' }));
  });

  it('getMcpServer encodes id', async () => {
    ok({ id: 's/1' });
    await getMcpServer('s/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/mcp/servers/s%2F1');
  });

  it('getMcpServer throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Server not found');
    await expect(getMcpServer('missing')).rejects.toThrow('Server not found');
  });

  // ── createMcpServer ───────────────────────────────────────────────────

  it('createMcpServer sends POST /v1/mcp/servers with params', async () => {
    const params = { name: 'New Server', category: 'data', scopes: ['read'] };
    ok({ id: 's2', ...params });
    const result = await createMcpServer(params);
    expect(result).toEqual({ id: 's2', ...params });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/mcp/servers');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(params);
  });

  it('createMcpServer throws on 400', async () => {
    err(400, 'VALIDATION', 'Name required');
    await expect(createMcpServer({} as any)).rejects.toThrow('Name required');
  });

  // ── applyForCertification ─────────────────────────────────────────────

  it('applyForCertification sends POST /v1/mcp/servers/:id/certify with level', async () => {
    const cert = { id: 'cert-1', serverId: 's1', requestedLevel: 'gold', status: 'pending' };
    ok(cert);
    const result = await applyForCertification('s1', 'gold');
    expect(result).toEqual(cert);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/mcp/servers/s1/certify');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ level: 'gold' });
  });

  it('applyForCertification encodes serverId', async () => {
    ok({ id: 'cert-1' });
    await applyForCertification('s/1', 'silver');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/mcp/servers/s%2F1/certify');
  });

  it('applyForCertification throws on error', async () => {
    err(409, 'CONFLICT', 'Already certified');
    await expect(applyForCertification('s1', 'gold')).rejects.toThrow('Already certified');
  });

  // ── getCertification ──────────────────────────────────────────────────

  it('getCertification sends GET /v1/mcp/certifications/:id', async () => {
    const cert = { id: 'cert-1', status: 'approved' };
    ok(cert);
    const result = await getCertification('cert-1');
    expect(result).toEqual(cert);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/mcp/certifications/cert-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getCertification throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Certification not found');
    await expect(getCertification('missing')).rejects.toThrow('Certification not found');
  });
});
