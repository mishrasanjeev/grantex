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

const MOCK_SCIM_USER = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  id: 'scimuser_01',
  userName: 'alice@corp.com',
  displayName: 'Alice Smith',
  active: true,
  emails: [{ value: 'alice@corp.com', primary: true }],
  meta: { resourceType: 'User', created: '2026-02-27T00:00:00Z', lastModified: '2026-02-27T00:00:00Z' },
};

const MOCK_TOKEN = {
  id: 'scimtok_01',
  label: 'Okta',
  token: 'raw_secret_abc',
  createdAt: '2026-02-27T00:00:00Z',
  lastUsedAt: null,
};

describe('ScimClient — token management', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('createToken() POSTs to /v1/scim/tokens', async () => {
    const mockFetch = makeFetch(201, MOCK_TOKEN);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.createToken({ label: 'Okta' });

    expect(result.id).toBe('scimtok_01');
    expect(result.token).toBe('raw_secret_abc');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/scim\/tokens$/);
    expect(init.method).toBe('POST');
  });

  it('listTokens() GETs /v1/scim/tokens', async () => {
    const mockFetch = makeFetch(200, { tokens: [{ ...MOCK_TOKEN, token: undefined }] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.listTokens();

    expect(result.tokens).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/scim\/tokens$/);
    expect(init.method).toBe('GET');
  });

  it('revokeToken() DELETEs /v1/scim/tokens/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.scim.revokeToken('scimtok_01');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/scim\/tokens\/scimtok_01$/);
    expect(init.method).toBe('DELETE');
  });
});

describe('ScimClient — SCIM 2.0 Users', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('listUsers() GETs /scim/v2/Users', async () => {
    const listResp = { totalResults: 1, startIndex: 1, itemsPerPage: 100, Resources: [MOCK_SCIM_USER] };
    const mockFetch = makeFetch(200, listResp);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.listUsers();

    expect(result.totalResults).toBe(1);
    expect(result.Resources[0]!.userName).toBe('alice@corp.com');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users$/);
    expect(init.method).toBe('GET');
  });

  it('listUsers({ startIndex, count }) appends query params', async () => {
    const mockFetch = makeFetch(200, { totalResults: 0, startIndex: 11, itemsPerPage: 10, Resources: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.scim.listUsers({ startIndex: 11, count: 10 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('startIndex=11');
    expect(url).toContain('count=10');
  });

  it('getUser() GETs /scim/v2/Users/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_SCIM_USER);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.getUser('scimuser_01');

    expect(result.id).toBe('scimuser_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users\/scimuser_01$/);
    expect(init.method).toBe('GET');
  });

  it('createUser() POSTs to /scim/v2/Users', async () => {
    const mockFetch = makeFetch(201, MOCK_SCIM_USER);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.createUser({ userName: 'alice@corp.com' });

    expect(result.id).toBe('scimuser_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users$/);
    expect(init.method).toBe('POST');
  });

  it('replaceUser() PUTs to /scim/v2/Users/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_SCIM_USER);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.scim.replaceUser('scimuser_01', { userName: 'alice@corp.com', active: true });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users\/scimuser_01$/);
    expect(init.method).toBe('PUT');
  });

  it('updateUser() PATCHes /scim/v2/Users/:id with Operations', async () => {
    const mockFetch = makeFetch(200, { ...MOCK_SCIM_USER, active: false });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.scim.updateUser('scimuser_01', [
      { op: 'replace', path: 'active', value: false },
    ]);

    expect(result.active).toBe(false);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users\/scimuser_01$/);
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { Operations: unknown[] };
    expect(body.Operations).toHaveLength(1);
  });

  it('deleteUser() DELETEs /scim/v2/Users/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.scim.deleteUser('scimuser_01');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scim\/v2\/Users\/scimuser_01$/);
    expect(init.method).toBe('DELETE');
  });
});
