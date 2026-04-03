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

import { listAuditEntries, getAuditEntry } from '../audit';

describe('audit', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listAuditEntries ──────────────────────────────────────────────────

  it('listAuditEntries without params sends GET /v1/audit/entries', async () => {
    ok({ entries: [{ id: 'e1', action: 'token.exchange' }] });
    const result = await listAuditEntries();
    expect(result).toEqual([{ id: 'e1', action: 'token.exchange' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/audit/entries', expect.objectContaining({ method: 'GET' }));
  });

  it('listAuditEntries with agentId param', async () => {
    ok({ entries: [] });
    await listAuditEntries({ agentId: 'agent-1' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/audit/entries?agentId=agent-1');
  });

  it('listAuditEntries with grantId param', async () => {
    ok({ entries: [] });
    await listAuditEntries({ grantId: 'g1' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/audit/entries?grantId=g1');
  });

  it('listAuditEntries with principalId param', async () => {
    ok({ entries: [] });
    await listAuditEntries({ principalId: 'p1' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/audit/entries?principalId=p1');
  });

  it('listAuditEntries with action param', async () => {
    ok({ entries: [] });
    await listAuditEntries({ action: 'token.verify' });
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/audit/entries?action=token.verify');
  });

  it('listAuditEntries with multiple params', async () => {
    ok({ entries: [] });
    await listAuditEntries({ agentId: 'a1', action: 'grant.revoke' });
    const url = mockFetch.mock.calls[0]![0];
    expect(url).toContain('agentId=a1');
    expect(url).toContain('action=grant.revoke');
  });

  it('listAuditEntries throws on error', async () => {
    err(500, 'INTERNAL', 'DB error');
    await expect(listAuditEntries()).rejects.toThrow('DB error');
  });

  // ── getAuditEntry ─────────────────────────────────────────────────────

  it('getAuditEntry sends GET /v1/audit/:id', async () => {
    ok({ id: 'e1', action: 'token.exchange' });
    const result = await getAuditEntry('e1');
    expect(result).toEqual({ id: 'e1', action: 'token.exchange' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/audit/e1', expect.objectContaining({ method: 'GET' }));
  });

  it('getAuditEntry encodes id', async () => {
    ok({ id: 'e/1' });
    await getAuditEntry('e/1');
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:3000/v1/audit/e%2F1');
  });

  it('getAuditEntry throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Entry not found');
    await expect(getAuditEntry('missing')).rejects.toThrow('Entry not found');
  });
});
