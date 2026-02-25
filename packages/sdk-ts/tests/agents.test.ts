import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_AGENT = {
  id: 'ag_01',
  did: 'did:grantex:ag_01',
  name: 'travel-booker',
  description: 'Books travel',
  scopes: ['calendar:read', 'payments:initiate:max_500'],
  status: 'active' as const,
  developerId: 'org_1',
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
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

describe('AgentsClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('register() POSTs to /v1/agents', async () => {
    const mockFetch = makeFetch(200, MOCK_AGENT);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const agent = await grantex.agents.register({
      name: 'travel-booker',
      description: 'Books travel',
      scopes: ['calendar:read'],
    });

    expect(agent.did).toBe('did:grantex:ag_01');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/agents$/);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init as RequestInit).method).toBe('POST');
  });

  it('get() GETs /v1/agents/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_AGENT);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const agent = await grantex.agents.get('ag_01');

    expect(agent.id).toBe('ag_01');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/agents\/ag_01$/);
  });

  it('list() GETs /v1/agents', async () => {
    const listResponse = { agents: [MOCK_AGENT], total: 1, page: 1, pageSize: 20 };
    vi.stubGlobal('fetch', makeFetch(200, listResponse));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.agents.list();

    expect(result.agents).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('update() POSTs to /v1/agents/:id', async () => {
    const updated = { ...MOCK_AGENT, name: 'updated-name' };
    const mockFetch = makeFetch(200, updated);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const agent = await grantex.agents.update('ag_01', { name: 'updated-name' });

    expect(agent.name).toBe('updated-name');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/agents\/ag_01$/);
  });

  it('delete() DELETEs /v1/agents/:id', async () => {
    vi.stubGlobal('fetch', makeFetch(204, null));

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.agents.delete('ag_01')).resolves.toBeUndefined();

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });
});
