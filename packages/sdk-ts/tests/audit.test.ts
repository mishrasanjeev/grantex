import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_ENTRY = {
  entryId: 'evt_01',
  agentId: 'ag_01',
  agentDid: 'did:grantex:ag_01',
  grantId: 'grant_01',
  principalId: 'user_abc',
  action: 'payment.initiated',
  metadata: { amount: 420, currency: 'USD', merchant: 'Air India' },
  hash: 'abc123hash',
  prevHash: null,
  timestamp: '2026-02-25T12:00:00Z',
  status: 'success' as const,
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('AuditClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('log() POSTs to /v1/audit/log', async () => {
    const mockFetch = makeFetch(200, MOCK_ENTRY);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const entry = await grantex.audit.log({
      agentId: 'ag_01',
      grantId: 'grant_01',
      action: 'payment.initiated',
      metadata: { amount: 420, currency: 'USD', merchant: 'Air India' },
      status: 'success',
    });

    expect(entry.entryId).toBe('evt_01');
    expect(entry.action).toBe('payment.initiated');
    expect(entry.status).toBe('success');
    expect(entry.prevHash).toBeNull();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/audit\/log$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['action']).toBe('payment.initiated');
  });

  it('list() GETs /v1/audit/entries', async () => {
    const listResponse = { entries: [MOCK_ENTRY], total: 1, page: 1, pageSize: 20 };
    vi.stubGlobal('fetch', makeFetch(200, listResponse));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.audit.list();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entryId).toBe('evt_01');
  });

  it('list() appends query params to /v1/audit/entries', async () => {
    const listResponse = { entries: [], total: 0, page: 1, pageSize: 20 };
    const mockFetch = makeFetch(200, listResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.audit.list({ agentId: 'ag_01', action: 'payment.initiated' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/audit/entries');
    expect(url).toContain('agentId=ag_01');
    expect(url).toContain('action=payment.initiated');
  });

  it('get() GETs /v1/audit/:id', async () => {
    vi.stubGlobal('fetch', makeFetch(200, MOCK_ENTRY));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const entry = await grantex.audit.get('evt_01');

    expect(entry.entryId).toBe('evt_01');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/audit\/evt_01$/);
  });

  it('log() without metadata still works', async () => {
    vi.stubGlobal('fetch', makeFetch(200, { ...MOCK_ENTRY, metadata: {} }));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const entry = await grantex.audit.log({
      agentId: 'ag_01',
      grantId: 'grant_01',
      action: 'file.read',
    });

    expect(entry.entryId).toBe('evt_01');
  });
});
