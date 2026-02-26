import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_POLICY = {
  id: 'pol_01',
  name: 'Block all',
  effect: 'deny' as const,
  priority: 0,
  agentId: null,
  principalId: null,
  scopes: null,
  timeOfDayStart: null,
  timeOfDayEnd: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('PoliciesClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('create() POSTs to /v1/policies', async () => {
    const mockFetch = makeFetch(201, MOCK_POLICY);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.policies.create({ name: 'Block all', effect: 'deny' });

    expect(result.id).toBe('pol_01');
    expect(result.effect).toBe('deny');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/policies$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['name']).toBe('Block all');
    expect(body['effect']).toBe('deny');
  });

  it('list() GETs /v1/policies', async () => {
    const mockFetch = makeFetch(200, { policies: [MOCK_POLICY], total: 1 });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.policies.list();

    expect(result.policies).toHaveLength(1);
    expect(result.total).toBe(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/policies$/);
    expect(init.method).toBe('GET');
  });

  it('get() GETs /v1/policies/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_POLICY);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.policies.get('pol_01');

    expect(result.id).toBe('pol_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/policies\/pol_01$/);
    expect(init.method).toBe('GET');
  });

  it('update() PATCHes /v1/policies/:id', async () => {
    const mockFetch = makeFetch(200, { ...MOCK_POLICY, name: 'Updated' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.policies.update('pol_01', { name: 'Updated' });

    expect(result.name).toBe('Updated');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/policies\/pol_01$/);
    expect(init.method).toBe('PATCH');
  });

  it('delete() DELETEs /v1/policies/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.policies.delete('pol_01');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/policies\/pol_01$/);
    expect(init.method).toBe('DELETE');
  });
});
