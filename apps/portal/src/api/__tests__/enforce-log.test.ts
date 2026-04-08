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

import { listEnforceLogs } from '../enforce-log';

const MOCK_ENTRY = {
  id: 'el_01',
  timestamp: '2026-04-08T00:00:00Z',
  agentId: 'ag_01',
  agentDid: 'did:grantex:ag_01',
  connector: 'salesforce',
  tool: 'create_lead',
  permission: 'write',
  result: 'allowed' as const,
  reason: '',
  scopes: ['tool:salesforce:write'],
  grantId: 'grnt_01',
};

describe('enforce-log', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('listEnforceLogs sends GET /v1/enforce-log without params', async () => {
    ok({ entries: [MOCK_ENTRY], total: 1, page: 1, pageSize: 20 });
    const result = await listEnforceLogs();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.connector).toBe('salesforce');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/enforce-log',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listEnforceLogs with result filter', async () => {
    ok({ entries: [], total: 0, page: 1, pageSize: 20 });
    await listEnforceLogs({ result: 'denied' });
    expect(mockFetch.mock.calls[0]![0]).toContain('result=denied');
  });

  it('listEnforceLogs with connector filter', async () => {
    ok({ entries: [], total: 0, page: 1, pageSize: 20 });
    await listEnforceLogs({ connector: 'stripe' });
    expect(mockFetch.mock.calls[0]![0]).toContain('connector=stripe');
  });

  it('listEnforceLogs with agentId filter', async () => {
    ok({ entries: [], total: 0, page: 1, pageSize: 20 });
    await listEnforceLogs({ agentId: 'ag_01' });
    expect(mockFetch.mock.calls[0]![0]).toContain('agentId=ag_01');
  });

  it('listEnforceLogs with pagination', async () => {
    ok({ entries: [], total: 50, page: 3, pageSize: 10 });
    await listEnforceLogs({ page: 3, pageSize: 10 });
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('page=3');
    expect(url).toContain('pageSize=10');
  });

  it('listEnforceLogs with all filters combined', async () => {
    ok({ entries: [MOCK_ENTRY], total: 1, page: 1, pageSize: 20 });
    await listEnforceLogs({ result: 'allowed', connector: 'salesforce', agentId: 'ag_01', page: 1, pageSize: 20 });
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('result=allowed');
    expect(url).toContain('connector=salesforce');
    expect(url).toContain('agentId=ag_01');
  });

  it('listEnforceLogs returns denied entries', async () => {
    const denied = { ...MOCK_ENTRY, result: 'denied', reason: 'read scope does not permit write operations' };
    ok({ entries: [denied], total: 1, page: 1, pageSize: 20 });
    const result = await listEnforceLogs({ result: 'denied' });
    expect(result.entries[0]!.result).toBe('denied');
    expect(result.entries[0]!.reason).toContain('read scope');
  });

  it('listEnforceLogs throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Invalid key');
    await expect(listEnforceLogs()).rejects.toThrow('Invalid key');
  });

  it('listEnforceLogs throws on server error', async () => {
    err(500, 'INTERNAL', 'Server error');
    await expect(listEnforceLogs()).rejects.toThrow('Server error');
  });
});
